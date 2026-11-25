import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test,type TestContext} from 'node:test';
import type {Context} from '@deepseek-ai/cordis';
import type {UserMessage} from '@deepseek-ai/dsh-llm';
import {Store} from '../../src/store.ts';
import {DshExecution} from '../../src/dsh.ts';
import {inspectPriorTools,type ClusterProbe,type ProbeResult,type ReadQueryReceipt} from '../../src/read-only-recovery.ts';
import {parseClusterProbe,prepareClusterProbe} from '../../src/kubernetes-preflight.ts';
import {GIT_STATUS_QUERY,WORKER_QUERY_TOOL,gitWorkingTreeStatus} from '../../src/git-status-query.ts';
import type {RunEvent} from '../../src/run-proof.ts';

const signal=new AbortController().signal;
function fixture(t:TestContext,cluster?:{probe:ClusterProbe;auth:string;result:ProbeResult},state:'settled'|'interrupted'|'running'='settled') {
  const cwd=mkdtempSync(join(realpathSync(tmpdir()),'sb-verified-recovery-'));
  let store=new Store(join(cwd,'ledger.sqlite'));
  t.after(()=>{store.close();rmSync(cwd,{recursive:true,force:true});});
  const reopen=()=>{
    store.close();
    store=new Store(join(cwd,'ledger.sqlite'));
    return store;
  };
  const bot=store.createBot('bot',{name:'Recovery',instructions:'Synthetic'});
  const manager=store.beginManager('manager',bot.id,cwd);
  store.confirmManager(manager.id,manager.requestedSessionId);
  const task=store.createTask('task',{botId:bot.id,goal:'Verify a file',scope:'Read the bounded file',acceptance:'Report readable',reviewPolicy:'human'});
  const binding=store.beginBinding('binding',task.id,task.rowVersion,cwd);
  store.confirmBinding(binding.id,binding.requestedSessionId);
  const run=store.reserveRun('reserve',task.id,store.getTask(task.id).rowVersion);
  const automatic={id:'automated',source:{kind:'super-bot',runId:run.id,inputId:run.inputId,taskId:task.id,
    generation:run.generation,taskRevision:run.taskRevision}};
  store.saveRunMessage(run.id,automatic.id,JSON.stringify(automatic));
  store.claimDispatch(run.id);
  store.inputEnqueued(run.id);
  store.inputEntered(run.id,automatic.id,1);
  store.associateRunTurn(run.id,1,0,1);
  const endKind=state==='interrupted'?'error':'completed';
  if(state!=='running') {
    store.workerReport(run.id,'blocked',{kind:'blocked',summary:'File unavailable',checks:'Native read could not find it'});
    if(cluster)store.recordPreflightReceipt(run.id,'read',cluster.probe,cluster.auth,cluster.result);
    store.observeRunEnd(run.id,cluster?6:5,endKind,true);
    if(state==='interrupted')store.runRecovery(run.id,'Lost process handle after observed end.');
    else store.settleRun(run.id);
  }
  const path=join(cwd,'fixture.txt');
  const args={file_path:path,offset:3,limit:4};
  const events:RunEvent[]=[
    {seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'user/message',surfaceOp:'append',data:automatic},
    {seq:2,type:'user/message',surfaceOp:'append',data:{source:{kind:'runtime-context',form:'snapshot'}}},
    {seq:3,type:'tool/call',data:{turn:1,step:2,callId:'read',name:'read',arguments:JSON.stringify(args)}},
    {seq:4,type:'tool/result',data:{turn:1,step:2,message:{toolCallId:'read',isError:true},
      error:{code:'FS_NOT_FOUND',reason:'file not found'}}},
    {seq:5,type:'turn/end',data:{turn:1,reason:{kind:endKind}}},
  ];
  if(cluster) {
    events[3]!.data.name='super_bot_preflight';
    events[3]!.data.arguments=JSON.stringify(cluster.probe);
    events[4]!.data={turn:1,step:2,message:{toolCallId:'read',isError:false,content:[{type:'text',text:JSON.stringify(cluster.result)}]}};
    const end=events.pop()!;
    events.push({seq:5,type:'tool/call',data:{turn:1,step:3,callId:'possible-write',name:'bash',arguments:'{}'}});
    events.push({...end,seq:6});
  }
  const session={id:run.sessionId,deriveMessages:()=>[]};
  const jobs:{id:string;owner:string;status:string}[]=[];
  const inbox={nextTurn:[] as object[],nextStep:[] as object[]};
  const sent:UserMessage[]=[];
  const guards:((exec:{name:string;arguments?:unknown})=>string|undefined)[]=[];
  const agent={id:run.sessionId,session,status:'idle',inbox,
    ctx:{on:()=>()=>{},tools:{restrict:()=>()=>{},guard:(guard:typeof guards[number])=>{guards.push(guard);return ()=>{};}}},
    followup:(message:UserMessage)=>{sent.push(message);},whenIdle:()=>new Promise(()=>{})};
  const options={nativeCode:'',beforeResolve:async()=>{},beforeRead:async()=>{}};
  let calls=0;
  const execution=(ledger=store)=>new DshExecution({
    workingDirectory:{get:()=>cwd},jobs:{list:()=>jobs},agents:{get:()=>agent,list:()=>[agent]},
    permissionPresets:{set:()=>{}},sessionProjections:{snapshot:()=>({values:{modelSelection:{next:{provider:'fixture',model:'fixture'}}}})},
    sessions:{flush:async()=>true},
    sessionPersistence:{open:async()=>({header:session,read:async()=>({events:structuredClone(events)}),close:async()=>{}})},
    sessionController:{resolveAgent:async()=>{await options.beforeResolve();return {agent};}},
    effect:()=>{},on:()=>()=>{},
    tools:{execute:async(request:any)=>{
      assert.equal(request.agent,agent);
      assert.equal(request.calls.length,1);
      const [call]=request.calls;
      assert.equal(call.name,'read');
      assert.deepEqual(JSON.parse(call.arguments),args);
      calls++;
      await options.beforeRead();
      return {results:[{callId:call.id,result:options.nativeCode?
        {isError:true,error:{info:{code:options.nativeCode}}}:
        {isError:false,value:{path,offset:3,lines:[{number:3,text:'evidence'}]},content:[{type:'text',text:'evidence'}]}}]};
    }},
  } as unknown as Context,ledger,cwd,{fullAccess:!!cluster});
  const id=task.id,version=store.getTask(id).rowVersion;
  return {store,reopen,cwd,task,run,manager,version,args,events,jobs,inbox,options,calls:()=>calls,execution,sent,guards,
    inspect:(e=execution())=>e.inspectAutoRecovery(id,version,run.id,manager.id,()=>{}),
    perform:(e=execution())=>e.performAutoRecovery(id,version,run.id,manager.id,signal,()=>{}),
  };
}

