import { AsyncLocalStorage } from 'node:async_hooks';
import { AppType, Client, DefaultCache, defaultHttpInstance, Domain, EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import { AppError } from './model.ts';
import { isFeishuChatId, isFeishuOpenId, type FeishuCheckResult, type FeishuConfig, type FeishuConnectionState,
  type FeishuCredentials, type FeishuGroup, type FeishuGroupDiagnosis, type FeishuGroupTextMessage, type FeishuHandlers,
  type FeishuTextMessage, type FeishuTransport } from './feishu-types.ts';

const MESSAGE_EVENT = 'im.message.receive_v1';
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_TEXT_BODY_BYTES = 150_000;
const BOT_IDENTITY_TIMEOUT_MS = 1200;
const BOT_IDENTITY_RETRY_MS = 10_000;
const FEISHU_ORIGIN = 'https://open.feishu.cn';
const MISSING_FEISHU_SCOPE = 99991672;
const ALL_GROUP_TEXT_SCOPES = new Set(['im:message.group_msg', 'im:message.group_msg:readonly']);
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

// Explicit parameter or credential rejections from the self-built token endpoint.
const CREDENTIAL_REJECTIONS = new Set([10003, 10005, 10014, 10015, 99991543]);

/** Exchanges a fresh token for these credentials without using the SDK's token cache. */
export async function checkFeishuConfig(config: FeishuCredentials, options: Pick<TransportOptions, 'httpAdapter' | 'requestTimeoutMs'>
  & { signal?: AbortSignal } = {}): Promise<FeishuCheckResult> {
  const timeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeout);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const http = defaultHttpInstance.create({ adapter: options.httpAdapter, timeout, maxRedirects: 0 });
  try {
    const response = await http.post<unknown>(`${FEISHU_ORIGIN}/open-apis/auth/v3/tenant_access_token/internal`,
      { app_id: config.appId, app_secret: config.appSecret }, { signal, validateStatus: status => status < 500 });
    signal.throwIfAborted();
    const { code, tenant_access_token: token } = object(response.data);
    if ((response.status === 200 || [400, 401, 403].includes(response.status))
      && typeof code === 'number' && CREDENTIAL_REJECTIONS.has(code)) return { credentials: 'failed' };
    if (response.status === 200 && code === 0 && typeof token === 'string' && /^\S+$/.test(token)) {
      return { credentials: 'passed' };
    }
  } catch { /* Transport failures leave the credentials unverified. */ }
  return { credentials: 'unverified' };
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

function humanText(event: Record<string, unknown>): FeishuTextMessage | null {
  const { sender, message } = event;
  const { sender_type: senderType, sender_id: senderId } = object(sender);
  const { open_id: senderOpenId } = object(senderId);
  const { chat_id: chatId, message_id: messageId, message_type: messageType,
    create_time: createTime, content, mentions } = object(message);
  if (senderType !== 'user' || !isFeishuOpenId(senderOpenId)) return null;
  if (messageType !== 'text' || !isFeishuChatId(chatId)) return null;
  if (typeof messageId !== 'string' || !/^om_[A-Za-z0-9_]{1,125}$/.test(messageId) || typeof content !== 'string') return null;
  const createdAt = typeof createTime === 'string' && /^\d+$/.test(createTime) ? Number(createTime) : createTime;
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) return null;
  if (Buffer.byteLength(content) > MAX_TEXT_BODY_BYTES) return null;
  const text = readableText(content, mentions);
  if (!text) return null;
  return { chatId, messageId, senderOpenId, createdAt, text };
}

function groupChat(value: unknown): boolean {
  return value === 'group' || value === 'topic_group' || value === 'topic';
}

type GroupEvent = (appId: unknown, payload: Record<string, unknown>, trusted: boolean) => Promise<void>;

