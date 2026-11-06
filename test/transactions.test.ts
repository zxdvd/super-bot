import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

const ready={kind:'ready' as const,summary:'Saved result',checks:'Two facts',evidence:[{path:'/tmp/synthetic-result.md',sha256:'synthetic',bytes:20}]};
const tables=['tasks','runs','inputs','resources','reports','results','reviews','attentions','outbox','events','requests'];
function snapshot(store:Store){return tables.map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]);}
function setup(store:Store,enter=true){
 const bot=store.createBot('bot',{name:'Transaction fixture',instructions:'Synthetic files'});
 const manager=store.beginManager('manager',bot.id,'/tmp/transaction-manager');store.confirmManager(manager.id,manager.requestedSessionId);
 const task=store.createTask('task',{botId:bot.id,goal:'Write facts',scope:'Own directory',acceptance:'Read facts',reviewPolicy:'bot'});
 const binding=store.beginBinding('binding',task.id,task.rowVersion,'/tmp/transaction-task');store.claimBindingCreation(binding.id);store.confirmBinding(binding.id,binding.requestedSessionId);
 const run=store.reserveRun('run',task.id,store.getTask(task.id).rowVersion);store.saveRunMessage(run.id,'message','{}');store.claimDispatch(run.id);store.inputEnqueued(run.id);if(enter)store.inputEntered(run.id,'message',1);
 return {task,run};
}

for(const stage of ['report','settle','accept','manager-rework'] as const)test(`${stage} failure is atomic and a committed receipt survives reopen`,()=>{
 const dir=mkdtempSync(join(tmpdir(),'super-bot-transaction-')),file=join(dir,'ledger.sqlite');let store=new Store(file);
 try{
  const {task,run}=setup(store);let resultId:string|undefined;
  if(stage!=='report')resultId=store.workerReport(run.id,'report',ready).resultId;
  if(stage==='accept'||stage==='manager-rework')store.settleRun(run.id);
  const version=store.getTask(task.id).rowVersion;
  const apply=()=>stage==='report'?store.workerReport(run.id,'report',ready):stage==='settle'?store.settleRun(run.id):stage==='accept'?store.acceptResult('accept',task.id,version,resultId!):store.managerReview('review',task.botId,task.id,version,resultId!,'rework','Add evidence');
  // Fail at the last receipt insertion, after every business mutation has run.
  const requestId=stage==='report'?`report:${run.id}:report`:stage==='settle'?`settle:${run.id}`:stage==='accept'?'accept':'review';
  store.db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON requests WHEN NEW.id='${requestId}' BEGIN SELECT RAISE(ABORT,'receipt fault'); END`);
  const before=snapshot(store);assert.throws(apply,/receipt fault/);assert.deepEqual(snapshot(store),before);
  store.close();store=new Store(file);assert.deepEqual(snapshot(store),before);store.db.exec('DROP TRIGGER fail_receipt');
  const first=apply(),after=snapshot(store);store.close();store=new Store(file);
  assert.deepEqual(apply(),first);assert.deepEqual(snapshot(store),after);
  if(stage==='report'){assert.equal(store.getRun(run.id).state,'running');assert.equal(store.heldRuns().length,1);assert.equal(store.getTask(task.id).lifecycle,'open');}
  if(stage==='settle'){assert.equal(store.getTask(task.id).lifecycle,'review');assert.equal(store.heldRuns().length,0);assert.equal(store.pendingManagerEvents(task.botId).filter(event=>event.id===`manager-event:settled:${run.id}`).length,1);}
  if(stage==='accept'){assert.equal(store.getTask(task.id).lifecycle,'completed');assert.ok(store.runResult(run.id)?.humanAcceptedAt);assert.equal(store.taskDetail(task.id).attentions.filter(a=>a.state==='open').length,0);}
  if(stage==='manager-rework'){assert.equal(store.getTask(task.id).lifecycle,'open');assert.equal(store.db.prepare("SELECT count(*) AS n FROM inputs WHERE kind='rework'").get()?.n,1);assert.equal(store.heldRuns().length,0);}
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('unknown notification after restart is not replayed and does not alter task execution',()=>{
 const dir=mkdtempSync(join(tmpdir(),'super-bot-notify-')),file=join(dir,'ledger.sqlite');let store=new Store(file);
 try{
  const {task,run}=setup(store);const event=store.pendingManagerEvents(task.botId)[0]!;
  assert.equal(store.claimManagerEvent(event.id,'notify-message','{}'),true);const taskBefore=store.getTask(task.id),runBefore=store.getRun(run.id);
  store.close();store=new Store(file);store.resetUnconfirmedManagerEvents();
  assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=?').get(event.id)?.state,'unknown');assert.equal(store.claimManagerEvent(event.id,'new-message','{}'),false);
  store.managerEventEntered(event.id,'notify-message');assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=?').get(event.id)?.state,'unknown');
  assert.deepEqual(store.getTask(task.id),taskBefore);assert.deepEqual(store.getRun(run.id),runBefore);assert.equal(store.managerInfo(task.botId).hourlyWakes,1);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('ready committed before settlement remains only a candidate across restart recovery',()=>{
 const dir=mkdtempSync(join(tmpdir(),'super-bot-candidate-')),file=join(dir,'ledger.sqlite');let store=new Store(file);
 try{
  const {task,run}=setup(store);const reported=store.workerReport(run.id,'ready',ready);store.close();store=new Store(file);
  store.runRecovery(run.id,'Host restarted before settlement');
  assert.equal(store.runResult(run.id)?.id,reported.resultId);assert.equal(store.getTask(task.id).status,'recovery');assert.equal(store.heldRuns().length,1);
  assert.throws(()=>store.acceptResult('accept',task.id,store.getTask(task.id).rowVersion,reported.resultId!),/不能验收/);
  assert.throws(()=>store.reserveRun('retry',task.id,store.getTask(task.id).rowVersion),/尚未收敛|待办/);
  store.settleRun(run.id);assert.equal(store.getTask(task.id).status,'recovery');assert.equal(store.runResult(run.id)?.humanAcceptedAt,null);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('entered write failure cannot promote an enqueued input into a valid report',()=>{
 const store=new Store(':memory:');try{
  const {task,run}=setup(store,false);
  // The native user/message is observed, but its durable entered transaction fails.
  store.db.exec("CREATE TRIGGER fail_entered BEFORE INSERT ON events WHEN NEW.kind='input.entered' BEGIN SELECT RAISE(ABORT,'entered fault'); END");
  const before=snapshot(store);assert.throws(()=>store.inputEntered(run.id,'message',2),/entered fault/);assert.deepEqual(snapshot(store),before);
  assert.throws(()=>store.workerReport(run.id,'late-ready',ready),/尚无输入/);
  store.runRecovery(run.id,'Native message observed but ledger write failed');assert.equal(store.getRunInput(run.id).state,'unknown');assert.equal(store.heldRuns().length,1);assert.equal(store.getTask(task.id).status,'recovery');assert.equal(store.runResult(run.id),null);
 }finally{store.close();}
});