test('same native read and exact range run once, including across adapter restart',async t=>{
  const f=fixture(t);
  const inspection=await f.inspect();
  assert.equal(inspection.status,'eligible');
  assert.equal(f.calls(),0);
  const performed=await f.perform();
  assert.equal(performed.status,'readable');
  assert.equal('excerpt' in performed&&performed.excerpt,'evidence');
  assert.equal(f.calls(),1);
  assert.equal(f.store.taskDetail(f.task.id).run?.id,f.run.id);
  assert.equal(f.store.getTask(f.task.id).controlMode,'auto');
  assert.equal(f.store.getRun(f.run.id).state,'failed');
  assert.equal((await f.perform()).status,'already-checked');
  assert.equal(f.calls(),1);
  const audit=f.store.taskDetail(f.task.id).events.find(event=>event.kind==='run.recovery-confirmed');
  assert.equal(audit&&JSON.parse(audit.data).actor,'manager');
});

for(const block of ['unknown-call','pending-job','pending-input','new-native-turn','human-pause','claim-without-receipt'] as const) {
  test(`automatic recovery retains the old attention for ${block}`,async t=>{
    const f=fixture(t);
    if(block==='unknown-call')f.events[3]!.data.name='bash';
    if(block==='pending-job')f.jobs.push({id:'job',owner:f.run.sessionId,status:'running'});
    if(block==='pending-input')f.inbox.nextTurn.push({});
    if(block==='new-native-turn')f.events.push({seq:6,type:'turn/start',data:{turn:2}});
    if(block==='human-pause')f.options.beforeResolve=async()=>{f.store.controlTask('pause',f.task.id,f.version,'paused');};
    if(block==='claim-without-receipt') {
      const inspected=inspectPriorTools(f.events,f.store.taskDetail(f.task.id).binding!.cwd,1,0,5);
      assert.equal(f.store.claimRecoveryCheck(f.task.id,f.run.id,f.manager.id,f.version,inspected.files[0]!.evidence),true);
    }
    assert.equal((await f.perform()).status,'needs-human');
    assert.equal(f.calls(),0);
    const detail=f.store.taskDetail(f.task.id);
    assert.equal(detail.task.status,block==='human-pause'?'paused':'blocked');
    assert.equal(detail.settledBlocker,'settled-failure');
    assert.ok(detail.attentions.some(item=>item.id===`run:${f.run.id}`&&item.state==='open'));
  });
}

test('same read target deduplicates to the last durable result and a later success clears old failure',t=>{
  const f=fixture(t),cwd=f.store.taskDetail(f.task.id).binding!.cwd;
  const [, , ,original,failed, end]=f.events;
  const again={...original!,seq:5,data:{...original!.data,callId:'again'}};
  const retryResult={...failed!,seq:6,data:{...failed!.data,message:{...failed!.data.message,toolCallId:'again'}}};
  const timeline=[...f.events.slice(0,-1),again,retryResult,{...end!,seq:7}];
  const last=inspectPriorTools(timeline,cwd,1,0,7);
  assert.equal(last.files.length,1);
  assert.equal(last.files[0]!.evidence.callId,'again');
  retryResult.data.message.isError=false;
  assert.deepEqual(inspectPriorTools(timeline,cwd,1,0,7).files,[]);
});

