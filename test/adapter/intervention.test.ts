/** Queue or steer on a running Worker must not abort the automatic turn. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import {Store} from '../../src/store.ts';
import {DshExecution} from '../../src/dsh.ts';

async function fixture() {
  mkdirSync(resolve('.runtime'),{recursive:true});
  const directory=realpathSync(mkdtempSync(resolve('.runtime/intervention-'))),store=new Store(':memory:');
  const bot=store.createBot('bot',{name:'接管回归',instructions:'合成测试'});
  const task=store.createTask('task',{botId:bot.id,goal:'写说明',scope:'任务目录',acceptance:'回读',reviewPolicy:'human'});
  const binding=store.beginBinding('bind',task.id,task.rowVersion,directory);store.confirmBinding(binding.id,binding.requestedSessionId);
  const sessionEvents:Function[]=[];
  let cancels=0,removed:string[]=[],released=false,finish!:()=>void;
  const idle=new Promise<void>(resolve=>{finish=resolve;});
  const agent:any={id:binding.requestedSessionId,session:{id:binding.requestedSessionId},status:'idle',
    inbox:{nextTurn:[],nextStep:[],remove:(id:string)=>removed.push(id)},
    ctx:{tools:{restrict:()=>()=>{released=true;},guard:()=>()=>{released=true;}},on:()=>()=>{}},
    followup:()=>{agent.status='running';},whenIdle:()=>idle,cancel:()=>{cancels++;agent.status='idle';finish();}};
  const ctx={permissionPresets:{set:()=>{}},
    effect:(callback:()=>unknown)=>callback(),
    on:(name:string,fn:Function)=>{if(name==='session/event')sessionEvents.push(fn);return ()=>{};},
    tools:{register:()=>()=>{}},
    sessionController:{resolveAgent:async()=>({agent})},
    sessionProjections:{snapshot:()=>({values:{modelSelection:{next:{provider:'fake',model:'fake'}}}})},
    workingDirectory:{get:()=>directory},jobs:{list:()=>[]},agents:{list:()=>[],isOwnedBy:()=>false}} as unknown as Context;
  const execution=new DshExecution(ctx,store,directory,{fullAccess:true});execution.install();
  const emit=async(type:string,data:any)=>{for(const fn of sessionEvents)await fn(agent.session,{type,data,seq:1,time:Date.now()});};
  const run=await execution.dispatch('dispatch',task.id,store.getTask(task.id).rowVersion);
  return {directory,store,task,agent,run,emit,execution,cancels:()=>cancels,removed:()=>removed,released:()=>released,
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
    await f.emit('turn/start',{turn:1});
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
    await f.emit('turn/start',{turn:1});
    await f.emit('agent/inbox/spliced',{inserted:[user('next','自动轮结束后再说')]});
    await f.emit('turn/end',{turn:1,reason:{kind:'completed'}});
    assert.equal(f.store.getRun(f.run.id).finishedAt,null);assert.equal(f.store.getTask(f.task.id).controlMode,'auto');
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
