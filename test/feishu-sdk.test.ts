import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { FeishuGroups } from '../src/feishu-groups.ts';
import { checkFeishuConfig, createFeishuTransport } from '../src/feishu-sdk.ts';
import type { FeishuConnectionState, FeishuGroupTextMessage, FeishuPrivateTextMessage } from '../src/feishu-types.ts';
import { Store } from '../src/store.ts';

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
const applicationUrl = `https://open.feishu.cn/open-apis/application/v6/applications/${config.appId}`;
const publishedVersionUrl = `${applicationUrl}/app_versions/versionOnline`;
const issued = { code: 0, tenant_access_token: token, expire: 7200 };

function configCheck(respond: (request: Request) => unknown, status = 200) {
  const calls: Request[] = [];
  return { calls, run: () => checkFeishuConfig(config, {
    async httpAdapter(request) {
      calls.push(request);
      return { config: request, data: await respond(request), status, statusText: 'Fixture response', headers: {} };
    },
  }) };
}

test('credential verification exchanges a fresh tenant token each time and performs no permission queries', async () => {
  const f = configCheck(() => issued);
  assert.deepEqual(await f.run(), { credentials: 'passed' });
  assert.deepEqual(await f.run(), { credentials: 'passed' });
  assert.deepEqual(f.calls.map(({ method, url }) => [method, url]), [['post', tokenUrl], ['post', tokenUrl]]);
  assert.deepEqual(JSON.parse(f.calls[0]!.data), { app_id: config.appId, app_secret: config.appSecret });
  assert.equal(f.calls[1]!.headers.Authorization, undefined);
});

test('configuration detection distinguishes invalid credentials from network uncertainty', async () => {
  const invalid = configCheck(() => ({ code: 10014, msg: config.appSecret }), 400);
  const serverFailure = configCheck(() => ({ code: 10014, msg: config.appSecret }), 503);
  const unknown = configCheck(() => ({ code: 99991672, msg: config.appSecret }));
  const malformed = configCheck(() => ({ code: 0, tenant_access_token: '' }));
  const offline = configCheck(() => { throw Error(`${config.appSecret} ${token}`); });
  for (const [probe, expected] of [
    [invalid, 'failed'], [serverFailure, 'unverified'], [unknown, 'unverified'], [malformed, 'unverified'], [offline, 'unverified'],
  ] as const) {
    const result = await probe.run();
    assert.deepEqual(result, { credentials: expected });
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
  const messages: FeishuGroupTextMessage[] = [];
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
    onMessage: (message: FeishuGroupTextMessage) => { messages.push(message); },
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
    { chatId: 'oc_one', messageId: 'om_exact', senderOpenId: config.ownerOpenId, createdAt: 1795427300123, text: '部署进度如何？', receiptKind: 'plain' },
    { chatId: 'oc_one', messageId: 'om_topic', senderOpenId: config.ownerOpenId, createdAt: 1795427300123, text: '@助手 继续', receiptKind: 'unclassified' },
    { chatId: 'oc_one', messageId: 'om_new', senderOpenId: config.ownerOpenId, createdAt: 1795427300123, text: '  重连以后\n', receiptKind: 'plain' },
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
    return { code: 0, data: { name: '群主已授权', chat_mode: 'group', chat_status: 'normal', owner_id: config.ownerOpenId } };
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

for (const [scenario, description] of [
  ['ready', 'new group binds from member-only details while the joined list is stale'],
  ['sparse', 'limited new group details cannot bind, and retry uses the saved chat ID'],
  ['unavailable', 'new group binds on retry when details are briefly unavailable'],
  ['not-a-member', 'new group member details cannot override an explicit negative membership check'],
] as const) {
  test(description, async t => {
    const chatId = 'oc_created';
    const name = '新建测试群';
    const chatsUrl = 'https://open.feishu.cn/open-apis/im/v1/chats';
    const groupUrl = `${chatsUrl}/${chatId}`;
    let state: 'ready' | 'sparse' | 'unavailable' | 'not-a-member' = scenario;
    const f = fixture(request => {
      if (request.url === chatsUrl && request.method === 'post') return { code: 0, data: { chat_id: chatId } };
      if (request.url === chatsUrl) return { code: 0, data: { items: [{ chat_id: 'oc_unrelated' }] } };
      if (request.url === `${groupUrl}/members/is_in_chat`) {
        if (state === 'not-a-member') return { code: 0, data: { is_in_chat: false } };
        throw Object.assign(Error('Forbidden'), { config: request, response: { status: 400, data: { code: 99991672 } } });
      }
      assert.equal(request.url, groupUrl);
      assert.equal(request.method, 'get');
      assert.equal(request.headers.Authorization, `Bearer ${token}`);
      assert.equal(request.params.user_id_type, 'open_id');
      if (state === 'unavailable') {
        state = 'ready';
        return { code: 232006 };
      }
      return { code: 0, data: { name, chat_status: 'normal', bot_count: '1', user_count: '1',
        ...(state !== 'sparse' ? { chat_mode: 'group', owner_id: config.ownerOpenId } : {}),
      } };
    });
    t.after(() => f.transport.stop());
    const store = new Store(':memory:');
    t.after(() => store.close());
    const bot = store.createBot('bot:create-feishu', { name, instructions: '合成测试 Bot' });
    const groups = new FeishuGroups(store, config, f.transport);
    const resume = scenario === 'sparse' || scenario === 'not-a-member';
    if (resume) {
      await assert.rejects(groups.create(bot.id, name, 'initial'), { code: 'feishu-created-not-visible' });
      assert.equal(groups.get(bot.id), null);
      state = 'ready';
    }
    const resumed = resume ? new FeishuGroups(store, config, f.transport) : groups;
    const binding = await resumed.create(bot.id, name, 'bind');
    assert.equal(binding.chatId, chatId);
    assert.equal(binding.name, name);
    assert.deepEqual(resumed.get(bot.id), binding);
    assert.equal(f.calls.filter(call => call.url === chatsUrl && call.method === 'post').length, 1);
  });
}

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
    assert.equal((error as { code: string }).code, 'feishu-chat-members-scope');
    assert.match(String(error), /im:chat\.members:read/);
    assert.doesNotMatch(String(error), /SYNTHETIC_PRIVATE_/);
    return true;
  });
  assert.equal(f.calls.filter(call => call.url?.endsWith('/im/v1/chats')).length, 1);
  assert.equal(f.calls.filter(call => call.url?.endsWith('/members')).length, 1);
});