class FeishuEventDispatcher extends EventDispatcher {
  constructor(cache: DefaultCache, private readonly onPrivate: (appId: unknown, payload: Record<string, unknown>) => void,
    private readonly onGroup: GroupEvent) {
    super({ logger, cache });
    this.register({
      [MESSAGE_EVENT]: async event => {
        const payload = object(event);
        if (groupChat(object(payload.message).chat_type)) await this.onGroup(payload.app_id, payload, false);
      },
    });
  }

  override async invoke(data: unknown, options?: { needCheck?: boolean }) {
    const { schema, header, event } = object(data);
    const envelope = object(header), payload = object(event);
    if (schema === '2.0' && envelope.event_type === MESSAGE_EVENT) {
      const chatType = object(payload.message).chat_type;
      // The SDK flattens header and body fields. Use the original header for trusted WS evidence.
      if (chatType === 'p2p') {
        if (options?.needCheck === false) this.onPrivate(envelope.app_id, payload);
        return;
      }
      if (groupChat(chatType) && options?.needCheck === false) return this.onGroup(envelope.app_id, payload, true);
    }
    return super.invoke(data, options);
  }
}

function stoppedError(): AppError {
  return new AppError('feishu-stopped', '飞书接入已停止。');
}

function inspectError(): AppError {
  return new AppError('feishu-group-lookup', '无法读取飞书群，请核对群 ID、机器人入群状态及应用权限。');
}

function scopeDeniedBy(error: unknown, path: string): boolean {
  const { response, config } = object(error);
  const { url } = object(config);
  return object(object(response).data).code === MISSING_FEISHU_SCOPE && typeof url === 'string' && url.endsWith(path);
}

async function withScopeDiagnosis<T extends { code?: number }>(request: Promise<T>, path: string, denied: () => AppError): Promise<T> {
  const response = await request.catch(error => {
    if (scopeDeniedBy(error, path)) throw denied();
    throw error;
  });
  if (response?.code === MISSING_FEISHU_SCOPE) throw denied();
  return response;
}

function ordinaryTextGrant(scopes: unknown): FeishuGroupDiagnosis['ordinaryTextGrant'] {
  if (!Array.isArray(scopes)) return 'unknown';
  const entries = scopes.map(value => {
    if (typeof value === 'string') return { scope: value, types: ['tenant'] };
    const { scope, token_types: types } = object(value);
    return { scope, types };
  });
  if (entries.some(({ scope }) => typeof scope !== 'string' || !/^[\w.-]+(?::[\w.-]+)+$/.test(scope))) return 'unknown';
  const grants = entries.filter(({ scope }) => ALL_GROUP_TEXT_SCOPES.has(scope as string));
  if (grants.some(({ types }) => Array.isArray(types) && types.includes('tenant'))) return 'present';
  return grants.some(({ types }) => !Array.isArray(types) || !types.length || types.some(type => type !== 'user'))
    ? 'unknown' : 'missing';
}

function eventKeys(events: unknown): string[] | undefined {
  return Array.isArray(events) && events.every(event => typeof event === 'string' && /^[\w]+(?:\.[\w]+)+$/.test(event))
    ? events : undefined;
}

function receiveSubscription(eventInfos: unknown, events: unknown): FeishuGroupDiagnosis['receiveSubscription'] {
  const keys = (Array.isArray(eventInfos) && eventKeys(eventInfos.map(info => object(info).event_type))) || eventKeys(events);
  if (!keys) return 'unknown';
  return keys.includes(MESSAGE_EVENT) ? 'present' : 'missing';
}

