import { AppError, type Task } from './model.ts';
import type { MirrorQuery } from './mirror-host.ts';
import type { MirrorDetail, MirrorEvent } from './mirror.ts';
import type { Store } from './store.ts';

// Keep the wire projection explicit. The local queries can include Bot context, native session IDs and paths.
function taskRecord(task: Task, detail: boolean): Task {
  const { id, botId, goal, scope, acceptance, reviewPolicy, lifecycle, controlMode, taskRevision, rowVersion,
    createdAt, updatedAt, status, managerReviewed, blockingAttention, deliveredAt, botConfigRevision } = task;
  return { id, botId, goal, scope: detail ? scope : '', acceptance: detail ? acceptance : '', reviewPolicy, lifecycle,
    controlMode, taskRevision, rowVersion, sessionId: null, createdAt, updatedAt, status, managerReviewed, blockingAttention,
    deliveredAt, botConfigRevision };
}

function auditRecord({ id, kind, createdAt, data }: MirrorEvent): MirrorEvent {
  const event = { id, kind, createdAt, data: '{}' };
  if (kind !== 'work.report' && kind !== 'manager.delivered' && kind !== 'approval.decided') return event;
  const fields = JSON.parse(data) as Record<string, unknown>;
  if (kind === 'work.report' && typeof fields.kind === 'string' && typeof fields.summary === 'string') {
    return { ...event, report: { kind: fields.kind, summary: fields.summary,
      runId: typeof fields.runId === 'string' ? fields.runId : null } };
  }
  if (kind === 'approval.decided' && typeof fields.outcome === 'string') {
    return { ...event, data: JSON.stringify({ outcome: fields.outcome }) };
  }
  if (kind === 'manager.delivered') {
    return { ...event, data: JSON.stringify({ explicit: fields.explicit === true,
      ...(typeof fields.resultId === 'string' ? { resultId: fields.resultId } : {}) }) };
  }
  return event;
}

export function readLocalMirror(store: Store, query: MirrorQuery) {
  if (query.op === 'catalog') return store.listBots().map(({ id, name }) => ({ id, name }));
  if (query.op === 'session-origin') return store.ownsManagedSession(query.sessionId);
  if (query.op === 'tasks') {
    const page = store.listTasks(query);
    return { ...page, items: page.items.map(task => taskRecord(task, false)) };
  }
  const task = store.getTask(query.id);
  if (task.botId !== query.botId) throw new AppError('not-found', '任务不属于此 Bot。');
  const detail = store.taskDetail(task.id), run = detail.run;
  const result = detail.result, { reload, ...progress } = detail.progress;
  return {
    task: taskRecord(detail.task, true), records: store.taskResultRecords(task.id),
    events: detail.events.map(auditRecord), chatDelivery: detail.chatDelivery?.state ?? null,
    progress: { ...progress, reload: reload && { build: reload.build, at: reload.at } },
    run: run && { id: run.id, state: run.state, createdAt: run.createdAt, finishedAt: run.finishedAt },
    result: result && { id: result.id, runId: result.runId, taskRevision: result.taskRevision, summary: result.summary,
      checks: result.checks, createdAt: result.createdAt, humanAcceptedAt: result.humanAcceptedAt, fileCount: result.evidence.length },
  } satisfies MirrorDetail;
}
