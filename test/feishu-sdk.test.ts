import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { checkFeishuConfig, createFeishuTransport } from '../src/feishu-sdk.ts';
import type { FeishuConnectionState, FeishuPrivateTextMessage, FeishuTextMessage } from '../src/feishu-types.ts';

const config = { appId: 'cli_fixture', appSecret: 'SYNTHETIC_PRIVATE_SECRET', ownerOpenId: 'ou_fixture' };
const token = 'SYNTHETIC_PRIVATE_TOKEN';
const eventKind = 'im.message.receive_v1';
type Options = NonNullable<Parameters<typeof createFeishuTransport>[1]>;
type CreateSocket = NonNullable<Options['createSocket']>;
type SocketOptions = Parameters<CreateSocket>[0];
type SocketStart = Parameters<ReturnType<CreateSocket>['start']>[0];
type Adapter = Extract<Options['httpAdapter'], (...args: never[]) => unknown>;
type Request = Parameters<Adapter>[0];

const tokenUrl = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const scopesUrl = `https://open.feishu.cn/open-apis/application/v6/applications/${config.appId}`;
const issued = { code: 0, tenant_access_token: token, expire: 7200 };

function configCheck(respond: (request: Request) => unknown) {
  const calls: Request[] = [];
  return { calls, run: () => checkFeishuConfig(config, {
    async httpAdapter(request) {
      calls.push(request);
      return { config: request, data: await respond(request), status: 200, statusText: 'OK', headers: {} };
    },
  }) };
}

test('configuration detection always requests a fresh token and only reads application scopes', async () => {
  const f = configCheck(request => request.url === tokenUrl ? issued : {
    code: 0, data: { app: { app_id: config.appId, scopes: [
      { scope: 'im:message.group_at_msg:readonly', token_types: ['tenant'] },
      { scope: 'im:message:send_as_bot', token_types: ['tenant'] },
      { scope: 'im:chat:read', token_types: ['tenant'] },
      { scope: 'im:chat.members:read', token_types: ['user'] },
    ] } },
  });
  const result = await f.run();
  assert.equal(result.credentials, 'passed');
  const permissions = Object.fromEntries(result.permissions.map(({ scope, status }) => [scope, status]));
  assert.ok(Object.hasOwn(permissions, 'im:message.group_at_msg:readonly'));
  assert.equal(permissions['im:message:send_as_bot'], 'passed');
  assert.equal(permissions['im:chat:read'], 'passed');
  assert.equal(permissions['im:chat:create'], 'missing');
  assert.equal(permissions['im:chat.members:read'], 'missing');
  assert.equal(Object.hasOwn(permissions, 'im:message.group_msg'), false);
  await f.run();
  assert.deepEqual(f.calls.map(({ method, url }) => [method, url]), [
    ['post', tokenUrl], ['get', scopesUrl], ['post', tokenUrl], ['get', scopesUrl],
  ]);
  assert.ok(JSON.parse(f.calls[0]!.data).app_secret === config.appSecret);
  assert.ok(f.calls[1]!.headers.Authorization === `Bearer ${token}`);
  assert.equal(f.calls[1]!.params.lang, 'zh_cn');
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_/);
});

test('configuration detection keeps scopes unverified when the read-only inquiry is unavailable', async () => {
  for (const scopesResponse of [
    { code: 99991672, msg: config.appSecret },
    { code: 0, data: { app: {} } },
    { code: 0, data: { app: { scopes: [] } } },
    { code: 0, data: { app: { app_id: 'cli_other', scopes: [] } } },
  ]) {
    const f = configCheck(request => request.url === tokenUrl ? issued : scopesResponse);
    const result = await f.run();
    assert.equal(result.credentials, 'passed');
    assert.ok(result.permissions.length > 0);
    assert.ok(result.permissions.every(({ status }) => status === 'unverified'));
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_/);
  }
});

