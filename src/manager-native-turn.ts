import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ResolvedToolSet, ToolExecution } from '@deepseek-ai/dsh-tools';
import { isDeepStrictEqual } from 'node:util';
import { isFeishuSource, isNativeOwner } from './dsh-chat-events.ts';
import type { FeishuInput } from './feishu-inputs.ts';

type InputKind = 'host' | 'feishu';
type Position = { turn: number; step: number };
type Assembly = { signal: AbortSignal; toolSet: ResolvedToolSet };
type ToolCall = { name: string; token?: symbol };
type Step = Assembly & Position & {
  started: boolean;
  expected: readonly UserMessage[];
  cursor: number;
  calls: Map<string, ToolCall>;
  expanded: boolean;
};

function inputKind(message: UserMessage): InputKind | undefined {
  const { source } = message;
  if (isFeishuSource(source)) {
    if (typeof source.feishuMessageId === 'string' && source.feishuMessageId.length > 0 &&
        Object.keys(source).every(key => key === 'kind' || key === 'feishuMessageId')) return 'feishu';
    return;
  }
  // Both supported controllers publish these fields for a normal owner-transport or trusted local prompt.
  // This includes the ordinary in-process API. Retry, share and unrecognized source variants stay restricted.
  if (isNativeOwner(message) && 'rpcId' in source && typeof source.rpcId === 'string' && source.rpcId.length > 0 &&
      Object.keys(source).every(key => key === 'kind' || key === 'rpcId' || key === 'clientTimeZone') &&
      (!('clientTimeZone' in source) || typeof source.clientTimeZone === 'string')) return 'host';
}

function isRuntimeContext(message: UserMessage): boolean {
  const kind: string = message.source.kind;
  return kind === 'runtime-context';
}

function isHostContext(message: UserMessage): boolean {
  const kind: string = message.source.kind;
  // DSH adds these contexts in its pre-step waterfall after claiming inbox input.
  return isRuntimeContext(message) || kind === 'agent-instructions' || kind === 'time-context' || kind === 'skill-catalog';
}

/** Process-local evidence for one attached Manager; nothing is restored from its log. */
export class ManagerNativeTurn {
  private blockedInbox: Set<string>;
  private inserted = new WeakSet<UserMessage>();
  private claims: UserMessage[] = [];
  private turn?: number;
  private kind?: InputKind;
  private restricted = true;
  private turnSignal?: AbortSignal;
  private observedAbort = false;
  private stepNumber = 0;
  private assembly?: Assembly;
  private step?: Step;
  private feeds = new Map<AbortSignal, FeishuInput>();

  constructor(readonly agent: Agent, private readonly current: () => boolean) {
    this.blockedInbox = new Set();
    this.blockPending();
  }

  insert(message: UserMessage): void {
    if (!this.blockedInbox.has(message.id) && inputKind(message)) this.inserted.add(message);
  }

  discard(message: UserMessage): void {
    this.inserted.delete(message);
  }

  claim(turn: number, message: UserMessage): void {
    if (this.turn !== turn || this.restricted) return;
    if (!this.inserted.delete(message)) return this.restrict();
    this.claims.push(message);
  }

  assemble(signal: AbortSignal | undefined, toolSet: ResolvedToolSet | undefined): void {
    if (this.restricted || !signal || !toolSet) return;
    if (this.assembly) return this.restrict();
    this.assembly = { signal, toolSet };
  }

  prepare(turn: number, signal: AbortSignal): void {
    if (turn !== this.turn) return;
    if (this.turnSignal && this.turnSignal !== signal) return this.restrict();
    if (!this.turnSignal) {
      this.turnSignal = signal;
      if (signal.aborted) this.turnAborted();
      else signal.addEventListener('abort', this.turnAborted, { once: true });
    }
  }

  propose(position: Position, signal: AbortSignal, claimed: readonly UserMessage[], entered: readonly UserMessage[]): void {
    if (this.restricted || position.turn !== this.turn) return;
    const assembly = this.assembly;
    this.assembly = undefined;
    if (!assembly || assembly.signal !== signal || this.turnSignal !== signal || signal.aborted || this.step ||
        position.step !== this.stepNumber + 1 || this.claims.length !== claimed.length ||
        this.claims.some((message, i) => message !== claimed[i])) return this.restrict();
    this.claims = [];
    for (const message of claimed) {
      const kind = inputKind(message);
      if (!kind || (this.kind && this.kind !== kind)) return this.restrict();
      this.kind = kind;
    }
    if (!this.kind) return this.restrict();
    let consumed = 0;
    const ids = new Set<string>();
    for (const message of entered) {
      if (ids.has(message.id)) return this.restrict();
      ids.add(message.id);
      if (message === claimed[consumed]) consumed++;
      else if (!isHostContext(message)) return this.restrict();
    }
    if (consumed !== claimed.length || entered.filter(isRuntimeContext).length > 1) return this.restrict();
    this.step = {
      ...assembly, ...position, started: false, expected: entered, cursor: 0, calls: new Map(), expanded: false,
    };
  }

