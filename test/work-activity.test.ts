import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.ts';
import { botWorkSummaries } from '../src/work-activity.ts';

test('summary excludes inactive and folded work, scopes manager rows and includes actionable work beyond the inbox window', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const bot = store.createBot('one', { name: 'One', instructions: 'Synthetic only' });
  const other = store.createBot('two', { name: 'Two', instructions: 'Synthetic only' });
  const manager = store.beginManager('manager', bot.id, '/synthetic/one');
  store.confirmManager(manager.id, manager.requestedSessionId);
  const make = (goal: string, scope = 'Scope', startPaused = false) => store.createTask(goal, {
    botId: bot.id, goal, scope, acceptance: 'Criteria', reviewPolicy: 'human', startPaused,
  });
  const active = make('Automatic follow-up');
  const blocked = make('Question', '');
  make('【测试】active fixture');
  for (let i = 0; i < 105; i++) make('paused-' + i, 'Scope', true);
  const summary = () => botWorkSummaries(store.db).find(row => row.id === bot.id)!;
  assert.deepEqual({ ...summary() }, { id: bot.id, name: bot.name, sessionId: manager.requestedSessionId, working: 1, attention: 1 });
  const idle = botWorkSummaries(store.db).find(row => row.id === other.id)!;
  assert.equal(idle.sessionId, null);
  assert.equal(idle.working + idle.attention, 0);
  const inbox = store.taskInbox(bot.id);
  assert.equal(inbox.truncated, true);
  assert.equal(inbox.items.find(t => t.id === active.id)?.activity, 'working');
  assert.ok(inbox.items.find(t => t.id === blocked.id)?.activityQuestion);
  store.cancelTask('cancel', blocked.id, blocked.rowVersion);
  assert.equal(summary().attention, 0);
  store.controlTask('manual', active.id, active.rowVersion, 'manual');
  assert.equal(summary().working, 0);
});
