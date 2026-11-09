import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,symlinkSync,rmSync,truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { collectEvidence,verifyEvidence,containedPath,previewEvidence } from '../src/evidence.ts';

function prepared(store:Store,key='1',cwd=`/tmp/task-${key}`,reviewPolicy:'human'|'bot'='human') {
  const bot=store.createBot(`b:${key}`,{name:`Bot ${key}`,instructions:'文件工作'});
  const task=store.createTask(`t:${key}`,{botId:bot.id,goal:'写一个说明文件',scope:'任务目录',acceptance:'说明包含两项事实',reviewPolicy});
  const binding=store.beginBinding(`bnd:${key}`,task.id,1,cwd);store.claimBindingCreation(binding.id);store.confirmBinding(binding.id,binding.requestedSessionId);
  return store.getTask(task.id);
}
function entered(store:Store,key='1') {
  const task=prepared(store,key);const run=store.reserveRun(`dispatch:${key}`,task.id,task.rowVersion);
  store.saveRunMessage(run.id,`m:${key}`,JSON.stringify({id:`m:${key}`}));assert.equal(store.claimDispatch(run.id),true);
  store.inputEnqueued(run.id);store.inputEntered(run.id,`m:${key}`,15);return {task,run};
}
const ready={kind:'ready' as const,summary:'说明已生成',checks:'两项事实均在文档中',evidence:[{path:'/tmp/result.md',sha256:'synthetic',bytes:30}]};

