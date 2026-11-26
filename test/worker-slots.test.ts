import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Bot, Run } from '../src/model.ts';
import { Store } from '../src/store.ts';

function makeBot(store: Store, name: string): Bot {
  const bot = store.createBot(`bot-${name}`, { name, instructions: 'Only synthetic tasks' });
  const manager = store.beginManager(`manager-${name}`, bot.id, '/synthetic/manager');
  store.confirmManager(manager.id, manager.requestedSessionId);
  return store.getBot(bot.id);
}

function readyTask(store: Store, bot: Bot, name: string) {
  const task = store.createTask(`task-${name}`, {
    botId: bot.id,
    goal: name,
    scope: 'Own synthetic files',
    acceptance: 'Read them back',
    reviewPolicy: 'human',
  });
  const intent = store.beginBinding(
    `binding-${name}`,
    task.id,
    task.rowVersion,
    '/synthetic/worker',
  );
  const binding = store.confirmBinding(intent.id, intent.requestedSessionId);
  return { id: task.id, binding };
}

function reserve(store: Store, taskId: string) {
  return store.reserveRun(`reserve-${taskId}`, taskId, store.getTask(taskId).rowVersion);
}

function start(store: Store, taskId: string) {
  const run = reserve(store, taskId);
  const messageId = `message-${run.id}`;
  store.saveRunMessage(run.id, messageId, JSON.stringify({ id: messageId }));
  assert.equal(store.claimDispatch(run.id), true);
  store.inputEnqueued(run.id);
  store.inputEntered(run.id, messageId, 1);
  return store.getRun(run.id);
}

function wait(store: Store, taskId: string) {
  const task = store.getTask(taskId);
  assert.equal(store.dispatchWait(taskId)?.scope, 'bot');
  assert.throws(() => reserve(store, taskId), { code: 'capacity' });
  assert.equal(store.latestRun(taskId), null);
  store.recordWait(taskId);
  store.enqueueManager(
    task.botId,
    `capacity:${taskId}:${task.rowVersion}`,
    'Synthetic queue',
    taskId,
  );
}

function finish(store: Store, run: Run) {
  const task = store.getTask(run.taskId);
  store.requestStop(`stop-${run.id}`, task.id, task.rowVersion, run.id);
  store.settleCancelled(run.id);
}

test('two Bots run five Workers each and release capacity for their own sixth task', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = makeBot(store, 'A'),
    b = makeBot(store, 'B');
  assert.deepEqual(store.botCapacity(a.id), { maxRunningTasks: null, botLimit: 5, botHeld: 0 });
  const fill = (bot: Bot) =>
    Array.from({ length: 5 }, (_, i) =>
      start(store, readyTask(store, bot, `${bot.name}${i + 1}`).id),
    );
  const [a1] = fill(a),
    moreA = readyTask(store, a, 'A6');
  wait(store, moreA.id);
  assert.deepEqual(store.botCapacity(b.id), { maxRunningTasks: null, botLimit: 5, botHeld: 0 });
  const [b1] = fill(b),
    moreB = readyTask(store, b, 'B6');
  wait(store, moreB.id);
  assert.equal(store.heldRuns().filter((run) => run.state === 'running').length, 10);
  assert.deepEqual(store.botCapacity(a.id), { maxRunningTasks: null, botLimit: 5, botHeld: 5 });
  assert.deepEqual(store.botCapacity(b.id), { maxRunningTasks: null, botLimit: 5, botHeld: 5 });

  finish(store, b1);
  assert.equal(store.dispatchWait(moreA.id)?.scope, 'bot');
  assert.equal(store.dispatchWait(moreB.id), null);
  assert.equal(start(store, moreB.id).state, 'running');
  finish(store, a1);
  assert.equal(store.dispatchWait(moreA.id), null);
  assert.equal(start(store, moreA.id).state, 'running');
  assert.equal(store.heldRuns().length, 10);
});

test('Bot Worker slot changes apply immediately and persist through reset and reopen', (t) => {
  const runtime = join(process.cwd(), '.runtime');
  mkdirSync(runtime, { recursive: true });
  const dir = mkdtempSync(join(runtime, 'worker-slots-'));
  const file = join(dir, 'ledger.sqlite');
  let store = new Store(file);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true });
  });
  const a = makeBot(store, 'A'),
    b = makeBot(store, 'B');
  const first = readyTask(store, a, 'A1'),
    next = readyTask(store, a, 'A2'),
    third = readyTask(store, a, 'A3');
  assert.equal(store.setBotCapacity('limit-1', a.id, null, 1).botLimit, 1);
  reserve(store, first.id);
  assert.equal(store.dispatchWait(next.id)?.scope, 'bot');
  const raised = store.setBotCapacity('limit-2', a.id, 1, 2);
  assert.equal(raised.botLimit, 2);
  assert.deepEqual(store.setBotCapacity('limit-2', a.id, 1, 2), raised);
  assert.throws(() => store.setBotCapacity('stale-limit', a.id, 1, 3), {
    code: 'version-conflict',
  });
  for (const invalid of [0, -1, 1.5]) {
    assert.throws(() => store.setBotCapacity(`invalid-${invalid}`, a.id, 2, invalid), {
      code: 'invalid-input',
    });
  }
  assert.equal(store.dispatchWait(next.id), null);
  assert.equal(reserve(store, next.id).state, 'queued');
  assert.equal(store.getBot(a.id).managerSessionId, a.managerSessionId);
  store.close();
  store = new Store(file);
  assert.deepEqual(store.botCapacity(a.id), { maxRunningTasks: 2, botLimit: 2, botHeld: 2 });
  assert.deepEqual(store.botCapacity(b.id), { maxRunningTasks: null, botLimit: 5, botHeld: 0 });
  assert.equal(store.getBot(a.id).managerSessionId, a.managerSessionId);
  assert.equal(store.dispatchWait(third.id)?.scope, 'bot');
  const reset = store.setBotCapacity('limit-reset', a.id, 2, null);
  assert.deepEqual(reset, { maxRunningTasks: null, botLimit: 5, botHeld: 2 });
  assert.equal(store.dispatchWait(third.id), null);
  store.close();
  store = new Store(file);
  assert.deepEqual(store.botCapacity(a.id), reset);
});

