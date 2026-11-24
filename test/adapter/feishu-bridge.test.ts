import { ReloadAdmission } from '../../src/reload-admission.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { DshExecution } from '../../src/dsh.ts';
import { FeishuBridge } from '../../src/feishu-bridge.ts';
import { GROUP_EVIDENCE_KEY_PREFIX } from '../../src/feishu-group-evidence.ts';
import { FeishuGroups } from '../../src/feishu-groups.ts';
import type { FeishuConnectionState, FeishuGroupTextMessage, FeishuHandlers, FeishuTransport } from '../../src/feishu-types.ts';
import { Managers } from '../../src/manager.ts';
import { AppError, type ManagerBinding } from '../../src/model.ts';
import { Store } from '../../src/store.ts';

type FixtureAgent = {
  id: string;
  session: { id: string };
  history: any[];
  status: string;
  canceled: number;
  ctx: object;
  inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[]; remove(messageId: string): void };
  whenIdle(): Promise<void>;
  cancel(): void;
  occupy(): void;
  release(): void;
  followup(message: UserMessage): void;
  event(type: string, data: unknown, surfaceOp?: string, time?: number): Promise<object>;
  startTurn(): Promise<void>;
  propose(message: UserMessage): Promise<{ kind: 'enter'; messages: UserMessage[] } | { kind: 'reject' }>;
  enter(message?: UserMessage): Promise<UserMessage>;
  assistant(text: string, options?: { tool?: boolean; interrupted?: boolean; time?: number; finish?: string }): Promise<object>;
  endTurn(kind?: string): Promise<void>;
};

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const identity = { appId: 'cli_synthetic', ownerOpenId: 'ou_owner' };

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  const advance = () => ++now;
  const dir = mkdtempSync(join(tmpdir(), 'sb-feishu-'));
  let store = new Store(join(dir, 'ledger.sqlite'));
  const hooks = new Map<string, Set<Function>>();
  let tool: any;
  const agents = new Map<string, FixtureAgent>();
  const emit = async (name: string, ...args: unknown[]) => {
    await Promise.all([...(hooks.get(name) ?? [])].map(listener => listener(...args)));
  };
  const on = (name: string, listener: Function) => {
    if (!hooks.has(name)) hooks.set(name, new Set());
    hooks.get(name)!.add(listener);
    return () => hooks.get(name)!.delete(listener);
  };
  let delayedResolve: Promise<void> | undefined;
  const ctx = {
    on, effect: (start: Function) => start(),
    tools: { register: (item: any) => { tool = item; return () => {}; } },
    agents: { list: () => [...agents.values()], get: (id: string) => agents.get(id) },
    sessionController: { resolveAgent: async (id: string) => {
      await delayedResolve;
      const agent = agents.get(id);
      return agent ? { agent } : { error: 'synthetic missing' };
    } },
    sessionProjections: { snapshot: () => ({ values: { modelSelection: { next: model } } }) },
    sessions: { flush: async () => true },
    sessionPersistence: {
      stat: async (id: string) => ({ eventCount: agents.get(id)!.history.length, sizeBytes: 100 }),
      open: async (id: string) => ({
        header: { id }, read: async () => ({ events: agents.get(id)!.history }), close: async () => {},
      }),
    },
  } as unknown as Context;
  let model: unknown = { provider: 'synthetic', model: 'synthetic' };
  function attach(binding: ManagerBinding) {
    const id = binding.requestedSessionId, session = { id };
    const history: any[] = [];
    let turn = 0, settle = () => {}, idle = Promise.resolve();
    let preStep: Function;
    function event(type: string, data: unknown, surfaceOp?: string, time = advance()) {
      const value = { type, data, seq: history.length, time, ...(surfaceOp ? { surfaceOp } : {}) };
      history.push(value);
      return emit('session/event', session, value).then(() => value);
    }
    const agent: FixtureAgent = {
      id, session, history, status: 'idle', canceled: 0,
      ctx: {
        on: (_name: string, fn: Function) => { preStep = fn; return () => {}; },
        tools: { restrict: () => () => {}, guard: () => () => {} },
        systemPrompt: { section: () => () => {} },
      },
      inbox: {
        nextTurn: [] as UserMessage[],
        nextStep: [] as UserMessage[],
        remove(messageId: string) {
          this.nextTurn = this.nextTurn.filter(message => message.id !== messageId);
          this.nextStep = this.nextStep.filter(message => message.id !== messageId);
        },
      },
      whenIdle: () => idle,
      cancel: () => { agent.canceled++; },
      occupy() {
        agent.status = 'running';
        idle = new Promise<void>(resolve => { settle = resolve; });
      },
      release() {
        agent.status = 'idle';
        settle();
      },
      followup(message: UserMessage) {
        agent.inbox.nextTurn.push(message);
        if (agent.status === 'idle') agent.occupy();
        void event('agent/inbox/spliced', { target: 'next-turn', inserted: [message], start: agent.inbox.nextTurn.length - 1 });
      },
      event,
      async startTurn() { await event('turn/start', { turn: ++turn }); },
      async propose(message: UserMessage): Promise<{ kind: 'enter'; messages: UserMessage[] } | { kind: 'reject' }> {
        agent.inbox.remove(message.id);
        return preStep({ turn, agent }, async () => ({ kind: 'enter', messages: [message] }));
      },
      async enter(message: UserMessage = agent.inbox.nextTurn[0]!): Promise<UserMessage> {
        assert.ok(message, 'a native user message is available');
        await agent.startTurn();
        const decision = await agent.propose(message);
        assert.ok(decision.kind === 'enter');
        await event('user/message', decision.messages[0], 'append');
        return message;
      },
      assistant(text: string, options: { tool?: boolean; interrupted?: boolean; time?: number; finish?: string } = {}) {
        const content: any[] = [{ type: 'text', text }];
        if (options.tool) content.push({ type: 'tool-call', name: 'synthetic' });
        return event('assistant/message', {
          turn, interrupted: options.interrupted,
          message: { id: `reply-${history.length}`, role: 'assistant', source: { kind: 'model' }, content },
          stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: options.finish ?? 'stop' } } }],
        }, 'append', options.time);
      },
      async endTurn(kind = 'completed') {
        await event('turn/end', { turn, reason: { kind, ...(kind === 'error' ? { error: { code: 'Synthetic' } } : {}) } });
        agent.release();
      },
    };
    agents.set(id, agent);
    return agent;
  }
  function provision(name: string) {
    const bot = store.createBot(`bot:${name}`, { name, instructions: 'Synthetic Manager' });
    const initial = store.beginManager(`manager:${name}`, bot.id, dir);
    store.confirmManager(initial.id, initial.requestedSessionId);
    return { bot, initial, agent: attach(initial) };
  }
  const a = provision('Alpha'), b = provision('Beta');
  const sent: { chatId: string; text: string; uuid: string }[] = [];
  let handlers: FeishuHandlers;
  let send: (_: (typeof sent)[number]) => Promise<void> = async () => {};
  const transport: FeishuTransport = {
    async diagnoseGroup() { return { ordinaryTextGrant: 'unknown', receiveSubscription: 'unknown' }; },
    start(next) { handlers = next; },
    stop() {},
    inspectGroup: async chatId => ({ chatId, name: chatId }),
    createGroup: async () => { throw Error('synthetic fixture uses bound groups'); },
    async sendText(chatId, text, uuid) {
      const item = { chatId, text, uuid };
      sent.push(item);
      await send(item);
    },
  };
  const admission = new ReloadAdmission();
  const execution = {} as DshExecution;
  let managers = new Managers(ctx, store, execution, dir, () => '', { fullAccess: false });
  managers.install();
  let groups = new FeishuGroups(store, identity, transport);
  let bridge = new FeishuBridge(ctx, store, managers, groups, transport, identity, admission);
  bridge.start();
  const bind = async (botId: string, chatId: string) => {
    advance();
    const preview = await groups.preview(botId, chatId);
    return groups.bind(botId, preview.confirmationToken);
  };
  const aa = await bind(a.bot.id, 'oc_alpha'), bb = await bind(b.bot.id, 'oc_beta');
  function connection(state: FeishuConnectionState) { advance(); handlers.onConnection(state); }
  connection('ready');
  const incoming = (id: string, text: string, options: Partial<FeishuGroupTextMessage> = {}) => handlers.onMessage({
    chatId: 'oc_alpha', messageId: id, senderOpenId: identity.ownerOpenId, text, receiptKind: 'unclassified',
    createdAt: advance(), ...options,
  });
  function web(text: string, owner = true) {
    return createUserMessage({ source: { kind: 'user', rpcId: 'synthetic-browser-request' as never,
      ...(owner ? {} : { principal: { kind: 'share' } as never }) }, content: [{ type: 'text', text }] });
  }
  let call = 0;
  const runTool = (agent: typeof a.agent, args: object) => tool.execute(args, {
    agent, callId: `call-${++call}`, signal: new AbortController().signal,
  });
  const receipt = (id: string) => store.db.prepare('SELECT * FROM feishu_inbound_receipts WHERE messageId=?').get(id);
  t.after(async () => {
    await bridge.close();
    for (const agent of agents.values()) agent.release();
    await managers.dispose();
    store.close();
    rmSync(dir, { force: true, recursive: true });
  });
  return {
    a, b, aa, bb, sent, advance, connection, incoming, bind, web, runTool, receipt, admission,
    emit, get store() { return store; }, get groups() { return groups; }, get bridge() { return bridge; },
    setSend(fn: typeof send) { send = fn; },
    setModel(enabled: boolean) { model = enabled ? { provider: 'synthetic', model: 'synthetic' } : null; },
    delayResolve(promise?: Promise<void>) { delayedResolve = promise; },
    async replace(botId: string) {
      const old = store.activeManager(botId)!;
      advance();
      store.releaseManager(`release:${old.id}`, botId, old.generation);
      const next = store.beginManager(`replacement:${old.id}`, botId, dir);
      store.confirmManager(next.id, next.requestedSessionId);
      const agent = attach(next);
      await emit('agent/created', { agent });
      return agent;
    },
    async reopen() {
      await bridge.close();
      for (const agent of agents.values()) agent.release();
      await managers.dispose();
      hooks.clear();
      store.close();
      store = new Store(join(dir, 'ledger.sqlite'));
      managers = new Managers(ctx, store, execution, dir, () => '', { fullAccess: false });
      managers.install();
      groups = new FeishuGroups(store, identity, transport);
      bridge = new FeishuBridge(ctx, store, managers, groups, transport, identity, admission);
      bridge.start();
      connection('ready');
    },
  };
}

