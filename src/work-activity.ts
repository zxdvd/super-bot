import type { DatabaseSync } from 'node:sqlite';
import { TEST_TASK_PREFIX, type WorkActivity, type BotWorkSummary } from './model.ts';

// Only the current manager owns sidebar/session decorations. An unattended task without
// a live run or a durable automatic next step belongs in the waiting group.
const managers = `SELECT b.id, b.name, b.createdAt, m.sessionId FROM bots b
  LEFT JOIN managers m ON m.botId=b.id AND m.state='ready' AND m.configRevision=b.configRevision
    AND m.sessionId=b.managerSessionId AND m.requestedSessionId=m.sessionId`;

function activities(scoped: boolean) {
  return `SELECT t.id, t.botId, t.goal, CASE
    WHEN t.lifecycle='completed' AND res.humanAcceptedAt IS NULL THEN
      CASE WHEN delivery.state IN ('blocked','unknown') THEN 'attention'
        WHEN m.sessionId IS NOT NULL THEN 'working' END
    WHEN EXISTS (SELECT 1 FROM attentions a WHERE a.taskId=t.id AND a.taskRevision=t.taskRevision
      AND a.state='open' AND a.kind IN ('input','approval','recovery')) THEN 'attention'
    WHEN EXISTS (SELECT 1 FROM runs r WHERE r.taskId=t.id AND r.finishedAt IS NULL
      AND r.state IN ('queued','running','cancelling')) THEN 'working'
    WHEN t.lifecycle='review' AND delivery.state IN ('pending','sending','entered') AND m.sessionId IS NOT NULL THEN 'working'
    WHEN t.lifecycle='review' AND delivery.id IS NOT NULL THEN 'attention'
    WHEN t.id IN (SELECT taskId FROM outbox WHERE kind='manager.notify' AND (state='blocked' OR
      (state='unknown' AND coalesce(json_extract(payload,'$.reconcileAttempts'),0)>=3))) THEN 'attention'
    WHEN t.controlMode='auto' AND m.sessionId IS NOT NULL AND t.id IN
      (SELECT taskId FROM outbox WHERE kind='manager.notify' AND state IN ('pending','sending','entered')) THEN 'working'
    WHEN t.lifecycle='review' THEN 'attention'
    END AS activity
    FROM tasks t JOIN managers_now m ON t.botId=m.id
    LEFT JOIN results res ON t.lifecycle IN ('review','completed') AND res.taskRevision=t.taskRevision AND res.runId=(
      SELECT id FROM runs WHERE taskId=t.id ORDER BY createdAt DESC,rowid DESC LIMIT 1)
    LEFT JOIN outbox delivery ON delivery.id='manager-event:delivery:' || res.id
    WHERE (t.lifecycle IN ('open','review') OR (t.lifecycle='completed' AND t.id IN
      (SELECT taskId FROM outbox WHERE kind='manager.notify' AND state IN ('pending','sending','entered','blocked','unknown')
        AND json_extract(payload,'$.deliveryOnly')=1) AND res.humanAcceptedAt IS NULL AND delivery.state IN ('pending','sending','entered','blocked','unknown'))) ${scoped ? 'AND t.botId=?' : ''}`;
}

export function botWorkSummaries(db: DatabaseSync): BotWorkSummary[] {
  return db.prepare(`WITH managers_now AS (${managers}), activity AS (${activities(false)})
    SELECT m.id,m.name,m.sessionId,
      count(a.id) FILTER (WHERE a.activity='working' AND instr(a.goal,?)!=1) AS working,
      count(a.id) FILTER (WHERE a.activity='attention') AS attention
    FROM managers_now m LEFT JOIN activity a ON a.botId=m.id GROUP BY m.id ORDER BY m.createdAt,m.id`)
    .all(TEST_TASK_PREFIX) as unknown as BotWorkSummary[];
}

export function inboxActivity(db: DatabaseSync, botId: string) {
  const rows = db.prepare(`WITH managers_now AS (${managers}) ${activities(true)}`).all(botId);
  return new Map(rows.map(row => [String(row.id), row.activity as WorkActivity | null]));
}
