import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.ts';
import { botWorkSummaries } from '../src/work-activity.ts';
import type { MirrorDetail } from '../src/mirror.ts';
import { readLocalMirror } from '../src/mirror-queries.ts';
import { canStartTask, eventTitle, inboxGroups, recoveryEventMessage, stage, stageText, workGroup } from '../src/ui/work/format.ts';

function readyResult(store: Store, botId: string, goal: string, reviewPolicy: 'human' | 'bot' = 'human') {
  const task = store.createTask(goal, { botId, goal, scope: 'Scope', acceptance: 'Criteria', reviewPolicy });
  const binding = store.beginBinding(`bind:${goal}`, task.id, task.rowVersion, '/synthetic/activity');
  store.confirmBinding(binding.id, binding.requestedSessionId);
  const version = () => store.getTask(task.id).rowVersion;
  const run = store.reserveRun(`run:${goal}`, task.id, version());
  store.saveRunMessage(run.id, 'worker', '{}');
  store.claimDispatch(run.id);
  store.inputEntered(run.id, 'worker', 1);
  const { resultId } = store.workerReport(run.id, 'report', { kind: 'ready', summary: 'Ready', checks: 'Read facts',
    evidence: [{ path: '/synthetic/activity/result.md', sha256: 'synthetic', bytes: 20 }] });
  store.settleRun(run.id);
  assert.ok(resultId);
  return { task, version, resultId, eventId: `manager-event:delivery:${resultId}` };
}

test('a settled business blocker has no owner action in the local or mirrored work view', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const bot = store.createBot('bot', { name: 'Release', instructions: 'Synthetic only' });
  const task = store.createTask('task', { botId: bot.id, goal: 'Check production version', scope: 'Observe only',
    acceptance: 'Report running image', reviewPolicy: 'human' });
  const binding = store.beginBinding('bind', task.id, task.rowVersion, '/synthetic/release');
  store.confirmBinding(binding.id, binding.requestedSessionId);
  const run = store.reserveRun('dispatch', task.id, store.getTask(task.id).rowVersion);
  store.saveRunMessage(run.id, 'm', JSON.stringify({ id: 'm' }));
  store.claimDispatch(run.id);
  store.inputEnqueued(run.id);
  store.inputEntered(run.id, 'm', 1);
  store.associateRunTurn(run.id, 1, 0, 1);
  store.workerReport(run.id, 'report', { kind: 'blocked', summary: 'Release job missing', checks: 'Checked pipeline' });
  store.observeRunEnd(run.id, 5, 'completed', true);
  store.settleRun(run.id);
  const mirror = readLocalMirror(store, { op: 'detail', id: task.id, botId: bot.id }) as MirrorDetail;
  for (const row of [store.getTask(task.id), mirror.task]) {
    assert.equal(row.status, 'blocked');
    assert.equal(stageText(row), '任务受阻');
    assert.equal(stage(row), 'waiting');
    assert.equal(workGroup(row), 'doing');
  }
  assert.equal(botWorkSummaries(store.db)[0]?.attention, 0);
  assert.equal(canStartTask(store.taskDetail(task.id)), false);
});

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
  assert.deepEqual({ ...summary() }, { id: bot.id, name: bot.name, sessionId: manager.requestedSessionId,
    working: 1, attention: 1, review: 0 });
  const idle = botWorkSummaries(store.db).find(row => row.id === other.id)!;
  assert.equal(idle.sessionId, null);
  assert.equal(idle.working + idle.attention + idle.review, 0);
  const inbox = store.taskInbox(bot.id);
  assert.equal(inbox.truncated, true);
  assert.equal(inbox.items.find(t => t.id === active.id)?.activity, 'working');
  assert.ok(inbox.items.find(t => t.id === blocked.id)?.activityQuestion);
  store.cancelTask('cancel', blocked.id, blocked.rowVersion);
  assert.equal(summary().attention, 0);
  store.controlTask('manual', active.id, active.rowVersion, 'manual');
  assert.equal(summary().working, 0);
});

