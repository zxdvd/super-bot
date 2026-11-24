import { AsyncLocalStorage } from 'node:async_hooks';
import { AppType, Client, DefaultCache, defaultHttpInstance, Domain, EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import { AppError } from './model.ts';
import { isFeishuChatId, type FeishuCheckResult, type FeishuConfig, type FeishuConnectionState, type FeishuGroup, type FeishuHandlers,
  type FeishuTextMessage, type FeishuTransport } from './feishu-types.ts';

const MESSAGE_EVENT = 'im.message.receive_v1';
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_TEXT_BODY_BYTES = 150_000;
const FEISHU_ORIGIN = 'https://open.feishu.cn';
const MISSING_FEISHU_SCOPE = 99991672;
const SEND_THROTTLED_CODES = new Set([230020, 99991400]);
const MONTHLY_QUOTA_CODE = 99991403;
const noop = () => {};
// SDK diagnostics can include credentials, request payloads and message bodies.
const logger = { error: noop, warn: noop, info: noop, debug: noop, trace: noop };

type Socket = Pick<WSClient,'start'|'close'>;
type SocketOptions = ConstructorParameters<typeof WSClient>[0];
type SDKHttp = NonNullable<SocketOptions['httpInstance']>;
type HttpAdapter = typeof defaultHttpInstance.defaults.adapter;
type TransportOptions = {
  createSocket?: (options: SocketOptions) => Socket;
  httpAdapter?: HttpAdapter;
  requestTimeoutMs?: number;
};
type Connection = { handlers: FeishuHandlers; state: FeishuConnectionState; socket?: Socket };
type RequestBudget = { signal: AbortSignal; allowSend?: () => boolean };
type PageResponse<T> = {
  code?: number;
  data?: { items?: T[]; has_more?: boolean; page_token?: string };
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

const CHECK_SCOPES = [
  'im:message.group_at_msg:readonly', 'im:message:send_as_bot',
  'im:chat:read', 'im:chat:create', 'im:chat.members:read',
];
// Explicit parameter or credential rejections from the self-built token endpoint.
const CREDENTIAL_REJECTIONS = new Set([10003, 10005, 10014, 10015, 99991543]);

function permissionResults(scopes?: Record<string, unknown>[]): FeishuCheckResult['permissions'] {
  return CHECK_SCOPES.map(scope => {
    if (!scopes) return { scope, status: 'unverified' };
    const tokenTypes = scopes.filter(entry => entry.scope === scope).map(({ token_types: types }) =>
      Array.isArray(types) && types.length && types.every(type => type === 'tenant' || type === 'user') ? types : undefined);
    if (tokenTypes.some(types => types?.includes('tenant'))) return { scope, status: 'passed' };
    if (tokenTypes.some(types => types === undefined)) return { scope, status: 'unverified' };
    return { scope, status: 'missing' };
  });
}

/** Exchanges a fresh token, then reads the app's granted scopes when available. */
export async function checkFeishuConfig(config: FeishuConfig, options: Pick<TransportOptions, 'httpAdapter' | 'requestTimeoutMs'>
  & { signal?: AbortSignal } = {}): Promise<FeishuCheckResult> {
  const timeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeout);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const http = defaultHttpInstance.create({ adapter: options.httpAdapter, timeout, maxRedirects: 0 });
  let credentials: FeishuCheckResult['credentials'] = 'unverified';
  let scopes: Record<string, unknown>[] | undefined;
  try {
    const response = await http.post<unknown>(`${FEISHU_ORIGIN}/open-apis/auth/v3/tenant_access_token/internal`,
      { app_id: config.appId, app_secret: config.appSecret }, { signal, validateStatus: status => status < 500 });
    signal.throwIfAborted();
    const { code, tenant_access_token: token } = object(response.data);
    if ((response.status === 200 || [400, 401, 403].includes(response.status))
      && typeof code === 'number' && CREDENTIAL_REJECTIONS.has(code)) credentials = 'failed';
    if (response.status === 200 && code === 0 && typeof token === 'string' && /^\S+$/.test(token)) {
      credentials = 'passed';
      const path = `/open-apis/application/v6/applications/${encodeURIComponent(config.appId)}`;
      const detail = await http.get<unknown>(FEISHU_ORIGIN + path, {
        signal, params: { lang: 'zh_cn' }, headers: { Authorization: `Bearer ${token}` },
      });
      signal.throwIfAborted();
      const result = object(detail.data), app = object(object(result.data).app);
      if (detail.status === 200 && result.code === 0 && app.app_id === config.appId && Array.isArray(app.scopes)) {
        const parsed = app.scopes.map(object);
        if (parsed.every(entry => typeof entry.scope === 'string' && entry.scope.trim())) scopes = parsed;
      }
    }
  } catch { /* Transport and lookup failures leave unavailable evidence unverified. */ }
  return { credentials, permissions: permissionResults(scopes) };
}

function readableText(content: string, mentions: unknown): string {
  let value: unknown;
  try { value = object(JSON.parse(content)).text; } catch { return ''; }
  if (typeof value !== 'string' || !value.trim()) return '';
  const keys = new Map<string, string>();
  for (const entry of Array.isArray(mentions) ? mentions : []) {
    const { key, name } = object(entry);
    if (typeof key === 'string' && /^@_(?:user_\d+|all)$/.test(key) && typeof name === 'string' && name.trim()) {
      keys.set(key, `@${name.trim()}`);
    }
  }
  const placeholder = /@_(?:user_\d+|all)(?![\w])/g;
  // Mention-only messages do not provide a prompt. Keep named mentions in otherwise valid text.
  if (!value.replace(placeholder, key => keys.has(key) ? '' : key).trim()) return '';
  return value.replace(placeholder, key => keys.get(key) ?? key);
}

function ownerTextEvent(event: unknown, app: string, owner: string): FeishuTextMessage | null {
  const { app_id: appId, sender, message } = object(event);
  const { sender_type: senderType, sender_id: senderId } = object(sender);
  const { open_id: senderOpenId } = object(senderId);
  const { chat_type: chatType, chat_id: chatId, message_id: messageId, message_type: messageType,
    create_time: createTime, content, mentions } = object(message);
  if (appId !== undefined && appId !== app) return null;
  if (senderType !== 'user' || senderOpenId !== owner) return null;
  if ((chatType !== 'group' && chatType !== 'topic_group' && chatType !== 'topic') || messageType !== 'text' || !isFeishuChatId(chatId)) return null;
  if (typeof messageId !== 'string' || !/^om_[A-Za-z0-9_]{1,125}$/.test(messageId) || typeof content !== 'string') return null;
  const createdAt = typeof createTime === 'string' && /^\d+$/.test(createTime) ? Number(createTime) : createTime;
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) return null;
  if (Buffer.byteLength(content) > MAX_TEXT_BODY_BYTES) return null;
  const text = readableText(content, mentions);
  if (!text) return null;
  return { chatId, messageId, senderOpenId, createdAt, text };
}