test('lowering A to three keeps its running Workers and leaves B at five', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = makeBot(store, 'A'),
    b = makeBot(store, 'B');
  const running = Array.from({ length: 4 }, (_, i) =>
    start(store, readyTask(store, a, `A${i + 1}`).id),
  );
  const next = readyTask(store, a, 'A5');
  const [b1] = Array.from({ length: 4 }, (_, i) =>
    start(store, readyTask(store, b, `B${i + 1}`).id),
  );
  assert.deepEqual(store.setBotCapacity('lower', a.id, null, 3), {
    maxRunningTasks: 3,
    botLimit: 3,
    botHeld: 4,
  });
  for (const run of running) assert.deepEqual(store.getRun(run.id), run);
  wait(store, next.id);
  assert.equal(start(store, readyTask(store, b, 'B5').id).state, 'running');
  assert.deepEqual(store.botCapacity(b.id), { maxRunningTasks: null, botLimit: 5, botHeld: 5 });
  finish(store, b1);
  assert.equal(store.dispatchWait(next.id)?.scope, 'bot');

  finish(store, running[0]);
  assert.equal(store.botCapacity(a.id).botHeld, 3);
  assert.equal(store.dispatchWait(next.id)?.scope, 'bot');
  finish(store, running[1]);
  assert.equal(store.botCapacity(a.id).botHeld, 2);
  assert.equal(store.dispatchWait(next.id), null);
  assert.equal(start(store, next.id).state, 'running');
  assert.equal(store.botCapacity(a.id).botHeld, 3);
});

test('older A waiters keep their order while B dispatches independently', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = makeBot(store, 'A'),
    b = makeBot(store, 'B');
  store.setBotCapacity('limit-a', a.id, null, 1);
  const a1 = reserve(store, readyTask(store, a, 'A1').id);
  reserve(store, readyTask(store, b, 'B1').id);
  const a2 = readyTask(store, a, 'A2'),
    a3 = readyTask(store, a, 'A3'),
    b2 = readyTask(store, b, 'B2');
  wait(store, a2.id);
  wait(store, a3.id);
  assert.equal(store.dispatchWait(b2.id), null);
  finish(store, a1);
  assert.equal(store.dispatchWait(a3.id)?.scope, 'bot');
  assert.equal(store.dispatchWait(b2.id), null, 'A waiters cannot reserve B capacity');
  assert.equal(reserve(store, b2.id).state, 'queued');
  assert.equal(store.dispatchWait(a2.id), null);
  assert.equal(store.dispatchWait(a3.id)?.holderTaskId, a2.id);
  assert.equal(reserve(store, a2.id).state, 'queued');
});

test('recovery continuation atomically replaces its own Bot slot and only-check releases it', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = makeBot(store, 'A'),
    b = makeBot(store, 'B');
  const work = readyTask(store, a, 'interrupted'),
    waiting = readyTask(store, a, 'waiting');
  const prior = reserve(store, work.id),
    other = reserve(store, readyTask(store, a, 'occupied-a').id);
  const bRun = reserve(store, readyTask(store, b, 'occupied-b').id);
  store.runRecovery(prior.id, 'Synthetic interrupted delivery');
  const current = store.getTask(work.id);
  const args = {
    attentionId: `run:${prior.id}`,
    bindingId: work.binding.id,
    expectedBindingGeneration: work.binding.generation,
  };
  store.setBotCapacity('limit-a', a.id, null, 1);
  assert.throws(() => store.continueRunRecovery('continue', work.id, current.rowVersion, args), {
    code: 'capacity',
  });
  assert.deepEqual(store.getTask(work.id), current);
  assert.deepEqual(
    new Set(store.heldRuns().map((run) => run.id)),
    new Set([prior.id, other.id, bRun.id]),
  );
  assert.equal(store.recoveryTarget(work.id, current.rowVersion, args).run?.id, prior.id);
  assert.equal(store.dispatchWait(readyTask(store, b, 'B2').id), null);

  store.setBotCapacity('raise-a', a.id, 1, 2);
  const next = store.continueRunRecovery('continue', work.id, current.rowVersion, args);
  assert.notEqual(next.id, prior.id);
  assert.notEqual(next.inputId, prior.inputId);
  assert.equal(next.bindingId, work.binding.id);
  assert.equal(
    store.continueRunRecovery('continue', work.id, current.rowVersion, args).id,
    next.id,
  );
  assert.deepEqual(
    new Set(store.heldRuns().map((run) => run.id)),
    new Set([next.id, other.id, bRun.id]),
  );
  assert.equal(store.dispatchWait(waiting.id)?.scope, 'bot');

  store.runRecovery(next.id, 'Synthetic lost confirmation');
  const problem = store.getTask(work.id);
  const paused = store.resolveRunRecovery('only-check', work.id, problem.rowVersion);
  assert.equal(paused.controlMode, 'paused');
  assert.equal(store.latestRun(work.id)?.id, next.id);
  assert.deepEqual(new Set(store.heldRuns().map((run) => run.id)), new Set([other.id, bRun.id]));
  assert.equal(store.dispatchWait(waiting.id), null);
});