test('automatic review and delivery, delivery issues, and human acceptance use distinct activities', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const bot = store.createBot('bot', { name: 'Results', instructions: 'Synthetic only' });
  const manager = store.beginManager('manager', bot.id, '/synthetic/manager');
  store.confirmManager(manager.id, manager.requestedSessionId);
  const human = readyResult(store, bot.id, 'Human review');
  const automatic = readyResult(store, bot.id, 'Automatic approval', 'bot');
  const fixture = readyResult(store, bot.id, '【测试】Folded review');
  const activity = (id: string) => store.taskInbox(bot.id).items.find(item => item.id === id)?.activity;
  const assertCounts = (working: number, attention: number, review: number) => {
    const { id: _id, name: _name, sessionId: _sessionId, ...counts } = botWorkSummaries(store.db)[0]!;
    assert.deepEqual(counts, { working, attention, review });
    assert.equal(store.taskInbox(bot.id).reviewTotal, review);
  };
  const deliver = (eventId: string) => store.managerNotificationDelivered(eventId, manager.requestedSessionId,
    { turn: 1, seq: 2, endSeq: 3, messageId: 'visible' });

  assertCounts(2, 0, 0);
  store.managerReview('review-human', bot.id, human.task.id, human.version(), human.resultId, 'human', 'Review ready');
  store.managerReview('review-bot', bot.id, automatic.task.id, automatic.version(), automatic.resultId, 'accept', 'Verified');
  store.managerReview('review-fixture', bot.id, fixture.task.id, fixture.version(), fixture.resultId, 'human', 'Review ready');
  assert.equal(store.getTask(automatic.task.id).lifecycle, 'completed');
  assert.equal(activity(automatic.task.id), 'working');
  assertCounts(2, 0, 0);

  assert.equal(store.managerDeliveryUncertain(human.eventId), true);
  assert.equal(store.managerDeliveryUncertain(fixture.eventId), true);
  assert.equal(activity(human.task.id), 'attention');
  assertCounts(1, 2, 0);
  store.resolveManagerNotification('handled-fixture', bot.id, fixture.eventId, 'handled', true);
  assert.equal(activity(fixture.task.id), 'review');
  deliver(human.eventId);
  assert.equal(activity(human.task.id), 'review');
  assertCounts(1, 0, 1);

  const groups = inboxGroups(store.taskInbox(bot.id).items, {}, Date.now());
  assert.deepEqual(groups.review.map(item => item.id), [human.task.id]);
  assert.deepEqual(groups.tests.map(item => item.id), [fixture.task.id]);
  deliver(automatic.eventId);
  store.acceptResult('accept', human.task.id, human.version(), human.resultId);
  assertCounts(0, 0, 0);
});

test('counts include old reviews while the inbox keeps its recent review window bounded', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const bot = store.createBot('bot', { name: 'Old results', instructions: 'Synthetic only' });
  const oldest = readyResult(store, bot.id, 'Oldest waiting result');
  for (let i = 0; i < 105; i++) {
    t.mock.timers.tick(1000);
    readyResult(store, bot.id, `Review ${i}`);
  }
  const inbox = store.taskInbox(bot.id);
  assert.equal(inbox.truncated, true);
  assert.equal(inbox.reviewTotal, 106);
  assert.equal(botWorkSummaries(store.db)[0]?.review, 106);
  assert.equal(inbox.items.filter(item => item.activity === 'review').length, 100);
  assert.equal(inbox.items.some(item => item.id === oldest.task.id), false);
});

test('a verified prerequisite blocker stays visible after recovery closes and mirrors only the outcome',t=>{
  const store=new Store(':memory:');
  t.after(()=>store.close());
  const bot=store.createBot('bot',{name:'Recovery activities',instructions:'Synthetic only'});
  const task=store.createTask('work',{botId:bot.id,goal:'Original work',scope:'Scope',acceptance:'Criteria',reviewPolicy:'human'});
  const binding=store.beginBinding('bind',task.id,task.rowVersion,'/synthetic/recovery');
  store.confirmBinding(binding.id,binding.requestedSessionId);
  const rowVersion=()=>store.getTask(task.id).rowVersion;
  const run=store.reserveRun('run',task.id,rowVersion());
  store.runRecovery(run.id,'Synthetic blocker',false);
  store.resolveRunRecovery('resolve',task.id,rowVersion());
  store.controlTask('resume',task.id,rowVersion(),'auto');
  const message='Missing prerequisite in /private/synthetic/path';
  const result={status:'present',message,observed:{ready:false,uid:'external-resource-id'}};
  store.set(`run-recovery-check:${run.id}`,JSON.stringify({resolution:result}));
  const payload=JSON.stringify({actor:'manager',managerId:'private-manager-id',runId:run.id,result});
  store.db.prepare('INSERT INTO events(taskId,kind,data,createdAt) VALUES (?,?,?,?)')
    .run(task.id,'run.recovery-confirmed',payload,Date.now());
  const local=store.getTask(task.id);
  assert.equal(local.status,'blocked');
  assert.equal(local.blockingAttention,null);
  assert.equal(botWorkSummaries(store.db).find(row=>row.id===bot.id)?.attention,1);
  assert.equal(store.taskInbox(bot.id).items.find(item=>item.id===task.id)?.activity,'attention');
  assert.equal(stage(local),'needs-you');
  assert.equal(workGroup(local),'needs-you');
  assert.equal(stageText(local),'前提未满足');
  assert.equal(canStartTask(store.taskDetail(task.id)),false);
  const sourceEvents=store.taskDetail(task.id).events.filter(event=>event.kind==='run.recovery-confirmed');
  assert.equal(eventTitle(sourceEvents[0]),'Bot 确认前提未满足');
  assert.equal(recoveryEventMessage(sourceEvents[0]),message);
  assert.equal(eventTitle(sourceEvents[1]),'用户完成恢复核对');
  const mirror=readLocalMirror(store,{op:'detail',id:task.id,botId:bot.id}) as MirrorDetail;
  const mirrored=mirror.events.filter(event=>event.kind==='run.recovery-confirmed');
  assert.deepEqual(mirrored.map(event=>JSON.parse(event.data)),[{actor:'manager',outcome:'not-ready'},{actor:'user'}]);
  assert.equal(eventTitle(mirrored[0]),'Bot 确认前提未满足');
  assert.equal(recoveryEventMessage(mirrored[0]),undefined);
});
