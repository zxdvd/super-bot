import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent';
import type { ChildWaitDetail } from '../../src/model.ts';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope';
import { Session } from '@deepseek-ai/dsh-session';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { apply } from '../../src/index.ts';
import { Store } from '../../src/store.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>(resolve => { settle = resolve; });
  return { promise, settle };
}

type NativeVersion = 'rc.1' | 'rc.5';

async function fixture(t: TestContext, version: NativeVersion) {
  const runtime = resolve('.runtime');
  mkdirSync(runtime, { recursive: true });
  const dataDir = realpathSync(mkdtempSync(join(runtime, 'df12-fixture-')));
  const cwd = join(dataDir, 'work');
  mkdirSync(cwd);
  const file = join(cwd, 'result.md');
  writeFileSync(file, 'final bytes');
  const seed = new Store(join(dataDir, 'ledger.sqlite'));
  const bot = seed.createBot('bot', { name: 'DF-12 fixture', instructions: 'Synthetic' });
  const manager = seed.beginManager('manager', bot.id, cwd);
  seed.confirmManager(manager.id, manager.requestedSessionId);
  const task = seed.createTask('task', { botId: bot.id, goal: 'Check children', scope: 'Own directory',
    acceptance: 'Read final bytes', reviewPolicy: 'human' });
  const binding = seed.beginBinding('binding', task.id, task.rowVersion, cwd);
  seed.confirmBinding(binding.id, binding.requestedSessionId);
  seed.close();

  const events = new Context();
  const emit = events.emit as (...args: unknown[]) => void;
  const connection = new HostConnectionService(new Context(), [], {
    isAuthenticated: () => false, authenticateApi: () => undefined,
  } as unknown as ConstructorParameters<typeof HostConnectionService>[2]);
  const fetch = connection.createSharedFetchHandler('/api').fetch;
  const effects: Array<() => void | Promise<void>> = [];
  const tools = new Map<string, { execute: Function }>();
  let resolves = 0, concluded = 0, waitCalls = 0;
  const workerSession = Session.create(SessionId(binding.requestedSessionId));
  const worker = makeAgent(workerSession);
  const other = makeAgent(Session.create(SessionId('other-root')));
  const registry = new Map([[worker.session.id, worker], [other.session.id, other]]);
  const parents = new Map<object, FakeAgent>();
  let wait: ReturnType<typeof deferred<boolean>> | undefined;
  let nativeService: object | undefined;
  let afterEvidenceRead: (() => void) | undefined;
  function nativeWait(agent: Agent) {
    assert.equal(agent, worker);
    waitCalls++;
    if (waitCalls === 2) afterEvidenceRead?.();
    return wait?.promise ?? Promise.resolve(false);
  }
  const tree = version === 'rc.1' ? { waitForChildren: nativeWait } : {
    waitForTreeWork: nativeWait,
    rootOf(agent: FakeAgent) {
      let root = agent;
      while (parents.has(root)) root = parents.get(root)!;
      return root;
    },
  };
  nativeService = tree;

  function makeAgent(session: Session, parent?: object) {
    let idle = deferred<void>();
    const agent = {
      id: session.id, session, status: 'idle', message: undefined as UserMessage | undefined,
      ctx: undefined as unknown as Context, signal: new AbortController(),
      inbox: { nextStep: [], nextTurn: [], remove: () => {} },
      followup(message: UserMessage) {
        agent.message = message; agent.status = 'running'; agent.signal = new AbortController(); idle = deferred<void>();
      },
      whenIdle: () => idle.promise,
      cancel() { agent.signal.abort(); },
      idle() { agent.status = 'idle'; idle.settle(); },
    };
    agent.ctx = createScope(events, agent, { parent }).ctx;
    Object.defineProperty(agent.ctx, 'tools', { value: { guard: () => () => {}, restrict: () => () => {} } });
    return agent;
  }
  type FakeAgent = ReturnType<typeof makeAgent>;

  const ctx = {
    connection,
    get: (name: string) => name === 'subagents' ? nativeService : undefined,
    on(name: string, fn: Function) {
      const off = (events.on as Function)(name, fn) as () => void;
      effects.push(off);
      return off;
    },
    effect(start: () => unknown) { const off = start(); if (typeof off === 'function') effects.push(off as () => void); },
    inject: async () => {},
    tools: { register(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    agents: { list: () => [...registry.values()], get: (id: SessionId) => registry.get(id),
      ...(version === 'rc.1' ? { isOwnedBy: (id: SessionId, owner: FakeAgent) => parents.get(registry.get(id)!) === owner } : {}) },
    jobs: { list: () => [] }, permissionPresets: { set: () => {} }, workingDirectory: { get: () => cwd },
    sessionController: { resolveAgent(id: string) { resolves++; assert.equal(id, worker.id); return { agent: worker }; } },
    sessionProjections: { snapshot: () => ({ values: { modelSelection: { next: { provider: 'fixture', model: 'fixture' } } } }) },
    sessions: { flush: async () => true },
    sessionPersistence: { async open(id: string, access: string) {
      assert.equal(access, 'read');
      if (id !== worker.id) throw Error('Unknown fixture session');
      return { header: workerSession.header, inheritedEventCount: 0,
        read: async () => ({ events: workerSession.snapshotEvents() }), close: async () => {} };
    } },
  } as unknown as Context;
  async function close() { for (const off of effects.splice(0).reverse()) await off(); }
  t.after(async () => {
    worker.cancel(); worker.idle(); wait?.settle(false);
    await close();
    assert.ok(dataDir.startsWith(join(runtime, 'df12-fixture-')));
    assert.equal(realpathSync(dataDir), dataDir);
    rmSync(dataDir, { recursive: true });
  });
  async function api(action: string, data: Record<string, unknown> = {}) {
    const response = await fetch(new Request('http://localhost/api/super-bot', {
      method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'df12', method: 'super-bot',
        payload: { action, id: task.id, sessionId: manager.requestedSessionId, ...data } }),
    }), connection.browserPeer);
    assert.equal(response.status, 200);
    const result = (await response.json()).result;
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  }
  function startTurn(turn: number) {
    const start = workerSession.append('turn/start', { turn });
    emit('session/event', workerSession, start);
    const input = workerSession.append('user/message', worker.message!, { surfaceOp: 'append' });
    emit('session/event', workerSession, input);
    return { startSeq: start.seq, inputSeq: input.seq };
  }
  function turnEnd(turn: number, reason: 'completed' | 'aborted' = 'completed') {
    const end = workerSession.append('turn/end', { turn, reason: reason === 'completed' ? { kind: reason }
      : { kind: reason, reason: { kind: 'user' } } });
    emit('session/event', workerSession, end);
    worker.idle();
  }
  function makeChild(id: string, parent = worker, local = true) {
    const child = makeAgent(Session.create(SessionId(id)), parent);
    child.status = 'running';
    const info = { runId: `${id}-activation`, id: child.id, provider: 'fixture', local,
      ...(version === 'rc.5' ? { parentSessionId: parent.id } : {}) };
    const route = (carrier: FakeAgent) => scopeTarget(tree, carrier);
    return {
      child, info,
      start(carrier = version === 'rc.1' ? parent : worker) {
        if (local) { registry.set(child.id, child); parents.set(child, parent); }
        emit(route(carrier), 'subagent/start', info);
      },
      end(stopReason = 'completed', carrier = version === 'rc.1' ? parent : worker) {
        child.idle(); registry.delete(child.id);
        emit(route(carrier), 'subagent/end', { ...info, stopReason });
      },
      emit: (edge: 'start' | 'end', overrides: Record<string, unknown>) => {
        emit(route(worker), `subagent/${edge}`, { ...info, ...overrides });
      },
    };
  }
  await apply(ctx, { dataDir, fullAccess: true });
  const initial = await api('task.detail');
  const run = await api('task.dispatch', { requestId: 'dispatch', expectedRowVersion: initial.task.rowVersion });
  return {
    api, worker, other, run, startTurn, turnEnd, makeChild,
    onEvidenceRead: (callback: () => void) => { afterEvidenceRead = callback; },
    download: (resultId: string, preview = false, sessionId: string = manager.requestedSessionId) => fetch(new Request(
      `http://localhost/api/super-bot-file?resultId=${resultId}&index=0&sessionId=${sessionId}${preview ? '&preview=1' : ''}`),
    connection.browserPeer),
    async dropAttachment(resultId: string) {
      await close();
      const db = new DatabaseSync(join(dataDir, 'ledger.sqlite'));
      try { db.prepare('DELETE FROM result_attachments WHERE resultId = ?').run(resultId); }
      finally { db.close(); }
      await apply(ctx, { dataDir, fullAccess: true });
    },
    file,
    injectWrongTurn(turn: number) {
      const spoof = Session.create(worker.id);
      emit('session/event', spoof, spoof.append('turn/start', { turn }));
      emit('session/event', spoof, spoof.append('user/message', worker.message!, { surfaceOp: 'append' }));
    },
    childIdle(agent: FakeAgent) { agentEvents(agent.ctx, agent as unknown as Agent).emit('agent/status', { status: 'idle' }); },
    wait: () => {
      const pending = wait = deferred<boolean>();
      return { settle(value: boolean) { if (wait === pending) wait = undefined; pending.settle(value); } };
    },
    loseService: () => { nativeService = undefined; },
    resolves: () => resolves, concluded: () => concluded, waitCalls: () => waitCalls,
    ready: (callId: string) => tools.get('super_bot_report')!.execute({ kind: 'ready', summary: 'Final facts',
      checks: 'Read final bytes', files: [file] }, { agent: worker, callId, signal: worker.signal.signal,
      concludeTurn: () => { concluded++; } }),
    stopping: (turn: number, agent = worker) => agentEvents(agent.ctx, agent as unknown as Agent)
      .serial('agent/turn-stopping', { turn, signal: agent.signal.signal }),
    async reload() { await close(); await apply(ctx, { dataDir, fullAccess: true }); },
  };
}