test('real permission statuses do not imply task success or a second check',async t=>{
  const f=fixture(t);
  f.options.nativeCode='FS_PERMISSION_DENIED';
  assert.equal((await f.perform()).status,'denied');
  assert.equal(f.store.getTask(f.task.id).status,'blocked');
  assert.equal(f.store.getTask(f.task.id).controlMode,'auto');
  assert.equal(f.store.getRun(f.run.id).state,'failed');
  assert.equal((await f.perform()).status,'already-checked');
  assert.equal(f.calls(),1);
});

test('a task paused during a check does not publish a stale recovery receipt',async t=>{
  const f=fixture(t);
  f.options.beforeRead=async()=>{f.store.controlTask('pause-during-check',f.task.id,f.version,'paused');};
  await assert.rejects(f.perform(),/任务已经更新/);
  assert.equal(f.calls(),1);
  assert.equal(f.store.getTask(f.task.id).controlMode,'paused');
  assert.equal(f.store.recoveryCheck(f.run.id)?.resolution,undefined);
  assert.equal((await f.perform()).status,'needs-human');
  assert.equal(f.calls(),1);
});

test('unavailable exact read records uncertainty and never clears recovery',async t=>{
  const f=fixture(t);
  f.options.nativeCode='ABORTED';
  assert.equal((await f.perform()).status,'unavailable');
  const detail=f.store.taskDetail(f.task.id);
  assert.equal(detail.task.status,'blocked');
  assert.equal(detail.settledBlocker,'settled-failure');
  assert.ok(detail.events.some(event=>event.kind==='run.recovery-observed'));
  assert.equal((await f.perform()).status,'already-checked');
  assert.equal(f.calls(),1);
});

function fakeCluster(t:TestContext) {
  const cwd=mkdtempSync(join(realpathSync(tmpdir()),'sb-kube-preflight-'));
  const binary=join(cwd,'kubectl'),path=process.env.PATH;
  t.after(()=>{
    if(path===undefined)delete process.env.PATH;
    else process.env.PATH=path;
    rmSync(cwd,{recursive:true,force:true});
  });
  process.env.PATH=[cwd,path].filter(Boolean).join(':');
  const commands=join(cwd,'commands'),state=join(cwd,'resource-state');
  const kubectl=(server:string)=>`#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commands)},JSON.stringify(args)+'\\n');
if(args[0]==='config') {
  console.log(JSON.stringify({'current-context':'fixture',contexts:[{name:'fixture',context:{cluster:'fixture',user:'fixture'}}],
    clusters:[{name:'fixture',cluster:{server:${JSON.stringify(server)}}}],users:[{name:'fixture',user:{token:'synthetic-static'}}]}));
} else if(args.includes('whoami')) {
  fs.readFileSync(0);
  console.log(JSON.stringify({status:{userInfo:{username:'system:serviceaccount:fixture:shared'}}}));
} else if(args.includes('can-i')) {
  fs.readFileSync(0);
  console.log('no - fixture decision');
  process.exitCode=1;
} else if(args.includes('get')) {
  fs.readFileSync(0);
  if(fs.existsSync(${JSON.stringify(state)}))console.log(fs.readFileSync(${JSON.stringify(state)},'utf8'));
} else process.exitCode=7;
`;
  const configure=(server:string)=>writeFileSync(binary,kubectl(server),{mode:0o700});
  configure('https://synthetic.invalid');
  return {configure,state,commands:()=>readFileSync(commands,'utf8').trim().split('\n').map(line=>JSON.parse(line) as string[])};
}

test('structured Kubernetes probe reports denial with a reason and checks route before contacting a new server',async t=>{
  const cluster=fakeCluster(t);
  const probe=parseClusterProbe({kind:'permission',context:'fixture',namespace:'fixture',name:'claim',verb:'get',resource:'persistentvolumeclaims'});
  assert.throws(()=>parseClusterProbe({...probe,context:'fixture; touch x'}),/kubectl context/);
  assert.throws(()=>parseClusterProbe({...probe,impersonate:'another'}),/结构化/);
  const scoped=await prepareClusterProbe(probe,signal);
  const denied=await scoped.check();
  assert.equal(denied.status,'denied');
  assert.match(denied.message,/system:serviceaccount:fixture:shared.+get persistentvolumeclaims\/claim/);
  cluster.configure('https://replacement.invalid');
  await assert.rejects(prepareClusterProbe(probe,signal,scoped.auth),/配置已改变/);
  const seen=cluster.commands();
  assert.equal(seen.filter(args=>args.includes('whoami')).length,1);
  assert.equal(seen.filter(args=>args.includes('can-i')).length,1);
});

