import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.ts';
import { botWorkSummaries } from '../src/work-activity.ts';
import type { MirrorDetail } from '../src/mirror.ts';
import { readLocalMirror } from '../src/mirror-queries.ts';
import { canStartTask, eventTitle, recoveryEventMessage, stage, stageText, workGroup } from '../src/ui/work/format.ts';

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