test('authorized Feishu turn can create, answer and rework in the real Manager while keeping the native owner distinct', async t => {
  const f = await fixture(t), { a, b, store } = f;
  f.incoming('not-owner', 'Unauthorized input', { senderOpenId: 'ou_other' });
  f.incoming('other-chat', 'Unknown chat', { chatId: 'oc_unknown' });
  f.incoming('alpha-create', '请安排合成任务');
  f.incoming('beta-text', 'Another conversation', { chatId: f.bb.chatId });
  await tick();
  assert.equal(f.receipt('not-owner'), undefined);
  assert.equal(f.receipt('other-chat'), undefined);
  assert.equal(a.agent.inbox.nextTurn.length, 1);
  assert.equal(b.agent.inbox.nextTurn.length, 1);
  const message = await a.agent.enter();
  assert.deepEqual(message.source, { kind: 'user', feishuMessageId: 'alpha-create' });
  assert.equal(f.receipt('alpha-create')!.nativeSeq, a.agent.history.at(-1).seq);
  assert.equal(f.receipt('alpha-create')!.sessionId, a.agent.id);
  assert.equal(f.receipt('alpha-create')!.senderOpenId, identity.ownerOpenId);
  assert.notEqual(f.receipt('alpha-create')!.textDigest, '请安排合成任务');
  const { task } = await f.runTool(a.agent, {
    action: 'create', goal: 'Synthetic work', scope: 'One file', acceptance: 'Readable', dispatch: false,
  });
  await assert.rejects(() => f.runTool(a.agent, { action: 'pause', taskId: task.id,
    expectedRowVersion: task.rowVersion, userInstruction: '请安排合成任务' }), { code: 'human-message-required' });
  await a.agent.assistant('甲群已接单');
  await a.agent.endTurn();
  await b.agent.enter();
  await b.agent.assistant('乙群独立回答');
  await b.agent.endTurn();

  const bound = store.beginBinding('worker', task.id, store.getTask(task.id).rowVersion, tmpdir());
  store.confirmBinding(bound.id, bound.requestedSessionId);
  const firstRun = store.reserveRun('first-run', task.id, store.getTask(task.id).rowVersion);
  store.saveRunMessage(firstRun.id, 'native-test-1', '{}');
  store.claimDispatch(firstRun.id);
  store.inputEntered(firstRun.id, 'native-test-1', 1);
  store.workerReport(firstRun.id, 'waiting', { kind: 'waiting', summary: 'Which format?' });
  store.settleRun(firstRun.id);
  const question = store.taskDetail(task.id).pendingQuestions[0]!;
  assert.ok(question);
  f.incoming('alpha-answer', '请用 Markdown');
  await tick();
  await a.agent.enter();
  const answered = await f.runTool(a.agent, { action: 'respond', taskId: task.id,
    attentionId: question.id, expectedRowVersion: store.getTask(task.id).rowVersion });
  assert.equal(answered.input.content, '请用 Markdown');
  await a.agent.endTurn();

  const secondRun = store.reserveRun('second-run', task.id, store.getTask(task.id).rowVersion);
  store.saveRunMessage(secondRun.id, 'native-test-2', '{}');
  store.claimDispatch(secondRun.id);
  store.inputEntered(secondRun.id, 'native-test-2', 2);
  const report = store.workerReport(secondRun.id, 'ready', {
    kind: 'ready', summary: 'Synthetic result', checks: 'Synthetic evidence only',
    evidence: [{ path: join(tmpdir(), 'synthetic-feishu.md'), bytes: 1, sha256: 'synthetic' }],
  });
  store.settleRun(secondRun.id);
  assert.ok(report.resultId);
  f.incoming('alpha-rework', '请补一个例子');
  await tick();
  await a.agent.enter();
  const changed = await f.runTool(a.agent, { action: 'rework', taskId: task.id,
    resultId: report.resultId, expectedRowVersion: store.getTask(task.id).rowVersion });
  assert.equal(changed.task.lifecycle, 'open');
  await a.agent.endTurn();
  await tick();
  assert.deepEqual(f.sent.map(({ chatId, text }) => [chatId, text]), [
    ['oc_alpha', '甲群已接单'], ['oc_beta', '乙群独立回答'],
  ]);
});