test('readback with a lost write receipt verifies the same resource once and retains the uncertainty',async t=>{
  const cluster=fakeCluster(t);
  const probe=parseClusterProbe({kind:'deployment-state',context:'fixture',namespace:'fixture',name:'demo'});
  const original=await prepareClusterProbe(probe,signal);
  const result=await original.check();
  assert.equal(result.status,'missing');
  const f=fixture(t,{probe,auth:original.auth,result});
  writeFileSync(cluster.state,JSON.stringify({kind:'Deployment',
    metadata:{namespace:'fixture',name:'demo',uid:'synthetic-uid',generation:2},
    spec:{replicas:1,template:{spec:{containers:[{name:'fixture-worker',image:'registry.example/worker:old'},
      {name:'invalid',image:'unexpected\ntext'}]}}},
    status:{observedGeneration:2,replicas:1,readyReplicas:1,updatedReplicas:0,availableReplicas:1}}));
  const inspection=await f.inspect();
  assert.equal(inspection.status,'eligible');
  assert.ok('effectUncertain' in inspection&&inspection.effectUncertain);
  assert.ok('priorTools' in inspection&&(inspection.priorTools as {tool:string;result:string}[]).some(
    entry=>entry.tool==='bash'&&entry.result==='missing'));
  const checked=await f.perform();
  assert.equal(checked.status,'present');
  assert.deepEqual('observed' in checked&&checked.observed,{uid:'synthetic-uid',ready:false,
    deploymentImages:[{container:'fixture-worker',image:'registry.example/worker:old'}]},
    'one ready old replica does not prove the current rollout is ready');
  assert.ok('message' in checked);
  assert.match(checked.message,/部署规格镜像 fixture-worker=registry.example\/worker:old/);
  assert.equal(f.store.getTask(f.task.id).status,'blocked');
  assert.equal(f.store.recoveryCheck(f.run.id)?.effectUncertain,true);
  assert.equal((await f.perform()).status,'already-checked');
  assert.deepEqual(cluster.commands().map(args=>args[0]==='config'?'config':args.includes('whoami')?'whoami':args.includes('get')?'get':'other'),
    ['config','whoami','get','config','whoami','get']);
  assert.ok(cluster.commands().filter(args=>args.includes('get')).every(args=>
    args.includes('demo')&&args.includes('deployments.apps')&&args[2]==='fixture'&&args[4]==='fixture'));
  const events=f.store.taskDetail(f.task.id).events;
  assert.ok(events.some(event=>event.kind==='run.recovery-observed'));
  assert.ok(events.every(event=>event.kind!=='run.recovery-confirmed'));
  assert.equal(f.calls(),0);
  await assert.rejects(f.execution().endTaskLink('task.cancel','cancel-unknown-effect',f.task.id,f.version),
    /未确认的工具回执或外部效果/);
  assert.equal(f.store.getTask(f.task.id).lifecycle,'open');
});

test('settled business blockage can be cancelled without the legacy recovery acknowledgement',async t=>{
  const f=fixture(t);
  const cancelled=await f.execution().endTaskLink('task.cancel','cancel-settled',f.task.id,f.version);
  assert.equal(cancelled.lifecycle,'cancelled');
  assert.equal(f.store.taskRuns(f.task.id).length,1);
  assert.equal(f.sent.length,0);
  assert.equal(f.store.getRunInput(f.run.id).state,'entered');
});

test('ordinary settled business blockers report prior facts without opening an unnecessary owner decision',async t=>{
  const f=fixture(t);
  f.events[4]!.data.message.isError=false;
  const inspected=await f.inspect();
  assert.equal(inspected.status,'blocked');
  assert.deepEqual('priorReport' in inspected&&inspected.priorReport,
    {kind:'blocked',summary:'File unavailable',checks:'Native read could not find it'});
  const detail=f.store.taskDetail(f.task.id);
  assert.equal(detail.task.waitingForPrerequisite,true);
  assert.equal(detail.task.blockingAttention,null);
  assert.equal(f.calls(),0);
});

test('a durable interrupted read with a demonstrably quiet end can be checked without a new Worker',async t=>{
  const f=fixture(t,undefined,'interrupted');
  assert.equal(f.store.heldRuns()[0]?.id,f.run.id);
  assert.equal(f.store.getTask(f.task.id).status,'recovery');
  assert.equal((await f.perform()).status,'readable');
  assert.equal(f.store.heldRuns().length,0);
  assert.equal(f.store.taskDetail(f.task.id).settledBlocker,'verified-end');
  assert.equal(f.calls(),1);
  assert.equal(f.sent.length,0);
  assert.equal((await f.perform()).status,'already-checked');
});