test('configuration detection reports an unknown token type as unverified', async () => {
  const f = configCheck(request => request.url === tokenUrl ? issued : {
    code: 0, data: { app: { app_id: config.appId, scopes: [
      { scope: 'im:message:send_as_bot', token_types: ['undocumented'] },
    ] } },
  });
  const result = await f.run();
  assert.equal(result.permissions.find(item => item.scope === 'im:message:send_as_bot')?.status, 'unverified');
});

test('configuration detection distinguishes invalid credentials from network uncertainty', async () => {
  const invalid = configCheck(() => ({ code: 10014, msg: config.appSecret }));
  const offline = configCheck(() => { throw Error(`${config.appSecret} ${token}`); });
  for (const [probe, expected] of [[invalid, 'failed'], [offline, 'unverified']] as const) {
    const result = await probe.run();
    assert.equal(result.credentials, expected);
    assert.ok(result.permissions.every(({ status }) => status === 'unverified'));
    assert.deepEqual(probe.calls.map(({ url }) => url), [tokenUrl]);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_/);
  }
});

test('a new transport obtains its own token when the same application rotates its secret', async t => {
  const appId = 'cli_secretRotation';
  const requests: Array<{ secret?: string; authorization?: string }> = [];
  for (const version of ['before', 'after']) {
    const secret = `fixture-secret-${version}`;
    const accessToken = `fixture-token-${version}`;
    const transport = createFeishuTransport({ ...config, appId, appSecret: secret }, {
      async httpAdapter(request) {
        let data: unknown;
        if (request.url === tokenUrl) {
          requests.push({ secret: JSON.parse(request.data).app_secret });
          data = { ...issued, tenant_access_token: accessToken };
        } else {
          assert.equal(request.method, 'get');
          requests.push({ authorization: String(request.headers.Authorization) });
          data = request.url?.endsWith('/members/is_in_chat') ? { code: 0, data: { is_in_chat: true } }
            : { code: 0, data: { owner_id: config.ownerOpenId, chat_mode: 'group', name: '合成群' } };
        }
        return { config: request, data, status: 200, statusText: 'OK', headers: {} };
      },
    });
    t.after(() => transport.stop());
    assert.equal((await transport.inspectGroup('oc_rotated')).name, '合成群');
    transport.stop();
  }
  assert.deepEqual(requests, [
    { secret: 'fixture-secret-before' }, { authorization: 'Bearer fixture-token-before' }, { authorization: 'Bearer fixture-token-before' },
    { secret: 'fixture-secret-after' }, { authorization: 'Bearer fixture-token-after' }, { authorization: 'Bearer fixture-token-after' },
  ]);
});

function fixture(handler: (request: Request) => unknown = () => { throw Error('Unexpected API call'); }, timeout?: number,
  beforeToken?: () => void) {
  const calls: Request[] = [];
  const sockets: Array<{ options: SocketOptions; event?: SocketStart; closed?: boolean }> = [];
  const messages: FeishuTextMessage[] = [];
  const privateMessages: FeishuPrivateTextMessage[] = [];
  const states: FeishuConnectionState[] = [];
  const credentials = beforeToken ? { ...config, appId: 'cli_revocation_fixture' } : config;
  const transport = createFeishuTransport(credentials, {
    requestTimeoutMs: timeout,
    createSocket(options) {
      const entry: typeof sockets[number] = { options };
      sockets.push(entry);
      return { async start(event) { entry.event = event; }, close() { entry.closed = true; } };
    },
    async httpAdapter(request) {
      calls.push(request);
      const tokenRequest = request.url?.endsWith('/tenant_access_token/internal');
      if (tokenRequest) beforeToken?.();
      const data = tokenRequest ? { code: 0, tenant_access_token: token, expire: 7200 } : await handler(request);
      return { config: request, data, status: 200, statusText: 'OK', headers: {} };
    },
  });
  const handlers = {
    onMessage: (message: FeishuTextMessage) => { messages.push(message); },
    onPrivateMessage: (message: FeishuPrivateTextMessage) => { privateMessages.push(message); },
    onConnection: (state: FeishuConnectionState) => { states.push(state); },
  };
  return { transport, handlers, sockets, calls, messages, privateMessages, states };
}