function stoppedError(): AppError {
  return new AppError('feishu-stopped', '飞书接入已停止。');
}

function inspectError(): AppError {
  return new AppError('feishu-group-lookup', '无法读取飞书群，请核对群 ID、机器人入群状态及应用权限。');
}

function sendFailed(): AppError {
  return new AppError('feishu-send-failed', '飞书消息未确认送达，请核对连接状态与机器人群权限。');
}

function sendRetryable(): AppError {
  return new AppError('feishu-send-retryable', '暂时无法确认飞书消息送达。');
}

function sendHttpError(error: unknown): AppError {
  const { status, data } = object(object(error).response);
  const code = object(data).code;
  if (code === MONTHLY_QUOTA_CODE) return sendFailed();
  if (typeof code === 'number' && SEND_THROTTLED_CODES.has(code)) return sendRetryable();
  return typeof status !== 'number' || status === 408 || status === 429 || status >= 500 ? sendRetryable() : sendFailed();
}

function dataFrom<T>(response: { code?: number; data?: T }, failure: () => AppError): T {
  if (response?.code !== 0 || response.data === undefined) throw failure();
  return response.data;
}

async function hasPageItem<T>(readPage: (pageToken?: string) => Promise<PageResponse<T>>, matches: (item: T) => boolean): Promise<boolean> {
  const tokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const page = dataFrom(await readPage(pageToken), inspectError);
    if (page.items?.some(matches)) return true;
    if (!page.has_more) return false;
    pageToken = page.page_token;
    if (!pageToken || tokens.has(pageToken)) throw inspectError();
    tokens.add(pageToken);
  } while (pageToken);
  return false;
}

