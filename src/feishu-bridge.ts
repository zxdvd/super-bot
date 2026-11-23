import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { finalAssistantText, isNativeOwner, messageText } from './dsh-chat-events.ts';
import type { FeishuGroups } from './feishu-groups.ts';
import { reserveFeishuInput, untilFeishuAbort, type FeishuInput } from './feishu-inputs.ts';
import type { FeishuBinding, FeishuConfig, FeishuConnectionState, FeishuTextMessage, FeishuTransport } from './feishu-types.ts';
import type { Managers } from './manager.ts';
import { AppError } from './model.ts';
import type { Store } from './store.ts';

type Connection = Exclude<FeishuConnectionState, 'reconnected'>;
type Epoch = { since: number; bindings: Map<string, AbortController> };
type BindingEpoch = { binding: FeishuBinding; epoch: Epoch; signal: AbortSignal };
type Route = BindingEpoch & { sessionId: string };
type Issue = { bindingId: string; text: string };
type NativeMessages = {
  sequence: number;
  web: Map<string, Route | null>;
  assistant?: { route: Route; turn: number; messageId: string; text: string };
};

const SEND_RETRY_DELAYS = [0, 1000, 3000];

export type FeishuBridgeStatus = { connection: Connection; error?: string };

function ingressRejection(error: unknown): string | undefined {
  if (error instanceof AppError) {
    switch (error.code) {
      case 'feishu-model-required':
        return '飞书消息未进入对话，请先在 Bot 管理对话选择并配置模型，再发送新消息。';
      case 'manager-scope':
      case 'feishu-manager-unavailable':
        return '飞书消息未进入对话，请打开本机当前 Bot 管理对话并检查会话。';
      case 'feishu-manager-busy':
        return '飞书消息未进入对话，请先检查管理对话中的待处理消息，再发送新消息。';
      case 'reload-in-progress':
        return '宿主正在重载，飞书消息未进入对话。连接恢复后请发送新消息。';
    }
  }
}

/** Forwards live traffic for the local active Manager only. A reconnect abandons the old epoch. */
export class FeishuBridge {
  private running = false;
  private connection: Connection = 'stopped';
  private connectionError?: string;
  private epoch?: Epoch;
  private disposers: Array<() => unknown> = [];
  private native = new WeakMap<Session, NativeMessages>();
  private incoming = new Map<string, Promise<void>>();
  private outgoing = new Map<string, Promise<void>>();
  private inFlight = new Set<Promise<void>>();
  private inboundErrors = new Map<string, Issue>();
  private outboundErrors = new Map<string, Issue>();

  constructor(
    private readonly ctx: Context,
    private readonly store: Store,
    private readonly managers: Pick<Managers, 'submitFeishu'>,
    private readonly groups: Pick<FeishuGroups, 'get' | 'findByChat' | 'onUnbound'>,
    private readonly transport: FeishuTransport,
    private readonly config: Pick<FeishuConfig, 'appId' | 'ownerOpenId'>,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connection = 'connecting';
    this.connectionError = undefined;
    this.disposers.push(
      this.groups.onUnbound(bindingId => this.revokeBinding(bindingId)),
      this.ctx.on('session/event', (session, event) => this.observe(session, event)),
      this.ctx.on('agent/created', ({ agent }) => { this.seedInbox(agent); }),
      this.ctx.on('agent/inbox/discarded', ({ agent, message }) => {
        // A steer moves the same message synchronously to another queue.
        queueMicrotask(() => {
          if (!this.running || !isNativeOwner(message)) return;
          const queued = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(item => item.id === message.id);
          if (!queued) this.native.get(agent.session)?.web.delete(message.id);
        });
      }),
    );
    for (const agent of this.ctx.agents.list()) this.seedInbox(agent);
    try {
      this.transport.start({
        onMessage: message => { this.receive(message); },
        onConnection: state => { this.setConnection(state); },
      });
    } catch {
      this.setConnection('stopped');
    }
  }

  async close(): Promise<void> {
    if (this.running) {
      this.running = false;
      this.connection = 'stopped';
      this.invalidateEpoch();
      for (const stop of this.disposers.splice(0)) stop();
      try { this.transport.stop(); } catch { /* Local routing has already stopped. */ }
    }
    await Promise.allSettled(this.inFlight);
  }

  status(botId: string): FeishuBridgeStatus {
    const binding = this.running ? this.groups.get(botId) : null;
    const outbound = this.outboundErrors.get(botId), inbound = this.inboundErrors.get(botId);
    const error = this.connectionError ?? (outbound?.bindingId === binding?.id ? outbound?.text : undefined)
      ?? (inbound?.bindingId === binding?.id ? inbound?.text : undefined);
    return { connection: this.connection, ...(error ? { error } : {}) };
  }