test('the Manager rejects claimed Feishu authority for forged source, modified text and replay', async t => {
  const f = await fixture(t), { agent } = f.a;
  const action = { action: 'create', goal: 'Forbidden when sender is forged', dispatch: false };
  const forged = createUserMessage({
    source: { kind: 'user', feishuMessageId: 'invented' },
    content: [{ type: 'text', text: 'Fake Feishu identity' }],
  });
  await agent.startTurn();
  assert.equal((await agent.propose(forged)).kind, 'reject');
  const mixed = { ...forged, source: { ...f.web('rpc').source, kind: 'user' as const, feishuMessageId: 'invented' } };
  assert.equal((await agent.propose(mixed)).kind, 'reject');
  await agent.event('user/message', mixed, 'append');
  await assert.rejects(() => f.runTool(agent, action), { code: 'human-message-required' });
  await agent.endTurn();

  f.incoming('original', 'Authentic exact text');
  await tick();
  const real = agent.inbox.nextTurn[0]!;
  assert.ok(real);
  await agent.startTurn();
  const changed = { ...real, content: [{ type: 'text' as const, text: 'Altered after receipt' }] };
  assert.equal((await agent.propose(changed)).kind, 'reject');
  await agent.event('user/message', changed, 'append');
  await assert.rejects(() => f.runTool(agent, action), { code: 'human-message-required' });
  await agent.endTurn();
  await tick();
  assert.equal(f.receipt('original')!.nativeSeq, null);
  f.incoming('original', 'Redelivery must stay suppressed');
  await tick();
  assert.equal(agent.inbox.nextTurn.length, 0);

  f.incoming('valid', 'A real message');
  await tick();
  const valid = await agent.enter();
  assert.ok((await f.runTool(agent, { ...action, goal: 'Authorized once' })).task);
  await agent.endTurn();
  await agent.startTurn();
  assert.equal((await agent.propose(valid)).kind, 'reject');
  await agent.event('user/message', valid, 'append');
  await assert.rejects(() => f.runTool(agent, action), { code: 'human-message-required' });
  await agent.endTurn();
  assert.equal(f.store.listTasks({ botId: f.a.bot.id }).items.length, 1);
});