test('ready downloads the exact bytes read before the final native quiet check', async t => {
  const f = await fixture(t, 'rc.1');
  const submitted = Buffer.from([0, 255, 128, 10]);
  writeFileSync(f.file, submitted);
  f.startTurn(1);
  f.onEvidenceRead(() => writeFileSync(f.file, 'changed after validation'));
  const { resultId } = await f.ready('ready-with-file-change');
  assert.ok(resultId);
  f.turnEnd(1);
  const detail = await f.api('task.detail', { resultId });
  assert.equal(detail.linkedResult.evidence[0].bytes, submitted.length);
  assert.equal(detail.linkedResult.evidence[0].sha256, createHash('sha256').update(submitted).digest('hex'));
  assert.equal(detail.linkedResult.humanAcceptedAt, null);
  const response = await f.download(resultId);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), submitted);
  assert.equal((await f.download(resultId, true)).status, 415);
});

test('text preview uses the same scoped, immutable bytes as download', async t => {
  const f = await fixture(t, 'rc.1');
  const submitted = Buffer.from('最终内容\n<b>literal markup</b>\n');
  writeFileSync(f.file, submitted);
  f.startTurn(1);
  f.onEvidenceRead(() => writeFileSync(f.file, 'changed after validation'));
  const { resultId } = await f.ready('ready-preview');
  assert.ok(resultId);
  f.turnEnd(1);
  const response = await f.download(resultId, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(response.headers.get('content-disposition'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), submitted);
  assert.equal((await f.download(resultId, true, f.other.id)).status, 404);
  const download = await f.download(resultId);
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), submitted);

  await f.dropAttachment(resultId);
  assert.equal((await f.download(resultId, true)).status, 409); // The workspace now contains different bytes.
  writeFileSync(f.file, submitted);
  assert.deepEqual(Buffer.from(await (await f.download(resultId, true)).arrayBuffer()), submitted);
  rmSync(f.file);
  const missing = await f.download(resultId, true);
  assert.equal(missing.status, 409);
  assert.match(await missing.text(), /未保存附件副本.*无法读取.*恢复到原路径.*重新提交/);
});

