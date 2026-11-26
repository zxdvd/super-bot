import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { HostConnectionService, type Principal } from '@deepseek-ai/dsh-client-connection';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { apply, Config } from '../../src/index.ts';
import { Store } from '../../src/store.ts';

async function fixture(
  t: TestContext,
  scenario:
    | 'review'
    | 'interrupted'
    | 'capacity'
    | 'bot-capacity'
    | 'legacy-capacity'
    | 'stale' = 'review',
  registry: 'rc1' | 'rc5' = 'rc1',
) {
  const runtime = join(realpathSync(process.cwd()), '.runtime');
  mkdirSync(runtime, { recursive: true });
  const dataDir = mkdtempSync(join(runtime, 'df10-ledger-'));
  const database = join(dataDir, 'ledger.sqlite');
  const seed = new Store(database);
  const bot = seed.createBot('bot', { name: 'Recovery Bot', instructions: 'Synthetic only' });
  const task = seed.createTask('task', {
    botId: bot.id,
    goal: 'Synthetic task',
    scope: 'Files',
    acceptance: 'Read them',
    reviewPolicy: 'human',
  });
  const manager = seed.beginManager('manager', bot.id, dataDir);
  seed.confirmManager(manager.id, manager.requestedSessionId);
  const other = seed.createBot('other-bot', { name: 'Other Bot', instructions: 'Synthetic only' });
  const otherManager = seed.beginManager('other-manager', other.id, dataDir);
  seed.confirmManager(otherManager.id, otherManager.requestedSessionId);
  const cwd = join(dataDir, 'worker');
  mkdirSync(cwd);
  const intent = seed.beginBinding('bind', task.id, task.rowVersion, cwd);
  const binding = seed.confirmBinding(intent.id, intent.requestedSessionId);
  const run = seed.reserveRun('first-run', task.id, seed.getTask(task.id).rowVersion);
  seed.saveRunMessage(run.id, 'old-message', '{}');
  seed.claimDispatch(run.id);
  seed.inputEnqueued(run.id);
  if (scenario === 'review') {
    seed.inputEntered(run.id, 'old-message', 1);
    seed.workerReport(run.id, 'ready', {
      kind: 'ready',
      summary: 'Files ready',
      checks: 'Read back',
      evidence: [{ path: 'file.md', bytes: 1, sha256: 'synthetic' }],
    });
    seed.settleRun(run.id);
  } else {
    seed.runRecovery(run.id, 'Lost delivery receipt', false);
  }
  if (scenario === 'capacity' || scenario === 'bot-capacity' || scenario === 'legacy-capacity') {
    const occupied = seed.createTask('occupied', {
      botId: bot.id,
      goal: 'Other task',
      scope: 'Files',
      acceptance: 'Read',
      reviewPolicy: 'human',
    });
    const next = seed.beginBinding(
      'occupied-binding',
      occupied.id,
      occupied.rowVersion,
      join(dataDir, 'sibling'),
    );
    seed.confirmBinding(next.id, next.requestedSessionId);
    const holding = seed.reserveRun(
      'capacity-placeholder',
      occupied.id,
      seed.getTask(occupied.id).rowVersion,
    );
    seed.runRecovery(holding.id, 'Retained occupation', false);
    if (scenario === 'capacity') seed.setBotCapacity('one-slot', bot.id, null, 1);
  }
  if (scenario === 'stale') {
    seed.db.prepare('UPDATE attentions SET taskRevision=0 WHERE id=?').run(`run:${run.id}`);
  }
  const beforeLedger = snapshot(seed.db);
  seed.close();

  const connCtx = new Context();
  const connection = new HostConnectionService(connCtx, [], {
    isAuthenticated: () => false,
    authenticateApi: () => undefined,
  } as unknown as ConstructorParameters<typeof HostConnectionService>[2]);
  const fetch = connection.createSharedFetchHandler('/api').fetch;
  const effects: Array<() => unknown> = [],
    listeners = new Map<string, Function[]>(),
    tools = new Map<string, any>();
  const options = { selected: true, directory: cwd, failDelivery: false, failJobs: false };
  type LiveAgent = { id: string; status: string };
  const hooks: {
    beforeResolve?: () => Promise<void>;
    waitForTreeWork?: () => Promise<boolean>;
    resolveError?: string;
    rootOf?: (agent: LiveAgent) => LiveAgent;
  } = {};
  const sent: UserMessage[] = [],
    removed: string[] = [];
  const mounted = new Map<string, LiveAgent>(),
    owners = new Map<string, string>();
  const jobs: Array<{ id: string; owner: string; status: string }> = [];
  let resolves = 0,
    permissionChanges = 0;
  let finish = () => {};
  let idle = Promise.resolve();
  const session = { id: binding.sessionId!, header: { cwd } };
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    inbox: {
      nextTurn: [] as Array<{ id: string; source: Record<string, unknown>; content?: unknown }>,
      nextStep: [] as Array<{ id: string; source: Record<string, unknown>; content?: unknown }>,
      remove(id: string) {
        removed.push(id);
        for (const queue of [this.nextTurn, this.nextStep]) {
          const index = queue.findIndex((message) => message.id === id);
          if (index >= 0) queue.splice(index, 1);
        }
      },
    },
    ctx: { tools: { guard: () => () => {} }, on: () => () => {} },
    followup(message: UserMessage) {
      sent.push(message);
      agent.status = 'running';
      idle = new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (options.failDelivery) throw Error('Synthetic receipt loss after accepting input');
    },
    cancel() {
      agent.status = 'idle';
      finish();
    },
    whenIdle: () => idle,
  };
  const ctx = {
    connection,
    effect: (start: () => unknown) => {
      const dispose = start();
      if (typeof dispose === 'function') effects.push(dispose as () => unknown);
    },
    inject: async () => {},
    on: (name: string, handler: Function) => {
      const list = listeners.get(name) ?? [];
      list.push(handler);
      listeners.set(name, list);
      return () => {};
    },
    get: (key: string) =>
      key === 'subagents' && (hooks.waitForTreeWork || hooks.rootOf) ? hooks : undefined,
    tools: {
      register: (tool: { name: string }) => {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    agents: {
      get: (id: string) => mounted.get(id),
      list: () => [...mounted.values()],
      ...(registry === 'rc1'
        ? { isOwnedBy: (id: string, owner: LiveAgent) => owners.get(id) === owner.id }
        : {}),
    },
    jobs: {
      list: (owner: string) => {
        if (options.failJobs) throw Error('Registry unavailable');
        return jobs.filter((job) => job.owner === owner);
      },
    },
    workingDirectory: { get: () => options.directory },
    permissionPresets: {
      set: () => {
        permissionChanges++;
      },
    },
    sessionProjections: {
      snapshot: () => ({
        values: {
          modelSelection: options.selected
            ? { next: { provider: 'synthetic', model: 'test' } }
            : undefined,
        },
      }),
    },
    sessionController: {
      resolveAgent: async (id: string) => {
        resolves++;
        await hooks.beforeResolve?.();
        if (hooks.resolveError || id !== agent.id)
          return { error: hooks.resolveError ?? 'wrong-id' };
        const cold = !mounted.has(id);
        mounted.set(id, agent);
        if (cold) for (const notify of listeners.get('agent/created') ?? []) notify({ agent });
        return { agent };
      },
    },
  } as unknown as Context;
  async function close() {
    for (const dispose of effects.splice(0).reverse()) await dispose();
  }
  t.after(async () => {
    await close();
    assert.equal(realpathSync(dataDir), dataDir);
    assert.ok(dataDir.startsWith(join(runtime, 'df10-ledger-')));
    rmSync(dataDir, { recursive: true });
  });
  if (scenario === 'legacy-capacity') {
    const {
      managerModel: _managerModel,
      workerModel: _workerModel,
      ...legacyConfig
    } = Config({ dataDir, maxRunningTasks: 1 });
    await apply(ctx, legacyConfig);
  } else {
    await apply(ctx, { dataDir });
  }
  function raw(
    action: string,
    payload: Record<string, unknown> = {},
    peer = connection.browserPeer,
  ) {
    const fields =
      action.startsWith('task.') || action.startsWith('run.')
        ? { id: task.id, ...payload }
        : payload;
    return fetch(
      new Request('http://localhost/api/super-bot', {
        method: 'POST',
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'synthetic',
          method: 'super-bot',
          payload: { action, ...fields },
        }),
      }),
      peer,
    );
  }
  async function call(action: string, payload: Record<string, unknown> = {}) {
    const response = await raw(action, payload);
    assert.equal(response.status, 200);
    return (await response.json()).result;
  }
  const detail = async () => (await call('task.detail')).value;
  async function recoveryArgs() {
    const current = await detail();
    return {
      requestId: 'resume-recovery',
      expectedRowVersion: current.task.rowVersion,
      acknowledged: true,
      attentionId: current.recovery.attentionId,
      bindingId: binding.id,
      expectedBindingGeneration: binding.generation,
    };
  }
  const emit = async (event: unknown) => {
    for (const handler of listeners.get('session/event') ?? []) await handler(session, event);
  };
  async function ledger() {
    await close();
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      return snapshot(db);
    } finally {
      db.close();
    }
  }
  return {
    raw,
    call,
    detail,
    recoveryArgs,
    ledger,
    beforeLedger,
    bot,
    other,
    task,
    run,
    binding,
    agent,
    mounted,
    owners,
    jobs,
    options,
    hooks,
    sent,
    removed,
    emit,
    tools,
    manager,
    otherManager,
    resolves: () => resolves,
    permissionChanges: () => permissionChanges,
    nonOwner: () =>
      connection.createPeer({ principal: { kind: 'synthetic-other' } as unknown as Principal }),
    unauthenticated: () => connection.requestRejection({ headers: { host: 'localhost' } }),
  };
}