const sender = { sender_type: 'user', sender_id: { open_id: config.ownerOpenId } };
const message = { chat_type: 'group', chat_id: 'oc_one', message_id: 'om_exact', message_type: 'text',
  create_time: '1795427300123', content: JSON.stringify({ text: '部署进度如何？' }) };

test('official dispatcher preserves nested message time, filters senders and formats, and supports @ and topics', async t => {
  const f = fixture();
  t.after(() => f.transport.stop());
  f.transport.start(f.handlers);
  f.transport.start(f.handlers);
  const socket = f.sockets[0]!;
  assert.equal(f.sockets.length, 1);
  assert.equal(socket.options.autoReconnect, true);
  assert.ok(socket.options.handshakeTimeoutMs);
  const emit = (changes: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) =>
    socket.event!.eventDispatcher.invoke({ schema: '2.0', header: { event_type: eventKind, app_id: config.appId, ...overrides,
      create_time: '1795427309999' }, event: { sender, message, ...changes } }, { needCheck: false });
  await emit();
  assert.equal(f.messages.length, 0);
  socket.options.onReady?.();
  await emit();
  await emit({ message: { ...message, message_id: 'om_topic', chat_type: 'topic_group',
    content: JSON.stringify({ text: '@_user_1 继续' }), mentions: [{ key: '@_user_1', name: '助手' }] } });
  for (const malformed of [
    { message: { ...message, chat_type: 'p2p' } },
    { message: { ...message, chat_id: 'fake' } },
    { message: { ...message, content: '{}' } },
    { message: { ...message, content: 'not JSON' } },
    { message: { ...message, content: JSON.stringify({ text: '  ' }) } },
    { message: { ...message, content: JSON.stringify({ text: '@_user_1' }), mentions: [{ key: '@_user_1', name: '助手' }] } },
    { message: { ...message, message_type: 'file' } },
    { message: { ...message, create_time: undefined } },
    { message: { ...message, create_time: '1795427300.123' } },
    { message: { ...message, create_time: '9007199254740992' } },
    { sender: { ...sender, sender_type: 'app' } },
    { sender: { ...sender, sender_id: { open_id: 'ou_groupmember' } } },
  ]) await emit(malformed);
  await emit({}, { app_id: 'cli_other' });
  socket.options.onReconnecting?.();
  await emit();
  socket.options.onReconnected?.();
  await emit({ message: { ...message, message_id: 'om_new', content: JSON.stringify({ text: '  重连以后\n' }) } });
  f.transport.stop();
  socket.options.onReconnected?.();
  await emit();
  assert.equal(socket.closed, true);
  assert.deepEqual(f.states, ['connecting', 'ready', 'reconnecting', 'reconnected', 'stopped']);
  assert.deepEqual(f.messages, [
    { chatId: 'oc_one', messageId: 'om_exact', senderOpenId: config.ownerOpenId, createdAt: 1795427300123, text: '部署进度如何？' },
    { chatId: 'oc_one', messageId: 'om_topic', senderOpenId: config.ownerOpenId, createdAt: 1795427300123, text: '@助手 继续' },
    { chatId: 'oc_one', messageId: 'om_new', senderOpenId: config.ownerOpenId, createdAt: 1795427300123, text: '  重连以后\n' },
  ]);
  assert.equal(f.calls.length, 0);
});