test('only Web owner text and the final completed assistant reply cross to Feishu, including background delivery', async t => {
  const f = await fixture(t), { agent } = f.a;
  const web = f.web('网页提出请求');
  agent.followup(web);
  await agent.enter();
  await agent.assistant('Tool preamble', { tool: true });
  await agent.assistant('Visible final reply');
  const reply = agent.history.at(-1);
  await agent.endTurn();
  await f.emit('session/event', agent.session, reply);
  await f.emit('session/event', agent.session, agent.history.at(-1));

  agent.followup(f.web('Non-owner Web text', false));
  await agent.enter();
  await agent.assistant('Cancelled partial text', { interrupted: true });
  await agent.endTurn('error');

  const notice = createUserMessage({ source: {
    kind: 'super-bot-manager', botId: f.a.bot.id, managerId: f.a.initial.id, eventId: 'synthetic-worker-delivery',
  }, content: [{ type: 'text', text: 'Private Worker notice' }] });
  agent.followup(notice);
  await agent.enter();
  await agent.assistant('Background final delivery');
  await agent.endTurn();
  await tick();
  assert.deepEqual(f.sent.map(item => item.text), ['网页用户\n网页提出请求', 'Visible final reply', 'Background final delivery']);
  assert.equal(new Set(f.sent.map(item => item.uuid)).size, 3);
});