for (const version of ['rc.1', 'rc.5'] as const) {
  test(`${version} registered ready exposes and retains a same-Run native wait through task.detail`, async t => {
    const f = await fixture(t, version);
    const startTime = Date.now();
    let clock = startTime;
    t.mock.method(Date, 'now', () => clock);
    const turn = f.startTurn(1);
    const one = f.makeChild('child-one'), two = f.makeChild('child-two');
    const joining = f.wait();
    one.start(); two.start();
    const early = f.ready('ready-early');
    void early.catch(() => {});
    await tick();
    const live = await f.api('task.detail');
    assert.equal(f.waitCalls(), 1, 'the registered report reached the native tree service');
    assert.equal(live.childWaits?.length, 1, 'the product detail must expose the registered ready wait');
    const [item] = live.childWaits as ChildWaitDetail[];
    assert.ok(item);
    assert.equal(item.runId, f.run.id);
    assert.deepEqual({ turn: item.turn, startSeq: item.startSeq, inputSeq: item.inputSeq }, { turn: 1, ...turn });
    assert.equal(item.source, 'ready');
    assert.equal(item.outcome, 'waiting');
    assert.equal(item.startedAt, startTime);
    assert.equal(item.endedAt, null);
    assert.equal(item.pendingCount, 2);
    assert.deepEqual(item.children.map(c => [c.sessionId, c.parentSessionId]),
      [[one.info.id, f.worker.id], [two.info.id, f.worker.id]]);
    assert.equal(item.elapsedMs, 0);
    assert.equal(live.result, null);
    assert.equal(live.runHeld, true);
    clock += 12_000;
    one.end();
    const reopened = (await f.api('task.detail')).childWaits[0];
    assert.equal(reopened.pendingCount, 1);
    assert.equal(reopened.elapsedMs, 12_000);
    clock += 25_000;
    two.end(); joining.settle(true);
    assert.equal((await early).reason, 'subtree-joined');
    const stopped = await f.api('task.detail');
    assert.equal(stopped.childWaits.length, 1);
    assert.equal(stopped.childWaits[0].outcome, 'converged');
    assert.equal(stopped.childWaits[0].endedAt, startTime + 37_000);
    assert.equal(stopped.childWaits[0].elapsedMs, 37_000);
    assert.equal(f.concluded(), 0);
    assert.equal(stopped.runHeld, true);
    assert.equal((await f.ready('ready-final')).accepted, true);
    await f.stopping(1);
    f.turnEnd(1);
    await tick();
    const review = await f.api('task.detail');
    assert.equal(review.task.lifecycle, 'review');
    assert.equal(review.result.humanAcceptedAt, null);
    assert.deepEqual(review.childWaits, stopped.childWaits, 'fast clear ready and stopping probes add no wait');
    await f.reload();
    assert.deepEqual((await f.api('task.detail')).childWaits, stopped.childWaits);
    assert.equal(f.resolves(), 1, 'detail and reload must not open native agents');
  });

  test(`${version} native turn-stopping exposes only the tracked parent turn`, async t => {
    const f = await fixture(t, version);
    f.injectWrongTurn(2);
    await f.stopping(2);
    assert.equal(f.waitCalls(), 0, 'a different Session object cannot claim the Run even with its exact message');
    f.startTurn(3);
    const child = f.makeChild('stopping-child');
    const joining = f.wait();
    child.start();
    await f.stopping(3, child.child);
    await f.stopping(4);
    assert.equal(f.waitCalls(), 0);
    const stopping = f.stopping(3);
    void stopping.catch(() => {});
    await tick();
    assert.equal(f.waitCalls(), 1, 'the owned native stopping hook reached the tree service');
    const live = await f.api('task.detail');
    assert.equal(live.childWaits?.[0]?.source, 'turn-stopping');
    assert.equal(live.childWaits[0].turn, 3);
    assert.equal(live.childWaits[0].runId, f.run.id);
    f.childIdle(child.child);
    assert.equal((await f.api('task.detail')).runHeld, true);
    assert.equal((await f.api('task.detail')).run.finishedAt, null, 'a descendant going idle cannot close the parent');
    child.end('error'); joining.settle(true);
    await stopping;
    f.turnEnd(3);
    await tick();
    const detail = await f.api('task.detail');
    assert.equal(detail.childWaits[0].outcome, 'converged');
    assert.equal(detail.childWaits[0].children[0].stopReason, 'error');
    assert.equal(detail.task.status, 'recovery', 'native convergence does not supply a missing report');
    assert.equal(detail.runHeld, true);
  });

  test(`${version} foreign owners and mismatched ends cannot change the known count`, async t => {
    const f = await fixture(t, version);
    f.startTurn(1);
    const child = f.makeChild('owned');
    const external = f.makeChild('owned-external', f.worker, false);
    const nested = f.makeChild('nested', child.child);
    const foreign = f.makeChild('foreign', f.other, false);
    const joining = f.wait();
    child.start(); external.start(); nested.start(); foreign.start(f.other);
    if (version === 'rc.5') foreign.emit('start', {}); // Correct carrier, creator belongs to another tree.
    const ready = f.ready('owner-check');
    void ready.catch(() => {});
    await tick();
    const read = async (): Promise<ChildWaitDetail> => (await f.api('task.detail')).childWaits[0];
    const before = await read();
    assert.equal(before.pendingCount, 3);
    assert.deepEqual(before.children.map(c => [c.childId, c.parentSessionId, c.sessionId]), [
      [child.info.id, f.worker.id, child.info.id], [external.info.id, f.worker.id, null],
      [nested.info.id, child.info.id, nested.info.id],
    ]);
    child.emit('start', {}); // duplicate
    child.emit('end', { id: 'wrong-child', stopReason: 'completed' });
    child.emit('end', { provider: 'wrong-provider', stopReason: 'completed' });
    if (version === 'rc.5') child.emit('end', { parentSessionId: f.other.id, stopReason: 'completed' });
    assert.equal((await read()).pendingCount, 3);
    nested.end(); child.end(); external.end('aborted'); joining.settle(true);
    assert.equal((await ready).reason, 'subtree-joined');
    const after = await read();
    assert.equal(after.outcome, 'converged');
    assert.equal(after.children[1]?.stopReason, 'aborted');
    child.emit('end', { stopReason: 'error' }); // late/duplicate
    assert.deepEqual(await read(), after);
  });
}

