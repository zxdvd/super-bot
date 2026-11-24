import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { FeishuBridge } from './feishu-bridge.ts';
import { FeishuGroups } from './feishu-groups.ts';
import { FeishuSelfTest } from './feishu-self-test.ts';
import { feishuCredentials, loadFeishuSettings, saveFeishuSettings, type SavedFeishuSettings } from './feishu-settings.ts';
import type { FeishuBinding, FeishuConfig, FeishuSelfBinding, FeishuSettingsView, FeishuTransport } from './feishu-types.ts';
import type { Managers } from './manager.ts';
import { AppError, requiredText } from './model.ts';
import type { Store } from './store.ts';

const STARTUP_ISSUE = '飞书连接未能启动。请核对应用凭证和当前 profile 设置后重试。';

export interface FeishuStatus {
  connection: FeishuSettingsView['connection'];
  selfBinding: FeishuSelfBinding;
  error?: string;
  binding: (FeishuBinding & { url: string }) | null;
}

type Runtime = { appId: string; transport: FeishuTransport } & (
  { kind: 'bound'; groups: FeishuGroups; bridge: FeishuBridge }
  | { kind: 'unbound'; connection: FeishuSettingsView['connection'] }
);
type Sdk = typeof import('./feishu-sdk.ts');

function bindingView(binding: FeishuBinding | null): FeishuStatus['binding'] {
  if (!binding) return null;
  const { id, botId, chatId, name, boundAt } = binding;
  const url = new URL('https://applink.feishu.cn/client/chat/open');
  url.searchParams.set('openChatId', chatId);
  return { id, botId, chatId, name, boundAt, url: url.href };
}

function sameCredentials(left: FeishuConfig, right: FeishuConfig): boolean {
  return left.appId === right.appId && left.ownerOpenId === right.ownerOpenId && left.appSecret === right.appSecret;
}

const groupFields: Record<string, readonly string[]> = {
  'feishu.status': [],
  'feishu.preview': ['chatId'],
  'feishu.bind': ['confirmationToken'],
  'feishu.create': ['name', 'requestId'],
  'feishu.unbind': ['bindingId'],
};
const configurationField = ['configurationId'];
const sessionFields = [...configurationField, 'sessionId'];
const startFields = [...sessionFields, 'startToken'];
const settingsFields: Record<string, readonly string[]> = {
  'feishu.settings.get': [],
  'feishu.settings.check': ['appId', 'appSecret'],
  'feishu.settings.save': ['appId', 'appSecret', ...configurationField],
  'feishu.settings.test.start': startFields,
  'feishu.settings.test.status': sessionFields,
  'feishu.settings.test.retry': sessionFields,
  'feishu.settings.test.stop': startFields,
  'feishu.settings.test.skip': startFields,
  'feishu.settings.test.confirm': [...sessionFields, 'confirmationToken'],
};

function sessionIdOf(payload: Record<string, unknown>): string {
  const id = payload.sessionId;
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) {
    throw new AppError('feishu-settings-input', '测试会话标识无效，请从飞书设置重新开启。');
  }
  return id;
}

function startTokenOf(payload: Record<string, unknown>): string {
  return requiredText(payload.startToken, '测试开启凭据', 200);
}