test('disconnect, rebinding and restart drop stale events and never rerun work', async t => {
  const f = await fixture(t), { a } = f, { agent } = a;
  const preBinding = f.aa.boundAt - 1;
  f.incoming('before-bind', 'Old Feishu message', { createdAt: preBinding });
  f.incoming('initial-accepted', 'Run exactly once');
  await tick();
  const accepted = await agent.enter();
  await agent.endTurn();

  await agent.startTurn();
  await agent.assistant('Final generated before disconnect');
  f.connection('reconnecting');
  const offlineCreatedAt = f.advance();
  const offlineWeb = f.web('Offline pending Web prompt');
  agent.followup(offlineWeb);
  f.incoming('offline-now', 'Offline Feishu received');
  f.connection('reconnected');
  await agent.endTurn();
  f.incoming('offline-late', 'Offline Feishu delivered late', { createdAt: offlineCreatedAt });
  await agent.enter();
  await agent.assistant('New final after reconnect');
  await agent.endTurn();
  assert.equal(f.receipt('offline-now'), undefined);
  assert.equal(f.receipt('offline-late'), undefined);
  assert.equal(f.receipt('before-bind'), undefined);
  assert.deepEqual(f.sent.map(item => item.text), ['New final after reconnect']);

  let resolve!: () => void;
  f.delayResolve(new Promise<void>(done => { resolve = done; }));
  const oldBindingCreatedAt = f.advance();
  f.incoming('changing-binding', 'Manager resolution races with rebind');
  await tick();
  assert.equal(f.receipt('changing-binding')!.nativeSeq, null);
  f.groups.unbind(a.bot.id, f.aa.id);
  const replacement = await f.bind(a.bot.id, 'oc_alpha');
  assert.notEqual(replacement.id, f.aa.id);
  f.incoming('old-binding-late', 'Last binding late message', { createdAt: oldBindingCreatedAt });
  resolve();
  f.delayResolve();
  await tick();
  assert.equal(agent.inbox.nextTurn.length, 0);
  assert.equal(f.receipt('old-binding-late'), undefined);

  const restartCreatedAt = f.advance();
  agent.inbox.nextTurn.push(accepted, f.web('Persisted old native Web input'));
  await f.reopen();
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.ok(!('feishuMessageId' in agent.inbox.nextTurn[0]!.source));
  await agent.enter();
  await agent.endTurn();
  f.incoming('host-down', 'Arrives after restart', { createdAt: restartCreatedAt });
  f.incoming('initial-accepted', 'Replay using changed timestamp');
  f.incoming('changing-binding', 'Try to resend accepted but unentered input');
  await tick();
  assert.equal(f.receipt('host-down'), undefined);
  assert.equal(agent.inbox.nextTurn.length, 0);
  const previousManagerTime = f.advance();
  const newSession = await f.replace(a.bot.id);
  f.incoming('late-for-old-manager', 'Late input from previous manager generation', { createdAt: previousManagerTime });
  f.incoming('new-session', 'New message routes to the replacement Manager');
  await tick();
  assert.equal(agent.inbox.nextTurn.length, 0);
  assert.equal(newSession.inbox.nextTurn.length, 1);
  assert.equal(f.receipt('late-for-old-manager'), undefined);
  await newSession.enter();
  await newSession.assistant('New Manager, same Feishu group');
  await newSession.endTurn();
  assert.deepEqual(f.sent.map(item => [item.chatId, item.text]), [
    ['oc_alpha', 'New final after reconnect'], ['oc_alpha', 'New Manager, same Feishu group'],
  ]);
});

