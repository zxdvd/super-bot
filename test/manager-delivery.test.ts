import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../src/store.ts';

function fixture(store:Store) {
  const bot=store.createBot('bot',{name:'Delivery fixture',instructions:'Synthetic files'});
  const manager=store.beginManager('manager',bot.id,'/synthetic/manager');store.confirmManager(manager.id,manager.requestedSessionId);
  const task=store.createTask('task',{botId:bot.id,goal:'Write facts',scope:'Own files',acceptance:'Read facts',reviewPolicy:'human'});
  const binding=store.beginBinding('binding',task.id,task.rowVersion,'/synthetic/work');store.confirmBinding(binding.id,binding.requestedSessionId);
  const run=store.reserveRun('dispatch',task.id,store.getTask(task.id).rowVersion);
  store.saveRunMessage(run.id,'worker','{}');store.claimDispatch(run.id);store.inputEntered(run.id,'worker',1);
  const result=store.workerReport(run.id,'report',{kind:'ready',summary:'Facts written',checks:'Read facts',evidence:[{path:'/synthetic/work/result.md',sha256:'synthetic',bytes:20}]});store.settleRun(run.id);
  const event=store.pendingManagerEvents(bot.id).find(item=>item.id===`manager-event:settled:${run.id}`)!;
  return {bot,manager,task,run,result,event};
}

test('notification entry and managerReview are not delivery; review-to-final crash recovers only notification',()=>{
  const root=realpathSync(process.cwd());mkdirSync(join(root,'.runtime'),{recursive:true});
  const dir=mkdtempSync(join(root,'.runtime','delivery-regression-')),file=join(dir,'ledger.sqlite');let store=new Store(file);
  try {
    const f=fixture(store);store.claimManagerEvent(f.event.id,'notice','{}');
    store.managerEventEntered(f.event.id,'notice');
    assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=?').get(f.event.id)?.state,'entered','native user/message only proves entry, not final chat delivery');
    store.managerReview('review',f.bot.id,f.task.id,store.getTask(f.task.id).rowVersion,f.result.resultId!,'human','Read actual evidence');
    assert.equal(store.getTask(f.task.id).managerReviewed,true);
    const taskBefore=store.getTask(f.task.id),runBefore=store.getRun(f.run.id);
    // Real failure window: the committed review exists, no final assistant message exists, process reopens.
    store.close();store=new Store(file);store.resetUnconfirmedManagerEvents();
    const retry=store.pendingManagerEvents(f.bot.id).find(item=>item.id===`manager-event:delivery:${f.result.resultId}`);
    assert.ok(retry,'reviewed results must retain a separate delivery obligation');
    assert.equal(JSON.parse(retry.payload).deliveryOnly,true);assert.equal(JSON.parse(retry.payload).resultId,f.result.resultId);
    assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=?').get(f.event.id)?.state,'unknown','unfinished original management is not replayed');
    assert.deepEqual(store.getTask(f.task.id),taskBefore);assert.deepEqual(store.getRun(f.run.id),runBefore);
    assert.equal(store.heldRuns().length,0);assert.equal(store.runResult(f.run.id)?.humanAcceptedAt,null);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get()?.n,1);
  }finally {
    store.close();assert.ok(dir.startsWith(join(root,'.runtime','delivery-regression-')));rmSync(dir,{recursive:true,force:true});
  }
});

test('Review and its delivery obligation commit or roll back together and retry never duplicates responsibility',()=>{
  const store=new Store(':memory:');try {
    const f=fixture(store),version=store.getTask(f.task.id).rowVersion;
    const review=()=>store.managerReview('review',f.bot.id,f.task.id,version,f.result.resultId!,'human','Read evidence');
    store.db.exec("CREATE TEMP TRIGGER fail_review BEFORE INSERT ON requests WHEN NEW.id='review' BEGIN SELECT RAISE(ABORT,'review receipt fault'); END");
    assert.throws(review,/review receipt fault/);
    assert.equal(store.getTask(f.task.id).managerReviewed,false);
    assert.equal(store.managerNotifications(f.bot.id).filter(event=>JSON.parse(event.payload).deliveryOnly).length,0);
    store.db.exec('DROP TRIGGER fail_review');const first=review();assert.deepEqual(review(),first);
    assert.equal(store.managerNotifications(f.bot.id).filter(event=>JSON.parse(event.payload).deliveryOnly).length,1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM reviews').get()?.n,1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get()?.n,1);
  }finally{store.close();}
});

test('supplementary attempts count individually against the existing hourly wake budget; unknown sends never replay',()=>{
  const store=new Store(':memory:');try {
    const f=fixture(store);store.managerReview('review',f.bot.id,f.task.id,store.getTask(f.task.id).rowVersion,f.result.resultId!,'human','Read evidence');
    const id=`manager-event:delivery:${f.result.resultId}`;
    for(let n=0;n<20;n++) {
      assert.equal(store.claimManagerEvent(id,`delivery-${n}`,'{}'),true);
      store.managerEventEntered(id,`delivery-${n}`);store.managerEventUnknown(id);
    }
    assert.equal(store.managerWakeCount(f.bot.id,0),20);assert.equal(store.managerInfo(f.bot.id).hourlyWakes,20);
    assert.equal(store.db.prepare('SELECT attempts FROM outbox WHERE id=?').get(id)?.attempts,20);
    assert.equal(store.claimManagerEvent(id,'unconfirmed','{}'),true);store.resetUnconfirmedManagerEvents();
    assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=?').get(id)?.state,'unknown');
    assert.equal(store.claimManagerEvent(id,'never-replay','{}'),false);
    store.managerEventEntered(id,'unconfirmed');assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=?').get(id)?.state,'unknown');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get()?.n,1);
  }finally{store.close();}
});
