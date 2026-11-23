import type { Context } from '@deepseek-ai/cordis';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { FeishuBridge } from './feishu-bridge.ts';
import { FeishuGroups } from './feishu-groups.ts';
import type { FeishuBinding, FeishuConfig } from './feishu-types.ts';
import type { Managers } from './manager.ts';
import { AppError, requiredText } from './model.ts';
import type { Store } from './store.ts';

const filename = 'super-bot.feishu.json';
const credentialIssue = `无法读取飞书凭证。请检查当前 profile 下的 ${filename}、文件权限和必填字段，再重启宿主。`;
const startupIssue = '飞书连接未能启动。请核对应用凭证和宿主配置，再重启宿主。';

export interface FeishuStatus {
  connection: 'disabled' | 'offline' | 'connecting' | 'ready' | 'reconnecting' | 'stopped';
  error?: string;
  binding: (FeishuBinding & { url: string }) | null;
}

function readCredentials(profileDir: string | undefined): FeishuConfig {
  if (!profileDir) throw Error('Missing profile directory');
  const fd = openSync(join(profileDir, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || (process.getuid && stat.uid !== process.getuid())
      || stat.nlink !== 1 || (stat.mode & 0o077)) {
      throw Error('Unsafe credential file');
    }
    const bytes = Buffer.alloc(4097);
    const size = readSync(fd, bytes);
    if (size !== stat.size) throw Error('Credential file changed while reading');
    const { appId, appSecret, ownerOpenId } = JSON.parse(bytes.toString('utf8', 0, size));
    if (typeof appId !== 'string' || !/^cli_[a-zA-Z0-9]+$/.test(appId)
      || typeof appSecret !== 'string' || !appSecret.trim()
      || typeof ownerOpenId !== 'string' || !/^ou_[a-zA-Z0-9]+$/.test(ownerOpenId)) {
      throw Error('Invalid Feishu credentials');
    }
    return { appId, appSecret, ownerOpenId };
  } finally { closeSync(fd); }
}

function bindingView(binding: FeishuBinding | null): FeishuStatus['binding'] {
  if (!binding) return null;
  const { id, botId, chatId, name, boundAt } = binding;
  const url = new URL('https://applink.feishu.cn/client/chat/open');
  url.searchParams.set('openChatId', chatId);
  return { id, botId, chatId, name, boundAt, url: url.href };
}

const actionFields: Record<string, readonly string[]> = {
  'feishu.status': [],
  'feishu.preview': ['chatId'],
  'feishu.bind': ['confirmationToken'],
  'feishu.create': ['name', 'requestId'],
  'feishu.unbind': ['bindingId'],
};

export async function startFeishuHost(ctx: Context, store: Store, managers: Managers, enabled: boolean, profileDir?: string) {
  let active = true;
  let issue: string | undefined;
  let groups: FeishuGroups | undefined, bridge: FeishuBridge | undefined;
  if (enabled) {
    let credentials: FeishuConfig | undefined;
    try { credentials = readCredentials(profileDir); } catch { issue = credentialIssue; }
    if (credentials) {
      try {
        const { createFeishuTransport } = await import('./feishu-sdk.ts');
        const transport = createFeishuTransport(credentials);
        const { appId, ownerOpenId } = credentials;
        groups = new FeishuGroups(store, { appId, ownerOpenId }, transport, () => active);
        bridge = new FeishuBridge(ctx, store, managers, groups, transport, { appId, ownerOpenId });
        bridge.start();
      } catch {
        try { await bridge?.close(); } catch { /* SDK startup failure must not interrupt DSH. */ }
        bridge = undefined;
        issue = startupIssue;
      }
    }
    if (issue) ctx.logger.warn(`[super-bot] ${issue}`);
  }

  const status = (botId: string): FeishuStatus => {
    const current = bridge?.status(botId);
    return { connection: current?.connection ?? (enabled ? 'offline' : 'disabled'),
      error: current?.error ?? issue, binding: bindingView(groups?.get(botId) ?? null) };
  };
  async function invoke(action: string, payload: Record<string, unknown>) {
    if (!active) throw new AppError('feishu-unavailable', '当前宿主正在停止飞书连接。');
    const fields = Object.hasOwn(actionFields, action) ? actionFields[action] : undefined;
    if (!fields) throw new AppError('not-found', '未知飞书操作。');
    if (Object.keys(payload).some(key => key !== 'action' && key !== 'botId' && !fields.includes(key))) {
      throw new AppError('invalid-input', '请从本端 Bot 的飞书群设置执行此操作。');
    }
    const botId = requiredText(payload.botId, 'Bot 标识', 200);
    store.getBot(botId);
    if (action === 'feishu.status') return status(botId);
    if (!groups) throw new AppError('feishu-unavailable', issue ?? '此 profile 未启用飞书群。');
    if (action === 'feishu.unbind') {
      groups.unbind(botId, requiredText(payload.bindingId, '绑定标识', 200));
      return status(botId);
    }
    if (bridge?.status(botId).connection !== 'ready') {
      throw new AppError('feishu-offline', '飞书长连接尚未就绪，请检查连接状态后重试。');
    }
    if (action === 'feishu.preview') return groups.preview(botId, requiredText(payload.chatId, '群 ID', 200));
    if (action === 'feishu.bind') await groups.bind(botId, requiredText(payload.confirmationToken, '群预览凭据', 200));
    else await groups.create(botId, requiredText(payload.name, '群名', 60), requiredText(payload.requestId, '请求标识', 200));
    return status(botId);
  }
  const inFlight = new Set<Promise<unknown>>();
  return {
    async close() {
      active = false;
      try { await bridge?.close(); }
      catch { ctx.logger.warn('[super-bot] 飞书连接关闭时出现问题。'); }
      await Promise.allSettled(inFlight);
    },
    async invoke(action: string, payload: Record<string, unknown>) {
      const pending = invoke(action, payload);
      inFlight.add(pending);
      try { return await pending; } finally { inFlight.delete(pending); }
    },
  };
}
