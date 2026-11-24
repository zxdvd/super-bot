import { createHash } from 'node:crypto';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { isFeishuSource } from './dsh-chat-events.ts';
import { AppError, type ChatSource } from './model.ts';
import type { Store } from './store.ts';
import type { FeishuIdentity, FeishuTextMessage } from './feishu-types.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'super-bot-feishu': { kind: 'user'; feishuMessageId: string };
  }
}

export type FeishuInput = {
  bindingId: string;
  botId: string;
  sessionId: string;
  config: FeishuIdentity;
  received: FeishuTextMessage;
  signal: AbortSignal;
  isCurrent: () => boolean;
};

type PendingInput = {
  input: FeishuInput;
  turn?: number;
  entered: boolean;
  confirm: () => void;
};

function digest(text: string) {
  // Hash the exact string, including whitespace and Unicode, without copying it into the ledger.
  return createHash('sha256').update(text, 'utf16le').digest('hex');
}

export async function untilFeishuAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const value = await Promise.race([promise, aborted]);
    signal.throwIfAborted();
    return value;
  }
  finally { signal.removeEventListener('abort', abort); }
}

export function reserveFeishuInput(store: Store, input: FeishuInput): UserMessage | undefined {
  const { received, config } = input;
  if (input.signal.aborted || !input.isCurrent() || received.senderOpenId !== config.ownerOpenId) return;
  const message = createUserMessage({
    // The native renderer labels every other source kind as context rather than a chat bubble.
    source: { kind: 'user', feishuMessageId: received.messageId },
    content: [{ type: 'text', text: received.text }],
  });
  const receipt = store.db.prepare(`
    INSERT INTO feishu_inbound_receipts (
      messageId, nativeMessageId, bindingId, botId, sessionId, senderOpenId, appId, textDigest, acceptedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(messageId) DO NOTHING
  `).run(received.messageId, message.id, input.bindingId, input.botId, input.sessionId,
    received.senderOpenId, config.appId, digest(received.text), Date.now());
  if (receipt.changes === 1) return message;
}

/** A receipt survives restarts for deduplication. Only a live submission can authorize a turn. */
export class FeishuInputs {
  private pending = new Map<string, PendingInput>();

  constructor(private readonly store: Store) {}

  isPending(message: UserMessage): boolean {
    return this.pending.has(message.id);
  }

  private hasReceipt(sessionId: string, input: FeishuInput, message: UserMessage): boolean {
    const { source } = message, { received, config } = input;
    if (!isFeishuSource(source) || 'rpcId' in source || 'principal' in source) return false;
    const block = message.content[0];
    if (input.signal.aborted || !input.isCurrent() || sessionId !== input.sessionId ||
        received.senderOpenId !== config.ownerOpenId || source.feishuMessageId !== received.messageId ||
        this.store.botForSession(sessionId)?.id !== input.botId || message.content.length !== 1 ||
        block?.type !== 'text' || block.text !== received.text) return false;
    const receipt = this.store.db.prepare(`
      SELECT 1 FROM feishu_inbound_receipts WHERE messageId = ? AND nativeMessageId = ?
        AND bindingId = ? AND botId = ? AND sessionId = ? AND senderOpenId = ?
        AND appId = ? AND textDigest = ? AND nativeSeq IS NULL
    `).get(source.feishuMessageId, message.id, input.bindingId, input.botId, sessionId, config.ownerOpenId,
      config.appId, digest(block.text));
    return !!receipt;
  }

  private evidence(sessionId: string, message: UserMessage): PendingInput | undefined {
    const pending = this.pending.get(message.id);
    if (pending && !pending.entered && this.hasReceipt(sessionId, pending.input, message)) return pending;
  }

  authorize(sessionId: string, turn: number, message: UserMessage): boolean {
    if (!isFeishuSource(message.source)) return true;
    const pending = this.evidence(sessionId, message);
    if (!pending || (pending.turn !== undefined && pending.turn !== turn)) return false;
    pending.turn = turn;
    return true;
  }

  consume(sessionId: string, turn: number, event: SessionEvent<'user/message'>): { source: ChatSource; input: FeishuInput } | undefined {
    if (event.surfaceOp !== 'append') return;
    const pending = this.evidence(sessionId, event.data);
    if (!pending || pending.turn !== turn) return;
    const recorded = this.store.db.prepare(`
      UPDATE feishu_inbound_receipts SET nativeSeq = ? WHERE nativeMessageId = ? AND nativeSeq IS NULL
    `).run(event.seq, event.data.id);
    if (recorded.changes !== 1) return;
    pending.entered = true;
    pending.confirm();
    return {
      source: { sessionId, messageId: event.data.id, seq: event.seq, text: pending.input.received.text },
      input: pending.input,
    };
  }

  hasProposedInput(sessionId: string, turn: number, messageId: string): boolean {
    const pending = this.pending.get(messageId);
    return !!pending && !pending.entered && pending.input.sessionId === sessionId && pending.turn === turn;
  }

  async submit(agent: Agent, input: FeishuInput, message: UserMessage): Promise<boolean> {
    if (!this.hasReceipt(agent.id, input, message)) return false;
    let confirm!: () => void;
    const promise = new Promise<void>(resolve => { confirm = resolve; });
    const pending: PendingInput = { input, entered: false, confirm };
    this.pending.set(message.id, pending);
    const revoke = () => {
      // After pre-step approves a message, the Agent can be awaiting model preparation.
      if (!pending.entered && pending.turn !== undefined) agent.cancel({ kind: 'user' }, { keepInbox: true });
    };
    input.signal.addEventListener('abort', revoke, { once: true });
    try {
      agent.followup(message);
      await untilFeishuAbort(Promise.race([promise, agent.whenIdle()]), input.signal);
      if (pending.entered) return true;
      if (input.isCurrent()) throw new AppError('feishu-input-unconfirmed', '飞书输入未能进入原生会话，请检查 Bot 对话。');
      return false;
    } finally {
      input.signal.removeEventListener('abort', revoke);
      this.pending.delete(message.id);
      if (!pending.entered && [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(item => item.id === message.id)) {
        agent.inbox.remove(message.id);
      }
    }
  }
}