test('authorized input without a selected model receives one actionable response and is never retried', async t => {
  const f = await fixture(t);
  f.setModel(false);
  f.incoming('needs-model', 'Can the Bot work?');
  f.incoming('needs-model', 'Repeating the event');
  await tick();
  assert.equal(f.a.agent.inbox.nextTurn.length, 0);
  assert.equal(f.receipt('needs-model')!.nativeSeq, null);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /选择并配置模型/);
  assert.equal(f.bridge.status(f.a.bot.id).error, f.sent[0]!.text);
  f.setModel(true);
  f.incoming('needs-model', 'Old input should never start');
  await tick();
  assert.equal(f.a.agent.inbox.nextTurn.length, 0);
  assert.equal(f.sent.length, 1);
});

test('unknown send receipt retries only the same UUID and preserves the order of the group', async t => {
  const f = await fixture(t), { agent } = f.a;
  f.setSend(async () => {
    if (f.sent.length === 1) throw new AppError('feishu-send-retryable', 'Synthetic lost receipt');
  });
  agent.followup(f.web('Send once with a stable ID'));
  await agent.enter();
  await agent.assistant('Reply comes after the original user message');
  await agent.endTurn();
  await tick();
  assert.equal(f.sent.length, 1);
  const deadline = Date.now(); // mocked clock is intentionally unchanged while retries use a real timer
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(Date.now(), deadline);
  assert.deepEqual(f.sent.map(item => item.text), [
    '网页用户\nSend once with a stable ID', '网页用户\nSend once with a stable ID', 'Reply comes after the original user message',
  ]);
  assert.equal(f.sent[0]!.uuid, f.sent[1]!.uuid);
  assert.notEqual(f.sent[1]!.uuid, f.sent[2]!.uuid);
});

test('permanent delivery errors remain visible after a later success and expose no transport details', async t => {
  const f = await fixture(t), { agent } = f.a;
  f.setSend(async () => {
    if (f.sent.length === 1) throw new AppError('feishu-send-failed', 'Fixture includes secret credentials');
  });
  agent.followup(f.web('Permissions refused'));
  await agent.enter();
  await agent.assistant('Later reply sent');
  await agent.endTurn();
  await tick();
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.bridge.status(f.a.bot.id), {
    connection: 'ready', evidence: { plainTextAt: null, botMentionAt: null },
    error: '飞书投递未确认，请检查绑定群和应用权限。原文保留在 Bot 对话。',
  });
});

test('disconnect cancels a claimed input awaiting native admission without replaying the task', async t => {
  const f = await fixture(t), { agent } = f.a;
  f.incoming('between-step-and-append', 'Do not run after disconnection');
  await tick();
  const message = agent.inbox.nextTurn[0]!;
  await agent.startTurn();
  assert.equal((await agent.propose(message)).kind, 'enter');
  f.connection('reconnecting');
  assert.equal(agent.canceled, 1);
  await tick();
  // Even a late surface event cannot grant the turn human authority.
  await agent.event('user/message', message, 'append');
  await assert.rejects(() => f.runTool(agent, { action: 'create', goal: 'Should not run', dispatch: false }),
    { code: 'human-message-required' });
  await agent.endTurn();
  f.connection('reconnected');
  f.incoming('between-step-and-append', 'Redelivered with a fresh time');
  await tick();
  assert.equal(agent.inbox.nextTurn.length, 0);
  assert.equal(f.receipt('between-step-and-append')!.nativeSeq, null);
  assert.equal(f.sent.length, 0);
});

test('reconnect drops a group backlog behind an uncertain send and admits fresh replies immediately', async t => {
  const f = await fixture(t), { agent } = f.a;
  let rejectOld!: (error: unknown) => void;
  f.setSend(async () => {
    if (f.sent.length === 1) await new Promise<void>((_, reject) => { rejectOld = reject; });
  });
  agent.followup(f.web('Old in-flight user input'));
  await agent.enter();
  await agent.assistant('Old queued final reply');
  await agent.endTurn();
  assert.equal(f.sent.length, 1);

  f.connection('reconnecting');
  f.connection('reconnected');
  agent.followup(f.web('Fresh input'));
  await agent.enter();
  await agent.assistant('Fresh final reply');
  await agent.endTurn();
  rejectOld(new AppError('feishu-send-retryable', 'Old uncertain send result'));
  await tick();
  assert.deepEqual(f.sent.map(item => item.text), [
    '网页用户\nOld in-flight user input', '网页用户\nFresh input', 'Fresh final reply',
  ]);
  assert.match(f.bridge.status(f.a.bot.id).error ?? '', /断线时有一条飞书投递未确认/);
});

