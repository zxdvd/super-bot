import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { collectEvidence,verifyEvidence,containedPath } from '../src/evidence.ts';

function prepared(store:Store,key='1',cwd=`/tmp/task-${key}`) {
  const bot=store.createBot(`b:${key}`,{name:`Bot ${key}`,instructions:'文件工作'});
  const task=store.createTask(`t:${key}`,{botId:bot.id,goal:'写一个说明文件',scope:'任务目录',acceptance:'说明包含两项事实',reviewPolicy:'human'});
  const binding=store.beginBinding(`bnd:${key}`,task.id,1,cwd);store.claimBindingCreation(binding.id);store.confirmBinding(binding.id,binding.requestedSessionId);
  return store.getTask(task.id);
}
function entered(store:Store,key='1') {
  const task=prepared(store,key);const run=store.reserveRun(`dispatch:${key}`,task.id,task.rowVersion);
  store.saveRunMessage(run.id,`m:${key}`,JSON.stringify({id:`m:${key}`}));assert.equal(store.claimDispatch(run.id),true);
  store.inputEnqueued(run.id);store.inputEntered(run.id,`m:${key}`,15);return {task,run};
}
const ready={kind:'ready' as const,summary:'说明已生成',checks:'两项事实均在文档中',evidence:[{path:'/tmp/result.md',sha256:'synthetic',bytes:30}]};