  private invalidateEpoch(): void {
    const old = this.epoch;
    this.epoch = undefined;
    this.incoming.clear();
    this.outgoing.clear();
    for (const controller of old?.bindings.values() ?? []) controller.abort();
    old?.bindings.clear();
  }

  private revokeBinding(bindingId: string): void {
    const controller = this.epoch?.bindings.get(bindingId);
    this.epoch?.bindings.delete(bindingId);
    this.incoming.delete(bindingId);
    this.outgoing.delete(bindingId);
    controller?.abort();
  }

  private bindingEpoch(binding: FeishuBinding, epoch: Epoch): BindingEpoch {
    let controller = epoch.bindings.get(binding.id);
    if (!controller) {
      controller = new AbortController();
      epoch.bindings.set(binding.id, controller);
    }
    return { binding, epoch, signal: controller.signal };
  }

  private setConnection(state: FeishuConnectionState): void {
    if (!this.running) return;
    if (state === 'ready' && this.connection === 'ready') return;
    this.invalidateEpoch();
    this.connection = state === 'reconnected' ? 'ready' : state;
    this.connectionError = state === 'stopped' ? '飞书连接已停止，请检查当前宿主的飞书应用配置。' : undefined;
    if (this.connection === 'ready') this.epoch = { since: Date.now(), bindings: new Map() };
  }

  private newerThan(route: Route, createdAt: number): boolean {
    return Number.isSafeInteger(createdAt) && createdAt > Math.max(route.binding.boundAt, route.epoch.since);
  }

  private bindingStillExists(binding: FeishuBinding): boolean {
    if (!this.running) return false;
    try { return this.groups.get(binding.botId)?.id === binding.id; }
    catch { return false; }
  }

  private current(route: BindingEpoch & { sessionId?: string }): boolean {
    if (this.epoch !== route.epoch || route.signal.aborted || !this.bindingStillExists(route.binding)) return false;
    try { return !route.sessionId || this.store.botForSession(route.sessionId)?.id === route.binding.botId; }
    catch { return false; }
  }

  private enqueue(queue: Map<string, Promise<void>>, route: BindingEpoch, work: () => Promise<void>): void {
    const key = route.binding.id;
    const task = (queue.get(key) ?? Promise.resolve()).then(work).finally(() => {
      if (queue.get(key) === task) queue.delete(key);
      this.inFlight.delete(task);
    });
    queue.set(key, task);
    this.inFlight.add(task);
  }

  private receive(message: FeishuTextMessage): void {
    const epoch = this.epoch;
    if (!epoch || message.senderOpenId !== this.config.ownerOpenId) return;
    let binding: FeishuBinding | null = null;
    try {
      binding = this.groups.findByChat(message.chatId);
      if (!binding || !Number.isSafeInteger(message.createdAt) ||
          message.createdAt <= Math.max(binding.boundAt, epoch.since)) return;
      const manager = this.store.activeManager(binding.botId);
      if (manager && message.createdAt <= manager.createdAt) return;
      const sessionId = manager?.sessionId && this.store.botForSession(manager.sessionId)?.id === binding.botId
        ? manager.sessionId : undefined;
      const route = { ...this.bindingEpoch(binding, epoch), sessionId };
      const input: FeishuInput = {
        bindingId: binding.id, botId: binding.botId, sessionId: sessionId ?? '', config: this.config,
        received: message, signal: route.signal, isCurrent: () => this.current(route),
      };
      // Commit deduplication before the SDK acknowledges the event, even when Manager is unavailable.
      const prompt = reserveFeishuInput(this.store, input);
      if (!prompt) return;
      if (!sessionId) {
        this.reject(route, message.messageId,
          '飞书消息未进入对话。请在宿主打开本机 Bot 管理对话，再发送新消息。');
        return;
      }
      this.enqueue(this.incoming, route, async () => {
        try {
          if (!this.current(route)) return;
          if (await this.managers.submitFeishu(input, prompt) && this.current(route)) {
            this.inboundErrors.delete(route.binding.botId);
          }
        } catch (error) {
          if (!this.current(route)) return;
          const rejection = ingressRejection(error);
          if (rejection) this.reject(route, message.messageId, rejection);
          else this.inboundErrors.set(route.binding.botId, {
            bindingId: route.binding.id, text: '飞书消息未确认进入管理对话，请打开 Bot 对话核对。',
          });
        }
      });
    } catch (error) {
      const text = '宿主账本暂时无法接收飞书消息，请核对当前宿主。';
      if (binding) this.inboundErrors.set(binding.botId, { bindingId: binding.id, text });
      else this.connectionError = text;
      throw error;
    }
  }

