/** Product Store and production client lookup/navigation code; native UI is a synthetic boundary, not a browser. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { Bot, ManagerBinding, Task } from '../../src/model.ts';
import { Store } from '../../src/store.ts';
import { apply as applyClient, inject } from '../../src/client.tsx';
import { SessionWork, WorkButton } from '../../src/ui/SessionWork.tsx';
import { resultHeading, workGroup, type WorkspaceApi } from '../../src/ui/Workspace.tsx';
import { WORK_TAB, openBotConversation, readSessionBot, readTaskLink, toggleSessionWork, watchSessionBot, type SessionBotState } from '../../src/ui/work-navigation.ts';

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
  const ctx = { effect: (fn: Function) => { effects.push(fn); }, slots: { inject: (_name: string, fn: Function) => fn(), register: (options: any, render: Function) => { entries.push({ options, render }); } }, sidebarRightTabs: { register: (definition: unknown) => { definitions.push(definition); return () => {}; } }, sidebarRight: {}, layout: {}, connection: {}, uiWorkspace: {} } as unknown as Context;
  applyClient(ctx); effects[1]!();
  assert.ok(inject.includes('sidebarRight')); assert.ok(inject.includes('sidebarRightTabs'));
  const header = entries.find(entry => entry.options.name === 'conversation.session.header.actions')!;
  const hero = entries.find(entry => entry.options.name === 'conversation.hero.options')!;
  for (const entry of [header, hero]) { const element = entry.render({ sessionId: 'native-a' }); assert.equal(element.type, WorkButton); assert.equal(element.props.sessionId, 'native-a'); }
  const body = entries.find(entry => entry.options.name === 'sidebar.right.pane.tab')!;
  assert.equal(body.options.key, definitions[0].id); assert.equal(definitions[0].kind, WORK_TAB); assert.equal(definitions[0].keepMounted, undefined);
  const props = { sessionId: 'native-a', useTabInfo: () => ({ tab: { id: 'tab-a', visible: true, navigation: { params: { botId: 'forged-b' } } } }) };
  const element = body.render(props); assert.equal(element.type, SessionWork); assert.equal(element.props.sessionId, 'native-a'); assert.equal(element.props.tabId, 'tab-a'); assert.equal(element.props.botId, undefined);
  assert.equal(body.render({ ...props, useTabInfo: () => ({ tab: { visible: false } }) }), null);
  assert.ok(entries.every(entry => !['root', 'rightbar', 'conversation.session.header.corner'].includes(entry.options.name)));
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
