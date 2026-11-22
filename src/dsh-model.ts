/** Read native model selections and attribute request evidence without opening an Agent. */
import type { Context } from '@deepseek-ai/cordis';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type { Session, SessionEvent, SessionStore } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-session-projection';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import type { ActualModelRequest, ModelRoute, Run, RunInput, RunTurn, WorkerModelPlan } from './model.ts';

export function modelRoute(model: ModelSelection | ModelRoute): ModelRoute {
  return { provider: model.provider, model: model.model, reasoningEffort: model.reasoningEffort ?? null };
}

export function workerModelPlan(current: ModelRoute | null, override?: ModelSelection,
  manager?: { sessionId: string; model: ModelRoute | null }): WorkerModelPlan | null {
  if (override) return { ...modelRoute(override), source: 'role-override' };
  if (current) return { ...current, source: 'native-selection' };
  return manager?.model ? { ...manager.model, source: 'manager-inheritance', sourceSessionId: manager.sessionId } : null;
}

export function nativeModel(ctx: Context, session: Session) {
  return ctx.sessionProjections.snapshot(session, ['modelSelection']).values.modelSelection?.next ?? undefined;
}

export async function observeNativeModel(ctx: Context, id: string, session?: Session): Promise<ModelRoute | null> {
  try {
    const sessionId = SessionId(id);
    // The Web client also augments Context.sessions; this adapter runs on the Host.
    const live = session ?? (ctx.sessions as unknown as SessionStore | undefined)?.get?.(sessionId);
    if (live?.id === id) {
      const chosen = nativeModel(ctx, live);
      return chosen ? modelRoute(chosen) : null;
    }
    // Cold preparation is read-only and reused by DSH while the persistence revision matches.
    const snapshot = await ctx.sessionController.projections?.({ sessionId }, AbortSignal.timeout(5000));
    const chosen = snapshot?.kind === 'sequenced' ? snapshot.values.modelSelection?.next : null;
    return chosen ? modelRoute(chosen) : null;
  } catch { return null; }
}

type NativeLog = { events: readonly SessionEvent[]; ownStart: number };

export async function readModelLog(ctx: Context, id: string): Promise<NativeLog | undefined> {
  try {
    const signal = AbortSignal.timeout(5000);
    const handle = await ctx.sessionPersistence.open(SessionId(id), 'read', { signal });
    try {
      if (handle.header.id !== id) return;
      const { events } = await handle.read(0, undefined, { signal });
      if (events.some((event, index) => event.seq !== index)) return;
      const ownStart = handle.inheritedEventCount;
      if (!Number.isSafeInteger(ownStart) || ownStart < 0 || ownStart > events.length) return;
      return { events, ownStart };
    } finally { await handle.close(); }
  } catch { /* Unavailable, corrupt or incompatible logs leave model evidence unknown. */ }
}

function matchesInput(event: SessionEvent<'user/message'>, run: Run, input: RunInput): boolean {
  const source = event.data.source;
  return event.surfaceOp === 'append' && event.data.id === input.messageId && source.kind === 'super-bot' &&
    source.runId === run.id && source.taskId === run.taskId && source.inputId === run.inputId &&
    source.taskRevision === run.taskRevision && source.generation === run.generation;
}

function provesResponse(event: SessionEvent<'assistant/attempt'>): boolean {
  // The native stream can start then emit a local credential/adapter error.
  return event.data.stream.some(record => {
    if (record.type === 'tool-call-chunks') return true;
    if (record.type !== 'chunk') return record.texts.some(text => text.length > 0);
    const { chunk } = record;
    return chunk.type === 'usage' || (chunk.type === 'finish' && chunk.reason.kind === 'error' && !!chunk.reason.failure.requestId);
  });
}

export function actualModelRequests(log: NativeLog | undefined, run: Run, input: RunInput,
  proof: RunTurn | null): ActualModelRequest[] {
  if (!log || !input.messageId || input.id !== run.inputId || input.taskId !== run.taskId) return [];
  const { events, ownStart } = log;
  let exactInput: number | undefined;
  for (let i = ownStart; i < events.length; i++) {
    const event = events[i]!;
    if (event.type !== 'user/message' || event.data.source.kind !== 'super-bot' || event.data.source.runId !== run.id) continue;
    if (exactInput !== undefined || !matchesInput(event, run, input)) return [];
    exactInput = i;
  }
  if (exactInput === undefined || (proof?.inputSeq != null && proof.inputSeq !== exactInput)) return [];

  let turn: SessionEvent<'turn/start'> | undefined;
  let step: number | undefined;
  let activeRunInput = false;
  let inputSeen = false;
  let baseline: SessionEvent<'request/header'> | undefined;
  const requests: ActualModelRequest[] = [];
  for (let i = ownStart; i < events.length; i++) {
    const event = events[i]!;
    if (event.type === 'turn/start') {
      if (inputSeen) return []; // Another turn without a matching close is ambiguous.
      turn = event;
      step = undefined;
      activeRunInput = false;
    } else if (event.type === 'turn/end') {
      if (inputSeen) {
        if (event.data.turn !== turn?.data.turn || (proof?.endSeq != null && proof.endSeq !== i) ||
          (proof?.endKind != null && proof.endKind !== event.data.reason.kind)) return [];
        return requests;
      }
      turn = undefined;
      step = undefined;
    } else if (event.type === 'step/start' && event.data.turn === turn?.data.turn) {
      step = event.data.step;
    } else if (event.type === 'step/end' && event.data.turn === turn?.data.turn) {
      step = undefined;
    } else if (event.type === 'request/header') {
      baseline = event;
    } else if (i === exactInput) {
      if (!turn || step === undefined || activeRunInput || (proof?.turn != null && proof.turn !== turn.data.turn) ||
        (proof?.startSeq != null && proof.startSeq !== turn.seq)) return [];
      inputSeen = true;
    } else if (event.type === 'user/message' && event.data.source.kind === 'super-bot' && event.surfaceOp === 'append') {
      if (inputSeen) return []; // Two automatic inputs in one native turn cannot share evidence.
      activeRunInput = true;
    } else if (inputSeen && (event.type === 'assistant/message' || event.type === 'assistant/attempt') &&
      event.data.turn === turn?.data.turn && event.data.step === step) {
      const config = baseline?.data.header.config;
      const source = event.type === 'assistant/message' ? event.data.message.source : provesResponse(event) ? config : undefined;
      if (!source || (event.type === 'assistant/message' && event.surfaceOp !== 'append')) continue;
      const { provider, model } = source;
      const matchingHeader = config?.provider === provider && config.model === model ? baseline : undefined;
      requests.push({ provider, model, reasoningEffort: matchingHeader?.data.header.config.reasoningEffort ?? null,
        turn: event.data.turn, step: event.data.step, eventSeq: event.seq, headerSeq: matchingHeader?.seq ?? null, evidence: event.type });
    }
  }
  // A live or interrupted durable prefix can still contain a proved request.
  return proof?.endSeq != null && proof.endSeq < events.length ? [] : requests;
}
