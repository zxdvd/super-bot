import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import {Store} from '../../src/store.ts';
import {Managers} from '../../src/manager.ts';
import type {DshExecution} from '../../src/dsh.ts';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'super-bot-manager-retry-')),store=new Store(':memory:');
  const bot=store.createBot('bot',{name:'Bot',instructions:'Original config'});
  const agents=new Map<string,any>();let creates=0,resolves=0;
  let beforeResolve:((id:string)=>Promise<void>)|undefined;
  const ctx={
    sessionProjections:{snapshot:(session:any)=>({values:{modelSelection:{next:agents.get(session.id).selection}}})},
    workspaceRegistry:{create:async(cwd:string)=>({id:cwd,setTitle:async()=>{}})},
    sessionController:{
      create:async({sessionId,workspaceId}:any)=>{creates++;const agent:any={id:sessionId,session:{id:sessionId,header:{cwd:workspaceId}},status:'idle',inbox:{nextTurn:[],nextStep:[]},selection:null};agent.model={select:(model:any)=>{agent.selection=model;}};agents.set(sessionId,agent);return {sessionId};},
      rename:async()=>{},resolveAgent:async(id:string)=>{resolves++;await beforeResolve?.(id);return agents.has(id)?{agent:agents.get(id)}:{error:'missing'};},
    },
  } as unknown as Context;
  const managers=new Managers(ctx,store,{} as DshExecution,directory);
  return {store,bot,managers,agents,counts:()=>({creates,resolves}),beforeResolve:(callback:(id:string)=>Promise<void>)=>{beforeResolve=callback;},close:async()=>{await managers.dispose();store.close();rmSync(directory,{recursive:true,force:true});}};
}
const model={provider:'fake',model:'explicit-original'};
test('prepare retries return their own released generation after Bot configuration changes',async()=>{
  const f=fixture();try{
    const first=await f.managers.prepare('prepare',f.bot.id);
    f.store.updateBot('update',f.bot.id,1,{name:'Changed',instructions:'New config'},[]);
    const calls=f.counts();const old=await f.managers.prepare('prepare',f.bot.id);assert.equal(old.id,first.id);assert.equal(old.state,'released');assert.deepEqual(f.counts(),calls);
    const fresh=await f.managers.prepare('fresh',f.bot.id);
    assert.equal((await f.managers.prepare('prepare',f.bot.id)).id,first.id);assert.equal(f.store.activeManager(f.bot.id)?.id,fresh.id);
    const other=f.store.createBot('other',{name:'Other',instructions:'Other'});
    await assert.rejects(f.managers.prepare('prepare',other.id),{code:'idempotency-conflict'});
  }finally{await f.close();}
});
test('completed replacement retry ignores old activity and cannot select a model for later generations',async()=>{
  const f=fixture();try{
    const first=await f.managers.prepare('prepare',f.bot.id);const original=f.agents.get(first.sessionId!);original.selection=model;
    const second=await f.managers.replace('replace',f.bot.id,1);assert.deepEqual(f.agents.get(second.sessionId!).selection,model);
    original.status='running';const calls=f.counts();assert.equal((await f.managers.replace('replace',f.bot.id,1)).id,second.id);assert.deepEqual(f.counts(),calls);
    f.agents.get(second.sessionId!).selection=null;
    await f.managers.replace('replace',f.bot.id,1);assert.equal(f.agents.get(second.sessionId!).selection,null,'retry must preserve a later cleared choice');
    f.store.updateBot('update',f.bot.id,1,{name:'Changed',instructions:'New config'},[]);
    const third=await f.managers.prepare('fresh',f.bot.id);const old=await f.managers.replace('replace',f.bot.id,1);
    assert.equal(old.id,second.id);assert.equal(old.state,'released');assert.equal(f.store.activeManager(f.bot.id)?.id,third.id);assert.equal(f.agents.get(third.sessionId!).selection,null);
    await assert.rejects(f.managers.replace('replace',f.bot.id,2),{code:'idempotency-conflict'});
  }finally{await f.close();}
});
test('interrupted replacement only resumes preparation while its original configuration remains current',async()=>{
  const f=fixture();try{
    await f.managers.prepare('prepare',f.bot.id);f.store.releaseManager('replace',f.bot.id,1);
    const resumed=await f.managers.replace('replace',f.bot.id,1);assert.equal(resumed.generation,2);assert.equal(f.agents.get(resumed.sessionId!).selection,null);
    f.store.releaseManager('interrupted',f.bot.id,2);f.store.updateBot('update',f.bot.id,1,{name:'Changed',instructions:'New config'},[]);
    const calls=f.counts();await assert.rejects(f.managers.replace('interrupted',f.bot.id,2),{code:'manager-stale'});assert.deepEqual(f.counts(),calls);assert.equal(f.store.activeManager(f.bot.id),null);
    await f.managers.prepare('new-config',f.bot.id);await assert.rejects(f.managers.replace('interrupted',f.bot.id,2),{code:'manager-stale'});
  }finally{await f.close();}
});
test('late model inheritance rechecks the prepared generation after resolving its native Agent',async()=>{
  const f=fixture();try{
    const first=await f.managers.prepare('prepare',f.bot.id);f.agents.get(first.sessionId!).selection=model;
    f.beforeResolve(async id=>{if(id!==first.sessionId)f.store.updateBot('update',f.bot.id,1,{name:'Changed',instructions:'New config'},[]);});
    const result=await f.managers.replace('replace',f.bot.id,1);
    assert.equal(result.state,'released');assert.equal(f.agents.get(result.sessionId!).selection,null);assert.equal(f.store.activeManager(f.bot.id),null);
  }finally{await f.close();}
});

test('an interrupted replacement cannot adopt an independently prepared Manager in the same configuration',async()=>{
  const f=fixture();try{
    await f.managers.prepare('prepare',f.bot.id);f.store.releaseManager('interrupted',f.bot.id,1);
    const independent=await f.managers.prepare('independent',f.bot.id),calls=f.counts();
    await assert.rejects(f.managers.replace('interrupted',f.bot.id,1),{code:'manager-stale'});
    assert.deepEqual(f.counts(),calls);assert.equal(f.store.activeManager(f.bot.id)?.id,independent.id);assert.equal(f.agents.get(independent.sessionId!).selection,null);
  }finally{await f.close();}
});
