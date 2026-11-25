/** Product Store and production client lookup/navigation code; native UI is a synthetic boundary, not a browser. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { Bot, DeliveredResult, ManagerBinding, Task, TaskModelHistory, WorkerModelPreview } from '../../src/model.ts';
import { loadModelHistory, ModelPreview } from '../../src/ui/work/ModelDetails.tsx';
import { Store } from '../../src/store.ts';
import { parseWorkLink, resultFileUrl, workUrl, type WorkLink } from '../../src/work-links.ts';
import { LinkedTaskContent, TaskDefinition, TaskDetailHeader } from '../../src/ui/work/TaskDetail.tsx';
import { ResultFiles, ResultLinks, ResultLoadReceipt, ResultReport, ResultSummary } from '../../src/ui/work/ResultCard.tsx';
import { SessionControls } from '../../src/ui/work/SessionControls.tsx';
import { ReplyForm } from '../../src/ui/work/forms.tsx';
import { WorkMarkdown } from '../../src/ui/work/WorkMarkdown.tsx';
import { BotPanel } from '../../src/ui/work/BotPanel.tsx';
import type { WorkspaceState } from '../../src/ui/work/useWorkspace.ts';
import { apply as applyClient, inject } from '../../src/client.tsx';
import { SessionOriginHint, SessionWork, WorkButton } from '../../src/ui/SessionWork.tsx';
import { parseMirrorQuery } from '../../src/mirror-host.ts';
import { readLocalMirror } from '../../src/mirror-queries.ts';
import type { SessionOrigin } from '../../src/mirror.ts';
import { resultHeading, workGroup, type WorkspaceApi } from '../../src/ui/Workspace.tsx';
import { WORK_TAB, chatDeliveryLink, openBotConversation, openWorkLink, readSessionBot, readTaskLink, toggleSessionWork, watchSessionBot, watchSessionOrigin, workLinkForUrl, type SessionBotState } from '../../src/ui/work-navigation.ts';

function fixture() {
  const store = new Store(':memory:');
  const a = store.createBot('a', { name: 'Bot A', instructions: 'Synthetic A' });
  const b = store.createBot('b', { name: 'Bot B', instructions: 'Synthetic B' });
  const ma = store.beginManager('ma', a.id, '/synthetic/a');
  const mb = store.beginManager('mb', b.id, '/synthetic/b');
  store.confirmManager(ma.id, ma.requestedSessionId); store.confirmManager(mb.id, mb.requestedSessionId);
  const ta = store.createTask('ta', { botId: a.id, goal: 'A'.repeat(10000), scope: 'A files', acceptance: 'A checks', reviewPolicy: 'human' });
  const tb = store.createTask('tb', { botId: b.id, goal: 'B only', scope: 'B files', acceptance: 'B checks', reviewPolicy: 'human' });
  return { store, a: store.getBot(a.id), b: store.getBot(b.id), ma, mb, ta, tb };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function source(initial?: string) {
  let current = initial;
  const listeners = new Set<() => void>();
  return { getSnapshot: () => current, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, select: (id?: string) => { current = id; for (const listener of listeners) listener(); }, listeners };
}
function apiWith(call: WorkspaceApi['call'], opened: string[] = []): WorkspaceApi {
  return { call, openSession: id => { opened.push(id); }, beginNavigation: () => new AbortController().signal, openBot: async () => {} };
}

test('chat work settings give each Bot panel a distinct React key', () => {
  const f = fixture();
  try {
    const w = { sessionId: f.a.managerSessionId, locked: false } as WorkspaceState;
    const { children } = BotPanel({ w, bot: f.a, onBotDeleted: () => {} }).props;
    const keys = children.flat().flatMap((child: { key?: string | null } | undefined) => child?.key ?? []);
    assert.ok(keys.includes(`feishu:${f.a.id}`));
    assert.ok(keys.includes(`worker-capacity:${f.a.id}`));
    assert.ok(keys.includes(`delete:${f.a.id}:${f.a.configRevision}`));
    assert.equal(new Set(keys).size, keys.length);
  } finally { f.store.close(); }
});

test('read-only mirror offers neither Worker capacity controls nor capacity queries', () => {
  const f = fixture();
  try {
    const w = { sessionId: f.a.managerSessionId, locked: true,
      mirror: { owner: 'desktop', bot: { id: f.a.id, name: f.a.name } } } as WorkspaceState;
    const mirrored = BotPanel({ w, bot: f.a }).props.children;
    assert.ok(!mirrored.some((child: { key?: string | null } | undefined) => child?.key === `worker-capacity:${f.a.id}`));
    for (const op of ['bot.capacity.get', 'bot.capacity.set']) {
      assert.throws(() => parseMirrorQuery({ op, botId: f.a.id }), { code: 'invalid-input' });
    }
  } finally { f.store.close(); }
});

test('the matching native and expected model routes share a compact chip with accessible details', () => {
  const current = { provider: 'magpie-responses', model: 'codex/gpt-6.2-sol', reasoningEffort: 'xhigh' };
  const model: WorkerModelPreview = { current, expected: { ...current, source: 'role-override' } };
  const [native, next, hint] = ModelPreview({ model, showExpected: true, canStartManually: true }).props.children;
  const chip = native.type(native.props);
  const [visible, accessible] = chip.props.children;
  assert.equal(chip.props.className, 'badge');
  assert.equal(visible.props.children, 'Sol 6.2 · xhigh');
  assert.equal(visible.props['aria-hidden'], 'true');
  assert.match(accessible.props.children, /Worker 当前原生选择：magpie-responses \/ codex\/gpt-6\.2-sol · 推理档位 xhigh/);
  assert.match(accessible.props.children, /下次派发预计相同 · Super Bot Worker 角色覆盖/);
  assert.equal(chip.props.title, accessible.props.children);
  assert.equal(next, false);
  assert.equal(hint, false);
});

test('the next-run chip identifies differences in provider, model or effort separately from the native route', () => {
  const current = { provider: 'magpie-responses', model: 'codex/gpt-6.2-sol', reasoningEffort: 'xhigh' };
  for (const patch of [{ provider: 'other-route' }, { model: 'fixture-model' }, { reasoningEffort: 'medium' }]) {
    const expected = { ...current, ...patch, source: 'role-override' as const };
    const [native, next] = ModelPreview({ model: { current, expected }, showExpected: true, canStartManually: false }).props.children;
    assert.equal(native.props.label, 'Sol 6.2 · xhigh');
    assert.equal(next.props.label,
      `下次派发预计 · ${expected.model === current.model ? 'Sol 6.2' : expected.model} · ${expected.reasoningEffort}`);
    assert.ok(next.props.description.includes(`${expected.provider} / ${expected.model} · 推理档位 ${expected.reasoningEffort}`));
    assert.match(next.props.description, /下次派发预计 Worker 模型.*Super Bot Worker 角色覆盖/);
  }
});

test('compact model chips preserve unknowns, manual model guidance and the closed-task preview rule', () => {
  const preview = (model: WorkerModelPreview, showExpected = true) =>
    ModelPreview({ model, showExpected, canStartManually: true }).props.children;
  const [unknown, noDuplicate, hint] = preview({ current: null, expected: null });
  assert.equal(unknown.props.label, 'Worker 模型未知');
  assert.match(unknown.props.description, /Worker 当前原生选择：未知 · 下次派发预计未知/);
  assert.equal(noDuplicate, false);
  assert.match(hint.props.children, /手动开始前请在 Worker 会话选择模型/);
  const current = { provider: 'fixture', model: 'fixture-model', reasoningEffort: null };
  const [effortUnknown, nextUnknown] = preview({ current, expected: null });
  assert.equal(effortUnknown.props.label, 'fixture-model · 档位未知');
  assert.equal(nextUnknown.props.label, '下次派发预计 · 未知');
  const expected = { ...current, reasoningEffort: 'high', source: 'manager-inheritance' as const, sourceSessionId: 'fixture' };
  const [native, next, manual] = preview({ current: null, expected });
  assert.equal(native.props.label, 'Worker 模型未知');
  assert.match(next.props.description, /下次派发预计.*由 Bot 派发时继承/);
  assert.ok(manual);
  assert.equal(preview({ current, expected }, false)[1], false);
});

test('work detail sends the full scope and acceptance fields to Markdown and keeps missing-field labels', () => {
  const f = fixture();
  try {
    const w = { locked: false } as WorkspaceState;
    const scope = 'Read **all** relevant files.', acceptance = '- Run `npm test`\n- Review the output';
    const definitions = (task: Task) => TaskDefinition({ w, detail: { task } }).props.children[1].props.children;
    const [scopeLabel, scopeField, acceptanceLabel, acceptanceField] = definitions({ ...f.ta, scope, acceptance });
    assert.equal(scopeLabel.props.children, '任务范围');
    assert.equal(acceptanceLabel.props.children, '验收条件');
    assert.equal(scopeField.props.children.type, WorkMarkdown);
    assert.equal(scopeField.props.children.props.text, scope);
    assert.equal(acceptanceField.props.children.type, WorkMarkdown);
    assert.equal(acceptanceField.props.children.props.text, acceptance);
    const missing = definitions({ ...f.ta, scope: '', acceptance: '' });
    assert.equal(missing[1].props.children, '尚未填写');
    assert.equal(missing[3].props.children, '尚未填写');
  } finally { f.store.close(); }
});

test('execution model history drops requests after task and native session switches', async () => {
  const current = source('chat-a');
  const requests: (ReturnType<typeof deferred<TaskModelHistory>> & { signal?: AbortSignal })[] = [];
  const received: (TaskModelHistory | null)[] = [];
  const api = apiWith(<T>(action: string, payload?: Record<string, unknown>, signal?: AbortSignal) => {
    assert.equal(action, 'task.model-history');
    assert.deepEqual(payload, { id: requests.length ? 'task-b' : 'task-a', sessionId: current.getSnapshot() });
    const request = deferred<TaskModelHistory>();
    requests.push({ ...request, signal });
    return request.promise as Promise<T>;
  });
  api.currentSession = current.getSnapshot;
  api.watchCurrentSession = current.subscribe;
  const load = (taskId: string) => loadModelHistory({ api, taskId, sessionId: 'chat-a' }, value => received.push(value));
  const a = load('task-a');
  a?.(); // The previous drawer unmounts when selection changes.
  const b = load('task-b');
  requests[0]!.resolve({ taskId: 'task-a', runs: [] });
  await flush();
  assert.deepEqual(received, []);
  assert.equal(requests[0]!.signal?.aborted, true);
  current.select('chat-other');
  current.select('chat-a');
  requests[1]!.reject(new Error('late failure'));
  await flush();
  assert.deepEqual(received, [null]);
  assert.equal(requests[1]!.signal?.aborted, true);
  b?.();
  const mismatched = load('task-b');
  requests[2]!.resolve({ taskId: 'task-a', runs: [] });
  await flush();
  assert.equal(received.at(-1), null);
  mismatched?.();
  const active = load('task-b');
  requests[3]!.resolve({ taskId: 'task-b', runs: [] });
  await flush();
  assert.deepEqual(received.at(-1), { taskId: 'task-b', runs: [] });
  active?.();
  assert.equal(current.listeners.size, 0);
});

test('work ownership is read-only and follows only current ready native Bot conversations', () => {
  const f = fixture(); try {
    const before = f.store.db.prepare('SELECT count(*) AS n FROM events').get()!.n;
    assert.equal(f.store.botForSession(f.ma.requestedSessionId)?.id, f.a.id);
    assert.equal(f.store.botForSession(f.mb.requestedSessionId)?.id, f.b.id);
    const binding = f.store.beginBinding('worker', f.ta.id, f.ta.rowVersion, '/synthetic/task-a');
    f.store.confirmBinding(binding.id, binding.requestedSessionId);
    assert.equal(f.store.botForSession(binding.requestedSessionId), null, 'Worker is not a Bot conversation');
    assert.equal(f.store.botForSession('ordinary-native-session'), null);
    const afterSetup = f.store.db.prepare('SELECT count(*) AS n FROM events').get()!.n;
    for (let i = 0; i < 3; i++) { f.store.botForSession(f.ma.requestedSessionId); f.store.botForSession('ordinary'); }
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM events').get()!.n, afterSetup);
    assert.ok(Number(afterSetup) > Number(before));
    f.store.releaseManager('replace', f.a.id, f.ma.generation);
    assert.equal(f.store.botForSession(f.ma.requestedSessionId), null, 'old manager cannot own a work view');
    const next = f.store.beginManager('new', f.a.id, '/synthetic/a');
    assert.equal(f.store.botForSession(next.requestedSessionId), null, 'creating manager is not authoritative');
    f.store.confirmManager(next.id, next.requestedSessionId);
    assert.equal(f.store.botForSession(next.requestedSessionId)?.id, f.a.id);
    f.store.updateBot('config', f.a.id, f.a.configRevision, { name: 'A revised', instructions: 'New config' }, []);
    assert.equal(f.store.botForSession(next.requestedSessionId), null, 'config revision invalidates old conversation');
    assert.equal(f.store.botForSession(f.mb.requestedSessionId)?.id, f.b.id);
  } finally { f.store.close(); }
});

test('mirror origin lookup is exact and read-only for confirmed plugin-created sessions', () => {
  const f = fixture();
  try {
    const pending = f.store.beginBinding('worker', f.ta.id, f.ta.rowVersion, '/synthetic/a');
    const read = (sessionId: string) => readLocalMirror(f.store, parseMirrorQuery({ op: 'session-origin', sessionId }));
    assert.equal(read(pending.requestedSessionId), false);
    f.store.confirmBinding(pending.id, pending.requestedSessionId);
    const external = 'session-12345678-aaaa-4bbb-8ccc-1234567890ab';
    f.store.attachExistingSession('attach', { taskId: f.tb.id, expectedRowVersion: f.tb.rowVersion, sessionId: external,
      cwd: '/synthetic/b', fullHistoryApproved: true, directoryApproved: true });
    const before = f.store.db.prepare('SELECT max(id) AS n FROM events').get();
    assert.equal(read(f.ma.requestedSessionId), true);
    assert.equal(read(pending.requestedSessionId), true);
    assert.equal(read(external), false);
    for (const input of [{ op: 'session-origin', sessionId: '../arbitrary' },
      { op: 'session-origin', sessionId: f.ma.requestedSessionId, taskId: f.ta.id }]) {
      assert.throws(() => parseMirrorQuery(input), { code: 'invalid-input' });
    }
    assert.deepEqual(f.store.db.prepare('SELECT max(id) AS n FROM events').get(), before);
    f.store.releaseManager('replace', f.a.id, f.ma.generation);
    assert.equal(read(f.ma.requestedSessionId), false);
  } finally { f.store.close(); }
});

test('origin hint lookup is one read per visit and ignores responses for departing native sessions', async () => {
  const f = fixture(), current = source(f.ma.requestedSessionId);
  const requests: ReturnType<typeof deferred<SessionOrigin | null>>[] = [];
  const states: (SessionOrigin | undefined)[] = [];
  const api = apiWith(async <T>(action: string, payload?: Record<string, unknown>) => {
    assert.equal(action, 'session.origin');
    assert.deepEqual(payload, { sessionId: f.ma.requestedSessionId });
    const read = deferred<SessionOrigin | null>(); requests.push(read); return read.promise as Promise<T>;
  });
  const stop = watchSessionOrigin(api, f.ma.requestedSessionId, current, value => states.push(value));
  try {
    current.select(f.mb.requestedSessionId); current.select(f.ma.requestedSessionId);
    assert.equal(requests.length, 2);
    requests[0]!.resolve({ owner: 'web', local: true }); await flush();
    assert.equal(states.at(-1), undefined);
    requests[1]!.resolve({ owner: 'desktop', local: false }); await flush();
    assert.deepEqual(states.at(-1), { owner: 'desktop', local: false });
    current.select(undefined);
    assert.equal(states.at(-1), undefined);
  } finally { stop(); f.store.close(); }
  assert.equal(current.listeners.size, 0);
});

test('session lookup uses native identity, rejects mismatched responses and isolates the task page', async () => {
  const f = fixture(); try {
    const calls: unknown[] = [];
    const api = apiWith(async <T>(action: string, payload?: Record<string, unknown>) => {
      calls.push([action, payload]);
      assert.equal(action, 'bot.for-session');
      return f.store.botForSession(String(payload!.sessionId)) as T;
    });
    const controller = new AbortController();
    for (const [sessionId, expected] of [[f.ma.requestedSessionId, f.a.id], [f.mb.requestedSessionId, f.b.id], ['ordinary', null]] as const) {
      const bot = await readSessionBot(api, sessionId, controller.signal, () => sessionId);
      assert.equal(bot?.id ?? null, expected);
      if (bot) assert.deepEqual(f.store.listTasks({ botId: bot.id }).items.map(task => task.id), [bot.id === f.a.id ? f.ta.id : f.tb.id]);
    }
    assert.deepEqual(calls, [f.ma.requestedSessionId, f.mb.requestedSessionId, 'ordinary'].map(sessionId => ['bot.for-session', { sessionId }]));
    const wrong = apiWith(async <T>() => f.b as T);
    assert.equal(await readSessionBot(wrong, f.ma.requestedSessionId, controller.signal, () => f.ma.requestedSessionId), null);
  } finally { f.store.close(); }
});

test('late A ownership responses and errors cannot publish into B or an ordinary session', async () => {
  const f = fixture(); const current = source(f.ma.requestedSessionId);
  const requests: ReturnType<typeof deferred<Bot | null>>[] = [];
  const api = apiWith(async <T>() => { const request = deferred<Bot | null>(); requests.push(request); return request.promise as Promise<T>; });
  const states: (SessionBotState | undefined)[] = [];
  const stop = watchSessionBot(api, f.ma.requestedSessionId, current, state => states.push(state));
  try {
    current.select(f.mb.requestedSessionId);
    requests[0]!.resolve(f.a); await flush();
    assert.equal(states.at(-1), undefined);
    current.select(f.ma.requestedSessionId);
    assert.equal(requests.length, 2);
    current.select('ordinary'); requests[1]!.reject(new Error('late A error')); await flush();
    assert.equal(states.at(-1), undefined);
    assert.ok(states.every(state => state === undefined));
  } finally { stop(); f.store.close(); }
  assert.equal(current.listeners.size, 0);
});

test('A to B to A before render invalidates the first read; hidden and unmounted views cannot republish', async () => {
  const f = fixture(); const current = source(f.ma.requestedSessionId);
  const requests: ReturnType<typeof deferred<Bot | null>>[] = [];
  const api = apiWith(async <T>() => { const request = deferred<Bot | null>(); requests.push(request); return request.promise as Promise<T>; });
  const states: (SessionBotState | undefined)[] = [];
  const stop = watchSessionBot(api, f.ma.requestedSessionId, current, state => states.push(state));
  try {
    current.select(f.mb.requestedSessionId); current.select(f.ma.requestedSessionId);
    requests[0]!.resolve(f.a); await flush(); assert.equal(states.at(-1), undefined);
    requests[1]!.resolve(f.a); await flush(); assert.equal(states.at(-1)?.bot?.id, f.a.id);
    current.select(undefined); assert.equal(states.at(-1), undefined, 'global panel hides native work immediately');
    current.select(f.ma.requestedSessionId); stop();
    const count = states.length; requests[2]!.resolve(f.a); await flush(); assert.equal(states.length, count);
  } finally { stop(); f.store.close(); }
});

test('periodic read clears replaced manager ownership instead of keeping a stale Bot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const current = source(f.ma.requestedSessionId);
  const api = apiWith(async <T>(_action: string, payload?: Record<string, unknown>) => f.store.botForSession(String(payload!.sessionId)) as T);
  const states: (SessionBotState | undefined)[] = [];
  const stop = watchSessionBot(api, f.ma.requestedSessionId, current, state => states.push(state));
  try {
    await flush(); assert.equal(states.at(-1)?.bot?.id, f.a.id);
    f.store.releaseManager('replace', f.a.id, f.ma.generation);
    t.mock.timers.tick(5000); await flush(); assert.equal(states.at(-1)?.bot, null);
  } finally { stop(); f.store.close(); t.mock.timers.reset(); }
});

test('late prepare success and failure never pull navigation back; current prepare opens exactly its Bot', async () => {
  const f = fixture(); try {
    const opened: string[] = [], response = deferred<ManagerBinding>();
    const api = apiWith(async <T>() => response.promise as Promise<T>, opened);
    const nav = new AbortController();
    const opening = openBotConversation(api, f.a.id, nav.signal);
    nav.abort(); response.resolve(f.store.getManager(f.ma.id)); await opening;
    assert.deepEqual(opened, []);
    const failed = deferred<ManagerBinding>(), old = new AbortController();
    const failing = openBotConversation(apiWith(async <T>() => failed.promise as Promise<T>, opened), f.a.id, old.signal);
    old.abort(); failed.reject(new Error('late prepare error')); await failing;
    const live = apiWith(async <T>() => f.store.getManager(f.mb.id) as T, opened);
    await openBotConversation(live, f.b.id, new AbortController().signal);
    assert.deepEqual(opened, [f.mb.requestedSessionId]);
    await assert.rejects(openBotConversation(live, f.a.id, new AbortController().signal), /尚未准备/);
  } finally { f.store.close(); }
});

test('late delivery deep links cannot change the work owner after navigation away', async () => {
  const f = fixture(); try {
    const response = deferred<{ task: Task }>(), signal = new AbortController(), nav = new AbortController();
    const api = apiWith(async <T>() => response.promise as Promise<T>);
    const reading = readTaskLink(api, f.ta.id, signal.signal, nav.signal);
    nav.abort(); response.resolve({ task: f.ta }); assert.equal(await reading, undefined);
    const wrong = apiWith(async <T>() => ({ task: f.tb }) as T);
    assert.equal(await readTaskLink(wrong, f.ta.id, new AbortController().signal, new AbortController().signal), undefined);
    const right = apiWith(async <T>() => f.store.taskDetail(f.tb.id) as T);
    assert.equal((await readTaskLink(right, f.tb.id, new AbortController().signal, new AbortController().signal))?.botId, f.b.id);
  } finally { f.store.close(); }
});

test('native work toggle and return only target their on-screen session, never change navigation', () => {
  const current = source('session-a'), calls: string[] = [];
  let active: { id: string; kind: string } | undefined, expanded = false;
  const sidebar = { mounted: current, active: () => active, isExpanded: () => expanded, hide: (id: string) => { calls.push(`hide:${id}`); expanded = false; }, openTab: (kind: string) => { calls.push(`open:${kind}`); active = { id: 'tab-a', kind }; expanded = true; } } as unknown as ISidebarRight;
  toggleSessionWork('session-a', sidebar); toggleSessionWork('session-a', sidebar);
  assert.deepEqual(calls, [`open:${WORK_TAB}`, 'hide:tab-a']);
  current.select('session-b'); toggleSessionWork('session-a', sidebar);
  current.select(undefined); toggleSessionWork('session-a', sidebar);
  assert.equal(calls.length, 2);
  current.select('session-b'); toggleSessionWork('session-b', sidebar);
  assert.equal(calls.at(-1), `open:${WORK_TAB}`);
});

test('real client registration is additive, session-scoped, and ignores forged tab owner parameters', () => {
  const entries: { options: any; render: Function }[] = [], effects: Function[] = [], definitions: any[] = [];
  const opened: unknown[] = [];
  const ctx = { effect: (fn: Function) => { effects.push(fn); }, slots: { inject: (_name: string, fn: Function) => fn(), register: (options: any, render: Function) => { entries.push({ options, render }); } }, sidebarRightTabs: { register: (definition: unknown) => { definitions.push(definition); return () => {}; } }, sidebarRight: {}, layout: {}, connection: {}, uiWorkspace: { openSession: (target: unknown) => opened.push(target) } } as unknown as Context;
  applyClient(ctx); effects[1]!();
  assert.ok(inject.includes('sidebarRight')); assert.ok(inject.includes('sidebarRightTabs'));
  const header = entries.find(entry => entry.options.name === 'conversation.session.header.actions')!;
  const hero = entries.find(entry => entry.options.name === 'conversation.hero.options')!;
  for (const entry of [header, hero]) { const element = entry.render({ sessionId: 'native-a' }); assert.equal(element.type, WorkButton); assert.equal(element.props.sessionId, 'native-a'); }
  const origin = entries.filter(entry => entry.options.id === 'super-bot-session-origin');
  assert.deepEqual(origin.map(entry => entry.options.name), ['conversation.session.header.actions', 'conversation.hero.options']);
  for (const entry of origin) {
    const element = entry.render({ sessionId: 'native-a' });
    assert.equal(element.type, SessionOriginHint); assert.equal(element.props.sessionId, 'native-a');
  }
  assert.ok(entries.every(entry => !entry.options.name.includes('composer')));
  const body = entries.find(entry => entry.options.name === 'sidebar.right.pane.tab')!;
  assert.equal(body.options.key, definitions[0].id); assert.equal(definitions[0].kind, WORK_TAB); assert.equal(definitions[0].keepMounted, undefined);
  const props = { sessionId: 'native-a', useTabInfo: () => ({ tab: { id: 'tab-a', visible: true, navigation: { params: { botId: 'forged-b' } } } }) };
  const element = body.render(props); assert.equal(element.type, SessionWork); assert.equal(element.props.sessionId, 'native-a'); assert.equal(element.props.tabId, 'tab-a'); assert.equal(element.props.botId, undefined);
  assert.equal(element.props.linkedWork, undefined);
  element.props.api.openChildSession('native-parent', 'native-child');
  assert.deepEqual(opened, [{ parentSessionId: 'native-parent', childSessionId: 'native-child', mode: 'unknown' }]);
  const link = { kind: 'result', taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resultId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } as const;
  const nativeLink = (sessionId: string, revision: number) => body.render({ ...props, useTabInfo: () => ({
    tab: { id: 'tab-a', visible: true, navigation: { revision, params: { sessionId, botId: 'a', href: workUrl(link) } } },
  }) }).props.linkedWork;
  assert.deepEqual(nativeLink('native-a', 1), { link, botId: 'a', revision: 1 });
  assert.deepEqual(nativeLink('native-a', 2), { link, botId: 'a', revision: 2 });
  assert.equal(nativeLink('native-b', 1), undefined);
  const file = { resultId: link.resultId, index: 1, name: 'result.md' };
  const fileTab = (sessionId: string) => body.render({ ...props, useTabInfo: () => ({
    tab: { id: 'tab-a', visible: true, navigation: { params: { sessionId, file } } },
  }) }).props.file;
  assert.deepEqual(fileTab('native-a'), file);
  assert.equal(fileTab('native-b'), undefined);
  assert.equal(body.render({ ...props, useTabInfo: () => ({ tab: { visible: false, navigation: {} } }) }), null);
  assert.ok(entries.every(entry => !['root', 'rightbar', 'conversation.session.header.corner'].includes(entry.options.name)));
});

test('native work links use the current Bot tab, deduplicate repeated clicks, and discard late navigation', async () => {
  const f = fixture(), current = source(f.ma.requestedSessionId);
  const openings: unknown[] = [];
  const pending = deferred<Bot | null>();
  let asyncRead = false;
  let nav = new AbortController();
  const api = {
    ...apiWith(async <T>(_action: string, payload?: Record<string, unknown>) => {
      return asyncRead ? pending.promise as Promise<T> : f.store.botForSession(String(payload?.sessionId)) as T;
    }),
    beginNavigation: () => { nav.abort(); nav = new AbortController(); return nav.signal; },
  };
  const tab = { id: 'existing', kind: WORK_TAB };
  const sidebar = { mounted: current, active: () => openings.length === 2 ? tab : undefined,
    tabsIn: () => openings.length ? [tab] : [],
    openTab: (...args: unknown[]) => { openings.push(args); } } as unknown as Context['sidebarRight'];
  const question: WorkLink = { kind: 'question', taskId: f.ta.id, attentionId: `run:${f.tb.id}` };
  const result: WorkLink = { kind: 'result', taskId: f.ta.id, resultId: f.tb.id };
  const active = new AbortController().signal;
  try {
    assert.equal(await openWorkLink(api, sidebar, question, active), 'sidebar');
    assert.equal(await openWorkLink(api, sidebar, result, active), 'sidebar');
    assert.equal(await openWorkLink(api, sidebar, result, active), 'sidebar');
    assert.deepEqual(openings, [question, result, result].map((link, index) => [WORK_TAB,
      { params: { sessionId: f.ma.requestedSessionId, botId: f.a.id, href: workUrl(link) }, ...(index ? { replaceTab: 'existing' } : {}) }]));
    assert.equal(await openWorkLink(api, sidebar, { kind: 'task', taskId: f.ta.id }, active), 'work');
    current.select('ordinary');
    assert.equal(await openWorkLink(api, sidebar, result, active), 'work');
    current.select(f.ma.requestedSessionId); asyncRead = true;
    const late = openWorkLink(api, sidebar, question, active);
    current.select(f.mb.requestedSessionId); current.select(f.ma.requestedSessionId);
    pending.resolve(f.a);
    assert.equal(await late, undefined);
    const cancelled = openWorkLink(api, sidebar, question, active);
    api.beginNavigation();
    assert.equal(await cancelled, undefined);
    assert.equal(openings.length, 3);
    assert.equal(current.listeners.size, 0);
  } finally { f.store.close(); }
});

test('work link parser preserves explicit identity and allows only same-origin root work URLs', () => {
  const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resultId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const question: WorkLink = { kind: 'question', taskId, attentionId: `run:${resultId}` };
  const result: WorkLink = { kind: 'result', taskId, resultId }, origin = new URL('https://host.example');
  for (const link of [question, result, { kind: 'task', taskId }] as const) {
    assert.deepEqual(parseWorkLink(workUrl(link).slice(1)), link);
    assert.deepEqual(workLinkForUrl(new URL(workUrl(link), origin), origin), link);
  }
  for (const hash of [`#super-bot-task=${taskId}&resultId=`, `#super-bot-task=${taskId}&resultId=invalid`,
    `${workUrl(result).slice(1)}&resultId=${resultId}`, `${workUrl(result).slice(1)}&attentionId=run%3A${resultId}`]) {
    assert.equal(parseWorkLink(hash), undefined);
  }
  assert.equal(workLinkForUrl(new URL(`https://other.example${workUrl(result)}`), origin), undefined);
  assert.equal(workLinkForUrl(new URL(`/other${workUrl(result).slice(1)}`, origin), origin), undefined);
  assert.equal(workLinkForUrl(new URL(`/?resultId=${resultId}#super-bot-task=${taskId}`, origin), origin), undefined);
});

test('native delivery compatibility accepts exact loopback routes and rejects external or malformed lookalikes', () => {
  const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resultId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const origin = new URL('http://127.0.0.1:3201'), old = 'http://127.0.0.1:3200';
  const work = { kind: 'result', taskId, resultId } as const;
  const path = workUrl(work), file = `/api/super-bot-file?index=0&resultId=${resultId}`;
  const parse = (url: string) => chatDeliveryLink(new URL(url), origin);
  assert.deepEqual(parse(old + path), work);
  assert.deepEqual(parse(origin.origin + path), work);
  assert.deepEqual(parse(old + file), { kind: 'file', resultId, index: 0 });
  for (const href of [`https://example.org${path}`, `http://localhost:3200${path}`, `http://user@127.0.0.1:3200${path}`,
    `${old}${path}&resultId=${resultId}`, `${old}/?token=unexpected${path.slice(1)}`, `${old}${file}&index=1`,
    `${old}${file.replace('index=0', 'index=9007199254740992')}`]) assert.equal(parse(href), 'blocked', href);
  assert.equal(parse(old + workUrl({ kind: 'question', taskId, attentionId: `run:${resultId}` })), undefined);
  assert.equal(parse('https://example.org/article'), undefined);

  const desktop = new URL('dsh-app://app/');
  assert.equal(desktop.origin, 'null', 'WHATWG URL alone does not identify the registered Desktop document');
  assert.deepEqual(chatDeliveryLink(new URL(old + path), desktop), work);
  assert.deepEqual(chatDeliveryLink(new URL(old + file), desktop), { kind: 'file', resultId, index: 0 });
  assert.deepEqual(workLinkForUrl(new URL(path, desktop), desktop), work);
  const question = { kind: 'question', taskId, attentionId: `run:${resultId}` } as const;
  assert.deepEqual(workLinkForUrl(new URL(workUrl(question), desktop), desktop), question);
  assert.equal(workLinkForUrl(new URL(path, 'dsh-app://shell/'), desktop), undefined);
  assert.equal(chatDeliveryLink(new URL(old + path), new URL('dsh-app://shell/')), 'blocked');
  assert.equal(chatDeliveryLink(new URL(file, 'app://other/'), desktop), 'blocked');
  assert.equal(new URL(resultFileUrl(resultId, 0, 'session-example'), desktop).href,
    `dsh-app://app/api/super-bot-file?resultId=${resultId}&index=0&sessionId=session-example`);
});

test('a Desktop chat link opens only after checking the exact result in its current native Bot conversation', async () => {
  const f = fixture(), current = source(f.ma.requestedSessionId);
  const result = { kind: 'result', taskId: f.ta.id, resultId: crypto.randomUUID() } as const;
  const parsed = chatDeliveryLink(new URL(workUrl(result), 'http://127.0.0.1:3200'), new URL('dsh-app://app/'));
  assert.deepEqual(parsed, result);
  const detail = { task: f.ta, linkedResult: { id: result.resultId, taskId: f.ta.id } };
  const openings: unknown[] = [], pending = deferred<typeof detail>();
  const sidebar = { mounted: current, active: () => undefined, tabsIn: () => [],
    openTab: (...args: unknown[]) => openings.push(args) } as unknown as Context['sidebarRight'];
  const api = apiWith(async <T>(action: string, payload?: Record<string, unknown>) => {
    if (action === 'bot.for-session') return f.store.botForSession(String(payload?.sessionId)) as T;
    assert.equal(action, 'task.detail');
    assert.equal(payload?.resultId, result.resultId);
    assert.equal(payload?.id, result.taskId);
    if (payload?.sessionId !== f.ma.requestedSessionId) throw new Error('Wrong native Bot');
    return pending.promise as Promise<T>;
  });
  const signal = new AbortController().signal;
  try {
    const late = openWorkLink(api, sidebar, result, signal, true);
    await flush();
    current.select(f.mb.requestedSessionId); current.select(f.ma.requestedSessionId);
    pending.resolve(detail);
    assert.equal(await late, undefined);
    current.select(f.mb.requestedSessionId);
    assert.equal(await openWorkLink(api, sidebar, result, signal, true), undefined);
    current.select('ordinary-session');
    assert.equal(await openWorkLink(api, sidebar, result, signal, true), undefined);
    assert.deepEqual(openings, []);
    current.select(f.ma.requestedSessionId);
    assert.equal(await openWorkLink(api, sidebar, result, signal, true), 'sidebar');
    assert.deepEqual(openings, [[WORK_TAB, { params: { sessionId: f.ma.requestedSessionId, botId: f.a.id, href: workUrl(result) } }]]);
  } finally { f.store.close(); }
});

test('work grouping preserves human review and does not relabel a report as completed', () => {
  const f = fixture(); try {
    assert.equal(f.ta.goal.length, 10000);
    for (const status of ['queued', 'running', 'stopping', 'unscheduled'] as const) assert.equal(workGroup({ ...f.ta, status }), 'doing');
    for (const status of ['needs-input', 'approval', 'recovery', 'paused', 'manual'] as const) assert.equal(workGroup({ ...f.ta, status }), 'needs-you');
    assert.equal(workGroup({ ...f.ta, lifecycle: 'review', status: 'paused' }), 'delivered');
    assert.equal(workGroup({ ...f.ta, lifecycle: 'completed', status: 'completed' }), 'delivered');
    assert.equal(workGroup({ ...f.ta, lifecycle: 'cancelled', status: 'cancelled' }), 'cancelled');
    assert.equal(f.store.getTask(f.ta.id).lifecycle, 'open');
  } finally { f.store.close(); }
});


test('real ready, settlement, pause, rework and cancellation facts project distinct result headings', () => {
  const f = fixture(); try {
    const binding = f.store.beginBinding('binding', f.ta.id, f.ta.rowVersion, '/synthetic/task-a');
    f.store.confirmBinding(binding.id, binding.requestedSessionId);
    const run = f.store.reserveRun('dispatch', f.ta.id, f.store.getTask(f.ta.id).rowVersion);
    f.store.saveRunMessage(run.id, 'native-input', '{}'); f.store.claimDispatch(run.id); f.store.inputEntered(run.id, 'native-input', 1);
    const report = f.store.workerReport(run.id, 'ready', { kind: 'ready', summary: 'Synthetic candidate', checks: 'Synthetic checks', evidence: [{ path: '/synthetic/task-a/result.md', sha256: 'synthetic', bytes: 1 }] });
    assert.ok(f.store.taskDetail(f.ta.id).result);
    assert.equal(resultHeading(f.store.getTask(f.ta.id)), '候选报告 · 当前不可验收');
    f.store.settleRun(run.id);
    assert.equal(resultHeading(f.store.getTask(f.ta.id)), '成果 · 待你验收');
    f.store.controlTask('pause', f.ta.id, f.store.getTask(f.ta.id).rowVersion, 'paused');
    assert.equal(resultHeading(f.store.getTask(f.ta.id)), '成果 · 待你验收');
    f.store.rejectResult('rework', f.ta.id, f.store.getTask(f.ta.id).rowVersion, report.resultId!, 'Revise this candidate');
    assert.ok(f.store.taskDetail(f.ta.id).result, 'old report remains but cannot be accepted again');
    assert.equal(resultHeading(f.store.getTask(f.ta.id)), '候选报告 · 当前不可验收');
    f.store.cancelTask('cancel', f.ta.id, f.store.getTask(f.ta.id).rowVersion);
    assert.ok(f.store.taskDetail(f.ta.id).result, 'cancellation preserves report history');
    assert.equal(resultHeading(f.store.getTask(f.ta.id)), '历史报告 · 任务已取消');
    assert.equal(f.store.resultById(report.resultId!)!.humanAcceptedAt, null);
    const bBinding = f.store.beginBinding('b-binding', f.tb.id, f.tb.rowVersion, '/synthetic/task-b');
    f.store.confirmBinding(bBinding.id, bBinding.requestedSessionId);
    const bRun = f.store.reserveRun('b-dispatch', f.tb.id, f.store.getTask(f.tb.id).rowVersion);
    f.store.saveRunMessage(bRun.id, 'b-input', '{}'); f.store.claimDispatch(bRun.id); f.store.inputEntered(bRun.id, 'b-input', 1);
    f.store.workerReport(bRun.id, 'b-ready', { kind: 'ready', summary: 'Unsettled B', checks: 'Synthetic checks', evidence: [{ path: '/synthetic/task-b/result.md', sha256: 'synthetic', bytes: 1 }] });
    f.store.runRecovery(bRun.id, 'Synthetic unknown background activity');
    assert.ok(f.store.taskDetail(f.tb.id).result);
    assert.equal(f.store.getTask(f.tb.id).status, 'recovery');
    assert.equal(resultHeading(f.store.getTask(f.tb.id)), '候选报告 · 当前不可验收');
    assert.equal(workGroup(f.store.getTask(f.tb.id)), 'needs-you');
    assert.equal(resultHeading({ ...f.ta, lifecycle: 'completed', status: 'completed' }), '成果 · 已接受');
  } finally { f.store.close(); }
});

test('DF-13 task detail explains capacity waits and offers consistent actions', () => {
  const f = fixture();
  const w = { locked: false } as WorkspaceState;
  try {
    f.store.setBotCapacity('one-slot', f.b.id, null, 1);
    const holderTask = f.store.createTask('holder-task', {
      botId: f.b.id, goal: 'Occupy B capacity', scope: 'Own work', acceptance: 'Read', reviewPolicy: 'human',
    });
    for (const task of [holderTask, f.tb]) {
      const binding = f.store.beginBinding(`binding-${task.id}`, task.id, task.rowVersion, '/synthetic/shared');
      f.store.confirmBinding(binding.id, binding.requestedSessionId);
    }
    const holder = f.store.reserveRun('holder', holderTask.id, f.store.getTask(holderTask.id).rowVersion);
    const show = () => {
      const detail = f.store.taskDetail(f.tb.id);
      const head: any[] = TaskDetailHeader({ w, detail, close: () => {} }).props.children;
      const [primary] = head.at(-1).props.children;
      const advanced: any = SessionControls({ w, detail }).props.children[1];
      const start = (node: any): boolean => Array.isArray(node) ? node.some(start) :
        node?.props?.children === '开始执行' || !!node?.props && start(node.props.children);
      const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') :
        typeof node === 'string' ? node : node?.props ? text(node.props.children) : '';
      return { detail, status: text(head.at(-2)), starts: [start(primary.type(primary.props)), start(advanced.type(advanced.props))] };
    };
    const rowVersion = f.store.getTask(f.tb.id).rowVersion;
    assert.throws(() => f.store.reserveRun('blocked', f.tb.id, rowVersion), { code: 'capacity' });
    f.store.recordWait(f.tb.id);
    f.store.enqueueManager(f.b.id, `capacity:${f.tb.id}:${rowVersion}`, 'Synthetic wait', f.tb.id);
    const blocked = show();
    assert.deepEqual(blocked.starts, [false, false]);
    assert.match(blocked.status, /等待当前 Bot 的执行名额/);
    assert.match(blocked.status, /Bot 会继续安排/);
    f.store.saveRunMessage(holder.id, 'holder-input', '{}');
    f.store.claimDispatch(holder.id);f.store.inputEntered(holder.id, 'holder-input', 1);
    f.store.workerReport(holder.id, 'done', { kind: 'waiting', summary: 'Holder released the resource' });
    f.store.settleRun(holder.id);
    const ready = show();
    assert.equal(ready.detail.wait, null);
    assert.match(ready.status, /资源已就绪，等管理会话可用后由 Bot 继续安排/);
    assert.deepEqual(ready.starts, [false, false]);
    f.store.releaseManager('disable-B', f.b.id, f.mb.generation);
    const manual = show();
    assert.equal(manual.status, '');
    assert.deepEqual(manual.starts, [true, true]);
  } finally { f.store.close(); }
});

test('the linked task drawer offers only the exact answer or explicitly selected result', async () => {
  const f = fixture();
  const mutations: unknown[] = [];
  const w = { locked: false, mutate: async (...args: unknown[]) => { mutations.push(args); return true; } } as unknown as WorkspaceState;
  const close = () => {};
  const inTask = (taskId: string, key: string) => {
    const run = f.store.reserveRun(key, taskId, f.store.getTask(taskId).rowVersion);
    f.store.saveRunMessage(run.id, `msg-${key}`, '{}'); f.store.claimDispatch(run.id); f.store.inputEntered(run.id, `msg-${key}`, 1);
    return run;
  };
  const drawer = (link: Exclude<WorkLink, { kind: 'task' }>, reloadEligible = false, deliveredResult: DeliveredResult | null = null): any[] =>
    LinkedTaskContent({ w, close, link,
      detail: { ...f.store.taskDetail(f.ta.id), reloadEligible, deliveredResult,
        linkedResult: link.kind === 'result' ? f.store.resultById(link.resultId) : null } }).props.children;
  try {
    for (const task of [f.ta, f.tb]) {
      const binding = f.store.beginBinding(`binding-${task.id}`, task.id, task.rowVersion, `/synthetic/${task.id}`);
      f.store.confirmBinding(binding.id, binding.requestedSessionId);
    }
    const one = inTask(f.ta.id, 'question-a'), two = inTask(f.tb.id, 'question-b');
    const questionText = '**Question** about [this document](https://example.test/document).';
    for (const [run, key] of [[one, 'one'], [two, 'two']] as const) {
      f.store.workerReport(run.id, key, { kind: 'waiting', summary: key === 'one' ? questionText : 'Different question' });
      f.store.settleRun(run.id);
    }
    const question = { kind: 'question', taskId: f.ta.id, attentionId: `run:${one.id}` } as const;
    const [head, questionBox] = drawer(question);
    assert.equal(head.props.controls, false);
    assert.equal(questionBox.props.attention.id, question.attentionId);
    const questionChildren = questionBox.type(questionBox.props).props.children;
    const [, preview, explanation] = questionChildren;
    assert.equal(preview.type, 'p');
    assert.equal(preview.props.className, 'clamp prose-preview');
    assert.equal(preview.props.children, questionText);
    assert.equal(explanation.props.className, 'prose-details');
    assert.equal(explanation.props.children[1].type, WorkMarkdown);
    assert.equal(explanation.props.children[1].props.text, questionText);
    const answerForm = questionChildren.find((node: any) => node?.type === ReplyForm);
    await answerForm.props.submit('合成回答', 'answer');
    assert.deepEqual(mutations, [['attention.respond', { requestId: 'answer', id: question.taskId, attentionId: question.attentionId,
      expectedRowVersion: f.store.getTask(f.ta.id).rowVersion, text: '合成回答' }]]);
    assert.match(drawer({ ...question, attentionId: `run:${two.id}` })[1].props.children, /不属于此任务/);
    const answer = f.store.respondAttention('answer', question.attentionId, f.store.getTask(f.ta.id).rowVersion, '合成回答');
    assert.equal(answer.attentionId, question.attentionId);
    const responding = drawer(question)[1];
    assert.ok(!responding.type(responding.props).props.children.some((node: any) => node?.type === ReplyForm));
    const ready = (key: string, checks = 'Read the delivered file', summary = key) => {
      const run = inTask(f.ta.id, key);
      const { resultId } = f.store.workerReport(run.id, key, { kind: 'ready', summary, checks,
        evidence: [{ path: '/synthetic/result.md', sha256: key, bytes: 1 }] });
      f.store.settleRun(run.id); return { kind: 'result', taskId: f.ta.id, resultId: resultId! } as const;
    };
    const selfReported = '- Worker says **Web loaded**.\n- Desktop unverified.';
    const oldSummary = '**Old** [reference](https://example.test/notes).';
    const old = ready('old', selfReported, oldSummary);
    assert.match(drawer(question)[1].props.children, /已回答/);
    const resultHeader = drawer(old)[0];
    assert.equal(resultHeader.props.controls, true);
    const [primary] = resultHeader.type(resultHeader.props).props.children.at(-1).props.children;
    assert.equal(primary.type(primary.props), null);
    const cardChildren = (link: typeof old, eligible: boolean): any[] => {
      const card = drawer(link, eligible)[1];
      return card.type(card.props).props.children[1].props.children;
    };
    const loadPanel = (link: typeof old, eligible: boolean) => {
      const entry = cardChildren(link, eligible).find(node => node?.type === ResultLoadReceipt);
      return entry?.type(entry.props).props.children;
    };
    const [summaryView, linksView, fileView, verification, reviewView, , reportView] = cardChildren(old, true);
    assert.equal(summaryView.type, ResultSummary);
    assert.equal(linksView.type, ResultLinks);
    assert.equal(fileView.type, ResultFiles);
    assert.equal(fileView.props.result.id, old.resultId);
    const [verificationLabel, checks] = verification.props.children;
    assert.equal(verificationLabel.props.children, 'Worker 自述的检查与未验证项');
    assert.equal(checks.type, WorkMarkdown);
    assert.equal(checks.props.text, selfReported);
    const [, reviewActions] = reviewView.type(reviewView.props).props.children;
    const [accept, rework] = reviewActions.props.children;
    assert.equal(accept.props.children, '接受成果');
    assert.equal(rework.props.children[0].props.children, '要求返工');
    const reviewVersion = {
      id: old.taskId, expectedRowVersion: f.store.getTask(f.ta.id).rowVersion, resultId: old.resultId,
    };
    await accept.props.onClick();
    await rework.props.children[1].props.submit('修正报告', 'review-rework');
    assert.deepEqual(mutations.slice(1), [
      ['result.accept', { requestId: `accept:${old.resultId}:${reviewVersion.expectedRowVersion}`, ...reviewVersion }],
      ['result.reject', { requestId: 'review-rework', ...reviewVersion, text: '修正报告' }],
    ]);
    assert.equal(reportView.type, ResultReport);
    const [reportLabel, fullSummary, repeatedChecks] = reportView.type(reportView.props).props.children;
    assert.equal(reportLabel.props.children, '完整 Worker 报告');
    assert.equal(fullSummary.type, WorkMarkdown);
    assert.equal(fullSummary.props.text, oldSummary);
    assert.equal(repeatedChecks, undefined);
    assert.match(loadPanel(old, true)[0].props.children.join(''), /本端宿主 · 暂无匹配/);
    f.store.recordDevReload(`/synthetic/${f.ta.id}`, { resultId: old.resultId, build: 'old-build', from: 'before', to: 'after', pid: 42 });
    const matched = loadPanel(old, true);
    assert.match(matched[0].props.children.join(''), /本端宿主 · 原生回执已确认插件热载/);
    assert.equal(matched[2].props.children.join(''), '构建 old-build');
    assert.match(matched[3].props.children.join(''), /宿主 PID 42 · 实例 before → after/);
    f.store.rejectResult('rework', f.ta.id, f.store.getTask(f.ta.id).rowVersion, old.resultId, '再修一版');
    assert.equal(drawer(old)[0].props.controls, false);
    const latest = ready('latest');
    assert.equal(f.store.taskDetail(f.ta.id).progress.reload, null);
    assert.match(loadPanel(latest, true)[0].props.children.join(''), /暂无匹配/);
    assert.equal(loadPanel(latest, false), undefined, 'ordinary file results keep the existing compact card');
    assert.match(drawer(old)[1].props.children[1].props.children, /当前不可验收/);
    const shipped = { ...f.store.resultById(latest.resultId)!, deliveredAt: Date.now(), links: {} };
    const [oldHead, oldNotice] = drawer(old, false, shipped);
    assert.equal(oldHead.props.controls, false);
    const [, replacement, summary, links, report, files, next] = oldNotice.props.children;
    assert.match(replacement.props.children, /已被新版替代/);
    assert.equal(summary.type, ResultSummary);
    assert.equal(summary.props.result.summary, oldSummary);
    assert.equal(links.type, ResultLinks);
    assert.equal(links.type(links.props), null);
    assert.equal(report.props.checks, selfReported);
    assert.equal(files.props.result.id, old.resultId);
    assert.equal(next.props.href, workUrl(latest));
    const [newHead, newCard] = drawer(latest);
    assert.equal(newHead.props.controls, true);
    assert.equal(newCard.props.detail.result.id, latest.resultId);
    const [foreignHead, foreignNotice] = drawer({ ...old, resultId: f.tb.id });
    assert.equal(foreignHead.props.controls, false);
    assert.match(foreignNotice.props.children, /无效或不属于此任务/);
    assert.throws(() => f.store.acceptResult('old-accept', old.taskId, f.store.getTask(f.ta.id).rowVersion, old.resultId), { code: 'result-stale' });
    assert.equal(f.store.resultById(latest.resultId)?.humanAcceptedAt, null);
  } finally { f.store.close(); }
});

test('a legacy delivery keeps its plain preview and has no links group', () => {
  const summary = '**Worker report** with a [reference](https://example.test/reference).';
  const preview = ResultSummary({ result: { id: 'legacy', summary, links: {} } });
  assert.equal(preview.type, 'p');
  assert.equal(preview.props.className, 'clamp prose-preview');
  assert.equal(preview.props.children, summary);
  assert.equal(ResultLinks({ links: {} }), null);
});