test('official REST SDK creates a private owner group and sends chat text without dropping the caller UUID', async t => {
  const f = fixture(request => request.url?.endsWith('/im/v1/chats')
    ? { code: 0, data: { chat_id: 'oc_created', name: '私有群' } } : { code: 0, data: { message_id: 'om_sent' } });
  t.after(() => f.transport.stop());
  f.transport.start(f.handlers);
  await assert.rejects(f.transport.sendText('oc_created', '交付', 'stable-message'), { code: 'feishu-not-ready' });
  f.sockets[0]!.options.onReady?.();
  assert.deepEqual(await f.transport.createGroup('私有群', 'stable-group'), { chatId: 'oc_created', name: '私有群' });
  await f.transport.sendText('oc_created', '交付\n明细', 'stable-message');
  const create = f.calls.find(call => call.url?.endsWith('/im/v1/chats'))!;
  assert.equal(create.method, 'post');
  assert.deepEqual(create.params, { user_id_type: 'open_id', uuid: 'stable-group' });
  assert.deepEqual(JSON.parse(create.data), { name: '私有群', owner_id: config.ownerOpenId, user_id_list: [config.ownerOpenId],
    chat_type: 'private', chat_mode: 'group', group_message_type: 'chat', external: false });
  const send = f.calls.find(call => call.url?.endsWith('/im/v1/messages'))!;
  assert.equal(send.method, 'post');
  assert.deepEqual(send.params, { receive_id_type: 'chat_id' });
  assert.deepEqual(JSON.parse(send.data), { receive_id: 'oc_created', uuid: 'stable-message', msg_type: 'text',
    content: JSON.stringify({ text: '交付\n明细' }) });
  assert.equal(send.headers.Authorization, `Bearer ${token}`);
  await assert.rejects(f.transport.sendText('oc_created', '字'.repeat(50_000), 'too-long'), { code: 'feishu-text-too-long' });
  assert.equal(f.calls.filter(call => call.url?.endsWith('/im/v1/messages')).length, 1);
});

test('direct messages use the original WS application header and never go to group routing', async t => {
  const f = fixture();
  t.after(() => f.transport.stop());
  f.transport.start(f.handlers);
  const socket = f.sockets[0]!;
  const emit = (changes: Record<string, unknown> = {}, appId: unknown = config.appId, needCheck = false) =>
    socket.event!.eventDispatcher.invoke({ schema: '2.0', header: { event_type: eventKind, app_id: appId },
      event: { sender: { ...sender, sender_id: { open_id: 'ou_candidate' } },
        message: { ...message, chat_type: 'p2p' }, ...changes } }, { needCheck });
  await emit();
  socket.options.onReady?.();
  await emit({ app_id: config.appId }, 'cli_other');
  await emit({ app_id: config.appId }, null);
  await emit({}, config.appId, true);
  await emit({ sender: { ...sender, sender_type: 'app' } });
  await emit({ sender: { ...sender, sender_id: { user_id: 'ou_candidate' } } });
  await emit({ sender: { ...sender, sender_id: { open_id: 'untyped-id' } } });
  await emit({ message: { ...message, chat_type: 'p2p', content: '{}' } });
  await emit({ message: { ...message, chat_type: 'p2p', message_type: 'image' } });
  assert.deepEqual(f.privateMessages, []);
  await emit();
  assert.deepEqual(f.privateMessages, [{ appId: config.appId, chatId: 'oc_one', messageId: 'om_exact',
    senderOpenId: 'ou_candidate', createdAt: 1795427300123, text: '部署进度如何？' }]);
  assert.deepEqual(f.messages, []);
  socket.options.onReconnecting?.();
  await emit();
  f.transport.stop();
  await emit();
  assert.equal(f.privateMessages.length, 1);
  assert.equal(f.calls.length, 0);
});

