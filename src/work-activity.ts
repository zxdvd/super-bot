import type { DatabaseSync } from 'node:sqlite';
import { TEST_TASK_PREFIX, type WorkActivity, type BotWorkSummary } from './model.ts';
import { settledBlockerSql } from './settled-blocker.ts';

// Only the current manager owns sidebar/session decorations. An unattended task without
// a live run or a durable automatic next step belongs in the waiting group.
const managers = `SELECT b.id, b.name, b.createdAt, m.sessionId FROM bots b
  LEFT JOIN managers m ON m.botId=b.id AND m.state='ready' AND m.configRevision=b.configRevision
    AND m.sessionId=b.managerSessionId AND m.requestedSessionId=m.sessionId
  WHERE b.deletedAt IS NULL`;

function activities(scoped: boolean) {
  return `SELECT t.id, t.botId, t.goal, CASE
    WHEN t.lifecycle='completed' AND res.humanAcceptedAt IS NULL THEN
      CASE WHEN delivery.state IN ('blocked','unknown') THEN 'attention'
        WHEN m.sessionId IS NOT NULL THEN 'working' END
    WHEN EXISTS (SELECT 1 FROM attentions a WHERE a.taskId=t.id AND a.taskRevision=t.taskRevision
      AND a.state='open' AND a.kind IN ('input','approval','recovery')
      AND NOT (a.kind='recovery' AND a.id='run:' || latest.id AND latest.taskRevision=t.taskRevision AND latest.sessionId IS t.sessionId
        AND (${settledBlockerSql}) IS NOT NULL)) THEN 'attention'
    WHEN EXISTS (SELECT 1 FROM runs r WHERE r.taskId=t.id AND r.finishedAt IS NULL
      AND r.state IN ('queued','running','cancelling')) THEN 'working'
    WHEN t.lifecycle='open' AND t.controlMode='auto' AND (
      json_extract(recovery.value,'$.resolution.status') IN ('denied','missing')
      OR json_extract(recovery.value,'$.resolution.observed.ready')=0
      OR json_extract(recovery.value,'$.effectUncertain')=1) THEN 'attention'
    WHEN t.lifecycle='review' AND delivery.state IN ('pending','sending','entered') AND m.sessionId IS NOT NULL THEN 'working'
    WHEN t.lifecycle='review' AND delivery.state IN ('pending','sending','entered','blocked','unknown') THEN 'attention'
    WHEN t.lifecycle='review' AND delivery.state IN ('done','handled') THEN 'review'
    WHEN t.id IN (SELECT taskId FROM outbox WHERE kind='manager.notify' AND (state='blocked' OR
      (state='unknown' AND coalesce(json_extract(payload,'$.reconcileAttempts'),0)>=3))) THEN 'attention'
    WHEN t.controlMode='auto' AND m.sessionId IS NOT NULL AND t.id IN
      (SELECT taskId FROM outbox WHERE kind='manager.notify' AND state IN ('pending','sending','entered')) THEN 'working'
    WHEN t.lifecycle='review' THEN 'review'
    END AS activity
    FROM tasks t JOIN managers_now m ON t.botId=m.id
    LEFT JOIN runs latest ON latest.id=(SELECT id FROM runs WHERE taskId=t.id ORDER BY createdAt DESC,rowid DESC LIMIT 1)
    LEFT JOIN metadata recovery ON latest.taskRevision=t.taskRevision AND recovery.key='run-recovery-check:' || latest.id
    LEFT JOIN results res ON t.lifecycle IN ('review','completed') AND res.taskRevision=t.taskRevision AND res.runId=latest.id
    LEFT JOIN outbox delivery ON delivery.id='manager-event:delivery:' || res.id
    WHERE (t.lifecycle IN ('open','review') OR (t.lifecycle='completed' AND t.id IN
      (SELECT taskId FROM outbox WHERE kind='manager.notify' AND state IN ('pending','sending','entered','blocked','unknown')
        AND json_extract(payload,'$.deliveryOnly')=1) AND res.humanAcceptedAt IS NULL AND delivery.state IN ('pending','sending','entered','blocked','unknown'))) ${scoped ? 'AND t.botId=?' : ''}`;
}

export function botWorkSummaries(db: DatabaseSync): BotWorkSummary[] {
  return db.prepare(`WITH managers_now AS (${managers}), activity AS (${activities(false)})
    SELECT m.id,m.name,m.sessionId,
      count(a.id) FILTER (WHERE a.activity='working' AND instr(a.goal,?)!=1) AS working,
      count(a.id) FILTER (WHERE a.activity='attention') AS attention,
      count(a.id) FILTER (WHERE a.activity='review' AND instr(a.goal,?)!=1) AS review
    FROM managers_now m LEFT JOIN activity a ON a.botId=m.id GROUP BY m.id ORDER BY m.createdAt,m.id`)
    .all(TEST_TASK_PREFIX, TEST_TASK_PREFIX) as unknown as BotWorkSummary[];
}

export function inboxActivity(db: DatabaseSync, botId: string) {
  const rows = db.prepare(`WITH managers_now AS (${managers}) ${activities(true)}`).all(botId);
  const byTask = new Map<string, WorkActivity | null>();
  let reviewTotal = 0;
  for (const row of rows) {
    byTask.set(String(row.id), row.activity as WorkActivity | null);
    if (row.activity === 'review' && !String(row.goal).startsWith(TEST_TASK_PREFIX)) reviewTotal++;
  }
  return { byTask, reviewTotal };
}
