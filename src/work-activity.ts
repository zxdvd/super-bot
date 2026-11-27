import type { DatabaseSync } from 'node:sqlite';
import { TEST_TASK_PREFIX, type WorkActivity, type BotWorkSummary, type Task } from './model.ts';
import { settledBlockerSql } from './settled-blocker.ts';
import { currentLateJobSql } from './store/late-job.ts';

// Only the current manager owns sidebar/session decorations. An unattended task without
// a live run or a durable automatic next step belongs in the waiting group.
const managers = `SELECT b.id, b.name, b.createdAt, m.sessionId FROM bots b
  LEFT JOIN managers m ON m.botId=b.id AND m.state='ready' AND m.configRevision=b.configRevision
    AND m.sessionId=b.managerSessionId AND m.requestedSessionId=m.sessionId
  WHERE b.deletedAt IS NULL`;

const releaseDeadline = `json_extract(release.snapshot,'$.deadlineAt')`;
const expiredLateJob = `t.controlMode='auto' AND json_extract(late.value,'$.state')='waiting'
  AND coalesce(json_extract(late.value,'$.deadline'),0)<=$now`;

function activities(scope: '' | 'bot' | 'tasks') {
  return `SELECT t.id, t.botId, t.goal,
    CASE WHEN late.value IS NOT NULL THEN
      CASE WHEN ${expiredLateJob} THEN 'expired' ELSE 'tracked' END
      WHEN latest.state='interrupted' AND EXISTS (
        SELECT 1 FROM metadata WHERE key='late-job:' || latest.id
      ) THEN 'blocked' END AS lateJob,
    CASE WHEN stage.state='waiting' OR release.stageRunId IS NOT NULL THEN 1 ELSE 0 END AS observesExternalWork,
    CASE
    WHEN t.lifecycle='completed' AND res.humanAcceptedAt IS NULL THEN
      CASE WHEN delivery.state IN ('blocked','unknown') THEN 'attention'
        WHEN m.sessionId IS NOT NULL THEN 'working' END
    WHEN EXISTS (SELECT 1 FROM attentions a WHERE a.taskId=t.id AND a.taskRevision=t.taskRevision
      AND a.state='open' AND a.kind IN ('input','approval','recovery')
      AND NOT (a.kind='recovery' AND a.id='run:' || latest.id AND latest.taskRevision=t.taskRevision
        AND ((latest.sessionId IS t.sessionId AND (${settledBlockerSql}) IS NOT NULL)
          OR (late.value IS NOT NULL AND NOT (${expiredLateJob}))))) THEN 'attention'
    WHEN EXISTS (SELECT 1 FROM runs r WHERE r.taskId=t.id AND r.finishedAt IS NULL
      AND r.state IN ('queued','running','cancelling')) THEN 'working'
    WHEN t.lifecycle='open' AND t.controlMode='auto' AND stage.state='blocked' THEN 'attention'
    WHEN t.lifecycle='open' AND t.controlMode='auto' AND close.key IS NULL AND (
      json_extract(release.snapshot,'$.state') IN ('failed','needs-permission','expired') OR
      release.nextCheckAt IS NOT NULL AND ${releaseDeadline}<=$now) THEN 'attention'
    WHEN t.lifecycle='open' AND t.controlMode='auto' AND (
      json_extract(recovery.value,'$.resolution.status') IN ('denied','missing')
      OR json_extract(recovery.value,'$.resolution.observed.ready')=0
      OR json_extract(recovery.value,'$.effectUncertain')=1) THEN 'attention'
    WHEN t.lifecycle='review' AND delivery.state IN ('pending','sending','entered') AND m.sessionId IS NOT NULL THEN 'working'
    WHEN t.lifecycle='review' AND delivery.state IN ('pending','sending','entered','blocked','unknown') THEN 'attention'
    WHEN t.lifecycle='review' AND delivery.state IN ('done','handled') THEN 'review'
    WHEN t.id IN (SELECT taskId FROM outbox WHERE kind='manager.notify' AND (state='blocked' OR
      (state='unknown' AND coalesce(json_extract(payload,'$.reconcileAttempts'),0)>=3))) THEN 'attention'
    WHEN late.value IS NOT NULL AND t.controlMode='auto' AND NOT (${expiredLateJob}) THEN 'working'
    WHEN t.lifecycle='open' AND t.controlMode='auto' AND close.key IS NULL AND (
      stage.state='waiting' AND stage.nextCheckAt IS NOT NULL AND stage.observerOrigin IS NOT NULL
        AND EXISTS (SELECT 1 FROM bindings b WHERE b.id=latest.bindingId AND b.state='ready' AND b.sessionId=t.sessionId)
      OR release.nextCheckAt IS NOT NULL AND ${releaseDeadline}>$now) THEN 'working'
    WHEN t.controlMode='auto' AND m.sessionId IS NOT NULL AND t.id IN
      (SELECT taskId FROM outbox WHERE kind='manager.notify' AND state IN ('pending','sending','entered')) THEN 'working'
    WHEN t.lifecycle='review' THEN 'review'
    END AS activity
    FROM tasks t JOIN managers_now m ON t.botId=m.id
    LEFT JOIN runs latest ON latest.id=(SELECT id FROM runs WHERE taskId=t.id ORDER BY createdAt DESC,rowid DESC LIMIT 1)
    LEFT JOIN work_stages stage ON stage.runId=latest.id AND stage.taskRevision=t.taskRevision
      AND latest.sessionId=t.sessionId AND latest.finishedAt IS NOT NULL
    LEFT JOIN metadata late ON t.controlMode IN ('auto','paused') AND late.key='late-job:' || latest.id AND ${currentLateJobSql}
    LEFT JOIN metadata close ON close.key='task-close:' || t.id
    LEFT JOIN gitlab_release_receipts release ON stage.state='awaiting-decision' AND release.runId=latest.id AND release.stageRunId=(
      SELECT r.stageRunId FROM gitlab_release_receipts r JOIN work_stages s ON s.runId=r.stageRunId
      WHERE r.taskId=t.id AND s.taskRevision=t.taskRevision ORDER BY r.rowid DESC LIMIT 1)
    LEFT JOIN metadata recovery ON latest.taskRevision=t.taskRevision AND recovery.key='run-recovery-check:' || latest.id
    LEFT JOIN results res ON t.lifecycle IN ('review','completed') AND res.taskRevision=t.taskRevision AND res.runId=latest.id
    LEFT JOIN outbox delivery ON delivery.id='manager-event:delivery:' || res.id
    WHERE (t.lifecycle IN ('open','review') OR (t.lifecycle='completed' AND t.id IN
      (SELECT taskId FROM outbox WHERE kind='manager.notify' AND state IN ('pending','sending','entered','blocked','unknown')
        AND json_extract(payload,'$.deliveryOnly')=1) AND res.humanAcceptedAt IS NULL AND delivery.state IN ('pending','sending','entered','blocked','unknown')))
      ${scope === 'bot' ? 'AND t.botId=$botId' : scope === 'tasks' ? 'AND t.id IN (SELECT value FROM json_each($taskIds))' : ''}`;
}

