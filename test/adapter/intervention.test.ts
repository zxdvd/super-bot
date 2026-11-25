/** Queue or steer on a running Worker must not abort the automatic turn. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import {Store} from '../../src/store.ts';
import {DshExecution} from '../../src/dsh.ts';
import {collectEvidence} from '../../src/evidence.ts';
import {Managers} from '../../src/manager.ts';
import type {Run,Task,TaskCloseRequest} from '../../src/model.ts';
import {workUrl} from '../../src/work-links.ts';

async function fixture() {
  let external:'job'|'child'|undefined;
  let flush:()=>Promise<boolean>=async()=>true;
  let beforeResolve:()=>Promise<void>=async()=>{};
  let execute:((args:Record<string,unknown>,exec:unknown)=>Promise<unknown>)|undefined;
  let managers:Managers|undefined;
  mkdirSync(resolve('.runtime'),{recursive:true});
  const directory=realpathSync(mkdtempSync(resolve('.runtime/intervention-'))),store=new Store(':memory:');
  const bot=store.createBot('bot',{name:'接管回归',instructions:'合成测试'});
  const task=store.createTask('task',{botId:bot.id,goal:'写说明',scope:'任务目录',acceptance:'回读',reviewPolicy:'human'});
  const binding=store.beginBinding('bind',task.id,task.rowVersion,directory);store.confirmBinding(binding.id,binding.requestedSessionId);
  const sessionEvents:Function[]=[],events:any[]=[];
  let cancels=0,removed:string[]=[],released=false,deferStop=false,finish!:()=>void;
  const idle=new Promise<void>(resolve=>{finish=resolve;});
  const agent:any={id:binding.requestedSessionId,session:{id:binding.requestedSessionId},status:'idle',
    inbox:{nextTurn:[],nextStep:[],remove:(id:string)=>removed.push(id)},
    ctx:{tools:{restrict:()=>()=>{released=true;},guard:()=>()=>{released=true;}},on:()=>()=>{}},
    followup:()=>{agent.status='running';},whenIdle:()=>idle,cancel:()=>{cancels++;if(!deferStop){agent.status='idle';finish();}}};
  const ctx={permissionPresets:{set:()=>{}},
    effect:(callback:()=>unknown)=>callback(),
    on:(name:string,fn:Function)=>{if(name==='session/event')sessionEvents.push(fn);return ()=>{};},
    tools:{register:(tool:{name:string;execute:typeof execute})=>{if(tool.name==='super_bot_manage')execute=tool.execute;return ()=>{};}},sessions:{flush:()=>flush()},
    sessionPersistence:{open:async()=>({header:{id:agent.id},read:async()=>({events:structuredClone(events)}),close:async()=>{}})},
    sessionController:{resolveAgent:async()=>{await beforeResolve();return {agent};}},
    sessionProjections:{snapshot:()=>({values:{modelSelection:{next:{provider:'fake',model:'fake'}}}})},
    workingDirectory:{get:()=>directory},jobs:{list:()=>external==='job'?[{owner:agent.id,status:'running'}]:[]},
    agents:{get:(id:string)=>id===agent.id?agent:undefined,list:()=>external==='child'?[{}]:[],isOwnedBy:()=>external==='child'}} as unknown as Context;
  const execution=new DshExecution(ctx,store,directory,{fullAccess:true});execution.install();
  const emit=async(type:string,data:any)=>{const event={type,data,seq:events.length,time:Date.now(),...(type==='user/message'?{surfaceOp:'append'}:{})};events.push(event);for(const fn of sessionEvents)await fn(agent.session,event);await execution.whenReconciled();};
  const run=await execution.dispatch('dispatch',task.id,store.getTask(task.id).rowVersion);
  await emit('turn/start',{turn:1});
  function chat() {
    const manager=store.beginManager('manager',bot.id,directory);
    const session={id:manager.requestedSessionId};
    store.confirmManager(manager.id,session.id);
    managers=new Managers(ctx,store,execution,directory);managers.install();
    let seq=0,turn=0;
    async function event(type:string,data:unknown,surfaceOp?:string){
      for(const fn of sessionEvents)await fn(session,{type,data,seq:seq++,surfaceOp});
    }
    async function human(text:string) {
      await event('turn/start',{turn:++turn});
      await event('user/message',user(`human-${turn}`,text),'append');
    }
    const end=()=>event('turn/end',{turn,reason:{kind:'completed'}});
    const call=(callId:string,args:Record<string,unknown>,signal=new AbortController().signal)=>
      execute!({taskId:task.id,expectedRowVersion:store.getTask(task.id).rowVersion,...args},{agent:session,signal,callId}) as
        Promise<{task:Task;run:Run|null;stop?:{runId:string;requested:true};closeRequest?:TaskCloseRequest|null}>;
    return {manager,event,human,end,call};
  }
  return {ctx,directory,store,task,agent,run,emit,execution,bot,chat,deferStop:()=>{deferStop=true;},
    recordEnd:()=>events.push({type:'turn/end',seq:events.length,data:{turn:1,reason:{kind:'aborted',reason:{kind:'user'}}}})-1,
    beforeResolve:(fn:()=>Promise<void>)=>{beforeResolve=fn;},setFlush:(fn:()=>Promise<boolean>)=>{flush=fn;},
    setExternal:(value:'job'|'child')=>{external=value;},cancels:()=>cancels,removed:()=>removed,released:()=>released,
    finishIdle:()=>{agent.status='idle';finish();},
    close:async()=>{agent.status='idle';finish();await managers?.dispose();await execution.dispose();store.close();rmSync(directory,{recursive:true,force:true});}};
}

const user=(id:string,text:string)=>({id,source:{kind:'user',rpcId:`rpc:${id}`},content:[{type:'text',text}]});

test('one explicit owner message closes an active attempt after durable settlement',async()=>{
  const f=await fixture();try {
    const input=f.store.getRunInput(f.run.id);
    await f.emit('user/message',JSON.parse(input.messageJson!));
    f.deferStop();
    const chat=f.chat(),text='不做了，关闭这个任务';
    const args={action:'close',userInstruction:text,expectedRowVersion:f.store.getTask(f.task.id).rowVersion};
    await assert.rejects(chat.call('automatic-close',args),{code:'human-message-required'});
    await chat.human(text);
    const started=await chat.call('close',args);
    assert.equal(started.task.controlMode,'paused');
    assert.equal(started.task.lifecycle,'open');
    assert.equal(started.run?.state,'cancelling');
    assert.equal(started.closeRequest?.runId,f.run.id);
    assert.equal(f.cancels(),1);
    assert.deepEqual(await chat.call('close',args),started);
    assert.throws(()=>f.store.controlTask('resume',f.task.id,started.task.rowVersion,'auto'),{code:'task-closing'});
    await chat.end();
    f.finishIdle();
    await f.emit('turn/end',{turn:1,reason:{kind:'aborted',reason:{kind:'user'}}});
    await new Promise<void>(resolve=>setImmediate(resolve));
    const detail=f.store.taskDetail(f.task.id);
    assert.equal(detail.task.lifecycle,'cancelled');
    assert.equal(detail.closeRequest,null);
    assert.equal(detail.binding?.id,f.run.bindingId);
    assert.equal(detail.run?.id,f.run.id);
    assert.equal(detail.input?.id,input.id);
    assert.equal(f.cancels(),1);
    assert.equal(detail.events.filter(event=>event.kind==='task.cancelled').length,1);
    assert.ok(f.store.pendingManagerEvents(f.bot.id).some(event=>event.id===`manager-event:task-closed:${started.closeRequest?.id}`));
  }finally{await f.close();}
});

test('a stopped opaque CLI cannot resolve its own external effects even with a successful tool receipt',async()=>{
  const f=await fixture();try {
    const input=f.store.getRunInput(f.run.id);
    await f.emit('user/message',JSON.parse(input.messageJson!));
    await f.emit('tool/call',{turn:1,step:1,callId:'opaque',name:'bash',arguments:JSON.stringify({command:'synthetic-cli start'})});
    await f.emit('tool/result',{turn:1,step:1,message:{toolCallId:'opaque',isError:false,content:[{type:'text',text:'Started'}]}});
    f.deferStop();
    const version=f.store.getTask(f.task.id).rowVersion;
    const closing=await f.execution.closeTask('panel-close',f.task.id,version);
    f.finishIdle();
    await f.emit('turn/end',{turn:1,reason:{kind:'aborted',reason:{kind:'user'}}});
    await new Promise<void>(resolve=>setImmediate(resolve));
    const detail=f.store.taskDetail(f.task.id);
    assert.equal(detail.run?.state,'cancelled');
    assert.equal(detail.task.lifecycle,'open');
    assert.equal(detail.task.controlMode,'paused');
    assert.equal(detail.closeRequest?.id,closing.closeRequest?.id);
    assert.equal(detail.closeRequest?.blocker?.code,'effect-uncertain');
    assert.match(detail.closeRequest?.blocker?.message??'',/bash/);
    assert.equal(f.execution.recoveryDetail(detail)?.canContinue,false);
    assert.throws(()=>f.store.cancelTask('old-cancel',f.task.id,detail.task.rowVersion),{code:'task-closing'});
    assert.equal((await f.execution.closeTask('retry',f.task.id,detail.task.rowVersion)).task.lifecycle,'open');
    await assert.rejects(f.execution.recover('unchecked',f.task.id,detail.task.rowVersion,false),{code:'confirmation-required'});
    const closed=await f.execution.recover('checked',f.task.id,detail.task.rowVersion,true);
    assert.ok('lifecycle' in closed);
    assert.equal(closed.lifecycle,'cancelled');
    assert.ok(f.store.taskDetail(f.task.id).events.some(event=>event.kind==='task.close-blocked'));
  }finally{await f.close();}
});

for(const durable of [true,false])test(`restart ${durable?'replays verified settlement':'keeps a concrete blocker'} for a pending close`,async()=>{
  const f=await fixture();try {
    await f.emit('user/message',JSON.parse(f.store.getRunInput(f.run.id).messageJson!));
    f.deferStop();
    const pending=await f.execution.closeTask('close-before-restart',f.task.id,f.store.getTask(f.task.id).rowVersion);
    if(durable)f.store.observeRunEnd(f.run.id,f.recordEnd(),'aborted',true);
    const path=resolve(f.directory,'close-restart.sqlite');
    f.store.backupLedger(path);
    const reopened=new Store(path),restarted=new DshExecution(f.ctx,reopened,f.directory);
    try {
      f.agent.status='idle';
      restarted.install();await restarted.whenReconciled();
      const detail=reopened.taskDetail(f.task.id);
      assert.equal(f.cancels(),1,'startup does not signal cancellation again');
      if(durable) {
        assert.equal(detail.task.lifecycle,'cancelled');
        assert.equal(detail.run?.state,'cancelled');
        assert.equal(detail.closeRequest,null);
      } else {
        assert.equal(detail.task.lifecycle,'open');
        assert.equal(detail.closeRequest?.id,pending.closeRequest?.id);
        assert.match(detail.closeRequest?.blocker?.message??'',/重启后缺少/);
        assert.equal(reopened.heldRuns()[0]?.id,f.run.id);
      }
    }finally{await restarted.dispose();reopened.close();}
  }finally{await f.close();}
});

test('a queued next-turn message during an automatic run does not interrupt or cancel',async()=>{
  const f=await fixture();try {
    await f.emit('user/message',JSON.parse(f.store.getRunInput(f.run.id).messageJson!));
    await f.emit('agent/inbox/spliced',{inserted:[user('queued','下一轮再看目录')]});
    assert.equal(f.cancels(),0);assert.equal(f.removed().length,0);
    assert.equal(f.store.getTask(f.task.id).controlMode,'auto');
    assert.equal(f.store.getRun(f.run.id).state,'running');
    assert.equal(f.store.getRun(f.run.id).finishedAt,null);
    assert.equal(f.agent.status,'running');assert.equal(f.released(),false);
  }finally{await f.close();}
});

test('a mid-turn steer claimed as user/message does not take over or cancel',async()=>{
  const f=await fixture();try {
    await f.emit('user/message',f.store.getRunInput(f.run.id).messageJson?JSON.parse(f.store.getRunInput(f.run.id).messageJson!):{});
    await f.emit('agent/inbox/spliced',{inserted:[user('steer','先检查测试')]});
    await f.emit('user/message',user('steer','先检查测试'));
    assert.equal(f.cancels(),0);assert.equal(f.store.getTask(f.task.id).controlMode,'auto');
    assert.equal(f.store.getRun(f.run.id).finishedAt,null);assert.equal(f.released(),false);
  }finally{await f.close();}
});

test('a human new turn after the automatic turn ends records takeover without cancelling',async()=>{
  const f=await fixture();try {
    await f.emit('user/message',JSON.parse(f.store.getRunInput(f.run.id).messageJson!));
    await f.emit('agent/inbox/spliced',{inserted:[user('next','自动轮结束后再说')]});
    await f.emit('turn/end',{turn:1,reason:{kind:'completed'}});
    assert.equal(f.store.getRun(f.run.id).state,'interrupted','missing report is reconciled at its own turn end');assert.equal(f.store.getTask(f.task.id).controlMode,'auto');
    f.agent.status='running';
    await f.emit('turn/start',{turn:2});
    await f.emit('user/message',user('next','自动轮结束后再说'));
    assert.equal(f.cancels(),0);assert.equal(f.removed().length,0);
    assert.equal(f.store.getTask(f.task.id).controlMode,'manual');
    assert.equal(f.store.getRun(f.run.id).state,'interrupted');
    assert.ok(f.store.getRun(f.run.id).finishedAt);
    assert.equal(f.released(),true,'old restrictions must drop immediately so whenIdle following the new driver is not required');
    f.finishIdle();await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(f.store.getRun(f.run.id).state,'interrupted');assert.equal(f.store.heldRuns().length,1);
  }finally{await f.close();}
});


test('ready settles at its own turn/end before queued human work, without waiting for whole-session idle',async()=>{
  const f=await fixture();try {
    await f.emit('user/message',JSON.parse(f.store.getRunInput(f.run.id).messageJson!));
    const file=resolve(f.directory,'result.md');writeFileSync(file,'Synthetic evidence');
    f.store.workerReport(f.run.id,'ready',{kind:'ready',summary:'Checked',checks:'Read file',evidence:await collectEvidence(f.directory,[file])});
    await f.emit('agent/inbox/spliced',{inserted:[user('followup','New work')]});
    await f.emit('turn/end',{turn:1,reason:{kind:'completed'}});
    assert.equal(f.agent.status,'running');assert.equal(f.store.getRun(f.run.id).state,'settled');
    assert.equal(f.store.heldRuns().length,0);assert.equal(f.released(),true);
    await f.emit('turn/start',{turn:2});await f.emit('user/message',user('followup','New work'));
    assert.equal(f.store.getRun(f.run.id).state,'settled');assert.equal(f.store.getTask(f.task.id).controlMode,'manual');
    assert.equal(f.cancels(),0);assert.equal(f.store.taskDetail(f.task.id).attentions.some(a=>a.kind==='recovery'),false);
    await f.execution.dispose();assert.equal(f.cancels(),0,'disposing old execution cannot cancel the human turn');
  }finally{await f.close();}
});

for(const reason of ['aborted','error'])test(`${reason} turn with a ready report is recovery, never successful settlement`,async()=>{
  const f=await fixture();try {
    await f.emit('user/message',JSON.parse(f.store.getRunInput(f.run.id).messageJson!));
    const file=resolve(f.directory,'result.md');writeFileSync(file,'Candidate only');
    f.store.workerReport(f.run.id,'ready',{kind:'ready',summary:'Candidate',checks:'Read file',evidence:await collectEvidence(f.directory,[file])});
    await f.emit('turn/end',{turn:1,reason:reason==='error'?{kind:reason,error:{code:'SYNTHETIC'}}:{kind:reason,reason:{kind:'user'}}});
    assert.equal(f.store.getRun(f.run.id).state,'interrupted');assert.equal(f.store.heldRuns().length,1);
    assert.equal(f.store.getTask(f.task.id).lifecycle,'open');assert.equal(f.released(),true);
  }finally{await f.close();}
});

test('stopped automatic turn settles cancellation before the native follow-up',async()=>{
  const f=await fixture();try {
    await f.emit('user/message',JSON.parse(f.store.getRunInput(f.run.id).messageJson!));
    f.store.requestStop('stop',f.task.id,f.store.getTask(f.task.id).rowVersion);
    await f.emit('turn/end',{turn:1,reason:{kind:'aborted',reason:{kind:'user'}}});
    assert.equal(f.store.getRun(f.run.id).state,'cancelled');assert.equal(f.store.heldRuns().length,0);
    await f.emit('turn/start',{turn:2});await f.emit('user/message',user('takeover','Continue manually'));
    assert.equal(f.store.getRun(f.run.id).state,'cancelled');assert.equal(f.store.getTask(f.task.id).controlMode,'manual');
    assert.equal(f.released(),true);assert.equal(f.cancels(),0);
  }finally{await f.close();}
});

for(const kind of ['job','child'] as const)test(`turn/end cannot settle ready while a ${kind} still runs`,async()=>{
  const f=await fixture();try {
    await f.emit('user/message',JSON.parse(f.store.getRunInput(f.run.id).messageJson!));
    const file=resolve(f.directory,'result.md');writeFileSync(file,'Candidate only');
    f.store.workerReport(f.run.id,'ready',{kind:'ready',summary:'Candidate',checks:'Read file',evidence:await collectEvidence(f.directory,[file])});
    f.setExternal(kind);await f.emit('turn/end',{turn:1,reason:{kind:'completed'}});
    assert.equal(f.store.getRun(f.run.id).state,'interrupted');assert.equal(f.store.heldRuns().length,1);
    assert.equal(f.store.getTask(f.task.id).lifecycle,'open');assert.equal(f.released(),true);
    assert.equal(f.cancels(),0);
  }finally{await f.close();}
});

for(const failure of ['false','throw'])test(`live ${failure} durability barrier retains recovery lock instead of settling ready`,async()=>{
  const f=await fixture();try {
    await f.emit('user/message',JSON.parse(f.store.getRunInput(f.run.id).messageJson!));
    const file=resolve(f.directory,'result.md');writeFileSync(file,'Candidate');
    f.store.workerReport(f.run.id,'ready',{kind:'ready',summary:'Candidate',checks:'Read',evidence:await collectEvidence(f.directory,[file])});
    f.setFlush(async()=>{if(failure==='throw')throw Error('Synthetic failed persistence');return false;});
    await f.emit('turn/end',{turn:1,reason:{kind:'completed'}});
    assert.equal(f.store.getRun(f.run.id).state,'interrupted');assert.equal(f.store.heldRuns().length,1);
    assert.equal(f.store.runResult(f.run.id)?.humanAcceptedAt,null);
  }finally{await f.close();}
});

test('Stop racing the durability barrier cancels only the old Run, never the following native driver',async()=>{
  const f=await fixture();let resume!:()=>void;try {
    await f.emit('user/message',JSON.parse(f.store.getRunInput(f.run.id).messageJson!));
    const file=resolve(f.directory,'result.md');writeFileSync(file,'Candidate');
    f.store.workerReport(f.run.id,'ready',{kind:'ready',summary:'Candidate',checks:'Read',evidence:await collectEvidence(f.directory,[file])});
    f.setFlush(async()=>{await new Promise<void>(resolve=>{resume=resolve;});return true;});
    const ending=f.emit('turn/end',{turn:1,reason:{kind:'completed'}});
    await new Promise<void>(resolve=>setImmediate(resolve));
    const next=f.emit('turn/start',{turn:2}),human=f.emit('user/message',user('native-during-finalizing','Take over'));
    await new Promise<void>(resolve=>setImmediate(resolve));
    await f.execution.stop('stop-finalizing',f.task.id,f.store.getTask(f.task.id).rowVersion);
    assert.equal(f.cancels(),0);resume();await Promise.all([ending,next,human]);
    assert.equal(f.store.getTask(f.task.id).controlMode,'manual');
    assert.equal(f.store.getRun(f.run.id).state,'cancelled');assert.equal(f.store.heldRuns().length,0);
  }finally{resume?.();await f.close();}
});

test('Bot chat pauses and resumes management during an active attempt without stopping it',async()=>{
  const f=await fixture();try {
    await f.emit('user/message',JSON.parse(f.store.getRunInput(f.run.id).messageJson!));
    const chat=f.chat(),version=f.store.getTask(f.task.id).rowVersion;
    const text='Pause automatic management on the documentation task.';
    const pause={action:'pause',expectedRowVersion:version,userInstruction:text};
    await chat.human(`Do not ${text.replace('Pause','pause')}`);
    await assert.rejects(chat.call('dropped-negation',{...pause,userInstruction:text.replace('Pause','pause')}),{code:'control-human-text'});
    await chat.end();
    await chat.human(text);
    await assert.rejects(chat.call('incorrect-text',{...pause,userInstruction:'Model-invented request'}),{code:'control-human-text'});
    const paused=await chat.call('pause',pause);
    assert.equal(paused.task.controlMode,'paused');
    assert.equal(paused.task.status,'running');
    assert.equal(paused.run?.id,f.run.id);
    assert.deepEqual(await chat.call('pause',pause),paused);
    await chat.end();
    await chat.human('Resume automatic management for that task.');
    const resume={action:'resume',userInstruction:'Resume automatic management for that task.'};
    await assert.rejects(chat.call('stale-resume',{...resume,expectedRowVersion:version}),{code:'version-conflict'});
    const resumed=await chat.call('resume',resume);
    assert.equal(resumed.task.controlMode,'auto');
    assert.equal(resumed.run?.state,'running');
    assert.ok(f.store.pendingManagerEvents(f.bot.id).some(event=>event.id===`manager-event:resume:${f.task.id}:${resumed.task.rowVersion}`));
    assert.deepEqual(f.store.taskRuns(f.task.id).map(run=>run.id),[f.run.id]);
    assert.equal(f.cancels(),0);
    assert.deepEqual(f.removed(),[]);
  }finally{await f.close();}
});

test('chat stop targets an exact run; task cancellation waits for settlement and preserves history',async()=>{
  const f=await fixture();try {
    const input=f.store.getRunInput(f.run.id);
    await f.emit('user/message',JSON.parse(input.messageJson!));
    const chat=f.chat();f.deferStop();
    await chat.human('Cancel the documentation task.');
    const cancel={action:'cancel',userInstruction:'Cancel the documentation task.'};
    await assert.rejects(chat.call('cancel-running',cancel),{code:'session-busy'});
    await chat.end();
    await chat.human('Stop the current documentation run.');
    const stop={action:'stop',userInstruction:'Stop the current documentation run.',runId:f.run.id};
    await assert.rejects(chat.call('wrong-run',{...stop,runId:'older-run'}),{code:'run-stale'});
    await assert.rejects(chat.call('no-run',{...stop,runId:undefined}),{code:'invalid-input'});
    assert.equal(f.cancels(),0);
    const version=f.store.getTask(f.task.id).rowVersion;
    const stopping=await chat.call('stop',{...stop,expectedRowVersion:version});
    assert.deepEqual(stopping.stop,{runId:f.run.id,requested:true});
    assert.equal(stopping.task.status,'stopping');
    assert.equal(stopping.task.lifecycle,'open');
    assert.equal(stopping.task.controlMode,'paused');
    assert.equal(stopping.run?.state,'cancelling');
    assert.deepEqual(await chat.call('stop',{...stop,expectedRowVersion:version}),stopping);
    assert.deepEqual(await chat.call('stop-again',stop),stopping);
    assert.equal(f.cancels(),1);
    assert.deepEqual(f.removed(),[input.messageId]);
    let finishFlush!:()=>void,entered!:()=>void;
    const flush=new Promise<void>(resolve=>{finishFlush=resolve;});
    const settling=new Promise<void>(resolve=>{entered=resolve;});
    f.setFlush(async()=>{entered();await flush;return true;});
    const ending=f.emit('turn/end',{turn:1,reason:{kind:'aborted',reason:{kind:'user'}}});
    await settling;
    try {
      assert.deepEqual(await chat.call('stop',{...stop,expectedRowVersion:version}),stopping);
      await assert.rejects(chat.call('fresh-stop-during-settlement',stop),{code:'run-finishing'});
    } finally {finishFlush();await ending;}
    f.finishIdle();
    assert.equal((await chat.call('stop',{...stop,expectedRowVersion:version})).run?.state,'cancelled');
    assert.equal(f.store.getTask(f.task.id).lifecycle,'open');
    await chat.end();
    await chat.human('Cancel the documentation task.');
    const cancelled=await chat.call('cancel-settled',cancel);
    assert.equal(cancelled.task.lifecycle,'cancelled');
    assert.equal(cancelled.run?.id,f.run.id);
    assert.equal(f.store.activeBinding(f.task.id)?.id,f.run.bindingId);
    assert.equal(f.store.getRunInput(f.run.id).id,input.id);
    assert.equal(f.cancels(),1);
  }finally{await f.close();}
});

test('an explicit work link in the current owner message binds chat control to its task',async()=>{
  const f=await fixture();try {
    const other=f.store.createTask('second-task',{botId:f.bot.id,goal:'Other task',scope:'Local',acceptance:'Read',reviewPolicy:'human'});
    const chat=f.chat(),path=workUrl({kind:'result',taskId:other.id,resultId:f.run.id});
    const text=`Pause automatic management for [this work](http://127.0.0.1:6123${path}).`;
    const pause={action:'pause',userInstruction:text};
    await chat.human(text);
    await assert.rejects(chat.call('wrong-task',pause),{code:'control-task-link'});
    assert.equal(f.store.getTask(f.task.id).controlMode,'auto');
    assert.equal((await chat.call('linked-task',{...pause,taskId:other.id,expectedRowVersion:other.rowVersion})).task.controlMode,'paused');
    await chat.end();
    const conflicting=`Pause ${workUrl({kind:'task',taskId:f.task.id})} and ${path}`;
    await chat.human(conflicting);
    await assert.rejects(chat.call('multiple-tasks',{...pause,userInstruction:conflicting}),{code:'control-task-link'});
  }finally{await f.close();}
});

test('a fresh chat stop leaves a normally finishing Run and its result untouched',async()=>{
  const f=await fixture();try {
    await f.emit('user/message',JSON.parse(f.store.getRunInput(f.run.id).messageJson!));
    const file=resolve(f.directory,'result.md');writeFileSync(file,'Candidate');
    f.store.workerReport(f.run.id,'ready',{kind:'ready',summary:'Candidate',checks:'Read',evidence:await collectEvidence(f.directory,[file])});
    const chat=f.chat(),text='Stop the current documentation run.';
    await chat.human(text);
    let finishFlush!:()=>void,entered!:()=>void;
    const flush=new Promise<void>(resolve=>{finishFlush=resolve;});
    const settling=new Promise<void>(resolve=>{entered=resolve;});
    f.setFlush(async()=>{entered();await flush;return true;});
    const before=f.store.getTask(f.task.id);
    const ending=f.emit('turn/end',{turn:1,reason:{kind:'completed'}});
    await settling;
    try {
      await assert.rejects(chat.call('late-exact-stop',{action:'stop',runId:f.run.id,userInstruction:text}),{code:'run-finishing'});
      assert.equal(f.store.getRun(f.run.id).state,'running');
      assert.deepEqual(f.store.getTask(f.task.id),before);
      assert.equal(f.cancels(),0);
    } finally {finishFlush();await ending;}
    assert.equal(f.store.getRun(f.run.id).state,'settled');
    assert.equal(f.store.getTask(f.task.id).lifecycle,'review');
    assert.equal(f.store.runResult(f.run.id)?.humanAcceptedAt,null);
  }finally{await f.close();}
});

test('a native stop exception moves the Run to recovery without a stopped receipt',async()=>{
  const f=await fixture();const cancel=f.agent.cancel;
  try {
    await f.emit('user/message',JSON.parse(f.store.getRunInput(f.run.id).messageJson!));
    const chat=f.chat(),text='Stop the current documentation run.';
    await chat.human(text);
    let attempts=0;
    f.agent.cancel=()=>{attempts++;throw Error('Synthetic native cancellation failure');};
    const stop={action:'stop',runId:f.run.id,userInstruction:text,expectedRowVersion:f.store.getTask(f.task.id).rowVersion};
    const recovery=await chat.call('native-stop-error',stop);
    assert.deepEqual(recovery.stop,{runId:f.run.id,requested:true});
    assert.equal(recovery.task.status,'recovery');
    assert.equal(recovery.task.lifecycle,'open');
    assert.equal(recovery.run?.state,'interrupted');
    assert.ok(f.store.heldRuns().some(run=>run.id===f.run.id));
    assert.deepEqual(await chat.call('native-stop-error',stop),recovery);
    assert.equal(attempts,1);
    await f.emit('turn/end',{turn:1,reason:{kind:'aborted',reason:{kind:'user'}}});
    f.finishIdle();
    assert.equal(f.store.getRun(f.run.id).state,'interrupted');
  }finally{f.agent.cancel=cancel;await f.close();}
});

test('chat controls reject notices, non-owner prompts, edits, expired turns and other Bots',async()=>{
  const f=await fixture();try {
    const chat=f.chat(),text='Cancel the documentation task.',cancel={action:'cancel',userInstruction:text};
    const notice={...user('notice',text),source:{kind:'super-bot-manager',botId:f.bot.id,managerId:chat.manager.id,eventId:'synthetic'}};
    await chat.event('user/message',user('outside-turn',text),'append');
    await assert.rejects(chat.call('outside-turn',cancel),{code:'human-message-required'});
    await chat.event('turn/start',{turn:1});
    const guest=user('guest',text);
    await chat.event('user/message',{...guest,source:{...guest.source,principal:{kind:'synthetic'}}},'append');
    await chat.event('user/message',user('edit',text),'replace');
    await assert.rejects(chat.call('guest-and-edit',cancel),{code:'human-message-required'});
    await chat.event('user/message',notice,'append');
    await assert.rejects(chat.call('notice-only',cancel),{code:'human-message-required'});
    await chat.event('user/message',user('mixed-owner',text),'append');
    await assert.rejects(chat.call('notice-and-owner',cancel),{code:'human-message-required'});
    await chat.end();
    const other=f.store.createBot('other',{name:'Other',instructions:'Synthetic'});
    const foreign=f.store.createTask('foreign',{botId:other.id,goal:'Other',scope:'Local',acceptance:'Read',reviewPolicy:'human'});
    await chat.human(text);
    await assert.rejects(chat.call('cross-bot',{...cancel,taskId:foreign.id,expectedRowVersion:foreign.rowVersion}),{code:'manager-scope'});
    await chat.end();
    await assert.rejects(chat.call('ended-turn',cancel),{code:'human-message-required'});
    assert.equal(f.store.getTask(f.task.id).lifecycle,'open');
    assert.deepEqual(f.store.getTask(foreign.id),foreign);
    assert.equal(f.cancels(),0);
  }finally{await f.close();}
});

test('chat cancellation rechecks native human authority, signal and task version after resolving the Worker',async()=>{
  const f=await fixture();try {
    // This fixture has no external work. Settle its synthetic Run before exercising cancellation.
    f.store.requestStop('fixture-stop',f.task.id,f.store.getTask(f.task.id).rowVersion);
    f.store.settleCancelled(f.run.id);
    f.finishIdle();
    const chat=f.chat(),text='Cancel the documentation task.',cancel={action:'cancel',userInstruction:text};
    await chat.human(text);
    f.beforeResolve(chat.end);
    await assert.rejects(chat.call('turn-ended-during-lookup',cancel),{code:'human-message-required'});
    await chat.human(text);
    const abort=new AbortController();
    f.beforeResolve(async()=>abort.abort());
    await assert.rejects(chat.call('aborted-during-lookup',cancel,abort.signal),{name:'AbortError'});
    f.beforeResolve(async()=>{f.store.controlTask('ui-race',f.task.id,f.store.getTask(f.task.id).rowVersion,'auto');});
    await assert.rejects(chat.call('row-changed-during-lookup',cancel),{code:'version-conflict'});
    f.beforeResolve(async()=>{f.store.detachSession('ui-detach',f.task.id,f.store.getTask(f.task.id).rowVersion);});
    await assert.rejects(chat.call('binding-released-during-lookup',cancel),{code:'version-conflict'});
    const binding=f.store.beginBinding('ui-prepare',f.task.id,f.store.getTask(f.task.id).rowVersion,f.directory);
    f.store.confirmBinding(binding.id,binding.requestedSessionId);
    f.beforeResolve(async()=>{f.store.releaseManager('release',f.bot.id,chat.manager.generation);});
    await assert.rejects(chat.call('released-during-lookup',cancel),{code:'manager-scope'});
    assert.equal(f.store.getTask(f.task.id).lifecycle,'open');
    assert.equal(f.cancels(),0);
  }finally{await f.close();}
});

test('chat stop reports recovery when the exact Run has no live execution handle',async()=>{
  const f=await fixture();try {
    const task=f.store.createTask('orphan-task',{botId:f.bot.id,goal:'Other documentation',scope:'Local',acceptance:'Read',reviewPolicy:'human'});
    const binding=f.store.beginBinding('orphan-binding',task.id,task.rowVersion,f.directory);
    f.store.confirmBinding(binding.id,binding.requestedSessionId);
    const run=f.store.reserveRun('orphan-run',task.id,f.store.getTask(task.id).rowVersion);
    const chat=f.chat(),text='Stop the other documentation run.';
    await chat.human(text);
    const stopped=await chat.call('orphan-stop',{action:'stop',taskId:task.id,runId:run.id,userInstruction:text,
      expectedRowVersion:f.store.getTask(task.id).rowVersion});
    assert.equal(stopped.stop?.requested,true);
    assert.equal(stopped.task.status,'recovery');
    assert.equal(stopped.run?.state,'interrupted');
    assert.equal(stopped.task.lifecycle,'open');
    assert.ok(f.store.heldRuns().some(held=>held.id===run.id));
    assert.equal(f.cancels(),0);
  }finally{await f.close();}
});