  private reject(route: BindingEpoch & { sessionId?: string }, messageId: string, text: string): void {
    this.inboundErrors.set(route.binding.botId, { bindingId: route.binding.id, text });
    this.forward(route, 'feedback', messageId, text);
  }

  private forward(route: BindingEpoch & { sessionId?: string }, kind: 'web' | 'assistant' | 'feedback',
    messageId: string, text: string): void {
    const { binding, sessionId, signal } = route;
    const uuid = createHash('sha256').update(JSON.stringify([this.config.appId, binding.id, sessionId, kind, messageId]))
      .digest('hex').slice(0, 40);
    this.enqueue(this.outgoing, route, async () => {
      let attempted = false;
      try {
        for (const [attempt, wait] of SEND_RETRY_DELAYS.entries()) {
          if (wait) await delay(wait, undefined, { signal });
          signal.throwIfAborted();
          if (!this.current(route)) return;
          try {
            attempted = true;
            const sent = this.transport.sendText(binding.chatId, text, uuid, () => this.current(route));
            await untilFeishuAbort(sent, signal);
            return;
          } catch (error) {
            const retryable = error instanceof AppError && ['feishu-send-retryable', 'feishu-timeout'].includes(error.code);
            if (!retryable || attempt === SEND_RETRY_DELAYS.length - 1) throw error;
          }
        }
      } catch (error) {
        if (this.current(route)) {
          const text = error instanceof AppError && error.code === 'feishu-text-too-long'
            ? '该条文本超出飞书消息长度限制。原文保留在 Bot 对话。'
            : '飞书投递未确认，请检查绑定群和应用权限。原文保留在 Bot 对话。';
          this.outboundErrors.set(binding.botId, { bindingId: binding.id, text });
        } else if (attempted && signal.aborted && this.bindingStillExists(binding)) {
          this.outboundErrors.set(binding.botId, {
            bindingId: binding.id, text: '断线时有一条飞书投递未确认。原文保留在 Bot 对话。',
          });
        }
      }
    });
  }

  private state(session: Session): NativeMessages {
    let state = this.native.get(session);
    if (!state) {
      state = { sequence: -1, web: new Map() };
      this.native.set(session, state);
    }
    return state;
  }

  private seedInbox(agent: Agent): void {
    if (!this.store.botForSession(agent.id)) return;
    const state = this.state(agent.session);
    for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
      if (isNativeOwner(message) && !state.web.has(message.id)) state.web.set(message.id, null);
    }
  }

  private observe(session: Session, event: SessionEvent): void {
    if (!this.running || !['agent/inbox/spliced', 'user/message', 'assistant/message', 'turn/start', 'turn/end']
      .includes(event.type)) return;
    const bot = this.store.botForSession(session.id);
    if (!bot) return;
    const state = this.state(session);
    if (event.seq <= state.sequence) return;
    state.sequence = event.seq;

    const liveRoute = (): Route | null => {
      const epoch = this.epoch, binding = epoch ? this.groups.get(bot.id) : null;
      if (!epoch || !binding) return null;
      const route = { ...this.bindingEpoch(binding, epoch), sessionId: session.id };
      return this.newerThan(route, event.time) ? route : null;
    };

    if (event.type === 'agent/inbox/spliced') {
      // Compare the original enqueue time, as a queued prompt can enter the surface minutes later.
      for (const message of event.data.inserted) {
        if (isNativeOwner(message) && !state.web.has(message.id)) state.web.set(message.id, liveRoute());
      }
    } else if (event.type === 'user/message') {
      const route = state.web.get(event.data.id);
      state.web.delete(event.data.id);
      if (route && event.surfaceOp === 'append' && isNativeOwner(event.data) &&
          this.newerThan(route, event.time) && this.current(route)) {
        const text = messageText(event.data);
        if (text.trim()) this.forward(route, 'web', event.data.id, `网页用户\n${text}`);
      }
    } else if (event.type === 'assistant/message') {
      const route = liveRoute(), text = finalAssistantText(event);
      state.assistant = route && text ? { route, turn: event.data.turn, messageId: event.data.message.id, text } : undefined;
    } else {
      const reply = state.assistant;
      state.assistant = undefined;
      if (event.type === 'turn/end' && event.data.reason.kind === 'completed' && reply?.turn === event.data.turn &&
          this.newerThan(reply.route, event.time) && this.current(reply.route)) {
        this.forward(reply.route, 'assistant', reply.messageId, reply.text);
      }
    }
  }
}