function snapshot(db: DatabaseSync) {
  return Object.fromEntries(
    [
      'tasks',
      'bindings',
      'runs',
      'resources',
      'inputs',
      'outbox',
      'attentions',
      'requests',
      'events',
      'results',
      'reviews',
    ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}

test('run.recover rejects a settled result pending human review without a current recovery attention', async (t) => {
  const f = await fixture(t);
  const before = (await f.call('task.detail')).value;
  assert.equal(before.task.status, 'review');
  assert.equal(before.task.controlMode, 'auto');
  assert.equal(
    before.attentions.some(
      (item: { kind: string; state: string }) => item.kind === 'recovery' && item.state === 'open',
    ),
    false,
  );
  const result = await f.call('run.recover', {
    requestId: 'invalid-recovery',
    expectedRowVersion: before.task.rowVersion,
    acknowledged: true,
  });
  const after = (await f.call('task.detail')).value;
  assert.equal(after.task.controlMode, 'auto', `command was ${JSON.stringify(result)}`);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'recovery-stale');
  assert.deepEqual(after, before);
  assert.deepEqual(await f.ledger(), f.beforeLedger);
  assert.equal(f.resolves(), 0);
});

const CONTINUE = 'run.recover-and-continue';

test('an open attention from an old task revision cannot authorize either recovery action', async (t) => {
  const f = await fixture(t, 'stale');
  const detail = await f.detail();
  assert.equal(detail.task.status, 'recovery');
  assert.equal(detail.task.blockingAttention, null);
  assert.equal(detail.recovery.attentionId, null);
  assert.equal(detail.recovery.canContinue, false);
  const args = { ...(await f.recoveryArgs()), attentionId: `run:${f.run.id}` };
  for (const action of ['run.recover', CONTINUE]) {
    assert.equal((await f.call(action, args)).error.code, 'recovery-stale');
  }
  assert.equal(f.resolves(), 0);
  assert.deepEqual(await f.ledger(), f.beforeLedger);
});

test('detail polling observes only the current Worker and never resolves its cold session', async (t) => {
  const f = await fixture(t, 'interrupted');
  f.agent.inbox.nextStep.push({
    id: 'notice',
    source: { kind: 'tool-jobs', form: 'notice' },
    content: 'SYNTHETIC INLINE OUTPUT',
  });
  f.jobs.push(
    { id: 'root-job', owner: f.agent.id, status: 'completed' },
    { id: 'unrelated-job', owner: 'other', status: 'running' },
  );
  for (let i = 0; i < 3; i++) {
    const { recovery } = await f.detail();
    assert.deepEqual(recovery.worker, { sessionId: f.agent.id, status: null, inputs: null });
    assert.deepEqual(recovery.jobs, [
      { id: 'root-job', sessionId: f.agent.id, status: 'completed' },
    ]);
    assert.deepEqual(recovery.subtree, { state: 'unknown', children: [] });
  }
  f.mounted.set(f.agent.id, f.agent);
  f.mounted.set('child', { id: 'child', status: 'running' });
  f.mounted.set('grandchild', { id: 'grandchild', status: 'idle' });
  f.mounted.set('other', { id: 'other', status: 'running' });
  f.owners.set('child', f.agent.id);
  f.owners.set('grandchild', 'child');
  f.jobs.push({ id: 'descendant-job', owner: 'grandchild', status: 'stopping' });
  f.agent.inbox.nextTurn.push(
    { id: 'human', source: { kind: 'user' } },
    { id: 'never-replay', source: { kind: 'super-bot' } },
  );
  f.agent.inbox.nextStep.push(
    { id: 'child-result', source: { kind: 'subagent-settled' } },
    { id: 'other', source: { kind: 'unknown' } },
  );
  const { recovery } = await f.detail();
  assert.deepEqual(recovery.worker.inputs, [
    { queue: 'next-turn', kind: 'human', count: 1 },
    { queue: 'next-turn', kind: 'task', count: 1 },
    { queue: 'next-step', kind: 'job-result', count: 1 },
    { queue: 'next-step', kind: 'child-result', count: 1 },
    { queue: 'next-step', kind: 'other', count: 1 },
  ]);
  assert.deepEqual(recovery.subtree, {
    state: 'active',
    children: [
      { sessionId: 'child', status: 'running' },
      { sessionId: 'grandchild', status: 'idle' },
    ],
  });
  assert.deepEqual(
    recovery.jobs.map((job: { id: string }) => job.id),
    ['root-job', 'descendant-job'],
  );
  assert.doesNotMatch(
    JSON.stringify(recovery),
    /SYNTHETIC INLINE OUTPUT|unrelated-job|never-replay/,
  );
  assert.equal(f.resolves(), 0);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(await f.ledger(), f.beforeLedger);
});

test('rc.5 recovery polling uses live tree roots and keeps known descendants when another ownership lookup fails', async (t) => {
  const f = await fixture(t, 'interrupted', 'rc5');
  const uncertain = { id: 'unconfirmed-child', status: 'running' };
  const child = { id: 'child', status: 'running' };
  const grandchild = { id: 'grandchild', status: 'idle' };
  const otherRoot = { id: 'other-root', status: 'idle' };
  const otherChild = { id: 'other-child', status: 'running' };
  for (const live of [f.agent, uncertain, child, grandchild, otherRoot, otherChild])
    f.mounted.set(live.id, live);
  f.hooks.rootOf = (live) => {
    if (live === uncertain) throw Error('No active runtime owner');
    if (live === child || live === grandchild) return f.agent;
    return live === otherChild ? otherRoot : live;
  };
  let treeWaits = 0;
  f.hooks.waitForTreeWork = async () => {
    treeWaits++;
    return false;
  };
  f.jobs.push(
    { id: 'owned-job', owner: grandchild.id, status: 'stopping' },
    { id: 'unconfirmed-job', owner: uncertain.id, status: 'running' },
    { id: 'other-job', owner: otherChild.id, status: 'running' },
  );
  for (let i = 0; i < 2; i++) {
    const { recovery } = await f.detail();
    assert.deepEqual(recovery.subtree, {
      state: 'active',
      children: [
        { sessionId: child.id, status: child.status },
        { sessionId: grandchild.id, status: grandchild.status },
      ],
    });
    assert.deepEqual(recovery.jobs, [
      { id: 'owned-job', sessionId: grandchild.id, status: 'stopping' },
    ]);
  }
  f.mounted.delete(child.id);
  f.mounted.delete(grandchild.id);
  const { recovery } = await f.detail();
  assert.deepEqual(recovery.subtree, { state: 'unknown', children: [] });
  assert.deepEqual(recovery.jobs, []);
  assert.equal(f.resolves(), 0);
  assert.equal(treeWaits, 0);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(await f.ledger(), f.beforeLedger);
});

test('explicit continuation checks authorization and all versions before resolving a session', async (t) => {
  const f = await fixture(t, 'interrupted'),
    args = await f.recoveryArgs();
  assert.equal(f.unauthenticated(), 401);
  const peer = f.nonOwner();
  try {
    assert.equal((await f.raw(CONTINUE, args, peer)).status, 403);
  } finally {
    await peer.dispose();
  }
  for (const [override, code] of [
    [{ acknowledged: false }, 'confirmation-required'],
    [{ expectedRowVersion: args.expectedRowVersion - 1 }, 'version-conflict'],
    [{ expectedBindingGeneration: 0 }, 'invalid-input'],
    [{ expectedBindingGeneration: args.expectedBindingGeneration + 1 }, 'binding-stale'],
    [{ bindingId: 'different-binding' }, 'binding-stale'],
    [{ attentionId: 'different-attention' }, 'recovery-stale'],
    [{ sessionId: f.otherManager.requestedSessionId }, 'not-found'],
    [{ sessionId: f.agent.id }, 'not-found'],
  ] as const) {
    const result = await f.call(CONTINUE, { ...args, ...override });
    assert.equal(result.error?.code, code, JSON.stringify(result));
  }
  assert.equal((await f.call('task.dispatch', args)).error.code, 'recovery-required');
  for (const action of [CONTINUE, 'dispatch']) {
    await assert.rejects(
      f.tools
        .get('super_bot_manage')
        .execute(
          { ...args, taskId: f.task.id, action },
          {
            agent: { id: f.manager.requestedSessionId },
            callId: action,
            signal: new AbortController().signal,
          },
        ),
      { code: action === CONTINUE ? 'unknown-action' : 'recovery-required' },
    );
  }
  assert.equal(f.resolves(), 0);
  assert.deepEqual(await f.ledger(), f.beforeLedger);
});

test('pending terminal Job result, stale task input and native user messages are preserved and block continuation', async (t) => {
  const f = await fixture(t, 'interrupted'),
    args = await f.recoveryArgs();
  const notice = {
    id: 'notice',
    source: { kind: 'tool-jobs', form: 'notice' },
    content: 'SYNTHETIC INLINE OUTPUT',
  };
  f.agent.inbox.nextStep.push(notice);
  assert.equal((await f.call(CONTINUE, args)).error.code, 'session-busy');
  assert.deepEqual(f.agent.inbox.nextStep, [notice]);
  f.agent.inbox.nextStep.pop(); // Synthetic native consumption, outside Super Bot.
  const human = { id: 'pending-human', source: { kind: 'user', rpcId: 'human-request' } };
  const uncertain = { id: 'other-task-input', source: { kind: 'super-bot', taskId: 'other-task' } };
  f.agent.inbox.nextTurn.push(human, uncertain);
  assert.equal((await f.call('run.recover', args)).error.code, 'session-busy');
  assert.equal((await f.call(CONTINUE, args)).error.code, 'session-busy');
  assert.deepEqual(f.agent.inbox.nextTurn, [human, uncertain]);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(await f.ledger(), f.beforeLedger);
});

test('native consumption of preserved results permits a fresh continuation after rechecking the task', async (t) => {
  const f = await fixture(t, 'interrupted'),
    initial = await f.recoveryArgs();
  const notice = {
    id: 'native-notice',
    source: { kind: 'tool-jobs', form: 'notice' },
    content: 'SYNTHETIC OUTPUT',
  };
  const priorInput = {
    id: 'old-message',
    source: {
      kind: 'super-bot',
      taskId: f.task.id,
      runId: f.run.id,
      inputId: f.run.inputId,
      taskRevision: f.run.taskRevision,
      generation: f.run.generation,
    },
  };
  f.agent.inbox.nextStep.push(notice);
  f.agent.inbox.nextTurn.push(priorInput);
  assert.equal((await f.call(CONTINUE, initial)).error.code, 'session-busy');
  assert.deepEqual(f.removed, ['old-message']);
  assert.deepEqual(f.agent.inbox.nextStep, [notice]);
  assert.equal(f.sent.length, 0);
  // The native conversation, not the recovery command, receives the retained result.
  f.agent.inbox.nextStep.shift();
  await f.emit({
    type: 'user/message',
    data: { id: 'read-native', source: { kind: 'user', rpcId: 'user-read' }, content: [] },
    seq: 2,
  });
  assert.equal((await f.call(CONTINUE, initial)).error.code, 'version-conflict');
  const refreshed = await f.recoveryArgs();
  const restarted = await f.call(CONTINUE, refreshed);
  assert.ok(restarted.ok, JSON.stringify(restarted));
  assert.deepEqual(f.removed, ['old-message']);
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch(JSON.stringify(f.sent[0]), /native-notice|SYNTHETIC OUTPUT|old-message/);
  assert.equal((await f.detail()).task.status, 'queued');
});

test('busy, unavailable, unobservable and mismatched native state cannot release the old Run', async (t) => {
  const f = await fixture(t, 'interrupted'),
    args = await f.recoveryArgs(),
    before = await f.detail();
  const reject = async (code: string) => {
    const result = await f.call(CONTINUE, args);
    assert.equal(result.error?.code, code, JSON.stringify(result));
  };
  f.hooks.resolveError = 'unavailable';
  await reject('session-unavailable');
  delete f.hooks.resolveError;
  f.agent.status = 'running';
  await reject('session-busy');
  f.agent.status = 'idle';
  f.options.failJobs = true;
  await reject('job-unknown');
  f.options.failJobs = false;
  for (const status of ['running', 'stopping']) {
    f.jobs.push({ id: 'old-job', owner: f.agent.id, status });
    await reject('job-active');
    f.jobs.pop();
  }
  f.mounted.set('parked-child', { id: 'parked-child', status: 'idle' });
  f.owners.set('parked-child', f.agent.id);
  await reject('child-active');
  f.mounted.delete('parked-child');
  let finishTree!: (worked: boolean) => void;
  const pending = new Promise<boolean>((resolve) => {
    finishTree = resolve;
  });
  let checks = 0;
  f.hooks.waitForTreeWork = () => {
    checks++;
    return pending;
  };
  assert.equal((await f.detail()).recovery.subtree.state, 'unknown');
  assert.equal(checks, 0, 'polling does not start the native tree check');
  await reject('child-unknown');
  await reject('child-unknown');
  assert.equal(checks, 1);
  finishTree(true);
  f.hooks.waitForTreeWork = async () => true;
  await reject('child-unknown');
  f.hooks.waitForTreeWork = async () => {
    throw Error('Synthetic native failure');
  };
  await reject('child-unknown');
  f.hooks.waitForTreeWork = async () => false;
  f.options.directory = join(f.binding.cwd, '..');
  await reject('working-directory-changed');
  f.options.directory = f.binding.cwd;
  f.options.selected = false;
  await reject('model-required');
  assert.equal((await f.detail()).task.rowVersion, before.task.rowVersion);
  assert.equal(f.permissionChanges(), 0);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(await f.ledger(), f.beforeLedger);
});

test('only-check stays paused and uses one receipt despite concurrent requests', async (t) => {
  const f = await fixture(t, 'interrupted'),
    args = await f.recoveryArgs();
  const [first, same] = await Promise.all([
    f.call('run.recover', args),
    f.call('run.recover', args),
  ]);
  assert.equal(first.value.status, 'paused');
  assert.deepEqual(same, first);
  assert.deepEqual(await f.call('run.recover', args), first);
  assert.equal(
    (await f.call('run.recover', { ...args, expectedRowVersion: first.value.rowVersion })).error
      .code,
    'idempotency-conflict',
  );
  assert.equal(
    (
      await f.call('run.recover', {
        ...args,
        requestId: 'new',
        expectedRowVersion: first.value.rowVersion,
      })
    ).error.code,
    'recovery-stale',
  );
  assert.equal(
    (
      await f.call(CONTINUE, {
        ...args,
        requestId: 'competing',
        expectedRowVersion: first.value.rowVersion,
      })
    ).error.code,
    'recovery-stale',
  );
  const after = await f.detail();
  assert.equal(after.run.id, f.run.id);
  assert.equal(after.run.state, 'interrupted');
  assert.equal(after.runHeld, false);
  assert.equal(after.input.state, 'discarded');
  assert.equal(
    after.events.filter((e: { kind: string }) => e.kind === 'run.recovery-confirmed').length,
    1,
  );
  assert.equal(f.sent.length, 0);
});

test('continue schedules and delivers one new Run despite duplicate and competing requests', async (t) => {
  const f = await fixture(t, 'interrupted'),
    args = await f.recoveryArgs();
  f.hooks.waitForTreeWork = async () => false;
  const request = { ...args, sessionId: f.manager.requestedSessionId };
  const [first, same, other, only] = await Promise.all([
    f.call(CONTINUE, request),
    f.call(CONTINUE, request),
    f.call(CONTINUE, { ...request, requestId: 'other' }),
    f.call('run.recover', { ...args, requestId: 'only-check' }),
  ]);
  assert.ok(first.ok, JSON.stringify(first));
  assert.deepEqual(same, first);
  assert.equal(other.error.code, 'version-conflict');
  assert.equal(only.error.code, 'version-conflict');
  const newRun = first.value;
  assert.equal(newRun.taskId, f.task.id);
  assert.equal(newRun.bindingId, f.binding.id);
  assert.equal(newRun.sessionId, f.binding.sessionId);
  assert.notEqual(newRun.id, f.run.id);
  assert.notEqual(newRun.inputId, f.run.inputId);
  assert.equal(f.sent.length, 1);
  assert.notEqual(f.sent[0]!.id, 'old-message');
  assert.deepEqual(f.sent[0]!.source, {
    kind: 'super-bot',
    taskId: f.task.id,
    runId: newRun.id,
    inputId: newRun.inputId,
    taskRevision: f.task.taskRevision,
    generation: f.binding.generation,
    bindingId: f.binding.id,
    promptMode: 'full',
  });
  assert.deepEqual(await f.call(CONTINUE, request), first);
  assert.equal(
    (await f.call(CONTINUE, { ...request, expectedBindingGeneration: 42 })).error.code,
    'idempotency-conflict',
  );
  const after = await f.detail();
  assert.equal(after.task.status, 'queued');
  assert.equal(after.task.reviewPolicy, 'human');
  assert.equal(after.run.id, newRun.id);
  assert.equal(after.input.state, 'enqueued');
  assert.equal(after.recovery, null);
  assert.equal(after.result, null);
  assert.equal(after.events.filter((e: { kind: string }) => e.kind === 'run.queued').length, 2);
  assert.equal(
    after.events.filter((e: { kind: string }) => e.kind === 'run.recovery-confirmed').length,
    1,
  );
  await f.emit({ type: 'user/message', seq: 1, data: f.sent[0] });
  assert.equal((await f.detail()).task.status, 'running');
  assert.equal((await f.call(CONTINUE, request)).value.state, 'running');
  assert.equal(f.sent.length, 1);
});

test('version is checked again after asynchronous native resolution and after native human takeover', async (t) => {
  const f = await fixture(t, 'interrupted'),
    args = await f.recoveryArgs();
  let unblock!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.hooks.beforeResolve = () =>
    new Promise<void>((resolve) => {
      unblock = resolve;
      entered();
    });
  const command = f.call(CONTINUE, args);
  await started;
  assert.equal(f.resolves(), 1);
  try {
    await f.emit({
      type: 'user/message',
      seq: 30,
      data: { id: 'intervention', source: { kind: 'user', rpcId: 'native' }, content: [] },
    });
  } finally {
    unblock();
  }
  assert.equal((await command).error.code, 'version-conflict');
  const current = await f.detail();
  assert.equal(current.task.controlMode, 'manual');
  assert.equal(current.run.id, f.run.id);
  assert.equal(current.runHeld, true);
  assert.equal(f.sent.length, 0);
});

test('capacity refusal rolls back recovery and uncertain post-reservation delivery remains on the same receipt', async (t) => {
  const full = await fixture(t, 'capacity'),
    args = await full.recoveryArgs();
  assert.equal((await full.call(CONTINUE, args)).error.code, 'capacity');
  assert.equal(full.permissionChanges(), 0);
  assert.deepEqual(await full.ledger(), full.beforeLedger);

  const f = await fixture(t, 'interrupted'),
    requested = await f.recoveryArgs();
  f.options.failDelivery = true;
  const uncertain = await f.call(CONTINUE, requested);
  assert.ok(uncertain.ok, JSON.stringify(uncertain));
  assert.equal(uncertain.value.state, 'interrupted');
  assert.notEqual(uncertain.value.id, f.run.id);
  assert.deepEqual(await f.call(CONTINUE, requested), uncertain);
  assert.equal(f.sent.length, 1);
  const after = await f.detail();
  assert.equal(after.task.status, 'recovery');
  assert.equal(after.runHeld, true);
  assert.equal(after.input.state, 'unknown');
  assert.equal(after.recovery.attentionId, `run:${uncertain.value.id}`);
});

test('Bot capacity settings RPC governs the next Worker dispatch', async (t) => {
  const f = await fixture(t, 'bot-capacity');
  const original = (await f.call('bot.list')).value.find(
    (bot: { id: string }) => bot.id === f.bot.id,
  );
  const recovery = await f.recoveryArgs();
  const checked = await f.call('run.recover', recovery);
  assert.ok(checked.ok);
  assert.equal(checked.value.controlMode, 'paused');
  const resumed = await f.call('task.control', {
    requestId: 'turn-auto-on',
    expectedRowVersion: checked.value.rowVersion,
    mode: 'auto',
  });
  assert.ok(resumed.ok);

  const current = await f.call('bot.capacity.get', { botId: f.bot.id });
  assert.ok(current.ok);
  assert.deepEqual(current.value, { maxRunningTasks: null, botLimit: 5, botHeld: 1 });
  const rejected = await f.call('bot.capacity.set', {
    requestId: 'mirror-limit',
    owner: 'desktop',
    botId: f.bot.id,
    expectedMaxRunningTasks: null,
    maxRunningTasks: 3,
  });
  assert.equal(rejected.error.code, 'invalid-input');
  assert.deepEqual((await f.call('bot.capacity.get', { botId: f.bot.id })).value, current.value);
  const lower = await f.call('bot.capacity.set', {
    requestId: 'lower-limit',
    botId: f.bot.id,
    expectedMaxRunningTasks: null,
    maxRunningTasks: 1,
  });
  assert.ok(lower.ok);
  assert.equal(lower.value.botLimit, 1);
  const payload = { expectedRowVersion: resumed.value.rowVersion };
  const full = await f.call('task.dispatch', { requestId: 'before-raise', ...payload });
  assert.equal(full.error.code, 'capacity');
  assert.equal((await f.detail()).runHeld, false);
  assert.equal(f.sent.length, 0);

  const raise = await f.call('bot.capacity.set', {
    requestId: 'raise-limit',
    botId: f.bot.id,
    expectedMaxRunningTasks: 1,
    maxRunningTasks: 2,
  });
  assert.ok(raise.ok);
  assert.equal(raise.value.botLimit, 2);
  const dispatch = await f.call('task.dispatch', { requestId: 'after-raise', ...payload });
  assert.ok(dispatch.ok);
  assert.equal(dispatch.value.sessionId, f.binding.sessionId);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.call('bot.capacity.get', { botId: f.bot.id })).value.botHeld, 2);
  assert.deepEqual((await f.call('bot.capacity.get', { botId: f.other.id })).value, {
    maxRunningTasks: null,
    botLimit: 5,
    botHeld: 0,
  });
  const updated = (await f.call('bot.list')).value.find(
    (bot: { id: string }) => bot.id === f.bot.id,
  );
  assert.equal(updated.managerSessionId, original.managerSessionId);
  assert.equal(updated.configRevision, original.configRevision);
});

test('legacy host maxRunningTasks is ignored during real Worker continuation', async (t) => {
  const f = await fixture(t, 'legacy-capacity');
  const capacity = () => f.call('bot.capacity.get', { botId: f.bot.id });
  assert.deepEqual((await capacity()).value, { maxRunningTasks: null, botLimit: 5, botHeld: 2 });
  const resumed = await f.call(CONTINUE, await f.recoveryArgs());
  assert.ok(resumed.ok, JSON.stringify(resumed));
  assert.notEqual(resumed.value.id, f.run.id);
  assert.equal(resumed.value.sessionId, f.binding.sessionId);
  assert.equal(f.sent.length, 1);
  assert.deepEqual((await capacity()).value, { maxRunningTasks: null, botLimit: 5, botHeld: 2 });
});
