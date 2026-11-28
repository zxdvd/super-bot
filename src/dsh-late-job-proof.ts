import { AppError, type LateJobProof, type Run, type RunInput, type RunTurn } from './model.ts';
import { matchesJobSettlement, verifyRunBoundary, type RunEvent } from './run-proof.ts';

const mismatch = (message: string): never => {
  throw new AppError('late-job-unproven', message);
};
const nativeContext = (source: { kind?: string; form?: string } = {}) =>
  ((source.kind === 'runtime-context' || source.kind === 'time-context') &&
    source.form === 'snapshot') ||
  (source.kind === 'skill-catalog' && source.form === 'catalog');

/** DSH's native notice source carries the Job ID in the first line (rc.1 and rc.5).
 * A short notice pointing to job_output leaves output unconsumed. */
function inlineJobNotice(data: RunEvent['data']) {
  const { source, content } = data;
  if (
    source?.kind !== 'tool-jobs' ||
    source.form !== 'notice' ||
    content?.length !== 1 ||
    content[0]?.type !== 'text' ||
    typeof content[0].text !== 'string'
  )
    return;
  const match =
    /^background job ([a-z0-9_-]+) \([^\n]*\) finished \[status: (completed|failed|killed)(?:, [^\]\n]*)?\]\.(?: No new output\.$| Output:\n)/.exec(
      content[0].text,
    );
  if (match) return { id: match[1]!, status: match[2]! };
}

