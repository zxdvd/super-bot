import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { AgentModel, modelSelectionProjectionDefinition as selection } from '@deepseek-ai/dsh-agent';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import { createAssistantMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand';
import { Session } from '@deepseek-ai/dsh-session';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { apply } from '../../src/index.ts';
import type { Run } from '../../src/model.ts';
import type { RuntimeOptions } from '../../src/runtime.ts';
import { Store } from '../../src/store.ts';

const sol = { provider: 'synthetic-codex', model: 'codex/gpt-6.2-sol', reasoningEffort: ReasoningEffortId('xhigh') };
const medium = { ...sol, reasoningEffort: ReasoningEffortId('medium') };
const otherModel = { provider: 'synthetic-other', model: 'different' };
const error = { kind: 'error' as const, error: { code: 'MISSING_CREDENTIAL', message: 'synthetic pre-request failure' } };
function pick(session: Session) {
  return session.snapshotEvents().reduce((acc, event) => selection.apply(acc, event),
    selection.init(session.header, session.inheritedEventCount));
}

function fixture(t: TestContext) {
  const runtime = join(realpathSync(process.cwd()), '.runtime');
  mkdirSync(runtime, { recursive: true });
  const dataDir = mkdtempSync(join(runtime, 'df11-fixture-'));
  const seed = new Store(join(dataDir, 'ledger.sqlite'));
  const logs = new Map<string, Session>(), agents = new Map<string, ReturnType<typeof mockAgent>>();
  const effects: Array<() => void | Promise<void>> = [], listeners = new Map<string, Function[]>();
  const tools = new Map<string, { execute: Function }>();
  const migrationHints = new Set<string>();
  let resolves = 0;
  let reads = 0;
  function makeSession(id: string) {
    const session = Session.create(SessionId(id));
    logs.set(session.id, session);
    return session;
  }
  function makeTask(label: string) {
    const cwd = join(dataDir, label);
    mkdirSync(cwd);
    const bot = seed.createBot(`bot-${label}`, { name: label, instructions: 'Synthetic' });
    const manager = seed.beginManager(`manager-${label}`, bot.id, cwd);
    seed.confirmManager(manager.id, manager.requestedSessionId);
    const chat = makeSession(manager.requestedSessionId);
    const task = seed.createTask(`task-${label}`, { botId: bot.id, goal: 'Check', scope: 'Files', acceptance: 'Review', reviewPolicy: 'human' });
    const binding = seed.beginBinding(`binding-${label}`, task.id, task.rowVersion, cwd);
    seed.confirmBinding(binding.id, binding.requestedSessionId);
    return { task, chat, worker: makeSession(binding.requestedSessionId), cwd };
  }
  const a = makeTask('A'), b = makeTask('B');
  function mockAgent(session: Session, cwd: string) {
    let finish: () => void = () => {};
    let idle = Promise.resolve();
    const agent = {
      id: session.id, session, status: 'idle', cwd,
      model: new AgentModel(() => pick(session), session, { ...medium } as ConstructorParameters<typeof AgentModel>[2]),
      ctx: { tools: { restrict: () => () => {}, guard: () => () => {} }, systemPrompt: { section: () => () => {} }, on: () => () => {} },
      inbox: { nextTurn: [], nextStep: [], remove: () => {} },
      delivered: [] as UserMessage[],
      followup(message: UserMessage) {
        agent.delivered.push(message);
        agent.status = 'running';
        idle = new Promise(resolve => { finish = resolve; });
      },
      cancel() { agent.status = 'idle'; finish(); },
      whenIdle: () => idle,
    };
    agents.set(session.id, agent);
    return agent;
  }
  const connection = new HostConnectionService(new Context(), [], {
    isAuthenticated: () => false, authenticateApi: () => undefined,
  } as unknown as ConstructorParameters<typeof HostConnectionService>[2]);
  const fetch = connection.createSharedFetchHandler('/api').fetch;
  const ctx = {
    connection,
    effect(start: () => unknown) { const off = start(); if (typeof off === 'function') effects.push(off as () => void); },
    inject: async () => {},
    on(name: string, fn: Function) {
      const list = listeners.get(name) ?? [];
      listeners.set(name, list); list.push(fn);
      return () => list.splice(list.indexOf(fn), 1);
    },
    tools: { register(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    agents: { get: (id: string) => agents.get(id), list: () => [] },
    jobs: { list: () => [] },
    permissionPresets: { set: () => {} },
    workingDirectory: { get: (session: Session) => agents.get(session.id)?.cwd },
    sessionController: {
      resolveAgent(id: string) { resolves++; return agents.has(id) ? { agent: agents.get(id) } : { error: 'cold' }; },
      async projections({ sessionId }: { sessionId: string }) {
        const session = logs.get(sessionId);
        if (!session) return null;
        const { lastUsed, pending } = pick(session);
        const values = { modelSelection: { lastUsed, next: pending ?? lastUsed } };
        return migrationHints.has(sessionId) ? { kind: 'migration-required', values }
          : { kind: 'sequenced', asOfSeq: session.seq - 1, values };
      },
    },
    sessionProjections: { snapshot(session: Session) { const { lastUsed, pending } = pick(session); return { values: { modelSelection: { lastUsed, next: pending ?? lastUsed } } }; } },
    sessionPersistence: { async open(id: string, access: string) {
      assert.equal(access, 'read');
      const session = logs.get(id);
      if (!session) throw Error('Missing synthetic log');
      reads++;
      return { header: session.header, inheritedEventCount: session.inheritedEventCount,
        read: async () => ({ events: session.snapshotEvents() }), close: async () => {} };
    } },
  } as unknown as Context;
  let seeded = false;
  async function close() {
    for (const dispose of effects.splice(0).reverse()) await dispose();
    listeners.clear();
  }
  t.after(async () => {
    if (!seeded) seed.close();
    await close();
    assert.equal(realpathSync(dataDir), dataDir);
    assert.ok(dataDir.startsWith(join(runtime, 'df11-fixture-')));
    rmSync(dataDir, { recursive: true });
  });
  async function mount(options: RuntimeOptions = {}) {
    if (!seeded) { seed.close(); seeded = true; }
    await close();
    await apply(ctx, { dataDir, fullAccess: false, ...options });
  }
  async function call(action: string, scope = a, data: Record<string, unknown> = {}) {
    const response = await fetch(new Request('http://localhost/api/super-bot', {
      method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'df11', method: 'super-bot',
        payload: { action, id: scope.task.id, sessionId: scope.chat.id, ...data } }),
    }), connection.browserPeer);
    assert.equal(response.status, 200);
    return (await response.json()).result;
  }
  function begin(scope: typeof a, label: string) {
    const run = seed.reserveRun(label, scope.task.id, seed.getTask(scope.task.id).rowVersion);
    const message = createUserMessage({ source: { kind: 'super-bot', taskId: run.taskId, runId: run.id,
      inputId: run.inputId, taskRevision: run.taskRevision, generation: run.generation }, content: [{ type: 'text', text: 'synthetic' }] });
    seed.saveRunMessage(run.id, message.id, JSON.stringify(message));
    seed.claimDispatch(run.id); seed.inputEnqueued(run.id);
    return { run, message };
  }
  function enter(scope: typeof a, { run, message }: ReturnType<typeof begin>, turn: number, wrongSource = false) {
    const { seq: start } = scope.worker.append('turn/start', { turn });
    scope.worker.append('step/start', { turn, step: 1 });
    const input = scope.worker.append('user/message', wrongSource ? { ...message, source: { ...message.source, generation: 90 } } as UserMessage : message, { surfaceOp: 'append' });
    seed.inputEntered(run.id, message.id, input.seq);
    seed.associateRunTurn(run.id, turn, start, input.seq);
  }
  function end(scope: typeof a, run: Run, turn: number, step: number, reason: typeof error | { kind: 'completed' }, continueTask = false) {
    scope.worker.append('step/end', { turn, step });
    const event = scope.worker.append('turn/end', { turn, reason });
    if (reason.kind === 'error') {
      seed.observeRunEnd(run.id, event.seq, reason.kind, true);
      seed.runRecovery(run.id, 'Synthetic failure', false);
      return;
    }
    seed.workerReport(run.id, `report-${run.id}`, { kind: 'waiting', summary: 'Question' });
    seed.observeRunEnd(run.id, event.seq, reason.kind, true);
    seed.settleRun(run.id);
    if (continueTask) seed.respondAttention(`answer-${run.id}`, `run:${run.id}`, seed.getTask(scope.task.id).rowVersion, 'Synthetic answer');
  }
  return { a, b, seed, logs, agents, mount, close, call, mockAgent, begin, enter, end, migrationHints,
    resolveCount: () => resolves, readCount: () => reads,
    manage: (callId: string, scope: typeof a, args: Record<string, unknown>, agent?: ReturnType<typeof mockAgent>) => {
      return tools.get('super_bot_manage')!.execute(args, { callId, agent: agent ?? { id: scope.chat.id }, signal: new AbortController().signal });
    } };
}

function header(session: Session, config: typeof otherModel & { reasoningEffort?: typeof sol.reasoningEffort }, reason: 'initial' | 'change') {
  return session.append('request/header', { header: { config }, reason }).seq;
}
function reply(session: Session, turn: number, step: number, model = sol as typeof otherModel) {
  return session.append('assistant/message', { turn, step, stream: [], message: createAssistantMessage({ source: model,
    content: [{ type: 'text', text: 'synthetic model output' }] }) }, { surfaceOp: 'append' }).seq;
}

test('detail polls keep the preview lightweight and expanded history binds each Run across reload', async t => {
  const f = fixture(t), { a, b } = f;
  const first = f.begin(a, 'a1'); f.enter(a, first, 1);
  const inheritedHeader = header(a.worker, sol, 'initial'); reply(a.worker, 1, 1);
  f.end(a, first.run, 1, 1, { kind: 'completed' }, true);
  const isolated = f.begin(b, 'b1'); f.enter(b, isolated, 1);
  const bHeader = header(b.worker, medium, 'initial'); reply(b.worker, 1, 1);
  f.end(b, isolated.run, 1, 1, { kind: 'completed' }, true);
  const foreign = f.begin(b, 'b2'); f.enter(b, foreign, 2, true);
  reply(b.worker, 2, 1); f.end(b, foreign.run, 2, 1, { kind: 'completed' });

  const second = f.begin(a, 'a2'); f.enter(a, second, 2);
  const replyWithoutHeader = reply(a.worker, 2, 1);
  a.worker.append('step/end', { turn: 2, step: 1 });
  a.worker.append('model/selection', otherModel);
  a.worker.append('step/start', { turn: 2, step: 2 });
  const changedHeader = header(a.worker, otherModel, 'change');
  reply(a.worker, 2, 2, otherModel); f.end(a, second.run, 2, 2, { kind: 'completed' });
  a.worker.append('model/selection', medium);

  await f.mount();
  const aDetail = (await f.call('task.detail')).value;
  assert.deepEqual(aDetail.model, { current: medium, expected: { ...medium, source: 'native-selection' } });
  assert.equal((await f.call('task.detail', b)).value.model.current.reasoningEffort, 'medium');
  assert.deepEqual((await f.call('task.detail')).value.model, aDetail.model);
  assert.equal(f.readCount(), 0, 'detail must use the native projection, not the history reader');
  assert.equal((await f.call('task.model-history', b, { sessionId: a.chat.id })).error.code, 'not-found');
  assert.equal((await f.call('task.model-history', a, { sessionId: a.worker.id })).error.code, 'not-found');
  assert.equal((await f.call('task.model-history', a, { sessionId: 'ordinary-native-session' })).error.code, 'not-found');
  assert.equal((await f.call('task.model-history', a, { owner: 'desktop' })).error.code, 'invalid-input');
  assert.equal((await f.call('task.model-history', a, { runId: isolated.run.id })).error.code, 'invalid-input');
  assert.equal(f.readCount(), 0, 'out-of-scope queries must not read native events');
  const aHistory = (await f.call('task.model-history')).value;
  const bHistory = (await f.call('task.model-history', b)).value;
  assert.equal(aHistory.taskId, a.task.id);
  assert.deepEqual(aHistory.runs.map((run: { runId: string }) => run.runId), [second.run.id, first.run.id]);
  assert.deepEqual(aHistory.runs.map((run: { sessionId: string }) => run.sessionId), [a.worker.id, a.worker.id]);
  assert.equal(f.readCount(), 2, 'each explicitly queried session is read once');
  const [secondFacts, firstFacts] = aHistory.runs;
  assert.deepEqual(secondFacts.actual.map((call: any) => [call.turn, call.step, call.provider, call.model, call.reasoningEffort, call.headerSeq]),
    [[2, 1, sol.provider, sol.model, 'xhigh', inheritedHeader], [2, 2, otherModel.provider, otherModel.model, null, changedHeader]]);
  assert.equal(secondFacts.actual[0].eventSeq, replyWithoutHeader);
  assert.equal(firstFacts.actual[0].reasoningEffort, 'xhigh');
  assert.deepEqual(bHistory.runs[0].actual, []);
  assert.equal(bHistory.runs[1].actual[0].reasoningEffort, 'medium');
  assert.equal(bHistory.runs[1].actual[0].headerSeq, bHeader);
  assert.equal((await f.call('task.detail', b, { sessionId: a.chat.id })).error.code, 'not-found');

  await f.mount({ workerModel: { ...otherModel, reasoningEffort: ReasoningEffortId('high') } });
  const reloaded = (await f.call('task.detail')).value;
  assert.deepEqual(reloaded.model.current, aDetail.model.current);
  assert.equal(reloaded.model.expected.source, 'role-override');
  assert.equal(reloaded.model.expected.reasoningEffort, 'high');
  assert.deepEqual((await f.call('task.detail')).value.model, reloaded.model);
  assert.equal(f.readCount(), 2);
  assert.deepEqual((await f.call('task.model-history')).value, aHistory);
  await f.close();
  const ledger = new DatabaseSync(join(a.cwd, '..', 'ledger.sqlite'), { readOnly: true });
  try {
    const count = ledger.prepare('SELECT count(*) AS total FROM runs WHERE taskId = ?');
    assert.equal(count.get(a.task.id)?.total, 2);
    assert.equal(count.get(b.task.id)?.total, 2);
  } finally { ledger.close(); }
  assert.equal(f.resolveCount(), 0, 'polling and explicit history must not resolve either cold native session');
});

test('chat previews model provenance before dispatch and snapshots the chosen route on the actual Run', async t => {
  const f = fixture(t), { a, b } = f;
  const manager = f.mockAgent(a.chat, a.cwd), worker = f.mockAgent(a.worker, a.cwd);
  const other = f.mockAgent(b.chat, b.cwd), otherWorker = f.mockAgent(b.worker, b.cwd);
  other.model.select(otherModel);
  otherWorker.model.select({ ...otherModel, reasoningEffort: ReasoningEffortId('low') });
  await f.mount();
  const preview = (scope: typeof a, id: string, taskId = scope.task.id) =>
    f.manage(id, scope, { action: 'model-preview', taskId }, scope === a ? manager : other);
  assert.deepEqual(await preview(a, 'unselected'), { current: null, expected: null });
  await assert.rejects(preview(a, 'cross-bot', b.task.id), { code: 'manager-scope' });
  assert.deepEqual((await f.call('task.model-history')).value, { taskId: a.task.id, runs: [] });
  assert.equal(f.resolveCount(), 0);
  const native = await preview(b, 'native-choice');
  assert.deepEqual(native.expected, { ...otherModel, reasoningEffort: 'low', source: 'native-selection' });
  manager.model.select(sol);
  const planned = { ...sol, source: 'manager-inheritance', sourceSessionId: a.chat.id };
  assert.deepEqual(await preview(a, 'inheritance'), { current: null, expected: planned });
  assert.equal(worker.session.seq, 0, 'preview never selects a Worker model');
  const before = (await f.call('task.detail')).value;
  assert.deepEqual(before.model.expected, planned);
  const args = { action: 'dispatch', taskId: a.task.id, expectedRowVersion: before.task.rowVersion };
  const { run, expectedModel } = await f.manage('dispatch', a, args, manager);
  assert.deepEqual(expectedModel, planned);
  assert.equal(worker.delivered.length, 1);
  worker.model.select(otherModel);
  const detail = (await f.call('task.detail')).value;
  assert.deepEqual(detail.model.current, { ...otherModel, reasoningEffort: null });
  assert.deepEqual((await f.call('task.model-history')).value.runs[0], {
    runId: run.id, sessionId: a.worker.id, createdAt: run.createdAt, expected: planned, actual: [],
  });
  assert.deepEqual((await f.manage('dispatch', a, args, manager)).expectedModel, planned);
  assert.equal(worker.delivered.length, 1);

  await f.mount({ workerModel: medium });
  assert.deepEqual(await preview(a, 'role'), {
    current: { ...otherModel, reasoningEffort: null }, expected: { ...medium, source: 'role-override' },
  });
  assert.deepEqual((await f.call('task.model-history')).value.runs[0].expected, planned);
});

test('a bare header and an error-only attempt do not prove a request, and a later native turn cannot fill the gap', async t => {
  const f = fixture(t), { a } = f;
  const failed = f.begin(a, 'failed'); f.enter(a, failed, 1);
  header(a.worker, sol, 'initial');
  a.worker.append('assistant/attempt', { turn: 1, step: 1, stream: [
    { type: 'chunk', time: 1, chunk: { type: 'finish', reason: { kind: 'error', failure: error.error } } },
  ] });
  f.end(a, failed.run, 1, 1, error);
  a.worker.append('turn/start', { turn: 2 }); a.worker.append('step/start', { turn: 2, step: 1 });
  reply(a.worker, 2, 1); a.worker.append('step/end', { turn: 2, step: 1 });
  a.worker.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  await f.mount({ workerModel: medium });
  f.migrationHints.add(a.worker.id);
  const { model } = (await f.call('task.detail')).value;
  assert.deepEqual(model, { current: null, expected: { ...medium, source: 'role-override' } });
  assert.equal(f.readCount(), 0, 'a migration hint cannot trigger raw history as a fallback');
  assert.deepEqual((await f.call('task.model-history')).value.runs[0].actual, []);
  assert.equal(f.resolveCount(), 0);
});

test('legacy Runs bind only exact native inputs and preserve output-bearing retries without guessing an effort', async t => {
  const f = fixture(t), { a, b } = f;
  const legacy = f.begin(a, 'legacy'); f.enter(a, legacy, 1);
  const retryHeader = header(a.worker, sol, 'initial');
  const attemptSeq = a.worker.append('assistant/attempt', { turn: 1, step: 1, stream: [
    { type: 'reasoning-chunks', time0: 1, index: 0, dt: [0], texts: ['synthetic partial output'] },
  ] }).seq;
  reply(a.worker, 1, 1, otherModel); // Unmatched route proves no effort from the earlier header.
  f.end(a, legacy.run, 1, 1, { kind: 'completed' });
  f.seed.db.prepare('DELETE FROM run_turns WHERE runId=?').run(legacy.run.id);

  const failed = f.begin(b, 'pre-input');
  b.worker.append('turn/start', { turn: 1 }); b.worker.append('step/start', { turn: 1, step: 1 });
  b.worker.append('step/end', { turn: 1, step: 1 }); b.worker.append('turn/end', { turn: 1, reason: error });
  f.seed.runRecovery(failed.run.id, 'Failed before entering input', false);
  await f.mount({ workerModel: medium });
  const actual = (await f.call('task.model-history')).value.runs[0].actual;
  assert.deepEqual(actual.map((call: any) => [call.evidence, call.model, call.reasoningEffort, call.headerSeq]),
    [['assistant/attempt', sol.model, 'xhigh', retryHeader], ['assistant/message', otherModel.model, null, null]]);
  assert.equal(actual[0].eventSeq, attemptSeq);
  assert.deepEqual((await f.call('task.model-history', b)).value.runs[0].actual, []);
});
