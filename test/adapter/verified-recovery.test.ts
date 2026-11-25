import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test,type TestContext} from 'node:test';
import type {Context} from '@deepseek-ai/cordis';
import {Store} from '../../src/store.ts';
import {DshExecution} from '../../src/dsh.ts';
import {inspectPriorTools,type ClusterProbe,type ProbeResult} from '../../src/read-only-recovery.ts';
import {parseClusterProbe,prepareClusterProbe} from '../../src/kubernetes-preflight.ts';
import type {RunEvent} from '../../src/run-proof.ts';

const signal=new AbortController().signal;
function fixture(t:TestContext,cluster?:{probe:ClusterProbe;auth:string;result:ProbeResult}) {
  const cwd=mkdtempSync(join(realpathSync(tmpdir()),'sb-verified-recovery-'));
  const store=new Store(join(cwd,'ledger.sqlite'));
  t.after(()=>{store.close();rmSync(cwd,{recursive:true,force:true});});
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
  store.workerReport(run.id,'blocked',{kind:'blocked',summary:'File unavailable',checks:'Native read could not find it'});
  if(cluster)store.recordPreflightReceipt(run.id,'read',cluster.probe,cluster.auth,cluster.result);
  store.observeRunEnd(run.id,cluster?6:5,'completed',true);
  store.settleRun(run.id);
  const path=join(cwd,'fixture.txt');
  const args={file_path:path,offset:3,limit:4};
  const events:RunEvent[]=[
    {seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'user/message',surfaceOp:'append',data:automatic},
    {seq:2,type:'user/message',surfaceOp:'append',data:{source:{kind:'runtime-context',form:'snapshot'}}},
    {seq:3,type:'tool/call',data:{turn:1,step:2,callId:'read',name:'read',arguments:JSON.stringify(args)}},
    {seq:4,type:'tool/result',data:{turn:1,step:2,message:{toolCallId:'read',isError:true},
      error:{code:'FS_NOT_FOUND',reason:'file not found'}}},
    {seq:5,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
  ];
  if(cluster) {
    events[3]!.data.name='super_bot_preflight';
    events[3]!.data.arguments=JSON.stringify(cluster.probe);
    events[4]!.data={turn:1,step:2,message:{toolCallId:'read',isError:false,content:[{type:'text',text:JSON.stringify(cluster.result)}]}};
    const end=events.pop()!;
    events.push({seq:5,type:'tool/call',data:{turn:1,step:3,callId:'possible-write',name:'bash',arguments:'{}'}});
    events.push({...end,seq:6});
  }
  const session={id:run.sessionId};
  const jobs:{id:string;owner:string;status:string}[]=[];
  const inbox={nextTurn:[] as object[],nextStep:[] as object[]};
  const agent={id:run.sessionId,session,status:'idle',inbox,ctx:{on:()=>()=>{}}};
  const options={nativeCode:'',beforeResolve:async()=>{},beforeRead:async()=>{}};
  let calls=0;
  const execution=()=>new DshExecution({
    workingDirectory:{get:()=>cwd},jobs:{list:()=>jobs},agents:{get:()=>agent,list:()=>[agent]},
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
  } as unknown as Context,store,cwd,{fullAccess:!!cluster});
  const id=task.id,version=store.getTask(id).rowVersion;
  return {store,task,run,manager,version,args,events,jobs,inbox,options,calls:()=>calls,execution,
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
    assert.equal(f.store.getTask(f.task.id).status,'recovery');
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
  assert.equal(detail.task.status,'recovery');
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
    spec:{replicas:1},status:{observedGeneration:2,replicas:1,readyReplicas:1,updatedReplicas:0,availableReplicas:1}}));
  const inspection=await f.inspect();
  assert.equal(inspection.status,'eligible');
  assert.ok('effectUncertain' in inspection&&inspection.effectUncertain);
  assert.ok('priorTools' in inspection&&(inspection.priorTools as {tool:string;result:string}[]).some(
    entry=>entry.tool==='bash'&&entry.result==='missing'));
  const checked=await f.perform();
  assert.equal(checked.status,'present');
  assert.deepEqual('observed' in checked&&checked.observed,{uid:'synthetic-uid',ready:false},
    'one ready old replica does not prove the current rollout is ready');
  assert.equal(f.store.getTask(f.task.id).status,'recovery');
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
});