/** Verify all original Job identities and the later native turns that consumed their results. */
export function verifyLateJobs(
  run: Run,
  input: RunInput,
  turn: RunTurn,
  ids: readonly string[],
  events: readonly RunEvent[],
): LateJobProof | null {
  if (
    turn.quiet !== 0 ||
    !['completed', 'aborted', 'error'].includes(turn.endKind ?? '') ||
    !ids.length ||
    new Set(ids).size !== ids.length
  ) {
    mismatch('旧轮的后台占用没有可归属的原始回执。');
  }
  verifyRunBoundary(run, input, turn, events);
  const registered = new Map<string, RunEvent>();
  const settled = new Map<string, RunEvent>();
  const notices = new Map<string, { seq: number; endSeq?: number }>();
  const expected = new Set(ids);
  const submitted = new Map<string, string>();
  const inboxes = { 'next-turn': [] as string[], 'next-step': [] as string[] };
  const priorCalls = new Set<string>();
  let lastTurn = turn.turn!;
  let consumption: { turn: number; notices: string[]; responded: boolean } | undefined;
  for (const event of events) {
    if (
      event.type === 'tool/call' &&
      event.seq > turn.inputSeq! &&
      event.seq < turn.endSeq! &&
      event.data.turn === turn.turn
    ) {
      priorCalls.add(event.data.callId);
    }
    if (event.type === 'job/registered' && event.seq > turn.inputSeq!) {
      const id = event.data.jobId;
      if (
        event.seq > turn.endSeq! ||
        registered.has(id) ||
        event.data.owner !== run.sessionId ||
        !priorCalls.has(event.data.toolCall?.rootCallId)
      ) {
        mismatch('旧轮结束前后出现了无法归属的后台 Job。');
      }
      registered.set(id, event);
    }
    if (event.type === 'job/settled' && event.seq > turn.inputSeq!) {
      const id = event.data.jobId;
      const original = registered.get(id);
      if (
        settled.has(id) ||
        !matchesJobSettlement(original, event) ||
        expected.has(id) !== event.seq > turn.endSeq!
      ) {
        mismatch('后台 Job 的终态没有匹配的原生生产者回执。');
      }
      settled.set(id, event);
      continue;
    }
    if (event.seq <= turn.endSeq!) continue;
    // DSH appends this marker on ordinary Session reopen while retaining the same Session identity.
    if (
      event.type === 'session/end-seed' &&
      !consumption &&
      event.data.inherited === undefined &&
      event.surfaceOp === undefined
    )
      continue;
    if (event.type === 'agent/inbox/spliced') {
      const { target, start, inserted, removedCount = 0 } = event.data;
      const queue =
        typeof target === 'string' && Object.hasOwn(inboxes, target)
          ? inboxes[target as keyof typeof inboxes]
          : null;
      if (
        !queue ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(removedCount) ||
        start < 0 ||
        removedCount < 0 ||
        start + removedCount > queue.length ||
        !Array.isArray(inserted)
      ) {
        return mismatch('原生通知队列包含无法核对的旧输入。');
      }
      const messageIds = inserted.map((item) => {
        const notice = inlineJobNotice(item);
        if (
          !notice ||
          !expected.has(notice.id) ||
          settled.get(notice.id)?.data.status !== notice.status ||
          typeof item.id !== 'string' ||
          submitted.has(item.id)
        ) {
          return mismatch('Job 通知等待队列仍有未消费或无法归属的输入。');
        }
        submitted.set(item.id, JSON.stringify(item));
        return item.id as string;
      });
      queue.splice(start, removedCount, ...messageIds);
    } else if (
      event.type === 'turn/start' &&
      !consumption &&
      Number.isSafeInteger(event.data.turn) &&
      event.data.turn > lastTurn
    ) {
      lastTurn = event.data.turn;
      consumption = { turn: event.data.turn, notices: [], responded: false };
    } else if (event.type === 'turn/end' && consumption && event.data.turn === consumption.turn) {
      if (
        event.data.reason.kind !== 'completed' ||
        !consumption.notices.length ||
        !consumption.responded
      ) {
        mismatch('原生 Job 通知轮未正常消费结果，保留旧轮占用。');
      }
      for (const id of consumption.notices) notices.get(id)!.endSeq = event.seq;
      consumption = undefined;
    } else if (event.type === 'user/message' && consumption) {
      if (nativeContext(event.data.source)) continue;
      const notice = inlineJobNotice(event.data);
      if (
        !notice ||
        event.surfaceOp !== 'append' ||
        submitted.get(event.data.id) !== JSON.stringify(event.data) ||
        !expected.has(notice.id) ||
        notices.has(notice.id) ||
        settled.get(notice.id)?.data.status !== notice.status
      ) {
        return mismatch('Job 结果通知还未内联消费，或通知轮混有其他输入。请核对原 Worker 会话。');
      }
      notices.set(notice.id, { seq: event.seq });
      consumption.notices.push(notice.id);
      consumption.responded = false;
    } else if (
      event.type === 'assistant/message' &&
      consumption &&
      event.data.turn === consumption.turn &&
      consumption.notices.length &&
      !event.data.interrupted &&
      event.data.message?.content?.every((part: { type: string }) =>
        ['text', 'reasoning'].includes(part.type),
      )
    ) {
      consumption.responded = true;
    } else if (
      consumption &&
      [
        'request/header',
        'request/context',
        'step/start',
        'step/end',
        'system/message',
        'developer/message',
      ].includes(event.type) &&
      (event.data.turn === undefined || event.data.turn === consumption.turn)
    ) {
      continue;
    } else {
      mismatch('旧轮之后存在其他原生会话活动，待核对后再接续。');
    }
  }
  if (
    ids.some((id) => !registered.has(id)) ||
    [...registered.keys()].some((id) => !expected.has(id) && !settled.has(id))
  ) {
    mismatch('旧轮登记的 Job 与当时保留的占用不一致。');
  }
  if (
    consumption ||
    Object.values(inboxes).some((queue) => queue.length) ||
    ids.some((id) => !notices.get(id)?.endSeq)
  )
    return null;
  const jobs = ids.map((id) => ({
    id,
    registeredSeq: registered.get(id)!.seq,
    settledSeq: settled.get(id)!.seq,
    noticeSeq: notices.get(id)!.seq,
    consumedEndSeq: notices.get(id)!.endSeq!,
  }));
  return { jobs, lastSeq: Math.max(...jobs.map((job) => job.consumedEndSeq)) };
}

export function verifyLateJobScope(events: readonly RunEvent[], turn: RunTurn): void {
  const original = events.slice(turn.inputSeq! + 1, turn.endSeq!);
  if (
    original.some(
      (event) =>
        ['working-directory/change', 'approval/asked'].includes(event.type) ||
        (event.type === 'user/message' && !nativeContext(event.data.source)),
    )
  ) {
    mismatch('旧轮包含其他输入、目录变更或原生审批，无法沿用原授权。');
  }
}