test('the newest owner instruction waits for native activity and is then delivered once on the original task',async t=>{
  const f=fixture(t,undefined,'interrupted'),{store,task,run,manager}=f;
  const initial={sessionId:manager.requestedSessionId,messageId:'owner-first',seq:17,text:'继续'};
  const first=store.saveRecoveryInstruction(task.id,f.version,initial);
  f.inbox.nextStep.push({source:{kind:'tool-jobs',form:'notice'}});
  const firstAttempt=await f.execution().continueRecovery(task.id,first.task.rowVersion,manager.id,()=>{});
  assert.equal(firstAttempt.status,'waiting');
  assert.equal(f.execution().canWakeRecoveryContinuation(task.id),false);
  assert.equal(store.heldRuns()[0]?.id,run.id);
  assert.equal(f.inbox.nextStep.length,1);
  const latest={...initial,messageId:'owner-latest',seq:19,text:'  先只查新版本  '};
  const saved=store.saveRecoveryInstruction(task.id,first.task.rowVersion,latest,'read-only');
  assert.deepEqual(store.saveRecoveryInstruction(task.id,f.version,initial).instruction.source,latest);
  const duplicate=store.saveRecoveryInstruction(task.id,first.task.rowVersion,latest,'read-only');
  assert.equal(duplicate.task.rowVersion,saved.task.rowVersion);
  assert.equal(store.taskDetail(task.id).events.filter(event=>event.kind==='task.recovery-instruction').length,2);
  f.inbox.nextStep.pop(); // The native consumer, not recovery, settles the pending result.
  assert.equal(f.execution().canWakeRecoveryContinuation(task.id),true);
  const resumed=await f.execution().continueRecovery(task.id,saved.task.rowVersion,manager.id,()=>{});
  assert.equal(resumed.status,'started');
  assert.ok(resumed.run);
  assert.equal(resumed.run.taskId,task.id);
  assert.equal(f.sent.length,1);
  const workerText=f.sent[0]!.content[0];
  assert.ok(workerText?.type==='text');
  assert.match(workerText.text,/先只查新版本/);
  assert.match(workerText.text,/File unavailable/);
  assert.doesNotMatch(workerText.text,/Additional user input \(continuation\): 继续/);
  assert.equal(store.getRunInput(resumed.run.id).content,latest.text);
  assert.equal(store.recoveryWorkPlan(resumed.run.id)?.context.effectUncertain,false);
  assert.match(f.guards[0]!({name:'bash'})??'',/read-only/);
  assert.match(f.guards[0]!({name:'write'})??'',/read-only/);
  assert.equal(store.getRunInput(run.id).state,'entered');
  assert.equal(store.heldRuns()[0]?.id,resumed.run.id);
  assert.equal((await f.execution().continueRecovery(task.id,saved.task.rowVersion,manager.id,()=>{})).status,'already-started');
  assert.equal(f.sent.length,1);
});

test('interrupted execution with an unverified external operation keeps its slot and accepts no replacement Run',async t=>{
  const f=fixture(t,undefined,'interrupted'),{store,task,run,manager}=f;
  f.events[3]!.data.name='bash';
  const source={sessionId:manager.requestedSessionId,messageId:'inspect-after-write',seq:6,text:'只查上一轮写入的结果'};
  const saved=store.saveRecoveryInstruction(task.id,f.version,source,'read-only');
  const output=await f.execution().continueRecovery(task.id,saved.task.rowVersion,manager.id,()=>{});
  assert.equal(output.status,'blocked');
  assert.match(output.message,/未确认的外部效果/);
  assert.equal(store.heldRuns()[0]?.id,run.id);
  assert.equal(store.getRunInput(run.id).state,'entered');
  assert.equal(store.recoveryInstruction(task.id)?.runId,undefined);
  assert.equal(f.sent.length,0);
});

test('a stored capacity wait and plain owner confirmation retain the last concrete direction',async t=>{
  const f=fixture(t),{store,task,manager}=f;
  store.setBotCapacity('capacity',task.botId,null,1);
  const other=store.createTask('other',{botId:task.botId,goal:'Other work',scope:'Test files',acceptance:'Report',reviewPolicy:'human'});
  const b=store.beginBinding('other-binding',other.id,other.rowVersion,'/tmp');
  store.confirmBinding(b.id,b.requestedSessionId);
  const hold=store.reserveRun('hold-capacity',other.id,store.getTask(other.id).rowVersion);
  const firstSource={sessionId:manager.requestedSessionId,messageId:'concrete',seq:10,text:'仅查询工作目录里的版本'};
  const first=store.saveRecoveryInstruction(task.id,f.version,firstSource,'read-only');
  const current=store.saveRecoveryInstruction(task.id,first.task.rowVersion,{...firstSource,messageId:'confirm',seq:12,text:'继续'},undefined,true);
  assert.equal(current.instruction.mode,'read-only');
  assert.deepEqual(current.instruction.priorDirection,firstSource);
  const restarted=f.execution();
  const waited=await restarted.continueRecovery(task.id,current.task.rowVersion,manager.id,()=>{});
  assert.equal(waited.status,'waiting');
  assert.equal(f.sent.length,0);
  assert.equal(store.taskDetail(task.id).wait?.code,'capacity');
  const notice=`manager-event:continuation:${current.instruction.id}`;
  assert.equal(store.claimManagerEvent(notice,'manager-lost','{}'),true);
  store.resetUnconfirmedManagerEvents();
  store.resetUnconfirmedManagerEvents();
  assert.equal(store.managerEvent(`${notice}:restart`)?.state,'pending');
  assert.equal(store.managerNotifications(task.botId).filter(event=>event.id===`${notice}:restart`).length,1);
  store.requestStop('release-capacity',other.id,store.getTask(other.id).rowVersion,hold.id);
  store.settleCancelled(hold.id);
  assert.equal(store.dispatchBlocker(task.id),null);
  const retried=await f.execution().continueRecovery(task.id,current.task.rowVersion,manager.id,()=>{});
  assert.equal(retried.status,'started');
  const text=f.sent[0]?.content[0];
  assert.ok(text?.type==='text');
  assert.match(text.text,/仅查询工作目录里的版本/);
  assert.match(text.text,/Additional user input \(continuation\): 继续/);
  assert.equal(store.recoveryInstruction(task.id)?.runId,retried.run?.id);
});

