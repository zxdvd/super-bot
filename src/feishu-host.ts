import type { Context } from '@deepseek-ai/cordis';
import { FeishuBridge } from './feishu-bridge.ts';
import { FeishuGroups } from './feishu-groups.ts';
import { feishuCredentials, loadFeishuSettings, saveFeishuSettings, type SavedFeishuSettings } from './feishu-settings.ts';
import type { FeishuBinding, FeishuConfig, FeishuSettingsView } from './feishu-types.ts';
import type { Managers } from './manager.ts';
import { AppError, requiredText } from './model.ts';
import type { Store } from './store.ts';

const STARTUP_ISSUE = '飞书连接未能启动。请核对应用凭证和当前 profile 设置后重试。';

export interface FeishuStatus {
  connection: FeishuSettingsView['connection'];
  error?: string;
  binding: (FeishuBinding & { url: string }) | null;
}

type Runtime = { groups: FeishuGroups; bridge: FeishuBridge };
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
const credentialFields = ['appId', 'ownerOpenId', 'appSecret'];

export async function startFeishuHost(ctx: Context, store: Store, managers: Managers, legacyEnabled: boolean, profileDir?: string) {
  let active = true;
  let { saved, error: issue } = loadFeishuSettings(profileDir, legacyEnabled);
  let runtime: Runtime | undefined;
  const checks = new AbortController();
  const inFlight = new Set<Promise<unknown>>();
  let saveQueue: Promise<unknown> = Promise.resolve();

  function assertActive() {
    if (!active) throw new AppError('feishu-unavailable', '当前宿主正在停止飞书连接。');
  }

  function prepare(settings: FeishuConfig, sdk: Sdk): Runtime {
    const identity = { appId: settings.appId, ownerOpenId: settings.ownerOpenId };
    const transport = sdk.createFeishuTransport({ ...identity, appSecret: settings.appSecret });
    const groups = new FeishuGroups(store, identity, transport, () => active && runtime === next);
    const next: Runtime = { groups, bridge: new FeishuBridge(ctx, store, managers, groups, transport, identity) };
    return next;
  }

  async function retire(previous: Runtime | undefined) {
    try { await previous?.bridge.close(); }
    catch { ctx.logger.warn('[super-bot] 飞书连接关闭时出现问题。'); }
  }

  async function activate(next: Runtime) {
    runtime = next;
    try {
      next.bridge.start();
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

  function settingsView(): FeishuSettingsView {
    const current = runtime?.bridge.connectionStatus();
    const error = current?.error ?? issue;
    return {
      appId: saved?.appId ?? '', ownerOpenId: saved?.ownerOpenId ?? '', hasSecret: Boolean(saved?.appSecret),
      enabled: saved?.enabled ?? false, connection: current?.connection ?? (saved?.enabled ? 'offline' : 'disabled'),
      lastMessageAt: current?.lastMessageAt ?? null, ...(error ? { error } : {}),
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

  async function save(payload: Record<string, unknown>) {
    assertActive();
    const next: SavedFeishuSettings = { ...feishuCredentials(payload, saved), enabled: true };
    if (saved?.enabled && runtime && sameCredentials(saved, next) && runtime.bridge.connectionStatus().connection !== 'stopped') {
      return settingsView();
    }

    let prepared: Runtime;
    try {
      prepared = prepare(next, await import('./feishu-sdk.ts'));
    } catch {
      throw new AppError('feishu-unavailable', STARTUP_ISSUE);
    }
    assertActive();
    saveFeishuSettings(profileDir, next);
    saved = next;
    issue = undefined;
    const previous = runtime;
    runtime = undefined;
    await retire(previous);
    assertActive();
    await activate(prepared);
    return settingsView();
  }

  function invokeSettings(action: string, payload: Record<string, unknown>) {
    if (action !== 'feishu.settings.get' && action !== 'feishu.settings.check' && action !== 'feishu.settings.save') {
      throw new AppError('not-found', '未知飞书设置操作。');
    }
    const fields = action === 'feishu.settings.get' ? [] : credentialFields;
    if (Object.keys(payload).some(key => key !== 'action' && !fields.includes(key))) {
      throw new AppError('feishu-settings-input', '请从当前 profile 的飞书设置执行此操作。');
    }
    if (action === 'feishu.settings.get') return settingsView();
    if (action === 'feishu.settings.check') return check(payload);
    const pending = saveQueue.then(() => save(payload));
    saveQueue = pending.catch(() => {});
    return pending;
  }

  function status(botId: string): FeishuStatus {
    const current = runtime?.bridge.status(botId);
    return { connection: current?.connection ?? (saved?.enabled ? 'offline' : 'disabled'),
      error: current?.error ?? issue, binding: bindingView(runtime?.groups.get(botId) ?? null) };
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
    if (!current) throw new AppError('feishu-unavailable', issue ?? '此 profile 未启用飞书群。');
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