test('a service change leaves an unknown wait without refreshing stale elapsed time', async t => {
  const f = await fixture(t, 'rc.5');
  f.startTurn(1);
  const joining = f.wait();
  const stopping = f.stopping(1);
  const failed = assert.rejects(stopping, { code: 'child-unknown' });
  await tick();
  const live = (await f.api('task.detail')).childWaits[0];
  assert.equal(live.outcome, 'checking');
  assert.equal(live.pendingCount, null);
  assert.deepEqual(live.children, []);
  f.loseService();
  const disconnected = (await f.api('task.detail')).childWaits[0];
  assert.equal(disconnected.outcome, 'unknown');
  assert.equal(disconnected.endedAt, null);
  assert.equal(disconnected.elapsedMs, null);
  joining.settle(true);
  await failed;
  const detail = await f.api('task.detail');
  assert.equal(detail.childWaits[0].outcome, 'unknown');
  assert.ok(detail.childWaits[0].endedAt >= live.startedAt);
  assert.equal(detail.runHeld, true);
  f.worker.idle();
  await f.reload();
  assert.deepEqual((await f.api('task.detail')).childWaits, detail.childWaits);
});

test('stop records cancellation of the wait and a late child cannot settle the parent', async t => {
  const f = await fixture(t, 'rc.5');
  f.startTurn(1);
  const child = f.makeChild('external', f.worker, false);
  const joining = f.wait();
  child.start();
  const aborted = assert.rejects(f.ready('stop-wait'), { name: 'AbortError' });
  await tick();
  const live = await f.api('task.detail');
  await f.api('task.stop', { requestId: 'stop', expectedRowVersion: live.task.rowVersion });
  await aborted;
  f.turnEnd(1, 'aborted');
  const ended = await f.api('task.detail');
  assert.equal(ended.childWaits[0].outcome, 'cancelled');
  assert.equal(ended.childWaits[0].children[0].stopReason, null);
  assert.equal(ended.runHeld, true);
  assert.equal(ended.result, null);
  child.end('aborted'); joining.settle(true);
  await f.reload();
  assert.deepEqual((await f.api('task.detail')).childWaits, ended.childWaits);
});