test('only a fresh concrete owner instruction can atomically resume a paused task',async t=>{
  const f=fixture(t),{store,task,manager}=f;
  const paused=store.controlTask('user-paused',task.id,f.version,'paused');
  const prior={sessionId:manager.requestedSessionId,messageId:'waiter',seq:8,text:'先只核对版本'};
  const persisted=store.saveRecoveryInstruction(task.id,paused.rowVersion,prior,'read-only');
  assert.equal(persisted.task.controlMode,'paused');
  assert.equal((await f.execution().continueRecovery(task.id,persisted.task.rowVersion,manager.id,()=>{})).status,'blocked');
  assert.throws(()=>store.saveRecoveryInstruction(task.id,persisted.task.rowVersion,{...prior,messageId:'generic',seq:9},
    undefined,true,true),/明确的本次续跑指示/);
  const newest={...prior,messageId:'resume-with-limits',seq:10,text:'恢复执行，先只查新版本'};
  const resumed=store.saveRecoveryInstruction(task.id,persisted.task.rowVersion,newest,'read-only',false,true);
  assert.equal(resumed.task.controlMode,'auto');
  const pausedAgain=store.controlTask('second-pause',task.id,resumed.task.rowVersion,'paused');
  assert.equal(store.saveRecoveryInstruction(task.id,paused.rowVersion,newest,'read-only',false,true).task.rowVersion,pausedAgain.rowVersion);
  assert.equal(store.getTask(task.id).controlMode,'paused');
  assert.equal(f.sent.length,0);
});

for(const kind of ['ready','waiting'] as const)test(`an earlier ${kind} report is preserved without overriding a newer pending direction`,async t=>{
  const f=fixture(t,undefined,'running'),{store,task,run,manager}=f;
  const source={sessionId:manager.requestedSessionId,messageId:'during-old-run',seq:8,text:'应改为只读核对当前状态'};
  const saved=store.saveRecoveryInstruction(task.id,f.version,source,'read-only');
  store.workerReport(run.id,kind,{kind,summary:'Previous instruction',checks:'Past work',
    ...(kind==='ready'?{evidence:[{path:'prior.txt',bytes:4,sha256:'test'}]}:{})});
  store.observeRunEnd(run.id,5,'completed',true);
  store.settleRun(run.id,false);
  const detail=store.taskDetail(task.id);
  assert.equal(detail.task.lifecycle,'open');
  assert.equal(detail.task.controlMode,'auto');
  assert.equal(detail.settledBlocker,'verified-end');
  assert.equal(detail.attentions.some(attention=>attention.state==='open'),false);
  if(kind==='ready')assert.equal(store.runResult(run.id)?.humanAcceptedAt,null);
  else assert.equal(store.finalReport(run.id)?.kind,'waiting');
  assert.equal(store.managerEvent(`manager-event:continuation:${saved.instruction.id}:settled`)?.state,'pending');
  const continued=await f.execution().continueRecovery(task.id,detail.task.rowVersion,manager.id,()=>{});
  assert.equal(continued.status,'started');
  assert.equal(f.sent.length,1);
});

test('concrete owner authorization permits newly scoped work only with proven clean earlier tools',async t=>{
  const f=fixture(t),{store,task,manager}=f;
  const source={sessionId:manager.requestedSessionId,messageId:'owner-authorizes',seq:8,text:'用当前授权范围内的新步骤处理待办'};
  const saved=store.saveRecoveryInstruction(task.id,f.version,source,'authorized-work');
  f.events[3]!.data.name='bash';
  const blocked=await f.execution().continueRecovery(task.id,saved.task.rowVersion,manager.id,()=>{});
  assert.equal(blocked.status,'blocked');
  assert.equal(f.sent.length,0);
  assert.equal(store.recoveryInstruction(task.id)?.runId,undefined);
  f.events[3]!.data.name='read';
  const continued=await f.execution().continueRecovery(task.id,saved.task.rowVersion,manager.id,()=>{});
  assert.equal(continued.status,'started');
  assert.ok(continued.run);
  assert.equal(store.recoveryWorkPlan(continued.run.id)?.context.mode,'authorized-work');
  assert.equal(f.guards[0]!({name:'write',arguments:{file_path:f.args.file_path}}),undefined);
  assert.equal(f.sent.length,1);
});