function displayName(name: string | undefined): string {
  return name?.trim() || '（无主题）';
}

function assertChatId(chatId: string): void {
  if (!isFeishuChatId(chatId)) throw new AppError('feishu-chat-id', '请输入有效的飞书群 chat_id。');
}

function assertUuid(uuid: string): void {
  if (typeof uuid !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(uuid)) {
    throw new AppError('feishu-uuid', '飞书请求标识无效。');
  }
}

export function createFeishuTransport(config: FeishuConfig, options: TransportOptions = {}): FeishuTransport {
  const { appId, appSecret, ownerOpenId } = config;
  const credentials = { appId, appSecret, domain: Domain.Feishu, logger, source: 'super-bot' };
  // A replacement connection must not reuse SDK tokens from the previous secret.
  const cache = new DefaultCache();
  const requests = new AsyncLocalStorage<RequestBudget>();
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  let lifetime = new AbortController();
  let connection: Connection | undefined;

  function boundedHttp(signal?: AbortSignal): SDKHttp {
    const http = defaultHttpInstance.create({ adapter: options.httpAdapter, timeout: requestTimeoutMs, maxRedirects: 0 });
    http.interceptors.request.use(request => {
      const budget = requests.getStore();
      request.signal = AbortSignal.any([signal ?? lifetime.signal, budget?.signal ?? AbortSignal.timeout(requestTimeoutMs)]);
      // The SDK may asynchronously fetch a tenant token before sending the message request.
      if (request.url?.endsWith('/im/v1/messages') && budget?.allowSend?.() === false) {
        throw new AppError('feishu-binding-changed', '飞书绑定或连接已变更，消息发送已取消。');
      }
      return request;
    }, error => { throw error; }, { synchronous: true });
    // The SDK's generated APIs read the response body directly.
    http.interceptors.response.use(response => response.data);
    return http as unknown as SDKHttp;
  }

  const client = new Client({ ...credentials, appType: AppType.SelfBuild, cache, httpInstance: boundedHttp() });
  const im = client.im.v1;

  async function rest<T>(operation: () => Promise<T>, failure: (error: unknown) => AppError, allowSend?: () => boolean): Promise<T> {
    const session = lifetime.signal;
    if (session.aborted) throw stoppedError();
    const deadline = AbortSignal.timeout(requestTimeoutMs);
    const signal = AbortSignal.any([session, deadline]);
    try {
      const result = await requests.run({ signal, allowSend }, operation);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (session.aborted) throw stoppedError();
      if (deadline.aborted) throw new AppError('feishu-timeout', '飞书请求超时，请稍后核对结果。');
      throw error instanceof AppError ? error : failure(error);
    }
  }

  async function robotInGroup(chatId: string): Promise<boolean> {
    const path = { chat_id: chatId };
    const membership = await im.chatMembers.isInChat({ path }).catch(error => {
      const { response, config } = object(error);
      const code = object(object(response).data).code;
      const { url } = object(config);
      if (code === MISSING_FEISHU_SCOPE && typeof url === 'string' && url.endsWith(`/im/v1/chats/${chatId}/members/is_in_chat`)) {
        return { code: MISSING_FEISHU_SCOPE, data: undefined };
      }
      throw error;
    });
    if (membership?.code !== MISSING_FEISHU_SCOPE) return dataFrom(membership, inspectError)?.is_in_chat === true;
    // This app-token endpoint lists only chats the calling bot belongs to.
    return hasPageItem(pageToken => im.chat.list({ params: { page_size: 100, page_token: pageToken } }), item => item.chat_id === chatId);
  }

  function ownerInGroup(chatId: string): Promise<boolean> {
    return hasPageItem(pageToken => im.chatMembers.get({
      path: { chat_id: chatId }, params: { member_id_type: 'open_id', page_size: 100, page_token: pageToken },
    }), member => member.member_id === ownerOpenId);
  }

  function changeState(current: Connection, state: FeishuConnectionState): void {
    if (connection !== current || current.state === state) return;
    current.state = state;
    current.handlers.onConnection(state);
  }

  function isReady(current: Connection | undefined): boolean {
    return current?.state === 'ready' || current?.state === 'reconnected';
  }

  return {
    start(handlers) {
      if (connection) return;
      if (lifetime.signal.aborted) lifetime = new AbortController();
      const current: Connection = { handlers, state: 'connecting' };
      connection = current;
      const terminal = () => {
        if (connection !== current) return;
        try { changeState(current, 'stopped'); }
        finally {
          connection = undefined;
          current.socket?.close({ force: true });
        }
      };
      handlers.onConnection('connecting');
      if (connection !== current) return;
      try {
        const dispatcher = new EventDispatcher({ logger, cache }).register({
          [MESSAGE_EVENT]: async event => {
            if (connection !== current || !isReady(current)) return;
            const message = ownerTextEvent(event, appId, ownerOpenId);
            if (!message) return;
            try { await handlers.onMessage(message); }
            catch { throw new Error('Feishu message handoff failed'); }
          },
        });
        const createSocket = options.createSocket ?? (parameters => new WSClient(parameters));
        current.socket = createSocket({
          ...credentials, httpInstance: boundedHttp(lifetime.signal), autoReconnect: true,
          handshakeTimeoutMs: requestTimeoutMs, wsConfig: { pingTimeout: 10 },
          onReady: () => changeState(current, 'ready'),
          onReconnecting: () => changeState(current, 'reconnecting'),
          onReconnected: () => changeState(current, 'reconnected'),
          onError: terminal,
        });
        void current.socket.start({ eventDispatcher: dispatcher }).catch(terminal);
      } catch { terminal(); }
    },
    stop() {
      const current = connection;
      connection = undefined;
      lifetime.abort();
      if (!current) return;
      current.socket?.close({ force: true });
      if (current.state !== 'stopped') current.handlers.onConnection('stopped');
    },
    inspectGroup(chatId): Promise<FeishuGroup> {
      return rest(async () => {
        assertChatId(chatId);
        const path = { chat_id: chatId };
        if (!await robotInGroup(chatId)) throw new AppError('feishu-bot-not-in-group', '请先将此飞书应用的机器人加入群聊。');
        const group = dataFrom(await im.chat.get({ path, params: { user_id_type: 'open_id' } }), inspectError);
        if ((group.chat_mode !== 'group' && group.chat_mode !== 'topic') || (group.chat_status && group.chat_status !== 'normal')) {
          throw new AppError('feishu-not-group', '该 chat_id 对应的会话不是可用的飞书群。');
        }
        if (group.owner_id !== ownerOpenId && !await ownerInGroup(chatId)) {
          throw new AppError('feishu-owner-not-in-group', '配置的飞书账号必须在群内，请加入后重新预览。');
        }
        return { chatId, name: displayName(group.name) };
      }, inspectError);
    },
    createGroup(name, uuid): Promise<FeishuGroup> {
      const failure = () => new AppError('feishu-create-failed', '飞书建群结果待核对。请检查应用权限，或用原群名称重试。');
      return rest(async () => {
        assertUuid(uuid);
        const group = dataFrom(await im.chat.create({
          params: { user_id_type: 'open_id', uuid },
          data: { name, chat_type: 'private', chat_mode: 'group', group_message_type: 'chat', external: false,
            owner_id: ownerOpenId, user_id_list: [ownerOpenId] },
        }), failure);
        if (!isFeishuChatId(group.chat_id)) throw failure();
        return { chatId: group.chat_id, name: displayName(group.name ?? name) };
      }, failure);
    },
    sendText(chatId, text, uuid, canDispatch): Promise<void> {
      return rest(async () => {
        if (!isReady(connection)) throw new AppError('feishu-not-ready', '飞书长连接当前不可用。');
        assertChatId(chatId);
        assertUuid(uuid);
        const data = { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }), uuid };
        if (Buffer.byteLength(JSON.stringify(data)) > MAX_TEXT_BODY_BYTES) {
          throw new AppError('feishu-text-too-long', '该条文本超出飞书消息长度限制。');
        }
        const response = await im.message.create({ params: { receive_id_type: 'chat_id' }, data });
        if (typeof response?.code === 'number' && response.code !== 0) {
          throw SEND_THROTTLED_CODES.has(response.code) ? sendRetryable() : sendFailed();
        }
        if (response?.code !== 0 || !response.data?.message_id) throw sendRetryable();
      }, sendHttpError, () => isReady(connection) && (canDispatch?.() ?? true));
    },
  };
}