test('unlink revokes a claimed group message while native model preparation is pending', async t => {
  const f = await fixture(t), { a, b } = f;
  f.incoming('before-unlink', 'Do not enter the old session after unlink');
  f.incoming('second-bot-retains-authority', 'Beta will still respond', { chatId: f.bb.chatId });
  await tick();
  const message = a.agent.inbox.nextTurn[0]!;
  await a.agent.startTurn();
  assert.equal((await a.agent.propose(message)).kind, 'enter');
  f.groups.unbind(a.bot.id, f.aa.id);
  assert.equal(a.agent.canceled, 1);
  assert.equal(b.agent.canceled, 0);
  await a.agent.endTurn();
  await b.agent.enter();
  await b.agent.endTurn();
  assert.equal(f.receipt('before-unlink')!.nativeSeq, null);
  assert.ok(typeof f.receipt('second-bot-retains-authority')!.nativeSeq === 'number');
});

test('a bound group without an active Manager receives one request to reopen the local Bot', async t => {
  const f = await fixture(t);
  f.store.releaseManager('retire-for-unready-test', f.a.bot.id, f.a.initial.generation);
  f.incoming('no-active-manager', 'A work request needs its own active session');
  f.incoming('no-active-manager', 'Same delivery repeated');
  await tick();
  assert.equal(f.a.agent.inbox.nextTurn.length, 0);
  assert.equal(f.receipt('no-active-manager')!.nativeSeq, null);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /打开本机 Bot 管理对话/);
  assert.equal(f.bridge.status(f.a.bot.id).error, f.sent[0]!.text);
});

test('ordinary and bot-mention receipts persist per current binding without needing a model reply', async t => {
  const f = await fixture(t);
  const { a, b } = f;
  const evidence = (botId = a.bot.id) => f.bridge.status(botId).evidence;
  const empty = { plainTextAt: null, botMentionAt: null };
  assert.deepEqual(evidence(), empty);
  assert.deepEqual(evidence(b.bot.id), empty);
  f.setModel(false);

  f.incoming('not-the-owner', 'Unauthorized', { senderOpenId: 'ou_other', receiptKind: 'plain' });
  f.incoming('old', 'Before binding', { createdAt: f.aa.boundAt - 1, receiptKind: 'plain' });
  f.incoming('unknown', 'Structured mention not classified', { receiptKind: 'unclassified' });
  assert.deepEqual(evidence(), empty);
  assert.equal(f.receipt('not-the-owner'), undefined);
  assert.equal(f.receipt('old'), undefined);
  assert.ok(f.receipt('unknown'), 'unclassified text still routes normally');

  f.incoming('plain-alpha', '普通文字', { receiptKind: 'plain' });
  const alphaPlain = f.receipt('plain-alpha')!.acceptedAt;
  assert.deepEqual(evidence(), { plainTextAt: alphaPlain, botMentionAt: null });
  f.incoming('plain-alpha', 'Altered duplicate', { receiptKind: 'bot-mention' });
  assert.deepEqual(evidence(), { plainTextAt: alphaPlain, botMentionAt: null });
  f.incoming('mentioned-alpha', '@机器人 结构化提及', { receiptKind: 'bot-mention' });
  const alphaMentioned = f.receipt('mentioned-alpha')!.acceptedAt;
  f.incoming('beta-mention', 'Beta 独立', { chatId: f.bb.chatId, receiptKind: 'bot-mention' });
  assert.deepEqual(evidence(), { plainTextAt: alphaPlain, botMentionAt: alphaMentioned });
  assert.deepEqual(evidence(b.bot.id), { plainTextAt: null, botMentionAt: f.receipt('beta-mention')!.acceptedAt });
  await tick();
  assert.equal(f.receipt('plain-alpha')!.nativeSeq, null);

  const offline = f.advance();
  f.connection('reconnecting');
  f.incoming('disconnected', 'Disconnected', { receiptKind: 'plain' });
  f.connection('reconnected');
  f.incoming('delayed-while-offline', 'Delayed while offline', { receiptKind: 'plain', createdAt: offline });
  await f.reopen();
  assert.deepEqual(evidence(), { plainTextAt: alphaPlain, botMentionAt: alphaMentioned });
  const former = f.advance();
  f.groups.unbind(a.bot.id, f.aa.id);
  assert.equal(evidence(), null);
  assert.equal(f.store.get(GROUP_EVIDENCE_KEY_PREFIX + f.aa.id), null);
  const rebound = await f.bind(a.bot.id, f.aa.chatId);
  assert.notEqual(rebound.id, f.aa.id);
  f.incoming('plain-alpha', 'Replay of old message ID', { receiptKind: 'plain' });
  f.incoming('late-for-former-binding', 'Old binding', { receiptKind: 'bot-mention', createdAt: former });
  assert.deepEqual(evidence(), empty);
  assert.ok(evidence(b.bot.id)?.botMentionAt, 'unbinding Alpha preserves Beta evidence');
  f.incoming('new-mention', 'New binding', { receiptKind: 'bot-mention' });
  assert.deepEqual(evidence(), { plainTextAt: null, botMentionAt: f.receipt('new-mention')!.acceptedAt });
});