test('active-run directions survive a ledger reopen and enter the original task together in order',async t=>{
  const f=fixture(t,undefined,'running'),{store,task,run,manager}=f;
  const a={sessionId:manager.requestedSessionId,messageId:'staging2',seq:7,text:'另外读 staging2 回执。\n  保留原文。'};
  const b={...a,messageId:'prod',seq:9,text:'也读 prod 回执。'};
  const first=store.saveRecoveryInstruction(task.id,f.version,a,'read-only');
  const waiting=await f.execution().continueRecovery(task.id,first.task.rowVersion,manager.id,()=>{});
  assert.equal(waiting.status,'waiting');
  assert.equal(store.recoveryDirectionStatus(first.instruction),'next-run');
  const second=store.saveRecoveryInstruction(task.id,first.task.rowVersion,b,'read-only');
  assert.deepEqual(second.instruction.directions?.map(item=>item.source),[a,b]);
  assert.equal(store.recoveryDirectionStatus(second.instruction),'next-run');
  assert.equal(store.managerEvent(`manager-event:continuation:${first.instruction.id}`)?.state,'done');
  assert.equal(f.sent.length,0);
  store.workerReport(run.id,'waiting',{kind:'waiting',summary:'Earlier question'});
  store.observeRunEnd(run.id,5,'completed',true);
  store.settleRun(run.id,false);

  const reopened=f.reopen();
  const resumed=f.execution(reopened),version=reopened.getTask(task.id).rowVersion;
  const continued=await resumed.continueRecovery(task.id,version,manager.id,()=>{});
  const sent=f.sent[0]!;
  const body=sent.content[0];
  assert.equal(continued.status,'started');
  assert.equal(continued.run?.taskId,task.id);
  assert.equal(continued.run?.sessionId,run.sessionId);
  assert.ok(body?.type==='text');
  assert.ok(body.text.indexOf(a.text)>=0&&body.text.indexOf(a.text)<body.text.indexOf(b.text));
  assert.equal(body.text.split(a.text).length,2);
  assert.equal(body.text.split(b.text).length,2);
  assert.equal(sent.source.kind,'super-bot');
  if(sent.source.kind==='super-bot')assert.deepEqual(sent.source.ownerDirectionIds,[first.instruction.id,second.instruction.id]);
  const receipt=reopened.recoveryInstruction(task.id)!;
  assert.equal(reopened.recoveryDirectionStatus(receipt),'queued');
  reopened.inputEntered(continued.run!.id,sent.id,10);
  assert.equal(reopened.recoveryDirectionStatus(receipt),'entered');
  assert.equal((await resumed.continueRecovery(task.id,version,manager.id,()=>{})).status,'already-started');
  assert.equal(f.sent.length,1);
});

test('legacy pending instructions are retained until explicitly replaced or revoked',async t=>{
  const f=fixture(t,undefined,'running'),{store,task,run,manager}=f;
  const legacy={sessionId:manager.requestedSessionId,messageId:'old-read',seq:6,text:'Only inspect staging'};
  const first=store.saveRecoveryInstruction(task.id,f.version,legacy,'read-only');
  const {id,source,mode,priorRunId,taskRevision}=first.instruction;
  store.set(`recovery-instruction:${task.id}`,JSON.stringify({id,source,mode,priorRunId,taskRevision}));
  const later={...legacy,messageId:'also-prepare',seq:7,text:'Also prepare the report'};
  const added=store.saveRecoveryInstruction(task.id,first.task.rowVersion,later,'authorized-work');
  assert.equal(added.instruction.mode,'read-only');
  assert.deepEqual(added.instruction.directions?.map(item=>item.source),[legacy,later]);

  const replacement={...legacy,messageId:'replace-read',seq:8,text:'Replace the staging inspection with a prod-only check'};
  const replaced=store.saveRecoveryInstruction(task.id,added.task.rowVersion,replacement,'read-only',false,false,{kind:'replace',ids:[id]});
  assert.deepEqual(replaced.instruction.directions?.map(item=>item.source),[later,replacement]);
  assert.throws(()=>store.saveRecoveryInstruction(task.id,replaced.task.rowVersion,
    {...legacy,messageId:'stale-revocation',seq:9,text:'Remove the first direction'},undefined,false,false,{kind:'revoke',ids:[id]}),
  {code:'direction-stale'});
  const withdrawal={...legacy,messageId:'remove-all',seq:10,text:'Clear both pending requests'};
  const revoked=store.saveRecoveryInstruction(task.id,replaced.task.rowVersion,withdrawal,undefined,false,false,{kind:'revoke'});
  assert.deepEqual(revoked.instruction.directions,[]);
  assert.equal(store.recoveryDirectionStatus(revoked.instruction),'revoked');
  assert.equal(store.managerEvent(`manager-event:continuation:${replaced.instruction.id}`)?.state,'done');
  assert.equal(store.taskDetail(task.id).events.filter(event=>event.kind==='task.recovery-instruction').length,4);
  assert.equal(store.getRun(run.id).state,'running');
  assert.equal(f.sent.length,0);
});

