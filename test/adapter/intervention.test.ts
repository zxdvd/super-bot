/** Queue or steer on a running Worker must not abort the automatic turn. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import {Store} from '../../src/store.ts';
import {DshExecution} from '../../src/dsh.ts';
import {collectEvidence} from '../../src/evidence.ts';

async function fixture() {
  let external:'job'|'child'|undefined;
  let flush:()=>Promise<boolean>=async()=>true;
  mkdirSync(resolve('.runtime'),{recursive:true});
  const directory=realpathSync(mkdtempSync(resolve('.runtime/intervention-'))),store=new Store(':memory:');
  const bot=store.createBot('bot',{name:'接管回归',instructions:'合成测试'});
  const task=store.createTask('task',{botId:bot.id,goal:'写说明',scope:'任务目录',acceptance:'回读',reviewPolicy:'human'});
  const binding=store.beginBinding('bind',task.id,task.rowVersion,directory);store.confirmBinding(binding.id,binding.requestedSessionId);
  const sessionEvents:Function[]=[],events:any[]=[];
  let cancels=0,removed:string[]=[],released=false,finish!:()=>void;
  const idle=new Promise<void>(resolve=>{finish=resolve;});
  const agent:any={id:binding.requestedSessionId,session:{id:binding.requestedSessionId},status:'idle',
    inbox:{nextTurn:[],nextStep:[],remove:(id:string)=>removed.push(id)},
    ctx:{tools:{restrict:()=>()=>{released=true;},guard:()=>()=>{released=true;}},on:()=>()=>{}},
    followup:()=>{agent.status='running';},whenIdle:()=>idle,cancel:()=>{cancels++;agent.status='idle';finish();}};
  const ctx={permissionPresets:{set:()=>{}},
    effect:(callback:()=>unknown)=>callback(),
    on:(name:string,fn:Function)=>{if(name==='session/event')sessionEvents.push(fn);return ()=>{};},
    tools:{register:()=>()=>{}},sessions:{flush:()=>flush()},
    sessionPersistence:{open:async()=>({header:{id:agent.id},read:async()=>({events:structuredClone(events)}),close:async()=>{}})},
    sessionController:{resolveAgent:async()=>({agent})},
    sessionProjections:{snapshot:()=>({values:{modelSelection:{next:{provider:'fake',model:'fake'}}}})},
    workingDirectory:{get:()=>directory},jobs:{list:()=>external==='job'?[{owner:agent.id,status:'running'}]:[]},agents:{list:()=>external==='child'?[{}]:[],isOwnedBy:()=>external==='child'}} as unknown as Context;
  const execution=new DshExecution(ctx,store,directory,{fullAccess:true});execution.install();
  const emit=async(type:string,data:any)=>{const event={type,data,seq:events.length,time:Date.now(),...(type==='user/message'?{surfaceOp:'append'}:{})};events.push(event);for(const fn of sessionEvents)await fn(agent.session,event);await execution.whenReconciled();};
  const run=await execution.dispatch('dispatch',task.id,store.getTask(task.id).rowVersion);
  await emit('turn/start',{turn:1});
  return {directory,store,task,agent,run,emit,execution,setFlush:(fn:()=>Promise<boolean>)=>{flush=fn;},setExternal:(value:'job'|'child')=>{external=value;},cancels:()=>cancels,removed:()=>removed,released:()=>released,
    finishIdle:()=>{agent.status='idle';finish();},
    close:async()=>{agent.status='idle';finish();await execution.dispose();store.close();rmSync(directory,{recursive:true,force:true});}};
}

const user=(id:string,text:string)=>({id,source:{kind:'user',rpcId:`rpc:${id}`},content:[{type:'text',text}]});

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
