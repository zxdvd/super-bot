import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBotNavigation } from '../../src/ui/bot-navigation.ts';
import { forgetView, rememberedView, rememberView } from '../../src/ui/work/storage.ts';

function fixture() {
  const opened: string[][] = [],
    checks: Array<Record<string, unknown>> = [];
  const state = {
    owner: { botId: 'a', taskId: 'task-a' } as { botId: string; taskId: string } | null,
    available: true,
    failure: undefined as Error | undefined,
    checking: undefined as Promise<void> | undefined,
  };
  const navigation = createBotNavigation(
    {
      async call<T>(action: string, payload: Record<string, unknown> = {}) {
        assert.equal(action, 'session.worker-owner');
        checks.push(payload);
        await state.checking;
        if (state.failure) throw state.failure;
        return state.owner as T;
      },
      openSession: (id) => opened.push(['native', id]),
      openChildSession: (parent, child) => opened.push(['child', parent, child]),
    },
    {
      async openManager(bot, signal, chatOnly) {
        if (!signal.aborted) opened.push([chatOnly ? 'chat-only' : 'manager', bot]);
      },
      async hasSession() {
        return state.available;
      },
      showMainPanel: () => opened.push(['work']),
    },
  );
  return { navigation, opened, checks, state };
}

const task = { id: 'task-a', botId: 'a' };
const active = () => new AbortController().signal;

test('left sidebar returns to each Bot’s own Worker, main work, or Manager', async () => {
  const { navigation, opened } = fixture();
  navigation.setMainWork({ botId: 'b' });
  navigation.openWorker(task, 'worker-a');
  navigation.setMainWork(null);
  await navigation.select('b', active());
  assert.deepEqual(navigation.mainWork.getSnapshot(), { botId: 'b' });
  await navigation.select('a', active());
  navigation.rememberManager('a');
  await navigation.select('a', active());
  assert.deepEqual(opened, [
    ['native', 'worker-a'],
    ['work'],
    ['native', 'worker-a'],
    ['manager', 'a'],
  ]);
});

test('released binding and child paths retain their exact native target', async () => {
  const { navigation, opened, checks } = fixture();
  navigation.openWorker(task, 'old-a', true);
  await navigation.select('a', active());
  navigation.openChildWorker(task, 'worker-a', 'child-a');
  await navigation.select('a', active());
  assert.deepEqual(opened, [
    ['native', 'old-a'],
    ['native', 'old-a'],
    ['child', 'worker-a', 'child-a'],
    ['child', 'worker-a', 'child-a'],
  ]);
  assert.deepEqual(checks, [
    { sessionId: 'old-a', historical: true },
    { sessionId: 'child-a', parentSessionId: 'worker-a', taskId: 'task-a' },
  ]);
});

test('stale or cross-Bot Worker falls back to the right chat and transient failure is retryable', async () => {
  const { navigation, opened, state } = fixture();
  navigation.openWorker(task, 'worker-a');
  state.failure = new Error('offline');
  await assert.rejects(navigation.select('a', active()), /offline/);
  state.failure = undefined;
  await navigation.select('a', active());
  state.owner = { botId: 'b', taskId: task.id };
  await navigation.select('a', active());
  assert.deepEqual(opened, [
    ['native', 'worker-a'],
    ['native', 'worker-a'],
    ['chat-only', 'a'],
  ]);
  state.owner = { botId: task.botId, taskId: task.id };
  navigation.openWorker(task, 'worker-a');
  state.available = false;
  await navigation.select('a', active());
  assert.deepEqual(opened.at(-1), ['chat-only', 'a']);
});

test('a late Worker ownership reply cannot reverse a newer navigation', async () => {
  const { navigation, opened, state } = fixture();
  let complete!: () => void;
  state.checking = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const previous = new AbortController();
  navigation.openWorker(task, 'worker-a');
  const selecting = navigation.select('a', previous.signal);
  previous.abort();
  await navigation.select('b', active());
  complete();
  await selecting;
  assert.deepEqual(opened, [
    ['native', 'worker-a'],
    ['manager', 'b'],
  ]);
});

test('work view and task state belong to the Bot and its work surface', () => {
  const full = {
    botId: 'a',
    selected: 'full',
    view: 'list',
    query: 'query',
    offset: 25,
    filter: 'open',
  } as const;
  const compact = { ...full, selected: 'compact', view: 'inbox', query: '', offset: 0 } as const;
  const other = { ...compact, botId: 'b', selected: 'other' };
  try {
    rememberView(full);
    rememberView(compact, 'manager-a');
    rememberView(other, 'manager-b');
    assert.deepEqual(rememberedView('a'), full);
    assert.deepEqual(rememberedView('a', 'manager-a'), compact);
    assert.deepEqual(rememberedView('b', 'manager-b'), other);
    assert.equal(rememberedView('a', 'manager-b'), undefined);
    forgetView('a');
    assert.equal(rememberedView('a'), undefined);
    assert.equal(rememberedView('a', 'manager-a'), undefined);
    assert.deepEqual(rememberedView('b', 'manager-b'), other);
  } finally {
    forgetView('a');
    forgetView('b');
  }
});