test('ready is a candidate until execution converges and the user accepts exact evidence',()=>{
  const store=new Store(':memory:');try {
    const {task,run}=entered(store);const report=store.workerReport(run.id,'tool-1',ready);
    assert.deepEqual(store.workerReport(run.id,'tool-1',ready),report);
    assert.equal(store.getTask(task.id).lifecycle,'open');assert.equal(store.heldRuns().length,1);
    assert.throws(()=>store.acceptResult('early',task.id,store.getTask(task.id).rowVersion,report.resultId!),/不能验收/);
    store.settleRun(run.id);assert.equal(store.heldRuns().length,0);assert.equal(store.getTask(task.id).lifecycle,'review');
    const version=store.getTask(task.id).rowVersion;
    assert.throws(()=>store.acceptResult('wrong',task.id,version,'wrong-result'),/不能验收/);
    assert.equal(store.acceptResult('accept',task.id,version,report.resultId!).lifecycle,'completed');
    assert.equal(store.acceptResult('accept',task.id,version,report.resultId!).lifecycle,'completed');
    assert.ok(store.runResult(run.id)?.humanAcceptedAt);
    assert.equal(store.taskDetail(task.id).attentions.filter(a=>a.state==='open').length,0);
  }finally{store.close();}
});
test('dispatch control and unknown effects keep resource ownership',()=>{
  const store=new Store(':memory:');try {
    const task=prepared(store);const run=store.reserveRun('dispatch',task.id,task.rowVersion);
    assert.deepEqual(store.reserveRun('dispatch',task.id,task.rowVersion),run);
    store.saveRunMessage(run.id,'message','{"id":"message"}');
    store.controlTask('pause',task.id,store.getTask(task.id).rowVersion,'paused');
    assert.throws(()=>store.claimDispatch(run.id),/条件已经改变/);
    store.runRecovery(run.id,'送达状态未知');store.runRecovery(run.id,'另一条晚到错误');
    assert.equal(store.heldRuns().length,1);assert.equal(store.getTask(task.id).status,'recovery');
    assert.equal(store.getRunInput(run.id).state,'unknown');
  }finally{store.close();}
});
test('manual native intervention invalidates candidate review and late reports',()=>{
  const store=new Store(':memory:');try {
    const {task,run}=entered(store);const report=store.workerReport(run.id,'tool',ready);store.settleRun(run.id);
    store.nativeIntervention(run.sessionId,'human-message');store.nativeIntervention(run.sessionId,'human-message');
    assert.equal(store.getTask(task.id).controlMode,'manual');assert.equal(store.getTask(task.id).lifecycle,'open');
    assert.throws(()=>store.acceptResult('accept',task.id,store.getTask(task.id).rowVersion,report.resultId!),/不能验收/);
    assert.throws(()=>store.workerReport(run.id,'late',ready),/执行或目标已改变/);
  }finally{store.close();}
});
test('stop request does not release resources until convergence and refuses late ready',()=>{
  const store=new Store(':memory:');try {
    const {task,run}=entered(store);const version=store.getTask(task.id).rowVersion;
    const receipt=store.requestStop('stop',task.id,version);assert.deepEqual(store.requestStop('stop',task.id,version),receipt);
    assert.equal(store.getTask(task.id).status,'stopping');assert.equal(store.heldRuns().length,1);
    assert.throws(()=>store.workerReport(run.id,'late-ready',ready),/执行或目标已改变/);
    store.settleCancelled(run.id);assert.equal(store.heldRuns().length,0);assert.equal(store.getRun(run.id).state,'cancelled');
    assert.equal(store.getTask(task.id).lifecycle,'open');assert.equal(store.getTask(task.id).controlMode,'paused');
    assert.equal(store.getRunInput(run.id).state,'entered');
  }finally{store.close();}
});
test('resuming management after native input cannot revive the previous run authority',()=>{
  const store=new Store(':memory:');try {
    const {task,run}=entered(store);store.workerReport(run.id,'ready-before-human',ready);
    assert.equal(store.nativeIntervention(run.sessionId,'native'),true);assert.equal(store.nativeIntervention(run.sessionId,'native'),false);
    store.controlTask('resume',task.id,store.getTask(task.id).rowVersion,'auto');
    store.settleRun(run.id);
    assert.equal(store.getTask(task.id).lifecycle,'open');assert.equal(store.getRun(run.id).state,'interrupted');
    assert.equal(store.heldRuns().length,1);
    assert.throws(()=>store.workerReport(run.id,'late',ready),/执行或目标已改变/);
  }finally{store.close();}
});
test('capacity and overlapping work directories reject additional dispatches',()=>{
  const store=new Store(':memory:');try {
    const one=prepared(store,'1','/tmp/shared');store.reserveRun('d1',one.id,one.rowVersion);
    const nested=prepared(store,'nested','/tmp/shared/child');assert.throws(()=>store.reserveRun('dn',nested.id,nested.rowVersion),/重叠/);
    const two=prepared(store,'2','/tmp/other');store.reserveRun('d2',two.id,two.rowVersion);
    const three=prepared(store,'3','/tmp/third');assert.throws(()=>store.reserveRun('d3',three.id,three.rowVersion),/名额已占用/);
  }finally{store.close();}
});
test('answer stays pending until its own message enters, and a cancelled answer reopens the question',()=>{
  const store=new Store(':memory:');try {
    const {task,run}=entered(store);store.workerReport(run.id,'ask',{kind:'waiting',summary:'面向谁？'});store.settleRun(run.id);
    const attention=store.taskDetail(task.id).attentions.find(a=>a.state==='open')!;
    const version=store.getTask(task.id).rowVersion;
    const answer=store.respondAttention('answer',attention.id,version,'面向新同事');
    assert.deepEqual(store.respondAttention('answer',attention.id,version,'面向新同事'),answer);
    assert.equal(store.taskDetail(task.id).attentions.find(a=>a.id===attention.id)?.state,'responding');
    assert.equal(answer.state,'accepted');
    const next=store.reserveRun('next',task.id,store.getTask(task.id).rowVersion);assert.equal(next.inputId,answer.id);
    store.saveRunMessage(next.id,'answer-message','{}');store.claimDispatch(next.id);store.inputEnqueued(next.id);
    store.requestStop('stop',task.id,store.getTask(task.id).rowVersion);store.settleCancelled(next.id);
    assert.equal(store.taskDetail(task.id).attentions.find(a=>a.id===attention.id)?.state,'open');
    assert.equal(store.getRunInput(next.id).state,'discarded');
    const again=store.respondAttention('answer-again',attention.id,store.getTask(task.id).rowVersion,'面向新同事');
    store.controlTask('resume',task.id,store.getTask(task.id).rowVersion,'auto');
    const final=store.reserveRun('final',task.id,store.getTask(task.id).rowVersion);assert.equal(final.inputId,again.id);
    store.saveRunMessage(final.id,'final-message','{}');store.claimDispatch(final.id);store.inputEntered(final.id,'final-message',25);
    assert.equal(store.taskDetail(task.id).attentions.find(a=>a.id===attention.id)?.state,'resolved');
  }finally{store.close();}
});
test('rework preserves task revision but invalidates old acceptance and uses a distinct run',()=>{
  const store=new Store(':memory:');try {
    const {task,run}=entered(store);const result=store.workerReport(run.id,'report',ready);store.settleRun(run.id);
    const revised=store.rejectResult('reject',task.id,store.getTask(task.id).rowVersion,result.resultId!,'补充一段解释');
    assert.equal(revised.lifecycle,'open');assert.equal(revised.taskRevision,task.taskRevision);
    assert.throws(()=>store.acceptResult('old',task.id,revised.rowVersion,result.resultId!),/不能验收/);
    const next=store.reserveRun('rework',task.id,revised.rowVersion);assert.notEqual(next.id,run.id);
    assert.equal(store.getRunInput(next.id).kind,'rework');assert.equal(store.getRunInput(next.id).content,'补充一段解释');
  }finally{store.close();}
});
test('evidence hashes detect changed content and outside symlink paths',async()=>{
  const root=mkdtempSync(join(tmpdir(),'super-bot-evidence-'));const outside=mkdtempSync(join(tmpdir(),'super-bot-outside-'));
  try {
    writeFileSync(join(root,'result.md'),'original');const evidence=await collectEvidence(root,['result.md']);await verifyEvidence(root,evidence);
    writeFileSync(join(root,'result.md'),'changed');await assert.rejects(verifyEvidence(root,evidence),/已经变化/);
    symlinkSync(outside,join(root,'escape'));assert.throws(()=>containedPath(root,'escape/new.md'),/专用工作目录/);
    assert.throws(()=>containedPath(root,'../escape.md'),/专用工作目录/);
    await assert.rejects(collectEvidence(root,[]),/1～10/);
  }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