export function botWorkSummaries(db: DatabaseSync): BotWorkSummary[] {
  return db
    .prepare(`WITH managers_now AS (${managers}), activity AS (${activities('')})
    SELECT m.id,m.name,m.sessionId,
      count(a.id) FILTER (WHERE a.activity='working' AND instr(a.goal,?)!=1) AS working,
      count(a.id) FILTER (WHERE a.activity='attention') AS attention,
      count(a.id) FILTER (WHERE a.activity='review' AND instr(a.goal,?)!=1) AS review
    FROM managers_now m LEFT JOIN activity a ON a.botId=m.id GROUP BY m.id ORDER BY m.createdAt,m.id`)
    .all({ $now: Date.now() }, TEST_TASK_PREFIX, TEST_TASK_PREFIX) as unknown as BotWorkSummary[];
}

type TaskActivity = {
  id: string;
  goal: string;
  activity: WorkActivity | null;
  lateJob: 'tracked' | 'expired' | 'blocked' | null;
  observesExternalWork: 0 | 1;
};

export function taskActivities(db: DatabaseSync, taskIds: string[]) {
  const rows = db
    .prepare(`WITH managers_now AS (${managers}) ${activities('tasks')}`)
    .all({ $now: Date.now(), $taskIds: JSON.stringify(taskIds) }) as unknown as TaskActivity[];
  return new Map(rows.map((row) => [row.id, row]));
}

export function applyTaskActivity(task: Task, row?: TaskActivity, inbox = false): Task {
  if (!inbox && !row?.lateJob && !row?.observesExternalWork) return task;
  return {
    ...task,
    activity: row?.activity ?? null,
    ...(row?.lateJob === 'tracked' && task.blockingAttention === 'recovery'
      ? { blockingAttention: null }
      : {}),
  };
}

export function inboxActivity(db: DatabaseSync, botId: string) {
  const rows = db
    .prepare(`WITH managers_now AS (${managers}) ${activities('bot')}`)
    .all({ $now: Date.now(), $botId: botId }) as unknown as TaskActivity[];
  const byTask = new Map<string, TaskActivity>();
  let reviewTotal = 0;
  for (const row of rows) {
    byTask.set(row.id, row);
    if (row.activity === 'review' && !row.goal.startsWith(TEST_TASK_PREFIX)) reviewTotal++;
  }
  return { byTask, reviewTotal };
}
