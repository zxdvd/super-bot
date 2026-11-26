import type { DatabaseSync } from 'node:sqlite';
import type { ChatDeliveryStatus, DeliveryArtifacts, Result, Task, WorkReport } from '../model.ts';

export const DELIVERY_RETRIES_EXHAUSTED =
  '成果补交付已达到 3 次上限，已停止自动唤醒。请在 Bot 对话或工作面板核对成果；未重新执行 Worker。';

type DeliveryNotice = {
  chatDelivery?: { messageId?: string };
  deferReason?: string;
  deliveryUncertainReason?: string;
  deliveryRetryExhausted?: boolean;
  legacyDelivery?: { explicit?: boolean };
  reconcileNote?: string;
};

type DeliveryReceipt = {
  resultId: string;
  runId: string;
  eventId: string;
  deliveredAt: number;
  deliveryText?: string;
  linksJson: string;
  primaryLink?: string;
};

export type ManagerProblem = { message: string; at: number; eventId?: string };

export function readManagerProblem(db: DatabaseSync, botId: string): ManagerProblem | null {
  const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(`managerProblem:${botId}`);
  return row ? (JSON.parse(String(row.value)) as ManagerProblem) : null;
}

export function deliveryUncertainReason(payload: DeliveryNotice, diagnostic?: string): string {
  return (
    payload.deliveryUncertainReason ??
    diagnostic ??
    (payload.deliveryRetryExhausted ? DELIVERY_RETRIES_EXHAUSTED : undefined) ??
    (payload.legacyDelivery?.explicit
      ? '历史交付工具有回包，尚缺原聊天中的可核对回复。'
      : undefined) ??
    payload.reconcileNote ??
    '账本未能确认这份成果已在原聊天交付。'
  );
}

export function readReportedDeliveryArtifacts(db: DatabaseSync, runId: string): DeliveryArtifacts {
  const row = db.prepare("SELECT data FROM reports WHERE runId=? AND kind='ready'").get(runId);
  const { links, primaryLink } = row ? (JSON.parse(String(row.data)) as WorkReport) : {};
  return { links: links ?? {}, ...(primaryLink ? { primaryLink } : {}) };
}

export function readDeliveryReceipt(
  db: DatabaseSync,
  task: Pick<Task, 'id' | 'botId'>,
  resultId?: string,
): DeliveryReceipt | null {
  const row = db
    .prepare(`SELECT r.id AS resultId,r.runId,o.id AS eventId,e.createdAt AS deliveredAt,
      json_extract(o.payload,'$.deliveryText') AS deliveryText,
      coalesce(json_extract(o.payload,'$.links'),json_extract(p.data,'$.links')) AS links,
      CASE WHEN json_type(o.payload,'$.links') IS NOT NULL OR json_type(o.payload,'$.primaryLink') IS NOT NULL
        THEN json_extract(o.payload,'$.primaryLink') ELSE json_extract(p.data,'$.primaryLink') END AS primaryLink
    FROM events e JOIN outbox o ON o.id=json_extract(e.data,'$.eventId') AND o.taskId=e.taskId
    JOIN results r ON r.taskId=e.taskId AND r.id=json_extract(e.data,'$.resultId')
    LEFT JOIN reports p ON p.runId=r.runId AND p.kind='ready'
    WHERE e.taskId=? AND e.kind='manager.delivered' AND coalesce(json_extract(e.data,'$.explicit'),0)=0
      AND o.id='manager-event:delivery:' || r.id AND o.kind='manager.notify' AND o.state='done'
      AND json_extract(o.payload,'$.botId')=? AND json_extract(o.payload,'$.resultId')=r.id
      AND json_extract(o.payload,'$.taskRevision')=r.taskRevision
      AND json_extract(o.payload,'$.chatDelivery.messageId') IS NOT NULL AND (? IS NULL OR r.id=?)
    ORDER BY e.id DESC LIMIT 1`)
    .get(task.id, task.botId, resultId ?? null, resultId ?? null);
  if (!row) return null;
  return {
    resultId: String(row.resultId),
    runId: String(row.runId),
    eventId: String(row.eventId),
    deliveredAt: Number(row.deliveredAt),
    deliveryText: typeof row.deliveryText === 'string' ? row.deliveryText : undefined,
    linksJson: typeof row.links === 'string' ? row.links : '{}',
    primaryLink: typeof row.primaryLink === 'string' ? row.primaryLink : undefined,
  };
}

export function readChatDeliveryIds(
  db: DatabaseSync,
  botId: string,
  sessionId: string,
  turn: number,
  endSeq: number,
  messageId?: string,
): { taskId: string; resultId: string }[] {
  const rows = db
    .prepare(`SELECT e.taskId,json_extract(e.data,'$.resultId') AS resultId
    FROM events e JOIN tasks t ON t.id=e.taskId
    WHERE e.kind='manager.delivered' AND json_type(e.data,'$.resultId')='text'
      AND json_extract(e.data,'$.sessionId')=? AND json_extract(e.data,'$.turn')=? AND json_extract(e.data,'$.endSeq')=?
      AND coalesce(json_extract(e.data,'$.explicit'),0)=0 AND t.botId=?
      AND (? IS NULL OR json_extract(e.data,'$.messageId')=?) ORDER BY e.id`)
    .all(sessionId, turn, endSeq, botId, messageId ?? null, messageId ?? null);
  return rows.map((row) => ({ taskId: String(row.taskId), resultId: String(row.resultId) }));
}

export function readChatDeliveryStatus(
  db: DatabaseSync,
  task: Task,
  result: Result | null,
  historical: boolean,
): ChatDeliveryStatus | null {
  if (
    !result ||
    result.taskId !== task.id ||
    (!historical && !['review', 'completed'].includes(task.lifecycle))
  )
    return null;
  const eventId = `manager-event:delivery:${result.id}`;
  const row = db
    .prepare(`SELECT state,payload FROM outbox WHERE id=? AND kind='manager.notify' AND taskId=?
    AND json_extract(payload,'$.botId')=? AND json_extract(payload,'$.taskRevision')=?`)
    .get(eventId, task.id, task.botId, historical ? result.taskRevision : task.taskRevision);
  if (!row)
    return historical
      ? null
      : {
          state:
            task.lifecycle === 'review' && !task.managerReviewed ? 'awaiting-review' : 'uncertain',
        };

  const payload = JSON.parse(String(row.payload)) as DeliveryNotice;
  if (row.state === 'done' && payload.chatDelivery?.messageId) return { state: 'delivered' };
  const problem = readManagerProblem(db, task.botId);
  const diagnostic = problem?.eventId === eventId ? problem.message : undefined;
  const pending = ['pending', 'sending', 'entered'].includes(String(row.state));
  const handled = row.state === 'handled';
  const reason =
    row.state === 'unknown' || handled
      ? deliveryUncertainReason(payload, diagnostic)
      : pending
        ? (payload.deferReason ?? diagnostic)
        : (diagnostic ?? payload.reconcileNote ?? payload.deferReason);
  return {
    state: handled ? 'handled' : pending ? 'pending' : 'uncertain',
    ...(reason ? { reason } : {}),
  };
}
