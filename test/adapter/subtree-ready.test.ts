/** The registered report tool, native turn events and real ledger form the seam. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {symbols,type Context} from '@deepseek-ai/cordis';
import {scopeTarget} from '@deepseek-ai/dsh-scope';
import {Store} from '../../src/store.ts';
import {DshExecution} from '../../src/dsh.ts';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
async function fixture(version:'rc.1'|'rc.5'='rc.5') {
  mkdirSync(resolve('.runtime'),{recursive:true});
  const directory=realpathSync(mkdtempSync(resolve('.runtime/subtree-ready-'))),store=new Store(':memory:');
  const bot=store.createBot('bot',{name:'Tree regression',instructions:'Synthetic only'});
  const task=store.createTask('task',{botId:bot.id,goal:'Check children',scope:'Own directory',acceptance:'Read final bytes',reviewPolicy:'human'});
  const binding=store.beginBinding('bind',task.id,task.rowVersion,directory);store.confirmBinding(binding.id,binding.requestedSessionId);
  const file=join(directory,'result.md');writeFileSync(file,'Before child finishes');
  const listeners=new Map<string,Function[]>(),agentListeners=new Map<string,Function[]>(),events:any[]=[],order:string[]=[];
  let execute!:(args:any,exec:any)=>Promise<any>,guard!:(exec:any)=>unknown,conclusions=0,released=false;
  const idle=deferred<void>(),joined=deferred<boolean>(),abort=new AbortController();
  const agent:any={id:binding.requestedSessionId,session:{id:binding.requestedSessionId},status:'idle',
    inbox:{nextTurn:[],nextStep:[],remove:()=>{}},
    ctx:{tools:{restrict:()=>()=>{released=true;},guard:(fn:typeof guard)=>{guard=fn;return ()=>{released=true;};}},
      on:(name:string,fn:Function)=>{agentListeners.set(name,[...(agentListeners.get(name)??[]),fn]);return ()=>{};}},
    followup:()=>{agent.status='running';},whenIdle:()=>idle.promise,cancel:()=>abort.abort()};
  const child:any={id:'native-child',session:{id:'native-child'},status:'running',inbox:{nextTurn:[],nextStep:[]}};
  let childActive=false,childVisible=false,rootJobActive=false,treeCalls=0,rootJobId='worker-job';
  const interruptedChildren:string[]=[],killedJobs:string[]=[];
  const wait=async(root:any)=>{treeCalls++;assert.equal(root,agent);return childActive?joined.promise:false;};
  const tree={rootOf:(member:any)=>member===child?agent:member,interrupt:(id:string,authority:any)=>{
    assert.equal(authority.kind,'ancestor');assert.equal(authority.agent,agent);interruptedChildren.push(id);
  },
    ...(version==='rc.1'?{waitForChildren:wait}:{waitForTreeWork:wait})};
  let nativeService:object|undefined=tree;
  const carrier=scopeTarget(tree,agent);
  const childEdge=(local:boolean)=>({id:child.id,runId:'child-run',provider:'synthetic',local,
    ...(version==='rc.5'?{parentSessionId:agent.id}:{})});
  const ctx={permissionPresets:{set:()=>{}},effect:(fn:()=>unknown)=>fn(),
    get:(name:string)=>name==='subagents'&&nativeService?Object.create(nativeService,{[symbols.original]:{value:nativeService}}):undefined,
    on:(name:string,fn:Function)=>{listeners.set(name,[...(listeners.get(name)??[]),fn]);return ()=>{};},
    tools:{register:(tool:any)=>{if(tool.name==='super_bot_report')execute=tool.execute;return ()=>{};}},
    sessions:{flush:async()=>true},sessionPersistence:{open:async()=>({header:{id:agent.id},read:async()=>({events:structuredClone(events)}),close:async()=>{}})},
    sessionController:{resolveAgent:async()=>({agent})},workingDirectory:{get:()=>directory},
    sessionProjections:{snapshot:()=>({values:{modelSelection:{next:{provider:'fake',model:'fake'}}}})},
    jobs:{list:(owner:string)=>rootJobActive&&owner===agent.id?[{id:rootJobId,owner,status:'running'}]:[],
      kill:(id:string,owner:string)=>{assert.equal(owner,agent.id);killedJobs.push(id);}},
    agents:{list:()=>childVisible?[agent,child]:[agent],get:(id:string)=>id===agent.id?agent:childVisible&&id===child.id?child:undefined,
      ...(version==='rc.1'?{isOwnedBy:(id:string,owner:any)=>id===child.id&&owner===agent}:{})}} as unknown as Context;
  const execution=new DshExecution(ctx,store,directory,{fullAccess:true});execution.install();
  const emit=async(type:string,data:any,session=agent.session,durable=true)=>{
    const event={type,data,seq:events.length,time:Date.now(),...(type==='user/message'?{surfaceOp:'append'}:{})};
    if(durable&&session===agent.session)events.push(event);
    for(const fn of listeners.get('session/event')??[])await fn(session,event);
    await execution.whenReconciled();
  };
  const run=await execution.dispatch('dispatch',task.id,store.getTask(task.id).rowVersion);
  await emit('turn/start',{turn:1});await emit('user/message',JSON.parse(store.getRunInput(run.id).messageJson!));
  return {directory,store,task,run,agent,child,order,emit,bot,execution,interruptedChildren,killedJobs,
    loseNativeService:()=>{nativeService=undefined;},
    startRootJob:(id='worker-job')=>{rootJobActive=true;rootJobId=id;},
    finishRootJob:()=>{rootJobActive=false;},
    cancelled:()=>abort.signal.aborted,
    enqueueChildResult:()=>{agent.inbox.nextStep.push({source:{kind:'subagent-settled'}});},
    consumeChildResult:()=>{agent.inbox.nextStep.shift();},
    startChild:(phase:'local'|'external'|'materializing'='local')=>{
      childActive=true;childVisible=phase==='local';child.status='running';
      if(phase!=='materializing')for(const fn of agentListeners.get('subagent/start')??[])fn.call(carrier,childEdge(childVisible));
    },
    finishChild:()=>{
      const local=childVisible;
      writeFileSync(file,'After child finishes');child.status='idle';childActive=false;childVisible=false;order.push('child-end');
      for(const fn of agentListeners.get('subagent/end')??[])fn.call(carrier,{...childEdge(local),stopReason:'completed'});
      joined.resolve(true);
    },
    call:(id:string,overrides:Record<string,unknown>={})=>{order.push(id);return execute({kind:'ready',summary:'Final facts',checks:'Read final bytes',files:[file],...overrides},
      {agent,callId:id,signal:abort.signal,concludeTurn:()=>{conclusions++;order.push('conclude');}});},
    conclusions:()=>conclusions,released:()=>released,treeCalls:()=>treeCalls,guard:(name:string)=>guard({name}),
    stop:()=>execution.stop('stop',task.id,store.getTask(task.id).rowVersion),
    finishIdle:()=>{agent.status='idle';idle.resolve();},
    stopping:async(subject=agent,turn=1)=>{for(const fn of agentListeners.get('agent/turn-stopping')??[])await fn({agent:subject,turn,signal:abort.signal});},
    close:async()=>{joined.resolve(true);agent.cancel();agent.status='idle';idle.resolve();await execution.dispose();store.close();assert.ok(directory.startsWith(resolve('.runtime/subtree-ready-')));rmSync(directory,{recursive:true,force:true});}};
}

test('only ready reports register safe links, and a retry attests to the same links',async()=>{
  const f=await fixture();try {
    const result='https://example.test/releases/report',docs='https://docs.example.test/abc';
    for(const invalid of [{link:'javascript:alert(1)'},{link:'https://user:pass@example.test/report'},[result],{link:null}]) {
      await assert.rejects(f.call('bad',{links:invalid}),{code:'invalid-delivery-links'});
    }
    await assert.rejects(f.call('progress',{kind:'progress',links:{result}}),{code:'invalid-delivery-links'});
    assert.equal(f.store.finalReport(f.run.id),null);
    assert.equal(f.treeCalls(),0,'link validation happens before waiting for children or capturing files');
    const receipt=await f.call('deliverables',{links:{result,docs}});
    assert.equal(receipt.accepted,true);
    assert.deepEqual(await f.call('deliverables',{links:{docs,result}}),receipt);
    await assert.rejects(f.call('deliverables',{links:{result}}),{code:'idempotency-conflict'});
    await assert.rejects(f.call('deliverables'),{code:'idempotency-conflict'});
    const saved=f.store.db.prepare('SELECT data FROM reports WHERE runId=?').get(f.run.id);
    assert.deepEqual(JSON.parse(String(saved?.data)).links,{docs,result});
  }finally{await f.close();}
});

test('force delete retains the Worker reservation until the exact child and Job settle', {timeout:3000},async()=>{
  const f=await fixture();try {
    f.store.setBotCapacity('one-slot',f.bot.id,null,1);
    const other=f.store.createBot('other',{name:'Unrelated bot',instructions:'Synthetic only'});
    const next=f.store.createTask('other-task',{botId:other.id,goal:'Continue',scope:'Own work',acceptance:'Read',reviewPolicy:'human'});
    const binding=f.store.beginBinding('other-bind',next.id,next.rowVersion,f.directory);
    f.store.confirmBinding(binding.id,binding.requestedSessionId);
    f.startRootJob();f.startChild();
    f.agent.inbox.nextTurn.push({id:'native-user',source:{kind:'user',rpcId:'native'}});
    f.store.deleteBot('delete',f.bot.id,f.bot.configRevision,true);
    f.execution.stopDeletedBot(f.bot.id);f.execution.stopDeletedBot(f.bot.id);
    assert.equal(f.cancelled(),true);
    assert.deepEqual(f.interruptedChildren,[f.child.id]);
    assert.deepEqual(f.killedJobs,['worker-job']);
    assert.equal(f.agent.inbox.nextTurn[0].id,'native-user');
    assert.equal(f.store.getTask(f.task.id).lifecycle,'cancelled');
    assert.equal(f.store.getRun(f.run.id).state,'cancelling');
    assert.deepEqual(f.store.deletedBotRuns(f.bot.id).map(run=>run.id),[f.run.id]);
    assert.equal(f.store.dispatchBlocker(next.id),null);
    const independent=f.store.reserveRun('other-run',next.id,f.store.getTask(next.id).rowVersion);
    assert.equal(independent.state,'queued');
    await f.emit('turn/end',{turn:1,reason:{kind:'aborted',reason:{kind:'user'}}});
    await f.emit('turn/start',{turn:2});
    await f.emit('user/message',{id:'native-user',source:{kind:'user',rpcId:'native'}});
    f.finishRootJob();
    await delay(300);
    assert.deepEqual(f.store.deletedBotRuns(f.bot.id).map(run=>run.id),[f.run.id], 'owned child still holds the deleted Bot reservation');
    f.finishChild();
    while(f.store.deletedBotRuns(f.bot.id).length)await delay(25);
    assert.deepEqual(f.store.heldRuns().map(run=>run.id),[independent.id]);
    assert.equal(f.store.getRun(f.run.id).state,'cancelled');
    assert.deepEqual(f.killedJobs,['worker-job']);
  }finally{await f.close();}
});

test('force delete neither stops nor charges a following native user turn or Job', {timeout:3000},async()=>{
  const f=await fixture();try {
    f.startRootJob('old-worker-job');
    await f.emit('turn/end',{turn:1,reason:{kind:'aborted',reason:{kind:'user'}}});
    f.finishRootJob();
    await f.emit('turn/start',{turn:2});
    await f.emit('user/message',{id:'native-user',source:{kind:'user',rpcId:'native'}});
    f.startRootJob('native-user-job');
    assert.equal(f.store.getRun(f.run.id).state,'interrupted');
    f.store.deleteBot('delete',f.bot.id,f.bot.configRevision,true);
    f.execution.stopDeletedBot(f.bot.id);
    while(f.store.heldRuns().length)await delay(25);
    assert.equal(f.agent.status,'running');
    assert.equal(f.cancelled(),false);
    assert.deepEqual(f.killedJobs,[]);
    assert.equal(f.store.getRun(f.run.id).state,'interrupted');
    assert.equal(f.store.db.prepare("SELECT json_extract(data,'$.confirmed') AS confirmed FROM events WHERE kind='run.delete-release'").get()?.confirmed,0);
  }finally{await f.close();}
});

for(const version of ['rc.1','rc.5'] as const)test(`${version} early ready holds the execution slot and requires a fresh same-turn report`,async()=>{
  const f=await fixture(version);try {
    f.startChild();let returned=false;
    const first=f.call('early-ready').finally(()=>{returned=true;});void first.catch(()=>{});
    await tick();
    assert.equal(f.treeCalls(),1,'ready must join native tree work before sampling evidence or concluding');
    assert.equal(f.conclusions(),0,'ready must not conclude the parent while its native child is running');
    assert.equal(returned,false,'the first ready stays in the parent turn until tree work converges');
    assert.equal(f.store.runResult(f.run.id),null,'do not hash or commit evidence before the child finishes');
    assert.equal(f.store.getRun(f.run.id).finishedAt,null);assert.equal(f.store.heldRuns().length,1);assert.equal(f.released(),false);
    f.store.setBotCapacity('one-slot',f.bot.id,null,1);
    const other=f.store.createTask('other',{botId:f.task.botId,goal:'Queued work',scope:'Same directory',acceptance:'Own files',reviewPolicy:'human'});
    const binding=f.store.beginBinding('other-bind',other.id,other.rowVersion,f.directory);f.store.confirmBinding(binding.id,binding.requestedSessionId);
    assert.equal(f.store.dispatchBlocker(other.id),'capacity');
    f.enqueueChildResult();f.finishChild();const continuation=await first;
    assert.equal(continuation.accepted,false);assert.equal(continuation.reason,'subtree-joined');assert.match(continuation.next,/子 Agent/);
    assert.equal(f.conclusions(),0);assert.equal(f.store.finalReport(f.run.id),null);assert.equal(f.store.heldRuns().length,1);
    f.consumeChildResult();
    const final=await f.call('final-ready');assert.equal(final.accepted,true);assert.equal(f.conclusions(),1);
    const result=f.store.runResult(f.run.id)!;assert.equal(result.evidence[0]?.bytes,Buffer.byteLength('After child finishes'));
    await f.stopping();f.order.push('parent-end');await f.emit('turn/end',{turn:1,reason:{kind:'completed'}});
    assert.equal(f.store.getRun(f.run.id).state,'settled');assert.equal(f.store.getTask(f.task.id).lifecycle,'review');
    assert.equal(f.store.heldRuns().length,0);assert.equal(result.humanAcceptedAt,null);
    assert.equal(f.store.dispatchBlocker(other.id),null);
    assert.deepEqual(f.order,['early-ready','child-end','final-ready','conclude','parent-end']);
    assert.equal(f.store.runTurn(f.run.id)?.quiet,1);
  }finally{await f.close();}
});

test('a late same-batch child that already ended cannot validate the earlier ready evidence',async()=>{
  const f=await fixture();try {
    await f.call('ready-before-late-tool');
    assert.match(String(f.guard('subagent')),/final report/);
    f.startChild();f.finishChild(); // An already-admitted sibling tool can finish before the stop hook runs.
    await assert.rejects(f.stopping(),{code:'report-stale'});
    await f.emit('turn/end',{turn:1,reason:{kind:'completed'}});
    assert.equal(f.store.getRun(f.run.id).state,'interrupted');assert.equal(f.store.heldRuns().length,1);
    assert.equal(f.store.getTask(f.task.id).lifecycle,'open');assert.equal(f.store.runTurn(f.run.id)?.quiet,0);
  }finally{await f.close();}
});

for(const phase of ['external','materializing'] as const)test(`Stop interrupts ready during ${phase} child work and preserves occupancy`,{timeout:2000},async()=>{
  const f=await fixture();try {
    f.startChild(phase);
    const first=f.call('ready-before-stop');const aborted=assert.rejects(first,{name:'AbortError'});
    await tick();assert.equal(f.treeCalls(),1);
    await f.stop();await aborted;
    assert.equal(f.conclusions(),0);assert.equal(f.store.runResult(f.run.id),null);
    await f.emit('turn/end',{turn:1,reason:{kind:'aborted',reason:{kind:'user'}}});f.finishIdle();
    assert.equal(f.store.getRun(f.run.id).state,'interrupted');assert.equal(f.store.runTurn(f.run.id)?.quiet,0);
    assert.equal(f.store.heldRuns().length,1);assert.equal(f.store.taskDetail(f.task.id).attentions[0]?.kind,'recovery');
    f.finishChild();await tick();
    assert.equal(f.store.heldRuns().length,1,'a later child end cannot settle the ended parent');
  }finally{await f.close();}
});

test('a direct model finish joins child work at the owned native stopping event',async()=>{
  const f=await fixture();try {
    f.startChild();
    await f.stopping(f.child);await f.stopping(f.agent,2);
    assert.equal(f.treeCalls(),0);
    await f.emit('turn/end',{turn:1,reason:{kind:'error',error:{code:'MISSING_CREDENTIAL'}}},{id:f.agent.id},false);
    await f.emit('turn/end',{turn:2,reason:{kind:'completed'}},f.agent.session,false);
    assert.equal(f.store.getRun(f.run.id).finishedAt,null,'a different turn must not finalize this run');
    let stopped=false;const ending=f.stopping().then(()=>{stopped=true;});
    await tick();assert.equal(stopped,false);assert.equal(f.store.heldRuns().length,1);
    f.finishChild();await ending;
    await f.emit('turn/end',{turn:1,reason:{kind:'completed'}});
    assert.equal(f.store.getRun(f.run.id).state,'interrupted');assert.equal(f.store.finalReport(f.run.id),null);
    assert.equal(f.store.heldRuns().length,1);
  }finally{await f.close();}
});

test('an early completed turn cannot gain a quiet certificate after its native child ends',async()=>{
  const f=await fixture();try {
    f.startChild('external');const first=f.call('ready-before-end');void first.catch(()=>{});
    await tick();await f.emit('turn/end',{turn:1,reason:{kind:'completed'}});
    f.finishChild();await assert.rejects(first,{code:'report-stale'});
    assert.equal(f.store.finalReport(f.run.id),null);assert.equal(f.store.runTurn(f.run.id)?.quiet,0);
    assert.equal(f.store.getRun(f.run.id).state,'interrupted');assert.equal(f.store.heldRuns().length,1);
  }finally{await f.close();}
});

test('native stop breaks the stopping hook while child work is still live', {timeout:2000},async()=>{
  const f=await fixture();try {
    f.startChild('external');
    const ending=assert.rejects(f.stopping(),{name:'AbortError'});
    await tick();assert.equal(f.treeCalls(),1);
    await f.stop();await ending;
    await f.emit('turn/end',{turn:1,reason:{kind:'aborted',reason:{kind:'user'}}});
    assert.equal(f.store.getRun(f.run.id).state,'interrupted');assert.equal(f.store.heldRuns().length,1);
  }finally{await f.close();}
});

test('turn/end checks the tree again after a successful stopping hook',async()=>{
  const f=await fixture();try {
    assert.equal((await f.call('ready-before-stop-hook')).accepted,true);
    await f.stopping();
    f.startChild();f.finishChild();
    await f.emit('turn/end',{turn:1,reason:{kind:'completed'}});
    assert.equal(f.store.runTurn(f.run.id)?.quiet,0);
    assert.equal(f.store.getTask(f.task.id).lifecycle,'open');assert.equal(f.store.heldRuns().length,1);
  }finally{await f.close();}
});

test('ready defers when a finished child result is already queued for the next step',async()=>{
  const f=await fixture();try {
    f.enqueueChildResult();
    assert.equal((await f.call('unread-child-result')).reason,'subtree-joined');
    assert.equal(f.store.finalReport(f.run.id),null);assert.equal(f.conclusions(),0);
    f.consumeChildResult();assert.equal((await f.call('reviewed-child-result')).accepted,true);
    await f.stopping();await f.emit('turn/end',{turn:1,reason:{kind:'completed'}});
    assert.equal(f.store.getTask(f.task.id).lifecycle,'review');
  }finally{await f.close();}
});

test('a running parent job leaves ready as a candidate and blocks settlement at turn/end',async()=>{
  const f=await fixture();try {
    f.startRootJob();
    assert.equal((await f.call('ready-with-job')).accepted,true);
    await f.stopping();await f.emit('turn/end',{turn:1,reason:{kind:'completed'}});
    assert.equal(f.store.runTurn(f.run.id)?.quiet,0);assert.ok(f.store.runResult(f.run.id));
    assert.equal(f.store.getRun(f.run.id).state,'interrupted');assert.equal(f.store.heldRuns().length,1);
    assert.match(f.store.getRun(f.run.id).note,/后台工作/);
  }finally{await f.close();}
});

test('losing the native subagent service cannot certify a quiet tree',async()=>{
  const f=await fixture();try {
    f.loseNativeService();
    await assert.rejects(f.call('ready-without-native-service'),{code:'child-unknown'});
    await assert.rejects(f.stopping(),{code:'child-unknown'});
    await f.emit('turn/end',{turn:1,reason:{kind:'error',error:{code:'UNKNOWN'}}});
    assert.equal(f.store.runTurn(f.run.id)?.quiet,0);assert.equal(f.store.finalReport(f.run.id),null);
    assert.equal(f.store.getRun(f.run.id).state,'interrupted');assert.equal(f.store.heldRuns().length,1);
  }finally{await f.close();}
});