export async function startFeishuHost(ctx: Context, store: Store, managers: Managers, legacyEnabled: boolean, profileDir?: string) {
  let active = true;
  let { saved, error: issue } = loadFeishuSettings(profileDir, legacyEnabled);
  let runtime: Runtime | undefined;
  let configurationId = randomUUID();
  const selfTest = new FeishuSelfTest();
  const checks = new AbortController();
  const inFlight = new Set<Promise<unknown>>();
  let saveQueue: Promise<unknown> = Promise.resolve();

  function assertActive() {
    if (!active) throw new AppError('feishu-unavailable', '当前宿主正在停止飞书连接。');
  }

  function prepare(settings: FeishuConfig, sdk: Sdk): Runtime {
    const { appId, ownerOpenId } = settings;
    const transport = sdk.createFeishuTransport(settings);
    if (!ownerOpenId) return { kind: 'unbound', appId, transport, connection: 'connecting' };
    const identity = { appId, ownerOpenId };
    const groups = new FeishuGroups(store, identity, transport, () => active && runtime === next);
    const next: Runtime = {
      kind: 'bound', appId, transport, groups, bridge: new FeishuBridge(ctx, store, managers, groups, transport, identity),
    };
    return next;
  }

  async function retire(previous: Runtime | undefined) {
    try {
      if (previous?.kind === 'bound') await previous.bridge.close();
      else previous?.transport.stop();
    }
    catch { ctx.logger.warn('[super-bot] 飞书连接关闭时出现问题。'); }
  }

  async function activate(next: Runtime) {
    runtime = next;
    try {
      if (next.kind === 'bound') next.bridge.start();
      else next.transport.start({
        onMessage: () => {},
        onPrivateMessage: message => {
          if (runtime === next && next.connection === 'ready') selfTest.receive(message);
        },
        onConnection: state => {
          if (runtime !== next) return;
          next.connection = state === 'reconnected' ? 'ready' : state;
          if (state !== 'ready') selfTest.interrupt();
        },
      });
    } catch {
      runtime = undefined;
      issue = STARTUP_ISSUE;
      await retire(next);
    }
  }

  if (saved?.enabled) {
    try {
      await activate(prepare(saved, await import('./feishu-sdk.ts')));
    } catch { issue = STARTUP_ISSUE; }
  }
  if (issue && (profileDir || legacyEnabled)) ctx.logger.warn(`[super-bot] ${issue}`);

  function connectionStatus() {
    if (runtime?.kind === 'bound') return runtime.bridge.connectionStatus();
    return { connection: runtime?.connection ?? (saved?.enabled ? 'offline' : 'disabled'),
      lastMessageAt: null, error: runtime?.connection === 'stopped' ? STARTUP_ISSUE : undefined } as const;
  }

  function selfBinding(): FeishuSelfBinding {
    return saved?.ownerOpenId ? 'bound' : saved?.selfTestSkipped ? 'skipped' : 'unbound';
  }

  function settingsView(): FeishuSettingsView {
    const current = connectionStatus();
    const error = current.error ?? issue;
    const testStartToken = saved?.enabled && !saved.ownerOpenId ? selfTest.startToken() : undefined;
    return {
      appId: saved?.appId ?? '', ownerOpenId: saved?.ownerOpenId ?? '', configurationId, selfBinding: selfBinding(),
      hasSecret: Boolean(saved?.appSecret), enabled: saved?.enabled ?? false, connection: current.connection,
      lastMessageAt: current.lastMessageAt, ...(error ? { error } : {}),
      ...(testStartToken && { testStartToken }),
    };
  }

  async function check(payload: Record<string, unknown>) {
    const credentials = feishuCredentials(payload, saved);
    const sdk = await import('./feishu-sdk.ts').catch(() => {
      throw new AppError('feishu-unavailable', '当前宿主无法检测飞书配置。');
    });
    assertActive();
    const result = await sdk.checkFeishuConfig(credentials, { signal: checks.signal });
    assertActive();
    return result;
  }

  async function install(next: SavedFeishuSettings, validate: () => void) {
    let prepared: Runtime;
    try {
      prepared = prepare(next, await import('./feishu-sdk.ts'));
    } catch {
      throw new AppError('feishu-unavailable', STARTUP_ISSUE);
    }
    assertActive();
    validate();
    saveFeishuSettings(profileDir, next);
    saved = next;
    configurationId = randomUUID();
    selfTest.clear();
    issue = undefined;
    const previous = runtime;
    runtime = undefined;
    await retire(previous);
    assertActive();
    await activate(prepared);
    return settingsView();
  }

  function assertConfiguration(payload: Record<string, unknown>) {
    if (payload.configurationId !== configurationId) {
      throw new AppError('feishu-configuration-changed', '飞书连接配置已变更，请核对当前设置后重试。');
    }
  }

  function assertUnbound() {
    if (!saved?.enabled) throw new AppError('feishu-unavailable', '请先保存并连接飞书应用。');
    if (saved.ownerOpenId) throw new AppError('feishu-self-bound', '此飞书连接已绑定本人身份。');
    return saved;
  }

  function save(payload: Record<string, unknown>) {
    assertActive();
    assertConfiguration(payload);
    const credentials = feishuCredentials(payload, saved);
    const previous = saved?.appId === credentials.appId ? saved : undefined;
    const next: SavedFeishuSettings = { ...previous, ...credentials, enabled: true };
    if (previous?.enabled && runtime && sameCredentials(previous, next) && connectionStatus().connection !== 'stopped') {
      return settingsView();
    }
    return install(next, () => assertConfiguration(payload));
  }

  function skip(payload: Record<string, unknown>) {
    assertActive();
    assertConfiguration(payload);
    const current = assertUnbound();
    if (payload.sessionId === undefined) selfTest.assertCanSkip();
    else selfTest.assertCanSkip(sessionIdOf(payload), startTokenOf(payload));
    const next: SavedFeishuSettings = { ...current, selfTestSkipped: true };
    if (!current.selfTestSkipped) saveFeishuSettings(profileDir, next);
    saved = next;
    selfTest.clear();
    return settingsView();
  }

  function confirm(payload: Record<string, unknown>) {
    assertActive();
    assertConfiguration(payload);
    const current = assertUnbound(), sessionId = sessionIdOf(payload);
    const token = requiredText(payload.confirmationToken, '候选确认凭据', 200);
    const ownerOpenId = selfTest.confirmedOpenId(sessionId, token);
    return install({ ...current, ownerOpenId, selfTestSkipped: undefined }, () => {
      assertConfiguration(payload);
      selfTest.confirmedOpenId(sessionId, token);
    });
  }

  function serialize(work: () => unknown) {
    const pending = saveQueue.then(work);
    saveQueue = pending.catch(() => {});
    return pending;
  }

  function invokeSettings(action: string, payload: Record<string, unknown>) {
    const fields = Object.hasOwn(settingsFields, action) ? settingsFields[action] : undefined;
    if (!fields) throw new AppError('not-found', '未知飞书设置操作。');
    if (Object.keys(payload).some(key => key !== 'action' && !fields.includes(key))) {
      throw new AppError('feishu-settings-input', '请从当前 profile 的飞书设置执行此操作。');
    }
    if (action === 'feishu.settings.get') return settingsView();
    if (action === 'feishu.settings.check') return check(payload);
    if (action === 'feishu.settings.save') return serialize(() => save(payload));
    if (action === 'feishu.settings.test.skip') return serialize(() => skip(payload));
    if (action === 'feishu.settings.test.confirm') return serialize(() => confirm(payload));

    assertConfiguration(payload);
    assertUnbound();
    const sessionId = sessionIdOf(payload);
    if (action === 'feishu.settings.test.status') return selfTest.status(sessionId);
    if (action === 'feishu.settings.test.stop') return selfTest.stop(sessionId, startTokenOf(payload));
    if (runtime?.kind !== 'unbound' || runtime.connection !== 'ready') {
      throw new AppError('feishu-offline', '飞书长连接尚未就绪，请检查连接状态后重试。');
    }
    if (action === 'feishu.settings.test.start') {
      return selfTest.start(sessionId, startTokenOf(payload), runtime.appId, runtime.transport.sendText.bind(runtime.transport));
    }
    return selfTest.retry(sessionId);
  }

  function status(botId: string): FeishuStatus {
    const bound = runtime?.kind === 'bound' ? runtime : undefined;
    const current = bound?.bridge.status(botId) ?? connectionStatus();
    return { connection: current.connection, selfBinding: selfBinding(),
      error: current.error ?? issue, binding: bindingView(bound?.groups.get(botId) ?? null) };
  }

  async function invoke(action: string, payload: Record<string, unknown>) {
    assertActive();
    if (action.startsWith('feishu.settings.')) return invokeSettings(action, payload);
    const fields = Object.hasOwn(groupFields, action) ? groupFields[action] : undefined;
    if (!fields) throw new AppError('not-found', '未知飞书操作。');
    if (Object.keys(payload).some(key => key !== 'action' && key !== 'botId' && !fields.includes(key))) {
      throw new AppError('invalid-input', '请从本端 Bot 的飞书群设置执行此操作。');
    }
    const botId = requiredText(payload.botId, 'Bot 标识', 200);
    store.getBot(botId);
    if (action === 'feishu.status') return status(botId);
    const current = runtime;
    if (saved?.enabled && !saved.ownerOpenId) {
      throw new AppError('feishu-self-unbound', '请先在飞书连接设置中绑定本人身份。');
    }
    if (current?.kind !== 'bound') throw new AppError('feishu-unavailable', issue ?? '此 profile 未启用飞书群。');
    const { groups, bridge } = current;
    if (action === 'feishu.unbind') {
      groups.unbind(botId, requiredText(payload.bindingId, '绑定标识', 200));
      return status(botId);
    }
    if (bridge.status(botId).connection !== 'ready') {
      throw new AppError('feishu-offline', '飞书长连接尚未就绪，请检查连接状态后重试。');
    }
    if (action === 'feishu.preview') {
      const preview = await groups.preview(botId, requiredText(payload.chatId, '群 ID', 200));
      if (current !== runtime) throw new AppError('feishu-stopped', '飞书配置已变更，请刷新后重新预览。');
      return preview;
    }
    if (action === 'feishu.bind') await groups.bind(botId, requiredText(payload.confirmationToken, '群预览凭据', 200));
    else await groups.create(botId, requiredText(payload.name, '群名', 60), requiredText(payload.requestId, '请求标识', 200));
    if (current !== runtime) throw new AppError('feishu-stopped', '飞书配置已变更，请刷新后核对绑定。');
    return status(botId);
  }

  return {
    async close() {
      active = false;
      checks.abort();
      selfTest.clear();
      const current = runtime;
      runtime = undefined;
      await retire(current);
      await Promise.allSettled(inFlight);
    },
    async invoke(action: string, payload: Record<string, unknown>) {
      const pending = invoke(action, payload);
      inFlight.add(pending);
      try { return await pending; } finally { inFlight.delete(pending); }
    },
  };
}