test('a bot mention enters before subsequent plain text while its evidence lookup is still pending', async t => {
  const f = await fixture(t);
  const { a } = f;
  let prove!: (value: boolean) => void;
  const botMentionProof = new Promise<boolean>(resolve => { prove = resolve; });
  f.incoming('mention-pending', 'First @ message', { botMentionProof });
  f.incoming('plain-next', 'Second plain message', { receiptKind: 'plain' });
  await tick();
  const content = (message: UserMessage) => message.content.map(block => block.type === 'text' ? block.text : '').join('');
  assert.equal(content(await a.agent.enter()), 'First @ message');
  await a.agent.endTurn();
  await tick();
  assert.equal(content(await a.agent.enter()), 'Second plain message');
  await a.agent.endTurn();

  assert.equal(f.bridge.status(a.bot.id).evidence?.botMentionAt, null);
  prove(true);
  await tick();
  assert.equal(f.bridge.status(a.bot.id).evidence?.botMentionAt, f.receipt('mention-pending')!.acceptedAt);
  let disconnectedProof!: (value: boolean) => void;
  f.incoming('mention-pending-disconnect', 'Old epoch', {
    botMentionProof: new Promise(resolve => { disconnectedProof = resolve; }),
  });
  f.connection('reconnecting');
  f.connection('reconnected');
  disconnectedProof(true);
  await tick();
  assert.equal(f.bridge.status(a.bot.id).evidence?.botMentionAt, f.receipt('mention-pending')!.acceptedAt);

  let staleProof!: (value: boolean) => void;
  f.incoming('mention-pending-unbind', 'Old binding', { botMentionProof: new Promise(resolve => { staleProof = resolve; }) });
  f.groups.unbind(a.bot.id, f.aa.id);
  await f.bind(a.bot.id, f.aa.chatId);
  staleProof(true);
  await tick();
  assert.equal(f.bridge.status(a.bot.id).evidence?.botMentionAt, null);
  assert.equal(f.store.get(GROUP_EVIDENCE_KEY_PREFIX + f.aa.id), null);
});

test('failed evidence persistence rolls back its receipt and allows the same delivery to succeed later', async t => {
  const f = await fixture(t);
  f.store.db.exec(`
    CREATE TRIGGER reject_synthetic_evidence BEFORE INSERT ON metadata
    WHEN NEW.key LIKE 'feishu-group-evidence:%'
    BEGIN SELECT RAISE(ABORT, 'Synthetic evidence persistence failure'); END;
  `);
  assert.throws(() => f.incoming('retry-receipt', 'Original', { receiptKind: 'plain' }), /Synthetic evidence persistence failure/);
  assert.equal(f.receipt('retry-receipt'), undefined);
  assert.equal(f.bridge.status(f.a.bot.id).evidence?.plainTextAt, null);
  f.store.db.exec('DROP TRIGGER reject_synthetic_evidence');
  f.incoming('retry-receipt', 'Original', { receiptKind: 'plain' });
  assert.equal(f.bridge.status(f.a.bot.id).evidence?.plainTextAt, f.receipt('retry-receipt')!.acceptedAt);
  await tick();
  assert.equal(f.a.agent.inbox.nextTurn.length, 1);
  await f.a.agent.enter();
  await f.a.agent.endTurn();
});

test('protected reload and group intake exclude each other before the deduplication receipt', async t => {
  const f = await fixture(t);
  const resume = f.admission.pause();
  assert.throws(() => f.incoming('retry-id', 'Synthetic incoming'), { code: 'reload-in-progress' });
  assert.equal(f.receipt('retry-id'), undefined);
  resume();
  let release!: () => void;
  f.delayResolve(new Promise<void>(resolve => { release = resolve; }));
  try {
    await f.incoming('retry-id', 'Synthetic incoming');
    assert.ok(f.receipt('retry-id'));
    assert.throws(() => f.admission.pause(), /occupied/);
  } finally {
    release();
  }
});