test('creating a group reports the scope only for an exact denial at the create endpoint', async t => {
  let code = 99991672;
  const f = fixture(request => {
    assert.ok(request.url?.endsWith('/im/v1/chats'));
    throw Object.assign(Error(config.appSecret), { config: request, response: { status: 403, data: { code } } });
  });
  t.after(() => f.transport.stop());
  await assert.rejects(f.transport.createGroup('专用群', 'same-id'), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'feishu-chat-create-scope');
    assert.match(String(error), /im:chat:create/);
    assert.doesNotMatch(String(error), /SYNTHETIC_PRIVATE_/);
    return true;
  });
  code = 99991679;
  await assert.rejects(f.transport.createGroup('专用群', 'same-id'), { code: 'feishu-create-failed' });
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

test('group diagnosis reads only this app’s online version and recognizes modern and legacy tenant grants', async t => {
  const scopeNames = ['im:message.group_msg', 'im:message.group_msg:readonly'];
  let scopes: unknown[] = [{ scope: scopeNames[0], token_types: ['tenant'] }];
  let events = ['接收消息'];
  let eventInfos: unknown[] | undefined = [{ event_type: eventKind, event_name: '接收消息' }];
  const f = fixture(request => {
    assert.equal(request.method, 'get');
    assert.equal(request.params.lang, 'zh_cn');
    assert.equal(request.headers.Authorization, `Bearer ${token}`);
    if (request.url === applicationUrl) return { code: 0, data: { app: {
      app_id: config.appId, online_version_id: 'versionOnline', unaudit_version_id: 'versionDraft',
      scopes: [{ scope: 'im:message.group_msg', token_types: ['tenant'] }], event: { subscribed_events: [eventKind] },
    } } };
    assert.equal(request.url, publishedVersionUrl);
    return { code: 0, data: { app_version: { app_id: config.appId, version_id: 'versionOnline', status: 1,
      scopes, events, event_infos: eventInfos } } };
  });
  t.after(() => f.transport.stop());
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.transport.diagnoseGroup(), { ordinaryTextGrant: 'present', receiveSubscription: 'present' });
  scopes = [scopeNames[1]];
  eventInfos = undefined;
  events = [eventKind];
  assert.deepEqual(await f.transport.diagnoseGroup(), { ordinaryTextGrant: 'present', receiveSubscription: 'present' });
  scopes = [{ scope: scopeNames[0], token_types: ['user'] }];
  eventInfos = [{ event_type: 'contact.user.created_v3' }];
  events = ['contact.user.created_v3'];
  assert.deepEqual(await f.transport.diagnoseGroup(), { ordinaryTextGrant: 'missing', receiveSubscription: 'missing' });
  const readUrls = f.calls.filter(call => call.method === 'get').map(call => call.url);
  assert.deepEqual(readUrls, Array.from({ length: 3 }, () => [applicationUrl, publishedVersionUrl]).flat());
});

