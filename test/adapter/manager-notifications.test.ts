/** Durable readiness, safe preflight retry, and no-replay recovery of Manager notifications. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { Store } from '../../src/store.ts';
import { Managers } from '../../src/manager.ts';
import type { DshExecution } from '../../src/dsh.ts';
import type { ChatSource } from '../../src/model.ts';

function fixture(t: TestContext, options = { managerWakesPerHour: 20 }) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });
  const dir = mkdtempSync(join(tmpdir(), 'sb-notify-')),
    path = join(dir, 'ledger.sqlite');
  let store = new Store(path);
  const bot = store.createBot('bot', { name: 'Durable notice', instructions: 'Synthetic only' });
  let selected = true,
    unavailable = false,
    unreadable = false,
    oversized = false,
    reads = 0,
    resolves = 0,
    cancels = 0,
    finish = () => {};
  let idle = Promise.resolve();
  const messages: any[] = [],
    events: any[] = [],
    durable: any[] = [],
    hooks = new Map<string, Function>();
  let workerReady = true,
    workerBlocked = false,
    workerUnavailable = false;
  const workerAttempts: string[] = [];
  let unsentSourceCheck: (source: ChatSource, botId: string) => boolean;
  let unsentRefreshCalls = 0;
  const agent: any = {
    id: 'unprepared',
    session: { id: 'unprepared' },
    status: 'idle',
    model: {
      current: () => (selected ? { provider: 'fake', model: 'fake' } : undefined),
      select: () => {},
    },
    inbox: {
      nextTurn: [],
      nextStep: [],
      remove: (id: string) => {
        agent.inbox.nextTurn = agent.inbox.nextTurn.filter((m: any) => m.id !== id);
      },
    },
    followup: (message: any) => {
      messages.push(message);
      agent.status = 'running';
      idle = new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    whenIdle: () => idle,
    cancel: () => {
      cancels++;
      agent.status = 'idle';
      finish();
    },
    ctx: {
      tools: { restrict: () => () => {}, guard: () => () => {} },
      on: () => () => {},
      systemPrompt: { section: () => () => {} },
    },
  };
  const ctx = {
    permissionPresets: { set: () => {} },
    effect: (fn: Function) => fn(),
    on: (name: string, fn: Function) => {
      hooks.set(name, fn);
      return () => {};
    },
    agents: { list: () => [agent] },
    tools: { register: () => () => {} },
    sessionController: {
      resolveAgent: async () => {
        resolves++;
        if (unavailable) throw Error('Synthetic pre-enqueue unavailable');
        return { agent };
      },
    },
    sessionProjections: {
      snapshot: () => ({
        values: { modelSelection: selected ? { next: { provider: 'fake', model: 'fake' } } : {} },
      }),
    },
    sessions: {
      flush: async () => {
        durable.splice(0, durable.length, ...structuredClone(events));
        return true;
      },
    },
    sessionPersistence: {
      stat: async () => ({ eventCount: oversized ? 100001 : durable.length, sizeBytes: 100 }),
      open: async (id: string, mode: string) => {
        reads++;
        assert.equal(mode, 'read');
        if (unreadable) throw Error('Synthetic read failure');
        return {
          header: { id },
          read: async () => ({ events: structuredClone(durable) }),
          close: async () => {},
        };
      },
    },
  } as unknown as Context;
  const execution = {
    dispatch: () => {
      throw Error('No Worker execution during notification recovery');
    },
    registerUnsentDispatchSourceCheck: (check: typeof unsentSourceCheck) => {
      unsentSourceCheck = check;
    },
    resumeUnsentDispatches: () => {
      unsentRefreshCalls++;
    },
    canWakeRecoveryContinuation: () => workerReady,
    continueRecovery: async (
      taskId: string,
      rowVersion: number,
      managerId: string,
      authorize: () => void,
    ) => {
      authorize();
      workerAttempts.push(taskId);
      if (workerUnavailable)
        return {
          status: 'waiting',
          code: 'session-unavailable',
          message: 'Synthetic temporary Worker failure',
        };
      if (workerBlocked) return { status: 'blocked', message: 'Synthetic exact blocker' };
      if (store.dispatchBlocker(taskId)) {
        store.recordCapacityWait(`fixture-wait:${taskId}`, taskId, rowVersion);
        return { status: 'waiting', code: 'capacity' };
      }
      const instruction = store.recoveryInstruction(taskId)!;
      const run = store.reserveRecoveryContinuation(
        taskId,
        rowVersion,
        managerId,
        {
          context: {
            priorRunId: instruction.priorRunId,
            mode: 'read-only',
            effectUncertain: false,
            probes: [],
          },
          authorizedProbes: [],
        },
        { provider: 'fake', model: 'fake', reasoningEffort: null, source: 'native-selection' },
      );
      return { status: 'started', run };
    },
  } as unknown as DshExecution;
  let managers = new Managers(ctx, store, execution, dir, () => '', options);
  managers.install();
  const enqueue = (key = 'notice') => {
    store.enqueueManager(bot.id, key, 'Synthetic notice', null);
    return `manager-event:${key}`;
  };
  const ready = () => {
    const b = store.beginManager('manager', bot.id, dir);
    store.confirmManager(b.id, b.requestedSessionId);
    agent.id = b.requestedSessionId;
    agent.session = { id: agent.id };
    return b;
  };
  const pendingDirection = () => {
    const task = store.createTask('create-worker-task', {
      botId: bot.id,
      goal: 'Synthetic original task',
      scope: 'Synthetic directory only',
      acceptance: 'A follow-up is delivered',
      reviewPolicy: 'human',
    });
    const binding = store.beginBinding('bind-worker', task.id, task.rowVersion, dir);
    store.confirmBinding(binding.id, binding.requestedSessionId);
    const run = store.reserveRun('old-run', task.id, store.getTask(task.id).rowVersion);
    store.saveRunMessage(run.id, 'old-input', '{}');
    assert.equal(store.claimDispatch(run.id), true);
    store.inputEnqueued(run.id);
    store.inputEntered(run.id, 'old-input', 1);
    store.settleManagerEvent(`manager-event:created:${task.id}`);
    const { instruction } = store.saveRecoveryInstruction(
      task.id,
      store.getTask(task.id).rowVersion,
      { sessionId: agent.id, messageId: 'follow-up-owner', seq: 7, text: '只读检查精简名单。' },
      'read-only',
    );
    const finishRun = () => {
      store.workerReport(run.id, 'old-report', { kind: 'waiting', summary: 'Old Worker output' });
      store.settleRun(run.id);
    };
    return { task, run, instruction, finishRun };
  };
  const pulse = async (ms = 1000) => {
    t.mock.timers.tick(ms);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const row = (id = 'manager-event:notice') =>
    store.db.prepare('SELECT * FROM outbox WHERE id=?').get(id)!;
  const event = async (type: string, data: any, surfaceOp?: string) => {
    const value = {
      seq: events.length,
      type,
      data,
      time: Date.now(),
      ...(surfaceOp ? { surfaceOp } : {}),
    };
    events.push(value);
    await hooks.get('session/event')?.(agent.session, value);
  };
  const end = async (withReply = true, retire = true) => {
    await event('turn/start', { turn: 1 });
    await event('user/message', messages.at(-1), 'append');
    if (withReply)
      await event(
        'assistant/message',
        {
          turn: 1,
          message: {
            id: 'reply',
            source: { kind: 'model' },
            content: [{ type: 'text', text: 'Synthetic notification handled' }],
          },
          stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }],
        },
        'append',
      );
    await event('turn/end', { turn: 1, reason: { kind: 'completed' } });
    if (retire) {
      agent.status = 'idle';
      finish();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const reload = async () => {
    agent.status = 'idle';
    finish();
    await managers.dispose();
    store.close();
    store = new Store(path);
    managers = new Managers(ctx, store, execution, dir, () => '', options);
    managers.install();
  };
  return {
    get store() {
      return store;
    },
    bot,
    agent,
    messages,
    events,
    durable,
    enqueue,
    ready,
    pendingDirection,
    workerAttempts,
    setWorkerReady: (value: boolean) => {
      workerReady = value;
    },
    setWorkerBlocked: (value: boolean) => {
      workerBlocked = value;
    },
    setWorkerUnavailable: (value: boolean) => {
      workerUnavailable = value;
    },
    workerReturned: (sessionId: string) =>
      hooks.get('agent/created')?.({
        agent: { ...agent, id: sessionId, session: { id: sessionId } },
      }),
    authorizeUnsent: (source: ChatSource) => unsentSourceCheck(source, bot.id),
    registerBindingCheck: (check: (botId: string, bindingId: string) => boolean) =>
      managers.registerFeishuBindingCheck(check),
    unsentRefreshCalls: () => unsentRefreshCalls,
    pulse,
    row,
    end,
    event,
    reload,
    counts: () => ({ reads, resolves, cancels }),
    setOversized: (v: boolean) => {
      oversized = v;
    },
    setUnreadable: (v: boolean) => {
      unreadable = v;
    },
    setSelected: (v: boolean) => {
      selected = v;
    },
    setUnavailable: (v: boolean) => {
      unavailable = v;
    },
    crashClaim: (id: string) => {
      const b = store.activeManager(bot.id)!;
      const message = {
        id: `stable-lost-message:${id}`,
        source: { kind: 'super-bot-manager', managerId: b.id, botId: bot.id, eventId: id },
        content: [{ type: 'text', text: 'Synthetic notice' }],
      };
      assert.equal(store.claimManagerEvent(id, message.id, JSON.stringify(message)), true);
      return message;
    },
    reconcile: () => (managers as any).pump(),
    resolve: (id: string) =>
      managers.resolveNotification('manual-resolve', bot.id, id, 'handled', true),
    close: async () => {
      agent.status = 'idle';
      finish();
      await managers.dispose();
      store.close();
      rmSync(dir, { recursive: true, force: true });
      t.mock.timers.reset();
    },
  };
}

test('saved direction dispatches after the old Worker settles without a Manager model turn', async (t) => {
  const f = fixture(t);
  try {
    f.ready();
    const { task, run, instruction, finishRun } = f.pendingDirection();
    await f.pulse();
    assert.deepEqual(f.workerAttempts, []);
    assert.deepEqual(f.messages, []);
    finishRun();
    f.setSelected(false);
    await f.pulse();
    const next = f.store.latestRun(task.id)!;
    assert.notEqual(next.id, run.id);
    assert.equal(next.sessionId, run.sessionId);
    assert.equal(f.store.getRunInput(next.id).content, instruction.source.text);
    assert.equal(f.store.recoveryInstruction(task.id)?.runId, next.id);
    await f.reload();
    await f.pulse();
    assert.equal(f.store.latestRun(task.id)?.id, next.id);
    assert.deepEqual(f.workerAttempts, [task.id]);
    assert.deepEqual(f.messages, []);
  } finally {
    await f.close();
  }
});

test('restart resumes the saved direction even if the old notification was already settled', async (t) => {
  const f = fixture(t);
  try {
    f.ready();
    const { task, instruction, finishRun } = f.pendingDirection();
    finishRun();
    const notice = `manager-event:continuation:${instruction.id}`;
    f.store.settleManagerEvent(notice);
    f.store.settleManagerEvent(`${notice}:settled`);
    assert.equal(f.store.managerEvent(notice)?.state, 'done');
    await f.reload();
    await f.pulse();
    assert.deepEqual(f.workerAttempts, [task.id]);
    assert.deepEqual(f.messages, []);
    const next = f.store.latestRun(task.id)!;
    assert.equal(f.store.getRunInput(next.id).content, instruction.source.text);
    assert.equal(f.store.recoveryInstruction(task.id)?.runId, next.id);
  } finally {
    await f.close();
  }
});

test('a blocker retains the direction and retries only after conditions change', async (t) => {
  const f = fixture(t);
  try {
    f.ready();
    f.setSelected(false);
    const { task, instruction, finishRun } = f.pendingDirection();
    finishRun();
    f.setWorkerBlocked(true);
    await f.pulse();
    await f.pulse();
    const notice = `manager-event:continuation:${instruction.id}`;
    assert.equal(f.store.managerEvent(notice)?.state, 'pending');
    assert.equal(f.store.recoveryInstruction(task.id)?.runId, undefined);
    assert.deepEqual(f.workerAttempts, [task.id]);
    f.setWorkerReady(false);
    await f.pulse();
    f.setWorkerBlocked(false);
    f.setWorkerReady(true);
    await f.pulse();
    assert.deepEqual(f.workerAttempts, [task.id, task.id]);
    assert.ok(f.store.recoveryInstruction(task.id)?.runId);
    assert.deepEqual(f.messages, []);
  } finally {
    await f.close();
  }
});

test('explicit pause and then revocation prevent the stored direction from auto-dispatching', async (t) => {
  const f = fixture(t);
  try {
    const manager = f.ready();
    const { task, run, instruction, finishRun } = f.pendingDirection();
    finishRun();
    const paused = f.store.controlTask(
      'pause',
      task.id,
      f.store.getTask(task.id).rowVersion,
      'paused',
    );
    await f.pulse();
    assert.deepEqual(f.workerAttempts, []);
    const revoked = f.store.saveRecoveryInstruction(
      task.id,
      paused.rowVersion,
      {
        sessionId: manager.requestedSessionId,
        messageId: 'cancel-direction',
        seq: 8,
        text: '撤回补充。',
      },
      undefined,
      false,
      false,
      { kind: 'revoke', ids: [instruction.id] },
    );
    f.store.controlTask('resume', task.id, revoked.task.rowVersion, 'auto');
    await f.pulse();
    assert.deepEqual(f.workerAttempts, []);
    assert.equal(f.store.latestRun(task.id)?.id, run.id);
  } finally {
    await f.close();
  }
});

test('a continuation waits in FIFO and retries once when a Worker slot opens', async (t) => {
  const f = fixture(t);
  try {
    f.ready();
    f.setSelected(false);
    const { task, finishRun } = f.pendingDirection();
    finishRun();
    f.store.setBotCapacity('one-worker-slot', f.bot.id, null, 1);
    const other = f.store.createTask('other-task', {
      botId: f.bot.id,
      goal: 'Occupy the only Worker slot',
      scope: 'Synthetic only',
      acceptance: 'Worker starts',
      reviewPolicy: 'human',
    });
    const binding = f.store.beginBinding('other-binding', other.id, other.rowVersion, '/tmp');
    f.store.confirmBinding(binding.id, binding.requestedSessionId);
    const old = f.store.reserveRun('occupy-slot', other.id, f.store.getTask(other.id).rowVersion);
    f.store.settleManagerEvent(`manager-event:created:${other.id}`);
    await f.pulse();
    await f.pulse();
    assert.deepEqual(f.workerAttempts, [task.id]);
    assert.equal(f.store.dispatchWait(task.id)?.code, 'capacity');
    f.store.requestStop('free-slot', other.id, f.store.getTask(other.id).rowVersion, old.id);
    f.store.settleCancelled(old.id);
    await f.pulse();
    assert.deepEqual(f.workerAttempts, [task.id, task.id]);
    assert.ok(f.store.recoveryInstruction(task.id)?.runId);
    assert.deepEqual(f.messages, []);
  } finally {
    await f.close();
  }
});

test('a previously unavailable Worker becoming available re-arms its exact saved direction', async (t) => {
  const f = fixture(t);
  try {
    f.ready();
    f.setSelected(false);
    const { task, run, finishRun } = f.pendingDirection();
    finishRun();
    f.setWorkerBlocked(true);
    await f.pulse();
    await f.pulse();
    assert.deepEqual(f.workerAttempts, [task.id]);
    f.workerReturned('unrelated-session');
    await f.pulse();
    assert.deepEqual(f.workerAttempts, [task.id]);
    f.setWorkerBlocked(false);
    f.workerReturned(run.sessionId);
    await f.pulse();
    assert.deepEqual(f.workerAttempts, [task.id, task.id]);
    assert.ok(f.store.recoveryInstruction(task.id)?.runId);
  } finally {
    await f.close();
  }
});

test('temporary Worker failure retries the stored direction after an interval without a native event or model turn', async (t) => {
  const f = fixture(t);
  try {
    f.ready();
    const { task, run, instruction, finishRun } = f.pendingDirection();
    finishRun();
    f.setWorkerUnavailable(true);
    await f.pulse();
    assert.deepEqual(f.workerAttempts, [task.id]);
    assert.equal(f.store.latestRun(task.id)?.id, run.id);
    f.setWorkerUnavailable(false);
    await f.pulse(29999);
    assert.deepEqual(f.workerAttempts, [task.id]);
    await f.pulse(1);
    assert.deepEqual(f.workerAttempts, [task.id, task.id]);
    const next = f.store.latestRun(task.id)!;
    assert.equal(f.store.getRunInput(next.id).content, instruction.source.text);
    assert.equal(f.store.recoveryInstruction(task.id)?.runId, next.id);
    await f.pulse(60000);
    assert.equal(f.store.taskRuns(task.id).length, 2);
    assert.deepEqual(f.messages, []);
  } finally {
    await f.close();
  }
});

test('restart leaves a direction from a revoked Feishu binding unexecuted', async (t) => {
  const f = fixture(t);
  try {
    f.ready();
    const { task, run, instruction, finishRun } = f.pendingDirection();
    f.store.db
      .prepare(`INSERT INTO feishu_inbound_receipts
        (messageId,nativeMessageId,bindingId,botId,sessionId,senderOpenId,appId,textDigest,acceptedAt,nativeSeq)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(
        'fixture-feishu-event',
        instruction.source.messageId,
        'unbound-group',
        task.botId,
        instruction.source.sessionId,
        'former-owner',
        'fixture-app',
        createHash('sha256').update(instruction.source.text, 'utf16le').digest('hex'),
        Date.now(),
        instruction.source.seq,
      );
    f.store.db
      .prepare(`INSERT INTO feishu_group_bindings
        (id,botId,appId,ownerOpenId,chatId,name,boundAt) VALUES (?,?,?,?,?,?,?)`)
      .run('unbound-group', task.botId, 'fixture-app', 'former-owner', 'fixture-chat', 'Test', 0);
    finishRun();
    await f.reload();
    assert.equal(f.authorizeUnsent(instruction.source), false, 'the account has not loaded yet');
    const release = f.registerBindingCheck((_botId, bindingId) => bindingId === 'unbound-group');
    assert.equal(
      f.unsentRefreshCalls(),
      1,
      'loading the binding rechecks definitely unsent inputs',
    );
    assert.equal(f.authorizeUnsent(instruction.source), true);
    f.store.db.prepare('DELETE FROM feishu_group_bindings WHERE botId=?').run(task.botId);
    assert.equal(f.authorizeUnsent(instruction.source), false, 'a withdrawn binding revokes it');
    await f.pulse();
    assert.deepEqual(f.workerAttempts, []);
    assert.deepEqual(f.messages, []);
    assert.equal(f.store.latestRun(task.id)?.id, run.id);
    release();
  } finally {
    await f.close();
  }
});

test('not enabled / creating / missing model retains the original notification across restart, then wakes once when ready', async (t) => {
  const f = fixture(t);
  try {
    const id = f.enqueue();
    await f.pulse();
    assert.equal(f.row(id).state, 'pending');
    assert.equal(f.messages.length, 0);
    const b = f.store.beginManager('manager', f.bot.id, '/tmp/unready');
    await f.reload();
    await f.pulse();
    assert.equal(f.messages.length, 0);
    f.store.confirmManager(b.id, b.requestedSessionId);
    f.agent.id = b.requestedSessionId;
    f.agent.session = { id: b.requestedSessionId };
    f.setSelected(false);
    await f.pulse();
    assert.equal(f.row(id).attempts, 0);
    assert.equal(f.row(id).state, 'pending');
    await f.reload();
    f.setSelected(true);
    await f.pulse(30000);
    assert.equal(f.messages.length, 1);
    assert.equal(f.row(id).attempts, 1);
    await f.end();
    assert.equal(f.row(id).state, 'done');
    await f.reload();
    await f.pulse(3600000);
    assert.equal(f.messages.length, 1);
  } finally {
    await f.close();
  }
});

test('pre-enqueue errors back off durably five times, stop, and only explicit retry-unsent re-arms them', async (t) => {
  const f = fixture(t);
  try {
    f.ready();
    const id = f.enqueue();
    f.setUnavailable(true);
    for (const delay of [1000, 30000, 60000, 120000, 240000]) {
      await f.pulse(delay);
      await f.reload();
    }
    assert.equal(f.row(id).state, 'blocked');
    assert.equal(f.row(id).attempts, 0);
    assert.equal(f.messages.length, 0);
    const before = f.counts().resolves;
    await f.pulse(3600000);
    assert.equal(f.counts().resolves, before);
    assert.throws(() =>
      f.store.resolveManagerNotification('not-confirmed', f.bot.id, id, 'retry-unsent', false),
    );
    f.store.resolveManagerNotification('retry', f.bot.id, id, 'retry-unsent', true);
    f.setUnavailable(false);
    await f.pulse();
    assert.equal(f.messages.length, 1);
    await f.end();
    assert.equal(f.row(id).state, 'done');
  } finally {
    await f.close();
  }
});

test('hourly cap leaves pending with an exact reset deadline and wakes once when the window expires', async (t) => {
  const f = fixture(t, { managerWakesPerHour: 1 });
  try {
    f.ready();
    f.enqueue('first');
    await f.pulse();
    await f.end();
    const id = f.enqueue('second');
    await f.pulse();
    assert.equal(f.row(id).state, 'pending');
    assert.equal(f.row(id).attempts, 0);
    assert.equal(f.messages.length, 1);
    await f.reload();
    await f.pulse(3598000);
    assert.equal(f.messages.length, 1);
    await f.pulse(3000);
    assert.equal(f.messages.length, 2);
    await f.end();
    await f.pulse();
    assert.equal(f.messages.length, 2);
  } finally {
    await f.close();
  }
});

for (const proof of [
  'complete',
  'missing',
  'wrong-id',
  'duplicate',
  'gap',
  'no-final',
  'cross-turn',
  'wrong-source',
] as const)
  test(`unknown ${proof} is reconciled without loading an Agent or replaying input`, async (t) => {
    const f = fixture(t);
    try {
      f.ready();
      const id = f.enqueue(),
        message = f.crashClaim(id);
      const input = structuredClone(message);
      if (proof === 'wrong-id') input.id = 'different';
      if (proof === 'wrong-source') input.source.managerId = 'other-manager';
      f.durable.push(
        { seq: 0, type: 'turn/start', data: { turn: 1 } },
        { seq: 1, type: 'user/message', surfaceOp: 'append', data: input },
      );
      if (proof === 'cross-turn')
        f.durable.push({ seq: f.durable.length, type: 'turn/start', data: { turn: 2 } });
      if (proof === 'duplicate')
        f.durable.push({
          seq: f.durable.length,
          type: 'user/message',
          surfaceOp: 'append',
          data: input,
        });
      if (proof !== 'no-final')
        f.durable.push({
          seq: f.durable.length,
          type: 'assistant/message',
          surfaceOp: 'append',
          data: {
            turn: 1,
            message: {
              id: 'reply',
              source: { kind: 'model' },
              content: [{ type: 'text', text: 'Handled' }],
            },
            stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }],
          },
        });
      if (proof !== 'missing')
        f.durable.push({
          seq: f.durable.length,
          type: 'turn/end',
          data: { turn: 1, reason: { kind: 'completed' } },
        });
      if (proof === 'gap') f.durable[1].seq = 9;
      if (proof === 'complete') f.store.managerProblem(f.bot.id, 'Synthetic uncertain receipt', id);
      await f.reload();
      await f.pulse();
      assert.equal(f.row(id).state, proof === 'complete' ? 'done' : 'unknown');
      if (proof === 'complete') assert.equal(f.store.managerInfo(f.bot.id).problem, null);
      await f.reload();
      await f.pulse(30000);
      await f.reload();
      await f.pulse(60000);
      await f.pulse(3600000);
      assert.equal(f.messages.length, 0);
      assert.equal(f.row(id).attempts, 1);
      assert.equal(f.counts().resolves, 0);
      assert.ok(f.counts().reads <= 3);
      assert.throws(() =>
        f.store.resolveManagerNotification('unsafe-retry', f.bot.id, id, 'retry-unsent', true),
      );
      if (proof !== 'complete') {
        assert.equal(JSON.parse(String(f.row(id).payload)).reconcileAttempts, 3);
        f.store.resolveManagerNotification('handled', f.bot.id, id, 'handled', true);
        assert.equal(f.row(id).state, 'handled');
      }
    } finally {
      await f.close();
    }
  });

test('disabled Manager and paused tasks do not wake or consume pending notices', async (t) => {
  const f = fixture(t);
  try {
    const b = f.ready(),
      id = f.enqueue();
    f.store.releaseManager('disable', f.bot.id, b.generation);
    await f.pulse(3600000);
    assert.equal(f.messages.length, 0);
    assert.equal(f.row(id).state, 'pending');
    assert.equal(f.counts().resolves, 0);
  } finally {
    await f.close();
  }
});

test('paused task remains pending until explicit resume, without claim or model calls', async (t) => {
  const f = fixture(t);
  try {
    f.ready();
    const task = f.store.createTask('task', {
      botId: f.bot.id,
      goal: 'Synthetic',
      scope: 'Own files',
      acceptance: 'Read',
      reviewPolicy: 'human',
    });
    f.store.controlTask('pause', task.id, task.rowVersion, 'paused');
    await f.pulse();
    assert.equal(f.messages.length, 0);
    assert.equal(f.row(`manager-event:created:${task.id}`).attempts, 0);
    f.store.controlTask('resume', task.id, f.store.getTask(task.id).rowVersion, 'auto');
    await f.pulse(30000);
    assert.equal(f.messages.length, 1);
  } finally {
    await f.close();
  }
});

test('the old notification deadline cannot cancel a human follow-up on the same native driver', async (t) => {
  const f = fixture(t);
  try {
    f.ready();
    f.enqueue();
    await f.pulse();
    await f.end(true, false);
    await f.event('turn/start', { turn: 2 });
    await f.event(
      'user/message',
      {
        id: 'human',
        source: { kind: 'user', rpcId: 'native' },
        content: [{ type: 'text', text: 'Human follow-up' }],
      },
      'append',
    );
    await f.pulse(301000);
    assert.equal(f.counts().cancels, 0);
    assert.equal(f.messages.length, 1);
    assert.equal(f.row().state, 'done');
  } finally {
    await f.close();
  }
});

test('an unreadable legacy entered delivery cannot bypass the persistent reconciliation budget via live flush', async (t) => {
  const f = fixture(t);
  try {
    f.ready();
    const id = f.enqueue();
    f.crashClaim(id);
    f.store.db
      .prepare(
        "UPDATE outbox SET state='entered',payload=json_set(payload,'$.deliveryOnly',json('true')) WHERE id=?",
      )
      .run(id);
    f.setUnreadable(true);
    await f.reload();
    for (const delay of [1000, 30000, 60000, 3600000]) await f.pulse(delay);
    assert.equal(f.row(id).state, 'unknown');
    assert.equal(f.counts().reads, 3);
    assert.equal(f.counts().resolves, 0);
    assert.equal(f.messages.length, 0);
    await f.reload();
    await f.pulse(3600000);
    assert.equal(f.counts().reads, 3);
    f.store.resolveManagerNotification('manual-checked', f.bot.id, id, 'handled', true);
    assert.equal(f.row(id).state, 'handled');
    assert.equal(f.store.managerInfo(f.bot.id).problem, null);
  } finally {
    await f.close();
  }
});

test('oversized durable logs consume only the bounded metadata checks and never load an Agent', async (t) => {
  const f = fixture(t);
  try {
    f.ready();
    const id = f.enqueue();
    f.crashClaim(id);
    f.setOversized(true);
    await f.reload();
    for (const delay of [1000, 30000, 60000, 3600000]) await f.pulse(delay);
    assert.equal(f.row(id).state, 'unknown');
    assert.equal(JSON.parse(String(f.row(id).payload)).reconcileAttempts, 3);
    assert.equal(f.counts().reads, 0);
    assert.equal(f.counts().resolves, 0);
    assert.equal(f.messages.length, 0);
  } finally {
    await f.close();
  }
});

test('restart reconciliation handles at most ten notices per batch and shares one durable read', async (t) => {
  const f = fixture(t);
  try {
    f.ready();
    const ids = Array.from({ length: 12 }, (_, i) => f.enqueue(`batch:${i}`));
    for (const id of ids) f.crashClaim(id);
    await f.reload();
    await f.pulse();
    assert.equal(
      ids.filter((id) => JSON.parse(String(f.row(id).payload)).reconcileAttempts === 1).length,
      10,
    );
    assert.equal(f.counts().reads, 1);
    await f.pulse();
    assert.equal(
      ids.filter((id) => JSON.parse(String(f.row(id).payload)).reconcileAttempts === 1).length,
      12,
    );
    assert.equal(f.counts().reads, 2);
    assert.equal(f.messages.length, 0);
    assert.equal(f.counts().resolves, 0);
  } finally {
    await f.close();
  }
});

test('legacy pending enqueue hints and blocked records without identity never authorize a fresh attempt', async (t) => {
  const f = fixture(t);
  try {
    f.ready();
    const first = f.enqueue('legacy-attempt'),
      second = f.enqueue('legacy-identity');
    f.store.db.prepare('UPDATE outbox SET attempts=2 WHERE id=?').run(first);
    f.store.db
      .prepare(
        "UPDATE outbox SET payload=json_set(payload,'$.messageId','old-unconfirmed') WHERE id=?",
      )
      .run(second);
    for (const id of [first, second]) {
      assert.equal(f.store.claimManagerEvent(id, 'new-message', '{}'), false);
      assert.equal(f.row(id).state, 'unknown');
    }
    f.store.db.prepare("UPDATE outbox SET state='pending' WHERE id IN (?,?)").run(first, second);
    await f.reload();
    await f.pulse();
    assert.equal(f.row(first).state, 'unknown');
    assert.equal(f.row(second).state, 'unknown');
    assert.equal(f.messages.length, 0);
    assert.equal(f.counts().resolves, 0);
    f.store.db.prepare("UPDATE outbox SET state='blocked' WHERE id=?").run(first);
    assert.throws(
      () =>
        f.store.resolveManagerNotification('legacy-retry', f.bot.id, first, 'retry-unsent', true),
      { code: 'notification-uncertain' },
    );
  } finally {
    await f.close();
  }
});

test('handled and superseded notifications cannot leave a latent automatic Inbox wake, while human input survives', async (t) => {
  const f = fixture(t);
  try {
    const b = f.ready(),
      id = f.enqueue(),
      message = f.crashClaim(id);
    f.store.managerEventUnknown(id);
    const human = { id: 'human-pending', source: { kind: 'user', rpcId: 'human' }, content: [] };
    const unrelated = f.enqueue('unrelated'),
      unrelatedMessage = f.crashClaim(unrelated);
    f.store.managerEventUnknown(unrelated);
    f.agent.inbox.nextTurn.push(message, human, unrelatedMessage);
    f.resolve(id);
    assert.equal(f.row(id).state, 'handled');
    assert.deepEqual(f.agent.inbox.nextTurn, [human, unrelatedMessage]);
    assert.equal(f.messages.length, 0);
    assert.equal(f.counts().resolves, 0);
    const old = f.enqueue('old-manager'),
      oldMessage = f.crashClaim(old);
    f.store.managerEventUnknown(old);
    f.agent.inbox.nextTurn.push(oldMessage);
    f.store.releaseManager('disable-old', f.bot.id, b.generation);
    await f.reload();
    assert.deepEqual(f.agent.inbox.nextTurn, [human]);
  } finally {
    await f.close();
  }
});
