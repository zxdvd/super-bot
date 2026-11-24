import { randomUUID } from 'node:crypto';
import { isFeishuChatId, isFeishuOpenId, type FeishuPrivateTextMessage, type FeishuSelfTestCandidate,
  type FeishuSelfTestView, type FeishuTransport } from './feishu-types.ts';
import { AppError } from './model.ts';

const WINDOW_MS = 3 * 60_000;
const REPLY = 'Super Bot 已收到这条飞书私聊测试消息。请回到飞书连接设置，核对后确认本人身份。';
type Phase = FeishuSelfTestView['state'];
type Session = {
  sessionId: string;
  startToken: string;
  appId: string;
  startedAt: number;
  expiresAt: number;
  sendText: FeishuTransport['sendText'];
  state: Phase;
  timer: ReturnType<typeof setTimeout>;
  candidate?: FeishuSelfTestCandidate & { chatId: string };
};

function live(session: Session): boolean {
  return session.state !== 'conflict' && session.state !== 'expired' && session.state !== 'interrupted';
}

function stale(): AppError {
  return new AppError('feishu-test-stale', '本次飞书测试已失效，请从当前设置重新开启。');
}

/** The current configuration page owns one bounded test. No message enters Bot routing here. */
export class FeishuSelfTest {
  private session?: Session;
  private nextStartToken = randomUUID();

  constructor(private readonly now = Date.now) {}

  startToken(): string | undefined {
    const session = this.current();
    return session && live(session) ? undefined : this.nextStartToken;
  }

  start(sessionId: string, startToken: string, appId: string, sendText: FeishuTransport['sendText']): FeishuSelfTestView {
    const prior = this.current();
    if (prior?.sessionId === sessionId && prior.startToken === startToken) return this.view(prior);
    if (prior && live(prior)) {
      throw new AppError('feishu-test-busy', '此连接已有进行中的私聊测试，请在原设置页完成或停止，也可等测试过期。');
    }
    if (startToken !== this.nextStartToken) throw stale();
    this.nextStartToken = randomUUID();
    const startedAt = this.now();
    const timer = setTimeout(() => {
      if (this.session?.sessionId === sessionId && live(this.session)) this.finish(this.session, 'expired');
    }, WINDOW_MS).unref();
    const session: Session = { sessionId, startToken, appId, startedAt,
      expiresAt: startedAt + WINDOW_MS, sendText, state: 'waiting', timer };
    this.session = session;
    return this.view(session);
  }

  status(sessionId: string): FeishuSelfTestView {
    return this.view(this.require(sessionId));
  }

  receive(message: FeishuPrivateTextMessage): void {
    const now = this.now();
    const session = this.current();
    if (!session || !live(session) || session.appId !== message.appId) return;
    if (!Number.isSafeInteger(message.createdAt) || message.createdAt <= session.startedAt || message.createdAt > now
      || !isFeishuOpenId(message.senderOpenId) || !isFeishuChatId(message.chatId)) return;
    const text = message.text.trim();
    if (!text) return;
    const candidate = session.candidate;
    if (candidate) {
      if (candidate.openId !== message.senderOpenId || candidate.chatId !== message.chatId) {
        this.finish(session, 'conflict');
      }
      // A repeated message or another message from the same private chat leaves the original receipt in place.
      return;
    }
    const preview = text.length <= 120 ? text : text.slice(0, 120).replace(/[\uD800-\uDBFF]$/u, '') + '…';
    session.candidate = { chatId: message.chatId, openId: message.senderOpenId,
      receivedAt: now, preview, confirmationToken: randomUUID() };
    this.send(session, session.candidate);
  }

  retry(sessionId: string): FeishuSelfTestView {
    const session = this.require(sessionId);
    if (session.state === 'send-failed' && session.candidate) this.send(session, session.candidate);
    return this.view(session);
  }

  confirmedOpenId(sessionId: string, confirmationToken: string): string {
    const session = this.require(sessionId);
    if (session.state !== 'sent' || !session.candidate || session.candidate.confirmationToken !== confirmationToken) {
      throw new AppError('feishu-test-unconfirmed', '请核对当前测试候选，等收发通过后再确认本人身份。');
    }
    return session.candidate.openId;
  }

  assertCanSkip(sessionId?: string, startToken?: string): void {
    const session = this.current();
    if (sessionId && session?.sessionId === sessionId && session.startToken === startToken) return;
    if (session && live(session)) {
      throw new AppError('feishu-test-busy', '请在开启测试的设置页跳过本次测试。');
    }
    if (sessionId && startToken !== this.nextStartToken) throw stale();
  }

  stop(sessionId: string, startToken: string): void {
    const session = this.current();
    if (session?.sessionId === sessionId && session.startToken === startToken) {
      if (live(session)) this.finish(session, 'interrupted');
      return;
    }
    // Leaving the page can race the first start request. Revoke an unused start token too.
    if (this.startToken() !== startToken) throw stale();
    this.nextStartToken = randomUUID();
  }

  interrupt(): void {
    const session = this.current();
    if (session && live(session)) this.finish(session, 'interrupted');
  }

  clear(): void {
    if (this.session) this.finish(this.session, 'interrupted');
    this.session = undefined;
    this.nextStartToken = randomUUID();
  }

  private send(session: Session, { chatId, confirmationToken }: NonNullable<Session['candidate']>): void {
    session.state = 'sending';
    const sending = () => this.current() === session && session.state === 'sending';
    void (async () => {
      try {
        await session.sendText(chatId, REPLY, confirmationToken, sending);
        if (sending()) session.state = 'sent';
      } catch {
        if (sending()) session.state = 'send-failed';
      }
    })();
  }

  private current(): Session | undefined {
    const session = this.session;
    if (session && live(session) && this.now() >= session.expiresAt) this.finish(session, 'expired');
    return session;
  }

  private require(sessionId: string): Session {
    const session = this.current();
    if (!session || session.sessionId !== sessionId) throw stale();
    return session;
  }

  private finish(session: Session, state: 'conflict' | 'expired' | 'interrupted'): void {
    clearTimeout(session.timer);
    session.state = state;
    session.candidate = undefined;
  }

  private view(session: Session): FeishuSelfTestView {
    const { sessionId, expiresAt, state } = session;
    if (state === 'sending' || state === 'send-failed' || state === 'sent') {
      const { openId, receivedAt, preview, confirmationToken } = session.candidate!;
      return { sessionId, expiresAt, state, candidate: { openId, receivedAt, preview, confirmationToken } };
    }
    return { sessionId, expiresAt, state };
  }
}