function unknownDiagnosis(): FeishuGroupDiagnosis {
  return { ordinaryTextGrant: 'unknown', receiveSubscription: 'unknown' };
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
  let botOpenId: string | undefined;
  let pendingBotIdentity: Promise<string | undefined> | undefined;
  let nextBotIdentityCheck = 0;

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
  const applications = client.application.v6;

  async function rest<T>(operation: () => Promise<T>, failure: (error: unknown) => AppError, allowSend?: () => boolean,
    timeoutMs = requestTimeoutMs): Promise<T> {
    const session = lifetime.signal;
    if (session.aborted) throw stoppedError();
    const deadline = AbortSignal.timeout(timeoutMs);
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

  function lookupBotIdentity(): Promise<string | undefined> {
    if (pendingBotIdentity) return pendingBotIdentity;
    if (botOpenId || Date.now() < nextBotIdentityCheck) return Promise.resolve(botOpenId);
    nextBotIdentityCheck = Date.now() + BOT_IDENTITY_RETRY_MS;
    const failure = () => new AppError('feishu-bot-identity', '未能确认当前应用的机器人身份。');
    pendingBotIdentity = rest(async () => {
      const result = await client.request<{ code?: number; bot?: { open_id?: string } }>({
        url: '/open-apis/bot/v3/info', method: 'GET',
      });
      return result.code === 0 && isFeishuOpenId(result.bot?.open_id) ? result.bot.open_id : undefined;
    }, failure, undefined, Math.min(requestTimeoutMs, BOT_IDENTITY_TIMEOUT_MS))
      .then(id => { botOpenId = id; return id; }, () => undefined)
      .finally(() => { pendingBotIdentity = undefined; });
    return pendingBotIdentity;
  }

  function groupReceipt(mentions: unknown): Pick<FeishuGroupTextMessage, 'receiptKind' | 'botMentionProof'> {
    if (mentions === undefined || (Array.isArray(mentions) && mentions.length === 0)) return { receiptKind: 'plain' };
    if (!Array.isArray(mentions)) return { receiptKind: 'unclassified' };
    const openIds = mentions.flatMap(mention => {
      const { key, id } = object(mention);
      const openId = object(id).open_id;
      return typeof key === 'string' && /^@_user_\d+$/.test(key) && isFeishuOpenId(openId) ? [openId] : [];
    });
    if (!openIds.length) return { receiptKind: 'unclassified' };
    if (botOpenId) return { receiptKind: openIds.includes(botOpenId) ? 'bot-mention' : 'unclassified' };
    return { receiptKind: 'unclassified',
      botMentionProof: lookupBotIdentity().then(identity => identity !== undefined && openIds.includes(identity)) };
  }

  async function robotMembership(chatId: string): Promise<boolean | undefined> {
    const path = { chat_id: chatId };
    const membership = await im.chatMembers.isInChat({ path }).catch(error => {
      if (scopeDeniedBy(error, `/im/v1/chats/${chatId}/members/is_in_chat`)) {
        return { code: MISSING_FEISHU_SCOPE, data: undefined };
      }
      throw error;
    });
    if (membership?.code === MISSING_FEISHU_SCOPE) return undefined;
    return dataFrom(membership, inspectError)?.is_in_chat === true;
  }

  function robotInJoinedGroups(chatId: string): Promise<boolean> {
    // This app-token endpoint lists only chats the calling bot belongs to.
    return hasPageItem(pageToken => im.chat.list({ params: { page_size: 100, page_token: pageToken } }), item => item.chat_id === chatId);
  }

  function ownerInGroup(chatId: string, owner: string): Promise<boolean> {
    const denied = () => new AppError('feishu-chat-members-scope', '飞书拒绝读取群成员。请核对应用的「查看群成员」权限（im:chat.members:read）并发布新版本。');
    return hasPageItem(pageToken => withScopeDiagnosis(im.chatMembers.get({
      path: { chat_id: chatId }, params: { member_id_type: 'open_id', page_size: 100, page_token: pageToken },
    }), `/im/v1/chats/${chatId}/members`, denied), member => member.member_id === owner);
  }

  async function diagnoseGroup(): Promise<FeishuGroupDiagnosis> {
    try {
      return await rest(async () => {
        const path = { app_id: appId }, params = { lang: 'zh_cn' as const };
        const app = dataFrom(await applications.application.get({ path, params }), inspectError).app;
        const versionId = app?.online_version_id;
        if (app?.app_id !== appId || typeof versionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(versionId)) return unknownDiagnosis();
        const version = dataFrom(await applications.applicationAppVersion.get({
          path: { ...path, version_id: versionId }, params,
        }), inspectError).app_version;
        if (version?.app_id !== appId || version.version_id !== versionId || (version.status !== undefined && version.status !== 1)) {
          return unknownDiagnosis();
        }
        return { ordinaryTextGrant: ordinaryTextGrant(version.scopes),
          receiveSubscription: receiveSubscription(version.event_infos, version.events) };
      }, inspectError);
    } catch { return unknownDiagnosis(); }
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
    diagnoseGroup,
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
        const dispatcher = new FeishuEventDispatcher(cache, (sourceAppId, payload) => {
          if (connection !== current || !isReady(current) || sourceAppId !== appId || !handlers.onPrivateMessage) return;
          const message = humanText(payload);
          if (message) handlers.onPrivateMessage({ ...message, appId });
        }, async (sourceAppId, payload, trusted) => {
          if (connection !== current || !isReady(current) || !ownerOpenId) return;
          if (sourceAppId !== undefined && sourceAppId !== appId) return;
          const message = humanText(payload);
          if (!message || message.senderOpenId !== ownerOpenId) return;
          const receipt = trusted && sourceAppId === appId
            ? groupReceipt(object(payload.message).mentions)
            : { receiptKind: 'unclassified' as const };
          try { await handlers.onMessage({ ...message, ...receipt }); }
          catch { throw new Error('Feishu message handoff failed'); }
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
    inspectGroup(chatId, source): Promise<FeishuGroup> {
      return rest(async () => {
        if (!ownerOpenId) throw new AppError('feishu-self-unbound', '请先在飞书连接设置中绑定本人身份。');
        assertChatId(chatId);
        const path = { chat_id: chatId };
        const getGroup = async () => dataFrom(await im.chat.get({ path, params: { user_id_type: 'open_id' } }), inspectError);
        const membership = await robotMembership(chatId);
        const createdGroupLookup = membership === undefined && source === 'created' ? getGroup() : undefined;
        // If the details are unavailable, the joined list still determines whether to retry membership.
        const details = await createdGroupLookup?.catch(() => undefined);
        // Feishu omits owner_id for nonmembers. Exact details for a created group can precede the joined list.
        const memberDetails = details?.owner_id === ownerOpenId
          && details.chat_mode === 'group' && details.chat_status === 'normal';
        const botInGroup = membership ?? (memberDetails || await robotInJoinedGroups(chatId));
        if (!botInGroup) throw new AppError('feishu-bot-not-in-group', '请先将此飞书应用的机器人加入群聊。');
        const group = details ?? await (createdGroupLookup ?? getGroup());
        if ((group.chat_mode !== 'group' && group.chat_mode !== 'topic') || (group.chat_status && group.chat_status !== 'normal')) {
          throw new AppError('feishu-not-group', '该 chat_id 对应的会话不是可用的飞书群。');
        }
        if (group.owner_id !== ownerOpenId && !await ownerInGroup(chatId, ownerOpenId)) {
          throw new AppError('feishu-owner-not-in-group', '配置的飞书账号必须在群内，请加入后重新预览。');
        }
        return { chatId, name: displayName(group.name) };
      }, inspectError);
    },
    createGroup(name, uuid): Promise<FeishuGroup> {
      const failure = () => new AppError('feishu-create-failed', '飞书建群结果待核对。请检查应用权限，或用原群名称重试。');
      const denied = () => new AppError('feishu-chat-create-scope', '飞书拒绝建群。请核对应用的「创建群」权限（im:chat:create）并发布新版本。');
      return rest(async () => {
        if (!ownerOpenId) throw new AppError('feishu-self-unbound', '请先在飞书连接设置中绑定本人身份。');
        assertUuid(uuid);
        const group = dataFrom(await withScopeDiagnosis(im.chat.create({
          params: { user_id_type: 'open_id', uuid },
          data: { name, chat_type: 'private', chat_mode: 'group', group_message_type: 'chat', external: false,
            owner_id: ownerOpenId, user_id_list: [ownerOpenId] },
        }), '/im/v1/chats', denied), failure);
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