  observe(event: SessionEvent, feed?: FeishuInput): void {
    if (event.type === 'turn/start') {
      this.closeTurn();
      this.turn = event.data.turn;
      this.restricted = false;
      return;
    }
    if (event.type === 'turn/end') {
      if (event.data.reason.kind !== 'completed' && !this.observedAbort) this.blockPending();
      this.closeTurn();
      return;
    }
    if (this.restricted) return;
    const step = this.step;
    switch (event.type) {
      case 'step/start':
        if (!step || step.started || step.turn !== event.data.turn || step.step !== event.data.step) return this.restrict();
        step.started = true;
        this.stepNumber = step.step;
        return;
      case 'step/end':
        if (!step || step.turn !== event.data.turn || step.step !== event.data.step || !this.committed(step)) return this.restrict();
        if (step.expanded) step.toolSet.dispose();
        this.step = undefined;
        return;
      case 'user/message':
        if (!step?.started || event.surfaceOp !== 'append') return this.restrict();
        this.commit(step, event.data, feed);
        return;
      case 'tool/call':
        if (!step || step.turn !== event.data.turn || step.step !== event.data.step || !this.committed(step) ||
            step.calls.has(event.data.callId)) return this.restrict();
        step.calls.set(event.data.callId, { name: event.data.name });
    }
  }

  private commit(step: Step, message: UserMessage, feed?: FeishuInput): void {
    let expected = step.expected[step.cursor];
    // The loop replaces its proposed runtime snapshot at commit; a refresh can also omit it.
    if (expected && isRuntimeContext(expected) && !isRuntimeContext(message)) expected = step.expected[++step.cursor];
    if (!expected || (isRuntimeContext(expected) ? !isRuntimeContext(message) : !isDeepStrictEqual(message, expected))) {
      return this.restrict();
    }
    step.cursor++;
    if (!isFeishuSource(message.source)) return;
    if (!feed || feed.signal.aborted || !feed.isCurrent()) return this.restrict();
    if (!this.feeds.has(feed.signal)) feed.signal.addEventListener('abort', this.restrict, { once: true });
    this.feeds.set(feed.signal, feed);
  }

  private committed(step: Step): boolean {
    return step.started && (step.cursor === step.expected.length ||
      (step.cursor === step.expected.length - 1 && isRuntimeContext(step.expected[step.cursor]!)));
  }

  authorize(exec: Readonly<ToolExecution>, advance: 'prepare' | 'dispatch'): boolean {
    const step = this.step;
    if (this.restricted || !step || !this.committed(step) || typeof exec.token !== 'symbol' || step.signal.aborted || exec.signal.aborted ||
        exec.agent !== this.agent || exec.toolSet !== step.toolSet || exec.parent !== undefined ||
        exec.rootCallId !== exec.callId || (advance === 'prepare' && exec.signal !== step.signal)) return false;
    if (!this.current() || [...this.feeds.values()].some(feed => feed.signal.aborted || !feed.isCurrent())) {
      this.restrict();
      return false;
    }
    const call = step.calls.get(exec.callId);
    if (!call || call.name !== exec.name || !step.toolSet.view(this.agent).has(exec.name)) return false;
    if (advance === 'dispatch') return call.token === exec.token;
    if (call.token !== undefined) return false;
    call.token = exec.token;
    step.expanded = true;
    return true;
  }

  restrict = (): void => {
    this.restricted = true;
    // The native executor resolves this same set again at the tool body, after asynchronous wrappers.
    if (this.step?.expanded) this.step.toolSet.dispose();
    this.step = undefined;
    this.assembly = undefined;
    this.claims = [];
    for (const signal of this.feeds.keys()) signal.removeEventListener('abort', this.restrict);
    this.feeds.clear();
  };

  private turnAborted = (): void => {
    this.observedAbort = true;
    // A cancelled turn can retain its inbox. Only live insertions after this boundary are fresh again.
    this.blockPending();
    this.restrict();
  };

  private blockPending(): void {
    for (const message of [...this.agent.inbox.nextTurn, ...this.agent.inbox.nextStep]) this.blockedInbox.add(message.id);
    this.inserted = new WeakSet();
  }

  closeTurn(): void {
    this.restrict();
    this.turnSignal?.removeEventListener('abort', this.turnAborted);
    this.turnSignal = undefined;
    this.observedAbort = false;
    this.turn = undefined;
    this.kind = undefined;
    this.stepNumber = 0;
  }
}