test('group diagnosis keeps missing data, mismatched version, API denial and network failure unknown', async t => {
  let app: Record<string, unknown> = { app_id: config.appId, online_version_id: 'versionOnline' };
  let version: Record<string, unknown> = { app_id: config.appId, version_id: 'versionOnline' };
  let failure = 'none';
  const f = fixture(request => {
    if (request.url === applicationUrl) return { code: 0, data: { app } };
    assert.equal(request.url, publishedVersionUrl);
    if (failure === 'network') throw Error(config.appSecret);
    if (failure === 'scope') return { code: 99991672, msg: config.appSecret };
    return { code: 0, data: { app_version: version } };
  });
  t.after(() => f.transport.stop());
  const unknown = { ordinaryTextGrant: 'unknown', receiveSubscription: 'unknown' };
  assert.deepEqual(await f.transport.diagnoseGroup(), unknown);
  version = { ...version, scopes: [{ scope: 'im:message.group_msg' }], events: ['显示名'] };
  assert.deepEqual(await f.transport.diagnoseGroup(), unknown);
  version = { ...version, scopes: ['显示名'] };
  assert.deepEqual(await f.transport.diagnoseGroup(), unknown);
  const complete = { ...version, scopes: [], events: [] };
  for (const differs of [{ version_id: 'versionDraft' }, { app_id: 'cli_other' }, { status: 3 }]) {
    version = { ...complete, ...differs };
    assert.deepEqual(await f.transport.diagnoseGroup(), unknown);
  }
  for (failure of ['network', 'scope']) assert.deepEqual(await f.transport.diagnoseGroup(), unknown);
  const prior = f.calls.length;
  app = { ...app, app_id: 'cli_other' };
  assert.deepEqual(await f.transport.diagnoseGroup(), unknown);
  assert.deepEqual(f.calls.slice(prior).map(call => call.url), [applicationUrl]);
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

test('group evidence uses structured mention targets for the authenticated app robot only', async t => {
  const f = fixture(request => {
    assert.ok(request.url?.endsWith('/open-apis/bot/v3/info'));
    assert.equal(request.method, 'get');
    return { code: 0, bot: { open_id: 'ou_thisrobot', app_name: 'Same name' } };
  });
  t.after(() => f.transport.stop());
  f.transport.start(f.handlers);
  const socket = f.sockets[0]!;
  socket.options.onReady?.();
  const emit = (id: string, text: string, mentions?: unknown, headerApp = config.appId) =>
    socket.event!.eventDispatcher.invoke({ schema: '2.0', header: { event_type: eventKind, app_id: headerApp },
      event: { app_id: config.appId, sender, message: { ...message, message_id: id,
        content: JSON.stringify({ text }), mentions } } }, { needCheck: false });
  await emit('om_literal', 'Typed by hand: @Same name');
  await emit('om_empty', 'No mentions', []);
  await emit('om_invalid', 'Invalid structured data', null);
  await emit('om_all', '@_all hello', [{ key: '@_all', name: '所有人', id: { open_id: 'ou_thisrobot' } }]);
  assert.equal(f.calls.length, 0);
  const mention = { key: '@_user_1', name: 'Same name', id: { open_id: 'ou_thisrobot' } };
  await emit('om_wrong_app', '@_user_1 hello', [mention], 'cli_other');
  assert.equal(f.calls.length, 0);
  await emit('om_other', '@_user_1 hello', [{ ...mention, id: { open_id: 'ou_someoneelse' } }]);
  assert.equal(await f.messages.find(item => item.messageId === 'om_other')!.botMentionProof, false);
  await emit('om_wrong_identity_format', '@_user_1 hello', [{ ...mention, id: { user_id: 'ou_thisrobot' } }]);
  await emit('om_actual', '@_user_1 hello', [mention]);
  assert.deepEqual(f.messages.map(item => [item.messageId, item.receiptKind]), [
    ['om_literal', 'plain'], ['om_empty', 'plain'], ['om_invalid', 'unclassified'], ['om_all', 'unclassified'],
    ['om_other', 'unclassified'], ['om_wrong_identity_format', 'unclassified'], ['om_actual', 'bot-mention'],
  ]);
  assert.equal(f.calls.filter(request => request.url?.endsWith('/open-apis/bot/v3/info')).length, 1);
});

test('failed robot identity lookup never stops a group message from reaching its handler', async t => {
  const f = fixture(request => {
    assert.ok(request.url?.endsWith('/open-apis/bot/v3/info'));
    throw Error('Synthetic unavailable identity');
  });
  t.after(() => f.transport.stop());
  f.transport.start(f.handlers);
  const socket = f.sockets[0]!;
  socket.options.onReady?.();
  const emit = (id: string, mentioned: boolean) =>
    socket.event!.eventDispatcher.invoke({ schema: '2.0', header: { event_type: eventKind, app_id: config.appId },
      event: { sender, message: { ...message, message_id: id,
        content: JSON.stringify({ text: mentioned ? '@_user_1 hello' : 'ordinary' }),
        mentions: mentioned ? [{ key: '@_user_1', name: 'Unknown', id: { open_id: 'ou_candidate' } }] : [] } } },
    { needCheck: false });
  await emit('om_unknown_one', true);
  await emit('om_unknown_two', true);
  await emit('om_plain', false);
  assert.deepEqual(await Promise.all(f.messages.slice(0, 2).map(item => item.botMentionProof)), [false, false]);
  assert.deepEqual(f.messages.map(item => [item.text, item.receiptKind]), [
    ['@Unknown hello', 'unclassified'], ['@Unknown hello', 'unclassified'], ['ordinary', 'plain'],
  ]);
  assert.equal(f.calls.filter(request => request.url?.endsWith('/open-apis/bot/v3/info')).length, 1);
});

test('pending robot identity does not delay the SDK handler for a real structured mention', async t => {
  let prove!: (value: unknown) => void;
  const identity = new Promise(resolve => { prove = resolve; });
  const f = fixture(() => identity);
  t.after(() => f.transport.stop());
  f.transport.start(f.handlers);
  const socket = f.sockets[0]!;
  socket.options.onReady?.();
  const emit = (id: string, text: string, mentions?: unknown) =>
    socket.event!.eventDispatcher.invoke({ schema: '2.0', header: { event_type: eventKind, app_id: config.appId },
      event: { sender, message: { ...message, message_id: id, content: JSON.stringify({ text }), mentions } } },
    { needCheck: false });
  await emit('om_first', '@_user_1 first', [{ key: '@_user_1', name: 'Robot', id: { open_id: 'ou_robot' } }]);
  await emit('om_second', 'second');
  assert.deepEqual(f.messages.map(item => item.messageId), ['om_first', 'om_second']);
  assert.equal(f.messages[0]!.receiptKind, 'unclassified');
  assert.equal(f.messages[1]!.receiptKind, 'plain');
  prove({ code: 0, bot: { open_id: 'ou_robot' } });
  assert.equal(await f.messages[0]!.botMentionProof, true);
});
