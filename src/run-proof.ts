/** Verify a Run's exact native input and turn against the durable Session prefix. */
import { AppError, type Run, type RunInput, type RunTurn } from './model.ts';
export interface RunEvent {
  seq: number;
  type: string;
  surfaceOp?: unknown;
  data: any;
}
export function verifyRunTurn(
  run: Run,
  input: RunInput,
  proof: RunTurn,
  events: readonly RunEvent[],
  forReadback = false,
): string[] {
  if (proof.quiet !== 1) refuse('缺少原执行进程记录的轮次归属或后台收敛证据，保留占用；不会重投。');
  verifyRunBoundary(run, input, proof, events);
  if (
    proof.endKind !== 'completed' &&
    !(run.state === 'cancelling' && proof.endKind === 'aborted') &&
    !(forReadback && run.state === 'cancelled' && proof.endKind === 'aborted') &&
    !(forReadback && run.state === 'interrupted' && proof.endKind === 'error')
  )
    refuse('自动轮次非正常结束，请核对；没有补成功。');
  return events
    .slice(proof.endSeq! + 1)
    .filter(
      (e) =>
        e.type === 'user/message' && e.data.source?.kind === 'user' && 'rpcId' in e.data.source,
    )
    .map((e) => e.data.id);
}

function refuse(note: string): never {
  throw new AppError('run-proof', note);
}

export function verifyUnobservedRunEnd(
  run: Run,
  input: RunInput,
  proof: RunTurn,
  events: readonly RunEvent[],
): { endSeq: number; endKind: string } {
  if (proof.inputSeq === null || proof.endSeq !== null) refuse('缺少可读回的原轮坐标，保留占用。');
  const end = events
    .slice(proof.inputSeq + 1)
    .find((event) => event.type === 'turn/end' || event.type === 'turn/start');
  const endKind = end?.data.reason?.kind;
  // A synthetic interrupted or forked closer does not attest that the original turn ended.
  if (end?.type !== 'turn/end' || !['completed', 'error', 'aborted'].includes(endKind))
    refuse('缺少持久保存的原轮结束事件，保留占用。');
  const observed = { endSeq: end.seq, endKind };
  verifyRunBoundary(run, input, { ...proof, ...observed }, events);
  const jobs = new Map<string, RunEvent>();
  const approvals = new Set<string>();
  for (const event of events.slice(proof.startSeq! + 1)) {
    if (event.type === 'approval/asked') approvals.add(event.data.id);
    if (event.type === 'approval/decided') approvals.delete(event.data.id);
    if (event.type === 'job/registered' && event.data.owner === run.sessionId)
      jobs.set(event.data.jobId, event);
    if (event.type === 'job/settled' && matchesJobSettlement(jobs.get(event.data.jobId), event))
      jobs.delete(event.data.jobId);
  }
  const job = jobs.keys().next().value;
  if (job) throw new AppError('job-unknown', `原生作业 ${job} 缺少生产者的终态回执，保留占用。`);
  if (approvals.size) throw new AppError('recovery-pending', '原生审批尚无决定回执，保留占用。');
  return observed;
}

export function matchesJobSettlement(registered: RunEvent | undefined, settled: RunEvent) {
  const original = registered?.data,
    terminal = settled.data;
  return (
    !!original &&
    registered.seq < settled.seq &&
    terminal.jobId === original.jobId &&
    terminal.owner === original.owner &&
    terminal.startedAt === original.startedAt &&
    terminal.kind === original.kind &&
    terminal.label === original.label &&
    terminal.toolCall?.callId === original.toolCall?.callId &&
    terminal.toolCall?.rootCallId === original.toolCall?.rootCallId &&
    ['completed', 'failed', 'killed'].includes(terminal.status) &&
    terminal.producerReported === true
  );
}

export function verifyRunBoundary(
  run: Run,
  input: RunInput,
  proof: RunTurn,
  events: readonly RunEvent[],
): void {
  if (
    proof.turn === null ||
    proof.startSeq === null ||
    proof.inputSeq === null ||
    proof.endSeq === null
  )
    refuse('缺少原执行进程记录的轮次归属，保留占用。');
  if (
    proof.runId !== run.id ||
    input.id !== run.inputId ||
    !(proof.startSeq! < proof.inputSeq! && proof.inputSeq! < proof.endSeq!)
  )
    refuse('Run 证据身份或坐标顺序无效。');
  if (events.some((e, i) => e.seq !== i)) refuse('持久会话日志不是完整连续前缀，请人工核对。');
  const start = events[proof.startSeq!],
    entered = events[proof.inputSeq!],
    end = events[proof.endSeq!];
  if (start?.type !== 'turn/start' || start.data.turn !== proof.turn)
    refuse('持久轮次开始与 Run 归属不符。');
  const source = entered?.data.source;
  if (
    entered?.type !== 'user/message' ||
    entered.surfaceOp !== 'append' ||
    entered.data.id !== input.messageId ||
    source?.kind !== 'super-bot' ||
    source.runId !== run.id ||
    source.inputId !== run.inputId ||
    source.taskId !== run.taskId ||
    source.generation !== run.generation ||
    source.taskRevision !== run.taskRevision
  )
    refuse('持久自动输入身份与 Run 不符，不能补结算。');
  if (
    end?.type !== 'turn/end' ||
    end.data.turn !== proof.turn ||
    end.data.reason.kind !== proof.endKind
  )
    refuse('缺少匹配且持久保存的自动轮次结束事件，保留占用。');
  if (
    events
      .slice(proof.startSeq! + 1, proof.endSeq!)
      .some((e) => e.type === 'turn/start' || e.type === 'turn/end')
  )
    refuse('自动输入和结束事件不属于同一轮次。');
  if (
    events.filter(
      (e) =>
        e.type === 'user/message' &&
        e.data.source?.kind === 'super-bot' &&
        e.data.source.runId === run.id,
    ).length !== 1
  )
    refuse('自动输入存在重复或不明确的持久身份。');
}
