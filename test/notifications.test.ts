import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.ts';

function fixture(prepare=true) {
  const store=new Store(':memory:');
  const bot=store.createBot('bot',{name:'Notification fixture',instructions:'Synthetic work'});
  const manager=store.beginManager('manager',bot.id,'/synthetic/manager');store.confirmManager(manager.id,manager.requestedSessionId);
  const task=store.createTask('task',{botId:bot.id,goal:'Write facts',scope:'Own files',acceptance:'Read facts',reviewPolicy:'human'});
  const binding=store.beginBinding('binding',task.id,task.rowVersion,'/synthetic/work');store.claimBindingCreation(binding.id);
  if(prepare)store.confirmBinding(binding.id,binding.requestedSessionId);
  const start=()=>{
    const run=store.reserveRun('dispatch',task.id,store.getTask(task.id).rowVersion);
    store.saveRunMessage(run.id,'worker-input','{}');store.claimDispatch(run.id);store.inputEntered(run.id,'worker-input',1);return run;
  };
  const notices=()=>store.pendingManagerEvents(bot.id).filter(event=>event.id!==`manager-event:created:${task.id}`);
  return {store,bot,task,binding,start,notices};
}

test('unknown execution wakes the Bot once with recovery action, retaining resources and forbidding rerun',()=>{
  const f=fixture();try {
    const run=f.start();
    for(let n=0;n<20;n++)f.store.workerReport(run.id,`progress-${n}`,{kind:'progress',summary:`Working ${n}`});
    assert.equal(f.notices().length,0,'ordinary progress must not wake the Bot');
    f.store.runRecovery(run.id,'输入回执丢失，请核对原生会话');
    f.store.runRecovery(run.id,'Late error must not create another notification');
    assert.equal(f.notices().length,1);
    const reason=JSON.parse(f.notices()[0]!.payload).reason;
    assert.match(reason,/输入回执丢失/);assert.match(reason,/核对/);assert.match(reason,/不.*重/);
    assert.equal(f.notices()[0]!.taskId,f.task.id);assert.equal(f.store.getTask(f.task.id).status,'recovery');
    assert.equal(f.store.heldRuns().length,1);assert.equal(f.store.latestRun(f.task.id)?.id,run.id);
    assert.throws(()=>f.store.reserveRun('never-rerun',f.task.id,f.store.getTask(f.task.id).rowVersion));
  }finally{f.store.close();}
});

test('native approval wakes the Bot once with original Session action, not approval authority or a new Run',()=>{
  const f=fixture();try {
    const run=f.start();
    f.store.nativeApprovalAsked(run.id,'approval-1','write','Needs permission');
    f.store.nativeApprovalAsked(run.id,'approval-1','write','Needs permission');
    assert.equal(f.notices().length,1);
    const reason=JSON.parse(f.notices()[0]!.payload).reason;
    assert.match(reason,/等待审批/);assert.ok(reason.includes(run.sessionId));assert.match(reason,/原生/);assert.match(reason,/不.*代/);
    assert.equal(f.store.getTask(f.task.id).status,'approval');assert.equal(f.store.heldRuns().length,1);
    assert.throws(()=>f.store.reserveRun('another-run',f.task.id,f.store.getTask(f.task.id).rowVersion));
    f.store.nativeApprovalDecided(run.sessionId,'approval-1','allowed-once');
    assert.equal(f.store.getRun(run.id).state,'running');assert.equal(f.store.heldRuns().length,1);
  }finally{f.store.close();}
});

test('uncertain Session creation wakes the Bot without creating another Session or Run',()=>{
  const f=fixture(false);try {
    f.store.bindingRecovery(f.binding.id);f.store.bindingRecovery(f.binding.id);
    assert.equal(f.notices().length,1);assert.match(JSON.parse(f.notices()[0]!.payload).reason,/核对/);
    assert.equal(f.store.activeBinding(f.task.id)?.requestedSessionId,f.binding.requestedSessionId);
    assert.equal(f.store.latestRun(f.task.id),null);assert.equal(f.store.activeBinding(f.task.id)?.state,'recovery');
  }finally{f.store.close();}
});

test('budget stop wakes the Bot with explicit no-retry recovery after actual settlement',()=>{
  const f=fixture();try {
    const run=f.start();f.store.recordRunBudget(run.id,'steps');
    f.store.requestStop('stop',f.task.id,f.store.getTask(f.task.id).rowVersion);
    f.store.settleCancelled(run.id);f.store.settleCancelled(run.id);
    assert.equal(f.notices().length,1);assert.match(JSON.parse(f.notices()[0]!.payload).reason,/40 步/);
    assert.match(JSON.parse(f.notices()[0]!.payload).reason,/不会自动重试/);
    assert.equal(f.store.getTask(f.task.id).status,'recovery');assert.equal(f.store.getTask(f.task.id).controlMode,'paused');
    assert.equal(f.store.latestRun(f.task.id)?.id,run.id);assert.equal(f.store.heldRuns().length,0);
  }finally{f.store.close();}
});

test('recovery notification and execution facts roll back together when the final receipt fails',()=>{
  const f=fixture();try {
    const run=f.start();
    f.store.db.exec(`CREATE TEMP TRIGGER fail_recovery BEFORE INSERT ON requests WHEN NEW.id='recovery:${run.id}' BEGIN SELECT RAISE(ABORT,'recovery receipt fault'); END`);
    assert.throws(()=>f.store.runRecovery(run.id,'Synthetic failure'),/recovery receipt fault/);
    assert.equal(f.notices().length,0);assert.equal(f.store.getRun(run.id).state,'running');
    assert.equal(f.store.taskDetail(f.task.id).attentions.filter(item=>item.kind==='recovery').length,0);
    f.store.db.exec('DROP TRIGGER fail_recovery');f.store.runRecovery(run.id,'Synthetic failure');
    assert.equal(f.notices().length,1);assert.equal(f.store.getTask(f.task.id).status,'recovery');
  }finally{f.store.close();}
});

for(const kind of ['waiting','blocked','failed'] as const)test(`${kind} report wakes only at settled state and never on each progress report`,()=>{
  const f=fixture();try {
    const run=f.start();f.store.workerReport(run.id,'progress',{kind:'progress',summary:'Working'});
    assert.equal(f.notices().length,0);
    f.store.workerReport(run.id,'report',{kind,summary:'Needs user action'});f.store.settleRun(run.id);f.store.settleRun(run.id);
    assert.equal(f.notices().length,1);assert.match(JSON.parse(f.notices()[0]!.payload).reason,new RegExp(kind));
    assert.equal(f.store.latestRun(f.task.id)?.id,run.id);
  }finally{f.store.close();}
});