test('requires active group, robot membership, and owner on a paginated roster', async t => {
  let inChat = false, mode = 'p2p', status = 'normal', present = true;
  const f = fixture(request => {
    const url = request.url ?? '';
    if (url.endsWith('/members/is_in_chat')) return { code: 0, data: { is_in_chat: inChat } };
    if (url.endsWith('/members')) return { code: 0, data: request.params.page_token
      ? { items: present ? [{ member_id: config.ownerOpenId }] : [], has_more: false }
      : { items: [{ member_id: 'ou_someone' }], page_token: 'next', has_more: true } };
    assert.ok(url.endsWith('/chats/oc_target'));
    return { code: 0, data: { name: '现有群', chat_mode: mode, chat_status: status } };
  });
  t.after(() => f.transport.stop());
  await assert.rejects(f.transport.inspectGroup('fake-id'), { code: 'feishu-chat-id' });
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.transport.inspectGroup('oc_target'), { code: 'feishu-bot-not-in-group' });
  inChat = true;
  await assert.rejects(f.transport.inspectGroup('oc_target'), { code: 'feishu-not-group' });
  mode = 'topic';
  status = 'dissolved';
  await assert.rejects(f.transport.inspectGroup('oc_target'), { code: 'feishu-not-group' });
  status = 'normal';
  assert.deepEqual(await f.transport.inspectGroup('oc_target'), { chatId: 'oc_target', name: '现有群' });
  present = false;
  await assert.rejects(f.transport.inspectGroup('oc_target'), { code: 'feishu-owner-not-in-group' });
  assert.ok(f.calls.some(call => call.url?.endsWith('/members') && call.params.page_token === 'next'));
});

test('uses the calling robot’s paginated joined groups only for the is_in_chat scope error', async t => {
  let scenario = 'http-scope';
  const f = fixture(request => {
    const url = request.url ?? '';
    if (url.endsWith('/members/is_in_chat')) {
      if (scenario === 'http-scope') throw Object.assign(Error('Forbidden'), {
        config: request, response: { status: 400, data: { code: 99991672, msg: config.appSecret } },
      });
      if (scenario === 'body-error') return { code: 99991671 };
      if (scenario === 'negative') return { code: 0, data: { is_in_chat: false } };
      return { code: 99991672 };
    }
    if (url.endsWith('/im/v1/chats')) {
      assert.equal(request.method, 'get');
      assert.equal(request.headers.Authorization, `Bearer ${token}`);
      assert.equal(request.params.page_size, 100);
      if (!request.params.page_token) return { code: 0, data: { items: [{ chat_id: 'oc_target_other' }], has_more: true, page_token: 'next' } };
      return { code: 0, data: { items: scenario === 'missing' ? [] : [{ chat_id: 'oc_target' }], has_more: false } };
    }
    assert.ok(url.endsWith('/chats/oc_target'));
    return { code: 0, data: { name: '群主已授权', chat_mode: 'group', owner_id: config.ownerOpenId } };
  });
  t.after(() => f.transport.stop());
  assert.deepEqual(await f.transport.inspectGroup('oc_target'), { chatId: 'oc_target', name: '群主已授权' });
  scenario = 'body-scope';
  assert.deepEqual(await f.transport.inspectGroup('oc_target'), { chatId: 'oc_target', name: '群主已授权' });
  scenario = 'missing';
  await assert.rejects(f.transport.inspectGroup('oc_target'), { code: 'feishu-bot-not-in-group' });
  const visited = f.calls.length;
  scenario = 'body-error';
  await assert.rejects(f.transport.inspectGroup('oc_target'), { code: 'feishu-group-lookup' });
  scenario = 'negative';
  await assert.rejects(f.transport.inspectGroup('oc_target'), { code: 'feishu-bot-not-in-group' });
  assert.deepEqual(f.calls.slice(visited).map(call => call.url?.split('/').at(-1)), ['is_in_chat', 'is_in_chat']);
  assert.equal(f.calls.filter(call => call.url?.endsWith('/members')).length, 0);
  assert.equal(f.calls.filter(call => call.url?.endsWith('/chats/oc_target')).length, 2);
});

test('joined groups cannot prove the configured user is a member when someone else owns the chat', async t => {
  const f = fixture(request => {
    const url = request.url ?? '';
    if (url.endsWith('/members/is_in_chat')) return { code: 99991672 };
    if (url.endsWith('/im/v1/chats')) return { code: 0, data: { items: [{ chat_id: 'oc_target' }] } };
    if (url.endsWith('/members')) return { code: 99991672, msg: config.appSecret };
    return { code: 0, data: { name: '他人为群主', chat_mode: 'group', owner_id: 'ou_other' } };
  });
  t.after(() => f.transport.stop());
  await assert.rejects(f.transport.inspectGroup('oc_target'), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'feishu-group-lookup');
    assert.doesNotMatch(String(error), /SYNTHETIC_PRIVATE_/);
    return true;
  });
  assert.equal(f.calls.filter(call => call.url?.endsWith('/im/v1/chats')).length, 1);
  assert.equal(f.calls.filter(call => call.url?.endsWith('/members')).length, 1);
});

