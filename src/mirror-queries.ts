import { AppError, settledRunOutcome, type Result, type Task } from './model.ts';
import type { MirrorQuery } from './mirror-host.ts';
import type { MirrorDetail, MirrorEvent, ResultRecord } from './mirror.ts';
import type { Store } from './store.ts';

// Keep the wire projection explicit. The local queries can include Bot context, native session IDs and paths.
function taskRecord(task: Task, detail: boolean): Task {
  const {
    id,
    botId,
    goal,
    scope,
    acceptance,
    reviewPolicy,
    lifecycle,
    controlMode,
    taskRevision,
    rowVersion,
    createdAt,
    updatedAt,
    status,
    activity,
    stageState,
    managerReviewed,
    blockingAttention,
    lastRunOutcome,
    deliveredAt,
    botConfigRevision,
  } = task;
  return {
    id,
    botId,
    goal,
    scope: detail ? scope : '',
    acceptance: detail ? acceptance : '',
    reviewPolicy,
    lifecycle,
    controlMode,
    taskRevision,
    rowVersion,
    sessionId: null,
    createdAt,
    updatedAt,
    status,
    managerReviewed,
    blockingAttention,
    ...(lastRunOutcome ? { lastRunOutcome } : {}),
    ...(activity !== undefined ? { activity, ...(stageState ? { stageState } : {}) } : {}),
    ...(task.waitingForPrerequisite && { waitingForPrerequisite: true }),
    deliveredAt,
    botConfigRevision,
  };
}

function resultRecord({
  id,
  runId,
  taskRevision,
  summary,
  checks,
  createdAt,
  humanAcceptedAt,
  evidence,
}: Result): ResultRecord {
  return {
    id,
    runId,
    taskRevision,
    summary,
    checks,
    createdAt,
    humanAcceptedAt,
    fileCount: evidence.length,
  };
}

function auditRecord({ id, kind, createdAt, data }: MirrorEvent): MirrorEvent {
  const event = { id, kind, createdAt, data: '{}' };
  if (
    ['run.recovery-check-started', 'run.recovery-observed', 'run.recovery-confirmed'].includes(kind)
  ) {
    const { actor, result } = JSON.parse(data) as {
      actor?: unknown;
      result?: { status?: unknown; observed?: { ready?: unknown } };
    };
    const status = result?.observed?.ready === false ? 'not-ready' : result?.status;
    const outcome =
      typeof status === 'string' &&
      ['readable', 'allowed', 'denied', 'present', 'missing', 'unavailable', 'not-ready'].includes(
        status,
      )
        ? status
        : undefined;
    return {
      ...event,
      data: JSON.stringify({
        actor: actor === 'manager' || actor === 'user' ? actor : undefined,
        outcome,
      }),
    };
  }
  if (!['work.report', 'manager.delivered', 'approval.decided', 'run.settled'].includes(kind))
    return event;
  const fields = JSON.parse(data) as Record<string, unknown>;
  if (kind === 'run.settled') {
    const outcome = settledRunOutcome(fields.kind);
    return outcome ? { ...event, data: JSON.stringify({ kind: outcome }) } : event;
  }
  if (
    kind === 'work.report' &&
    typeof fields.kind === 'string' &&
    typeof fields.summary === 'string'
  ) {
    return {
      ...event,
      report: {
        kind: fields.kind,
        summary: fields.summary,
        runId: typeof fields.runId === 'string' ? fields.runId : null,
      },
    };
  }
  if (kind === 'approval.decided' && typeof fields.outcome === 'string') {
    return { ...event, data: JSON.stringify({ outcome: fields.outcome }) };
  }
  if (kind === 'manager.delivered') {
    return {
      ...event,
      data: JSON.stringify({
        explicit: fields.explicit === true,
        ...(typeof fields.resultId === 'string' ? { resultId: fields.resultId } : {}),
      }),
    };
  }
  return event;
}

export function readLocalMirror(store: Store, query: MirrorQuery) {
  if (query.op === 'catalog') return store.listBots().map(({ id, name }) => ({ id, name }));
  if (query.op === 'session-origin') return store.ownsManagedSession(query.sessionId);
  if (query.op === 'tasks') {
    const page = store.listTasks(query);
    return { ...page, items: page.items.map((task) => taskRecord(task, false)) };
  }
  store.getBot(query.botId);
  const task = store.getTask(query.id);
  if (task.botId !== query.botId) throw new AppError('not-found', '任务不属于此 Bot。');
  const detail = store.taskDetail(task.id),
    run = detail.run;
  const { result, deliveredResult } = detail,
    { reload, ...progress } = detail.progress;
  return {
    task: taskRecord(detail.task, true),
    records: store.taskResultRecords(task.id),
    events: detail.events.map(auditRecord),
    chatDelivery: detail.chatDelivery?.state ?? null,
    progress: { ...progress, reload: reload && { build: reload.build, at: reload.at } },
    run: run && {
      id: run.id,
      state: run.state,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      ...(run.outcome ? { outcome: run.outcome } : {}),
    },
    result: result && resultRecord(result),
    deliveredResult: deliveredResult && {
      ...resultRecord(deliveredResult),
      deliveredAt: deliveredResult.deliveredAt,
      deliveryText: deliveredResult.deliveryText,
      links: deliveredResult.links,
      ...(deliveredResult.primaryLink ? { primaryLink: deliveredResult.primaryLink } : {}),
    },
  } satisfies MirrorDetail;
}