test('evidence reads have hard byte limits and previews disclose truncation while verifying full hashes',async()=>{
  const root=mkdtempSync(join(tmpdir(),'super-bot-bounds-'));
  try {
    const path=join(root,'result.txt');writeFileSync(path,'a'.repeat(15000));
    const evidence=await collectEvidence(root,[path]);const preview=await previewEvidence(root,evidence);
    assert.equal(preview[0]?.text.length,12000);assert.equal(preview[0]?.bytes,15000);assert.equal(preview[0]?.truncated,true);
    writeFileSync(path,'a'.repeat(14999)+'b');await assert.rejects(previewEvidence(root,evidence),/已经变化/);
    truncateSync(path,10*1024*1024+1);await assert.rejects(collectEvidence(root,[path]),/不超过/);
    rmSync(path);await assert.rejects(verifyEvidence(root,evidence),/无法读取/);
    const second=join(root,'second.txt'),third=join(root,'third.txt');
    for(const file of [path,second]){writeFileSync(file,'');truncateSync(file,10*1024*1024);}
    writeFileSync(third,'x');await assert.rejects(collectEvidence(root,[path,second,third]),/不超过/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('native approval decisions resolve only their attention and never imply execution completion',()=>{
  const store=new Store(':memory:');try {
    const {task,run}=entered(store);
    store.nativeApprovalAsked(run.id,'approval-1','write','Synthetic write');store.nativeApprovalAsked(run.id,'approval-1','write','Synthetic write');
    assert.equal(store.getTask(task.id).status,'approval');assert.equal(store.heldRuns().length,1);
    store.workerReport(run.id,'ready',ready);assert.throws(()=>store.settleRun(run.id),/原生审批/);
    store.nativeApprovalDecided('other-session','approval-1','allowed-once');assert.equal(store.getTask(task.id).status,'approval');
    store.nativeApprovalDecided(run.sessionId,'approval-1','rejected');store.nativeApprovalDecided(run.sessionId,'approval-1','rejected');
    assert.equal(store.getTask(task.id).status,'running');assert.equal(store.heldRuns().length,1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='approval.decided'").get()?.n,1);
    assert.equal(store.getTask(task.id).lifecycle,'open');
    store.nativeApprovalAsked(run.id,'approval-2','write','Another request');
    store.runRecovery(run.id,'Host restarted');assert.equal(store.taskDetail(task.id).attentions.find(a=>a.id==='approval:approval-2')?.state,'stale');
    assert.equal(store.getTask(task.id).status,'recovery');assert.equal(store.heldRuns().length,1);
  }finally{store.close();}
});

test('cancelling settled work discards pending answers without accepting results or deleting history',()=>{
  const store=new Store(':memory:');try {
    const {task,run}=entered(store);store.workerReport(run.id,'ask',{kind:'waiting',summary:'还需要什么？'});store.settleRun(run.id);
    const attention=store.taskDetail(task.id).attentions.find(a=>a.state==='open')!;
    const answer=store.respondAttention('answer',attention.id,store.getTask(task.id).rowVersion,'不再继续');
    const version=store.getTask(task.id).rowVersion;const cancelled=store.cancelTask('cancel',task.id,version);
    assert.equal(cancelled.lifecycle,'cancelled');assert.equal(store.cancelTask('cancel',task.id,version).id,task.id);
    assert.equal(store.db.prepare('SELECT state FROM inputs WHERE id=?').get(answer.id)?.state,'discarded');
    assert.equal(store.taskDetail(task.id).attentions.filter(a=>['open','responding'].includes(a.state)).length,0);
    assert.equal(store.activeBinding(task.id)?.sessionId,run.sessionId);assert.equal(store.getRun(run.id).state,'settled');
    assert.throws(()=>store.reserveRun('late-dispatch',task.id,cancelled.rowVersion));
  }finally{store.close();}
});
test('cancel and detach refuse live or uncertain resource ownership',()=>{
  const store=new Store(':memory:');try {
    const {task,run}=entered(store);
    assert.throws(()=>store.cancelTask('cancel',task.id,store.getTask(task.id).rowVersion),/停止执行/);
    assert.throws(()=>store.detachSession('detach',task.id,store.getTask(task.id).rowVersion),/停止执行/);
    store.runRecovery(run.id,'receipt unknown');
    assert.throws(()=>store.cancelTask('cancel',task.id,store.getTask(task.id).rowVersion),/停止执行/);
    assert.throws(()=>store.detachSession('detach',task.id,store.getTask(task.id).rowVersion),/停止执行/);
    assert.equal(store.heldRuns().length,1);assert.equal(store.getTask(task.id).lifecycle,'open');
    store.resolveRunRecovery('recover',task.id,store.getTask(task.id).rowVersion);
    assert.equal(store.cancelTask('cancel',task.id,store.getTask(task.id).rowVersion).lifecycle,'cancelled');
  }finally{store.close();}
});
test('detach preserves binding history, pauses work, and allows a new goal and generation',()=>{
  const store=new Store(':memory:');try {
    const task=prepared(store);const old=store.activeBinding(task.id)!;
    const detached=store.detachSession('detach',task.id,task.rowVersion);
    assert.equal(detached.sessionId,null);assert.equal(detached.controlMode,'paused');assert.equal(store.activeBinding(task.id),null);
    assert.equal(store.detachSession('detach',task.id,task.rowVersion).id,task.id);
    assert.equal(store.taskDetail(task.id).bindingHistory[0]?.sessionId,old.sessionId);
    assert.equal(store.bindingReceipt('bnd:1',task.id,1)?.state,'released');
    const revised=store.reviseTask('revise',task.id,detached.rowVersion,{goal:'新的说明目标',scope:'新的专用目录',acceptance:'新内容'});
    assert.equal(revised.taskRevision,2);
    const replacement=store.beginBinding('replace',task.id,revised.rowVersion,'/tmp/new-generation');
    assert.equal(replacement.generation,2);assert.notEqual(replacement.requestedSessionId,old.sessionId);
    assert.equal(store.getBinding(old.id).state,'released');
    assert.equal(store.nativeIntervention(old.sessionId!,'old-message'),false);
  }finally{store.close();}
});
test('a replacement binding never presents an old result as its current candidate',()=>{
  const store=new Store(':memory:');try {
    const {task,run}=entered(store);const report=store.workerReport(run.id,'ready',ready);store.settleRun(run.id);
    const rejected=store.rejectResult('rework',task.id,store.getTask(task.id).rowVersion,report.resultId!,'Change the goal first');
    const detached=store.detachSession('detach',task.id,rejected.rowVersion);
    assert.equal(store.taskDetail(task.id).result,null);assert.equal(store.runResult(run.id)?.id,report.resultId);
    const manager=store.beginManager('manager',task.botId,'/tmp/manager');store.confirmManager(manager.id,manager.requestedSessionId);
    const revised=store.reviseTask('revise',task.id,detached.rowVersion,{goal:'New goal',scope:'New directory',acceptance:'New result'});
    assert.ok(store.pendingManagerEvents(task.botId).some(event=>event.id.includes(`revision:${task.id}:2`)));
    const next=store.beginBinding('prepare-new',task.id,revised.rowVersion,'/tmp/new-task');store.confirmBinding(next.id,next.requestedSessionId);
    assert.equal(store.taskDetail(task.id).result,null);assert.equal(store.pendingInput(task.id),null);
    assert.throws(()=>store.workerReport(run.id,'late-old-revision',ready),/执行或目标已改变/);
  }finally{store.close();}
});

test('existing Session attachment requires both grants, pauses atomically, and cannot cross identities',()=>{
  const store=new Store(':memory:');try {
    const bot=store.createBot('bot',{name:'Existing Session Bot',instructions:'File tasks'});
    const task=store.createTask('task',{botId:bot.id,goal:'Continue existing work',scope:'Explicit directory',acceptance:'Read result',reviewPolicy:'human'});
    const grant={taskId:task.id,expectedRowVersion:task.rowVersion,sessionId:'existing-session',cwd:'/tmp/existing-session',fullHistoryApproved:true,directoryApproved:true};
    assert.throws(()=>store.attachExistingSession('missing-history',{...grant,fullHistoryApproved:false}),/明确授权/);
    assert.throws(()=>store.attachExistingSession('missing-directory',{...grant,directoryApproved:false}),/明确授权/);
    assert.throws(()=>store.attachExistingSession('stale',{...grant,expectedRowVersion:0}),/已经更新/);
    store.db.exec("CREATE TRIGGER reject_attach BEFORE INSERT ON events WHEN NEW.kind='session.attached' BEGIN SELECT RAISE(ABORT,'attach fault'); END");
    assert.throws(()=>store.attachExistingSession('attach',grant),/attach fault/);assert.equal(store.activeBinding(task.id),null);assert.equal(store.getTask(task.id).rowVersion,1);
    store.db.exec('DROP TRIGGER reject_attach');
    const binding=store.attachExistingSession('attach',grant);assert.deepEqual(store.attachExistingSession('attach',grant),binding);
    assert.equal(store.getTask(task.id).status,'paused');assert.equal(store.latestRun(task.id),null);
    const event=store.taskDetail(task.id).events.find(event=>event.kind==='session.attached')!;assert.equal(JSON.parse(event.data).history,'entire-session');
    const otherBot=store.createBot('other',{name:'Other Bot',instructions:'Other work'});
    const other=store.createTask('other-task',{botId:otherBot.id,goal:'Other task',scope:'Own files',acceptance:'Read result',reviewPolicy:'human'});
    assert.throws(()=>store.attachExistingSession('steal',{...grant,taskId:other.id}),/已用于/);
    store.detachSession('detach',task.id,store.getTask(task.id).rowVersion);
    assert.throws(()=>store.attachExistingSession('steal-history',{...grant,taskId:other.id}),/已用于/);
    const manager=store.beginManager('manager',otherBot.id,'/tmp/existing-manager');store.confirmManager(manager.id,manager.requestedSessionId);
    assert.throws(()=>store.attachExistingSession('manager-as-worker',{...grant,taskId:other.id,sessionId:manager.requestedSessionId}),/已用于/);
  }finally{store.close();}
});

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
    assert.throws(()=>store.workerReport(run.id,'late',ready),/执行或目标已改变/);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='work.report-stale' AND taskId=?").get(task.id)?.n,1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM results WHERE taskId=?').get(task.id)?.n,1);
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
test('manager binding is durable, its wake is claimed once, and another bot cannot review its result',()=>{
  const store=new Store(':memory:');try {
    const {task,run}=entered(store);const manager=store.beginManager('manager',task.botId,'/tmp/manager');
    assert.deepEqual(store.beginManager('manager',task.botId,'/tmp/manager'),manager);
    assert.equal(store.claimManagerCreation(manager.id),true);assert.equal(store.claimManagerCreation(manager.id),false);
    store.confirmManager(manager.id,manager.requestedSessionId);
    store.enqueueManager(task.botId,'synthetic-notify','Synthetic event',task.id);
    const event=store.pendingManagerEvents(task.botId)[0];assert.ok(event);
    assert.equal(store.claimManagerEvent(event.id,'wake','{}'),true);assert.equal(store.claimManagerEvent(event.id,'wake','{}'),false);
    assert.equal(store.managerWakeCount(task.botId,Date.now()-10000),1);
    store.managerEventEntered(event.id,'wrong');assert.equal(store.managerInfo(task.botId).uncertain,0);
    store.managerEventUnknown(event.id);assert.equal(store.managerInfo(task.botId).uncertain,1);
    const result=store.workerReport(run.id,'report',ready);store.settleRun(run.id);
    assert.throws(()=>store.managerReview('foreign','other-bot',task.id,store.getTask(task.id).rowVersion,result.resultId!,'accept','looks good'),/自己负责/);
    const reviewed=store.managerReview('review',task.botId,task.id,store.getTask(task.id).rowVersion,result.resultId!,'accept','read and verified');
    assert.equal(reviewed.lifecycle,'review');assert.equal(store.runResult(run.id)?.humanAcceptedAt,null);
  }finally{store.close();}
});
test('manager queue counts all work, prioritizes human responses, and rotates between bots',()=>{
  const store=new Store(':memory:');try {
    const bots=['one','two','three'].map(key=>store.createBot(key,{name:key,instructions:'Synthetic'}));
    for(const bot of bots){const m=store.beginManager(`m:${bot.id}`,bot.id,`/tmp/${bot.id}`);store.confirmManager(m.id,m.requestedSessionId);assert.equal(store.managerInfo(bot.id).pending,0);store.enqueueManager(bot.id,`synthetic:${bot.id}`,'Synthetic event',null);}
    const [first,...others]=store.listBots();assert.ok(first);
    for(let n=0;n<25;n++)store.enqueueManager(first.id,`bulk:${n}`,'New task',null);
    store.enqueueManager(first.id,'human-answer','Human answer',null,10);
    assert.equal(store.managerInfo(first.id).pending,27);assert.equal(store.pendingManagerEvents(first.id).length,10);
    assert.equal(store.pendingManagerEvents(first.id)[0]?.id,'manager-event:human-answer');
    store.claimManagerEvent('manager-event:human-answer','msg','{}');
    assert.deepEqual(store.managerOrder().map(bot=>bot.id),[...others.map(bot=>bot.id),first.id]);
    store.db.exec("CREATE TEMP TRIGGER cursor_failure BEFORE INSERT ON metadata WHEN NEW.key='managerCursor' BEGIN SELECT RAISE(ABORT,'injected cursor failure'); END");
    const secondEvent=store.pendingManagerEvents(others[0]!.id)[0]!;
    assert.throws(()=>store.claimManagerEvent(secondEvent.id,'failed-msg','{}'),/cursor failure/);
    assert.equal(store.pendingManagerEvents(others[0]!.id)[0]?.state,'pending');assert.equal(store.managerWakeCount(others[0]!.id,0),0);
    store.managerProblem(first.id,'Unavailable');const original=store.managerInfo(first.id).problem;
    store.managerProblem(first.id,'Unavailable');assert.deepEqual(store.managerInfo(first.id).problem,original);
    store.managerProblem(first.id,'');assert.equal(store.managerInfo(first.id).problem,null);
    assert.equal(store.managerInfo(first.id).pending,26);
  }finally{store.close();}
});
test('manager automatic rework is capped at two and authorized acceptance never impersonates a human',()=>{
  const store=new Store(':memory:');try {
    const task=prepared(store,'auto','/tmp/auto','bot');
    for(let i=0;i<3;i++) {
      const run=store.reserveRun(`run-${i}`,task.id,store.getTask(task.id).rowVersion);
      store.saveRunMessage(run.id,`msg-${i}`,'{}');store.claimDispatch(run.id);store.inputEntered(run.id,`msg-${i}`,i);
      const report=store.workerReport(run.id,`report-${i}`,ready);store.settleRun(run.id);
      const reviewed=store.managerReview(`review-${i}`,task.botId,task.id,store.getTask(task.id).rowVersion,report.resultId!,'rework','补充事实出处');
      assert.equal(reviewed.lifecycle,i<2?'open':'review');
    }
    assert.match(store.taskDetail(task.id).attentions.find(a=>a.state==='open')!.question,/已达 2 次/);
    const result=store.taskDetail(task.id).result!;
    assert.throws(()=>store.managerReview('after-cap',task.botId,task.id,store.getTask(task.id).rowVersion,result.id,'accept','又觉得可以'),/管理判断未应用/);
    const auto=prepared(store,'authorized','/tmp/authorized','bot');const attempt=store.reserveRun('authorized-run',auto.id,auto.rowVersion);
    store.saveRunMessage(attempt.id,'auto-msg','{}');store.claimDispatch(attempt.id);store.inputEntered(attempt.id,'auto-msg',1);
    const candidate=store.workerReport(attempt.id,'auto-report',ready);store.settleRun(attempt.id);
    const accepted=store.managerReview('auto-accept',auto.botId,auto.id,store.getTask(auto.id).rowVersion,candidate.resultId!,'accept','已核对全部验收条件');
    assert.equal(accepted.lifecycle,'completed');assert.equal(store.taskDetail(task.id).result!.humanAcceptedAt,null);
  }finally{store.close();}
});
test('replacing a manager keeps tasks and immediately revokes the previous session',()=>{
  const store=new Store(':memory:');try {
    const task=prepared(store);const first=store.beginManager('first',task.botId,'/tmp/manager');store.confirmManager(first.id,first.requestedSessionId);
    const old=store.releaseManager('replace',task.botId,first.generation);assert.equal(old.id,first.id);
    assert.equal(store.managerForSession(first.requestedSessionId),null);assert.equal(store.getTask(task.id).goal,task.goal);
    const next=store.beginManager('next',task.botId,'/tmp/manager');assert.equal(next.generation,2);
    store.confirmManager(next.id,next.requestedSessionId);
    assert.equal(store.getBot(task.botId).managerSessionId,next.requestedSessionId);
    assert.throws(()=>store.releaseManager('stale',task.botId,1),/已经改变/);
  }finally{store.close();}
});

test('restarting and replacing Manager cannot reset automatic rework allowance',()=>{
  const directory=mkdtempSync(join(tmpdir(),'super-bot-rework-')),file=join(directory,'ledger.sqlite');let store=new Store(file);
  try {
    const task=prepared(store,'persisted-rework',join(directory,'work'),'bot');
    for(let round=0;round<3;round++) {
      const previous=store.activeManager(task.botId);if(previous)store.releaseManager(`replace-${round}`,task.botId,previous.generation);
      const manager=store.beginManager(`manager-${round}`,task.botId,join(directory,'manager'));store.confirmManager(manager.id,manager.requestedSessionId);
      const run=store.reserveRun(`run-${round}`,task.id,store.getTask(task.id).rowVersion);
      store.saveRunMessage(run.id,`message-${round}`,'{}');store.claimDispatch(run.id);store.inputEntered(run.id,`message-${round}`,round);
      const report=store.workerReport(run.id,`report-${round}`,ready);store.settleRun(run.id);
      store.managerReview(`review-${round}`,task.botId,task.id,store.getTask(task.id).rowVersion,report.resultId!,'rework','请补充证据');
      store.close();store=new Store(file);
      assert.equal(store.getTask(task.id).lifecycle,round<2?'open':'review');
      assert.equal(store.getTask(task.id).controlMode,round<2?'auto':'paused');
    }
    assert.match(store.taskDetail(task.id).attentions.find(a=>a.state==='open')!.question,/已达 2 次/);
    assert.throws(()=>store.reserveRun('extra-run',task.id,store.getTask(task.id).rowVersion),/暂停|自动/);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('enabling a Manager queues each eligible existing task without duplicating pending responsibility',()=>{
  const store=new Store(':memory:');try {
    const bot=store.createBot('bot',{name:'Existing backlog',instructions:'Own files'});
    const tasks=Array.from({length:4},(_,n)=>store.createTask(`task-${n}`,{botId:bot.id,goal:`Existing task ${n}`,scope:'Own directory',acceptance:'Read result',reviewPolicy:'human',startPaused:n===3}));
    const manager=store.beginManager('manager',bot.id,'/tmp/backlog-manager');store.confirmManager(manager.id,manager.requestedSessionId);
    assert.equal(store.managerInfo(bot.id).pending,3);assert.deepEqual(new Set(store.pendingManagerEvents(bot.id).map(event=>event.taskId)),new Set(tasks.slice(0,3).map(task=>task.id)));
    store.releaseManager('replace',bot.id,manager.generation);const replacement=store.beginManager('replacement',bot.id,'/tmp/backlog-manager');store.confirmManager(replacement.id,replacement.requestedSessionId);
    assert.equal(store.managerInfo(bot.id).pending,3);
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


test('run budgets persist the reason, retain ownership until stopped, and require explicit recovery',()=>{
  const store=new Store(':memory:');try {
    const {task,run}=entered(store);
    assert.equal(store.recordRunBudget(run.id,'steps'),true);assert.equal(store.recordRunBudget(run.id,'steps'),true);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='run.budget-reached'").get()?.n,1);
    store.requestStop('budget-stop',task.id,store.getTask(task.id).rowVersion);
    assert.equal(store.recordRunBudget(run.id,'time'),false);assert.equal(store.heldRuns().length,1);
    assert.equal(store.getTask(task.id).status,'stopping');
    store.settleCancelled(run.id);assert.equal(store.heldRuns().length,0);assert.equal(store.getTask(task.id).status,'recovery');
    assert.match(store.getRun(run.id).note,/40 步/);assert.equal(store.recordRunBudget(run.id,'steps'),false);
    const paused=store.resolveRunRecovery('recover',task.id,store.getTask(task.id).rowVersion);
    assert.equal(paused.status,'paused');assert.throws(()=>store.reserveRun('no-auto-retry',task.id,paused.rowVersion),/不能自动执行/);
  }finally{store.close();}
});

test('directory overlap includes the filesystem root in either acquisition order',()=>{
  for(const [first,second] of [['/','/tmp/project'],['/tmp/project','/'],['/tmp/project','/tmp/project/nested']]) {
    const store=new Store(':memory:');try {
      const a=prepared(store,'a',first),b=prepared(store,'b',second);store.reserveRun('run-a',a.id,a.rowVersion);
      assert.throws(()=>store.reserveRun('run-b',b.id,b.rowVersion),/目录.*重叠/);assert.equal(store.latestRun(b.id),null);
    }finally{store.close();}
  }
});

test('maxRunningTasks bounds global execution slots',()=>{
  const directory=mkdtempSync(join(tmpdir(),'super-bot-slots-'));const store=new Store(join(directory,'ledger.sqlite'));
  try {
    store.maxRunningTasks=1;
    const one=prepared(store,'slot-1','/tmp/slot-1'),two=prepared(store,'slot-2','/tmp/slot-2');
    store.reserveRun('slot-run-1',one.id,one.rowVersion);
    assert.equal(store.dispatchBlocker(two.id),'capacity');assert.throws(()=>store.reserveRun('slot-run-2',two.id,two.rowVersion),{code:'capacity'});
    store.maxRunningTasks=2;assert.equal(store.dispatchBlocker(two.id),null);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