test('joined groups rejects repeated tokens and observes the shared request deadline', async t => {
  const deadline = 150;
  let waitForAbort = false;
  const f = fixture(async request => {
    if (request.url?.endsWith('/members/is_in_chat')) return { code: 99991672 };
    assert.ok(request.url?.endsWith('/im/v1/chats'));
    if (waitForAbort && request.params.page_token) {
      await new Promise<void>(resolve => request.signal!.addEventListener!('abort', () => resolve()));
      throw Error('aborted');
    }
    return { code: 0, data: { items: [], has_more: true, page_token: 'repeated' } };
  }, deadline);
  t.after(() => f.transport.stop());
  await assert.rejects(f.transport.inspectGroup('oc_target'), { code: 'feishu-group-lookup' });
  assert.equal(f.calls.filter(call => call.url?.endsWith('/im/v1/chats')).length, 2);
  waitForAbort = true;
  await Promise.all([
    assert.rejects(f.transport.inspectGroup('oc_target'), { code: 'feishu-timeout' }), delay(deadline + 5),
  ]);
  assert.equal(f.calls.filter(call => call.url?.endsWith('/im/v1/chats')).length, 4);
});

test('network and connection failures expose only fixed messages and HTTP work has a deadline', async t => {
  const deadline = 150;
  let result = 'permanent';
  const f = fixture(async request => {
    if (result === 'permanent') return { code: 230001, msg: `${config.appSecret} ${token}`, data: {} };
    if (result === 'throttled') return { code: 230020, msg: `${config.appSecret} ${token}`, data: {} };
    if (result === 'network') throw new Error(`${config.appSecret} ${token}`);
    await new Promise<void>(resolve => request.signal!.addEventListener!('abort', () => resolve()));
    throw new Error(`${config.appSecret} ${token}`);
  }, deadline);
  t.after(() => f.transport.stop());
  f.transport.start(f.handlers);
  const socket = f.sockets[0]!;
  socket.options.onReady?.();
  const send = () => f.transport.sendText('oc_target', '私人消息', 'same-id');
  const secure = (code: string) => (error: unknown) => {
    assert.equal((error as { code: string }).code, code);
    assert.doesNotMatch(String(error), /SYNTHETIC_PRIVATE_|私人消息/);
    return true;
  };
  await assert.rejects(send(), secure('feishu-send-failed'));
  result = 'throttled';
  await assert.rejects(send(), secure('feishu-send-retryable'));
  result = 'network';
  await assert.rejects(send(), secure('feishu-send-retryable'));
  result = 'timeout';
  await Promise.all([assert.rejects(send(), secure('feishu-timeout')), delay(deadline + 5)]);
  socket.options.onError?.(new Error(config.appSecret));
  assert.deepEqual(f.states, ['connecting', 'ready', 'stopped']);
  assert.equal(socket.closed, true);
  await assert.rejects(send(), secure('feishu-not-ready'));
});

test('a binding revoked while fetching the token blocks the HTTP send before dispatch', async t => {
  let bound = true;
  const f = fixture(() => ({ code: 0, data: { message_id: 'om_sent' } }), undefined, () => { bound = false; });
  t.after(() => f.transport.stop());
  f.transport.start(f.handlers);
  f.sockets[0]!.options.onReady?.();
  await assert.rejects(f.transport.sendText('oc_target', '待发送', 'stable-id', () => bound), { code: 'feishu-binding-changed' });
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.url!, /tenant_access_token\/internal$/);
});