test('a durable fixed Git query allows the authorized next step, while a successful legacy bash record remains unknown',async t=>{
  const f=fixture(t),{store,task,run,manager}=f;
  const source={sessionId:manager.requestedSessionId,messageId:'continue-work',seq:7,text:'Carry out the authorized next step'};
  const saved=store.saveRecoveryInstruction(task.id,f.version,source,'authorized-work');
  const call=f.events[3]!.data,result=f.events[4]!;
  call.name='bash';
  call.arguments=JSON.stringify({command:'git status --short'});
  result.data={turn:1,step:2,message:{toolCallId:'read',isError:false,content:[{type:'text',text:'?? current.txt'}]}};
  const continued=()=>f.execution().continueRecovery(task.id,saved.task.rowVersion,manager.id,()=>{});
  const legacy=await continued();
  assert.equal(legacy.status,'blocked');
  assert.match(legacy.message,/bash 缺少可信的只读/);

  call.name=WORKER_QUERY_TOOL;
  call.arguments=JSON.stringify({kind:GIT_STATUS_QUERY});
  const receipt:ReadQueryReceipt={kind:GIT_STATUS_QUERY,cwd:f.cwd,turn:1,inputSeq:1,
    result:{status:'ok',message:'Verified Git status',porcelain:'?? current.txt\n'}};
  result.data.message.content[0].text=JSON.stringify(receipt.result);
  const missing=await continued();
  assert.equal(missing.status,'blocked');
  assert.match(missing.message,new RegExp(WORKER_QUERY_TOOL));
  store.recordReadQueryReceipt(run.id,'read',receipt);
  result.data.message.content[0].text=JSON.stringify({...receipt.result,porcelain:''});
  assert.equal((await continued()).status,'blocked');
  result.data.message.content[0].text=JSON.stringify(receipt.result);
  call.arguments=JSON.stringify({kind:GIT_STATUS_QUERY,command:'touch guarded'});
  assert.equal((await continued()).status,'blocked');
  call.arguments=JSON.stringify({kind:GIT_STATUS_QUERY});
  const reopened=f.reopen();
  const success=await f.execution(reopened).continueRecovery(task.id,saved.task.rowVersion,manager.id,()=>{});
  assert.equal(success.status,'started');
  assert.equal(reopened.recoveryWorkPlan(success.run!.id)?.context.effectUncertain,false);
  assert.equal(reopened.recoveryWorkPlan(success.run!.id)?.context.priorReadQueries?.[0]?.kind,GIT_STATUS_QUERY);
  assert.equal(f.sent.length,1);
});

test('pinned sandboxed Git reads actual status and cannot execute repo-configured helpers',async t=>{
  if(process.platform!=='darwin'||!existsSync('/usr/bin/sandbox-exec')||
    !['/Library/Developer/CommandLineTools/usr/bin/git','/Applications/Xcode.app/Contents/Developer/usr/bin/git'].some(existsSync)) {
    t.skip('Apple Git sandbox unavailable');
    return;
  }
  const cwd=mkdtempSync(join(realpathSync(tmpdir()),'sb-query-git-'));
  t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  const git=(...args:string[])=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',
    env:{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',LC_ALL:'C'}});
  git('init','--quiet','--template=');
  writeFileSync(join(cwd,'staged.txt'),'original');
  writeFileSync(join(cwd,'modified.txt'),'original');
  git('add','.');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture');
  const head=git('rev-parse','HEAD').trim();
  writeFileSync(join(cwd,'staged.txt'),'new staged');
  git('add','staged.txt');
  writeFileSync(join(cwd,'modified.txt'),'new unstaged');
  writeFileSync(join(cwd,'new.txt'),'new untracked');
  const index=readFileSync(join(cwd,'.git/index'));
  const query=()=>gitWorkingTreeStatus(cwd,AbortSignal.timeout(12000),()=>{});
  const status=await query();
  assert.equal(status.status,'ok');
  assert.equal(status.head,head);
  assert.equal(status.porcelain,' M modified.txt\nM  staged.txt\n?? new.txt\n');
  assert.deepEqual(readFileSync(join(cwd,'.git/index')),index);

  const marker=join(cwd,'helper-ran.txt');
  const helper=join(cwd,'helper.sh');
  writeFileSync(helper,'#!/bin/sh\nprintf ran > "$1"\ncat\n',{mode:0o700});
  git('config','core.fsmonitor',helper);
  git('config','filter.query-fixture.clean',`"${helper}" "${marker}"`);
  writeFileSync(join(cwd,'.gitattributes'),'modified.txt filter=query-fixture\n');
  await query();
  assert.equal(existsSync(marker),false);
  assert.deepEqual(readFileSync(join(cwd,'.git/index')),index);
});