test('reload while awaiting keeps the known start and leaves an unobserved end unknown', async t => {
  const f = await fixture(t, 'rc.5');
  f.startTurn(1);
  const child = f.makeChild('external', f.worker, false);
  const joining = f.wait();
  child.start();
  const aborted = assert.rejects(f.ready('reload-wait'), { name: 'AbortError' });
  await tick();
  const live = (await f.api('task.detail')).childWaits[0];
  const reloading = f.reload();
  await aborted;
  f.worker.idle();
  await reloading;
  const detail = await f.api('task.detail');
  assert.equal(detail.childWaits[0].startedAt, live.startedAt);
  assert.equal(detail.childWaits[0].outcome, 'unknown');
  assert.equal(detail.childWaits[0].endedAt, null);
  assert.equal(detail.childWaits[0].elapsedMs, null);
  assert.equal(detail.childWaits[0].children[0].childId, child.info.id);
  assert.equal(detail.runHeld, true);
  joining.settle(true);
});

test('a retry in the same Worker shows only new owned members while retaining the old Run history', async t => {
  const f = await fixture(t, 'rc.5');
  f.startTurn(1);
  const first = f.makeChild('first');
  const joining = f.wait();
  first.start();
  const early = f.ready('ready-first');
  await tick();
  first.end(); joining.settle(true);
  assert.equal((await early).reason, 'subtree-joined');
  await f.ready('ready-to-review');
  await f.stopping(1);
  f.turnEnd(1);
  await tick();
  const reviewed = await f.api('task.detail');
  const rejected = await f.api('result.reject', { requestId: 'rework', expectedRowVersion: reviewed.task.rowVersion,
    resultId: reviewed.result.id, text: 'Retry synthetic fixture' });
  const retry = await f.api('task.dispatch', { requestId: 'retry', expectedRowVersion: rejected.rowVersion });
  f.startTurn(2);
  const second = f.makeChild('second');
  const next = f.wait();
  second.start();
  first.emit('end', { stopReason: 'error' });
  const secondEarly = f.ready('ready-second');
  void secondEarly.catch(() => {});
  await tick();
  const current = await f.api('task.detail');
  assert.deepEqual(current.childWaits.map((item: ChildWaitDetail) => [item.runId, item.turn, item.outcome]),
    [[retry.id, 2, 'waiting'], [f.run.id, 1, 'converged']]);
  assert.deepEqual(current.childWaits[0].children.map((child: { childId: string }) => child.childId), ['second']);
  assert.deepEqual(current.childWaits[1], reviewed.childWaits[0]);
  second.end(); next.settle(true);
  await secondEarly;
});
