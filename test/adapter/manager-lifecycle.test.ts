import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import {apply as applyClient} from '../../src/client.tsx';
import {Store} from '../../src/store.ts';
import {Managers} from '../../src/manager.ts';
import type {DshExecution} from '../../src/dsh.ts';
import type {RuntimeOptions} from '../../src/runtime.ts';
import type {WorkspaceApi} from '../../src/ui/work/api.ts';

function fixture(options:RuntimeOptions={}){
  const directory=mkdtempSync(join(tmpdir(),'super-bot-manager-retry-')),store=new Store(':memory:');
  const bot=store.createBot('bot',{name:'Bot',instructions:'Original config'});
  const agents=new Map<string,any>();let creates=0,resolves=0;
  let beforeResolve:((id:string)=>Promise<void>)|undefined;
  let agentCreated:((event:{agent:any})=>void)|undefined;
  const titles=new Map<any,any>();
  const ctx={
    effect:(register:()=>void)=>register(),tools:{register:()=>()=>{}},
    agents:{list:()=>[],get:(id:string)=>agents.get(id)},jobs:{list:()=>[]},
    on:(event:string,handler:typeof agentCreated)=>{if(event==='agent/created')agentCreated=handler;return ()=>{};},
    permissionPresets:{set:()=>{}},
    sessionTitle:{get:(session:any)=>titles.get(session),rename:(session:any,title:string)=>{const value={title,source:{kind:'user'}};titles.set(session,value);return value;}},
    sessions:{flush:async()=>true},
    sessionProjections:{snapshot:(session:any)=>({values:{modelSelection:{next:agents.get(session.id).selection}}})},
    workspaceRegistry:{create:async(cwd:string)=>({id:cwd,attachSession:async()=>{}})},
    sessionController:{
      create:async({sessionId,workspaceId}:any)=>{
        creates++;
        const agent:any={id:sessionId,session:{id:sessionId,header:{id:sessionId,cwd:workspaceId,isSeeded:false}},
          status:'idle',inbox:{nextTurn:[],nextStep:[]},whenIdle:async()=>{},selection:null,
          ctx:{tools:{restrict:()=>()=>{},guard:()=>()=>{}},on:()=>()=>{},systemPrompt:{section:()=>()=>{}}}};
        agent.model={select:(model:any)=>{agent.selection=model;}};
        agents.set(sessionId,agent);agentCreated?.({agent});return {sessionId};
      },
      rename:async()=>{},resolveAgent:async(id:string)=>{resolves++;await beforeResolve?.(id);return agents.has(id)?{agent:agents.get(id)}:{error:'missing'};},
    },
  } as unknown as Context;
  const createManagers=()=>new Managers(ctx,store,{} as DshExecution,directory,undefined,options);
  const managers=createManagers();
  return {store,bot,managers,agents,counts:()=>({creates,resolves}),beforeResolve:(callback:(id:string)=>Promise<void>)=>{beforeResolve=callback;},
    reopenAgent:(id:string)=>agentCreated?.({agent:agents.get(id)}),createManagers,
    close:async()=>{await managers.dispose();store.close();rmSync(directory,{recursive:true,force:true});}};
}
const model={provider:'fake',model:'explicit-original'};

test('reopening Bot chats preserves their own selections and only a new chat receives the Manager default', async () => {
  const managerModel={provider:'fake',model:'manager-default'};
  const f=fixture({managerModel});f.managers.install();
  try {
    const {sessionId}=await f.managers.prepare('open-a',f.bot.id);
    const a=f.agents.get(sessionId!);
    assert.deepEqual(a.selection,managerModel);
    a.model.select(model);

    const other=f.store.createBot('other',{name:'Other',instructions:'Synthetic'});
    const b=await f.managers.prepare('open-b',other.id);
    assert.deepEqual(f.agents.get(b.sessionId!).selection,managerModel);
    assert.equal((await f.managers.prepare('reopen-a',f.bot.id)).sessionId,sessionId);
    assert.deepEqual(a.selection,model);
  } finally { await f.close(); }
});

test('a cold Manager attachment preserves the persisted selection', async () => {
  const f=fixture({managerModel:{provider:'fake',model:'manager-default'}});
  const restored=f.createManagers();
  try {
    const {sessionId}=await f.managers.prepare('open',f.bot.id);
    const agent=f.agents.get(sessionId!);
    agent.model.select(model);
    restored.install();
    f.reopenAgent(sessionId!);
    assert.deepEqual(agent.selection,model);
  } finally { await restored.dispose();await f.close(); }
});

test('client openBot reuses the ready native chat and follows its replacement', async () => {
  const f = fixture();
  try {
    const opened: string[] = [];
    let api: WorkspaceApi | undefined;
    let navigation = new AbortController();
    applyClient({
      effect: () => {},
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (slot: { name: string; key?: string }, render: () => { props: { api: WorkspaceApi } }) => {
          if (slot.name === 'main' && slot.key === 'super-bot') api = render().props.api;
        },
      },
      connection: { rpc: { call: async (path: string, method: string, payload: Record<string, string>) => {
        assert.equal(path, '/api');
        assert.equal(method, 'super-bot');
        assert.equal(payload.action, 'manager.prepare');
        assert.equal(payload.botId, f.bot.id);
        return { ok: true, value: await f.managers.prepare(payload.requestId, payload.botId) };
      } } },
      layout: { beginNavigation: () => {
        navigation.abort();
        navigation = new AbortController();
        return navigation.signal;
      } },
      uiWorkspace: { openSession: (id: string) => opened.push(id) },
    } as unknown as Context);
    assert.ok(api);

    const first = await f.managers.prepare('first', f.bot.id);
    await api.openBot(f.bot.id);
    await api.openBot(f.bot.id);
    assert.deepEqual(opened, [first.sessionId, first.sessionId]);
    assert.equal(f.counts().creates, 1);

    const next = await f.managers.replace('replacement', f.bot.id, first.generation);
    assert.notEqual(next.sessionId, first.sessionId);
    await api.openBot(f.bot.id);
    assert.deepEqual(opened, [first.sessionId, first.sessionId, next.sessionId]);
    assert.equal(f.counts().creates, 2);
  } finally { await f.close(); }
});

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

test('deleting a Bot with an unloaded conversation does not resolve or start the native Agent', async () => {
  const f = fixture({ fullAccess: false });
  try {
    const manager = await f.managers.prepare('prepare', f.bot.id);
    f.agents.delete(manager.requestedSessionId);
    const before = f.counts();
    const deletion = await f.managers.deleteBot('delete', f.bot.id, 1, false, () => {});
    assert.equal(deletion.managerSessionId, manager.requestedSessionId);
    assert.equal(f.store.getManager(manager.id).state, 'released');
    assert.deepEqual(f.counts(), before);
    await assert.rejects(f.managers.prepare('prepare', f.bot.id), { code: 'not-found' });
    assert.deepEqual(f.counts(), before);
  } finally { await f.close(); }
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
    f.beforeResolve(async id=>{if(id!==first.sessionId&&f.store.activeManager(f.bot.id)?.state==='ready')f.store.updateBot('update',f.bot.id,1,{name:'Changed',instructions:'New config'},[]);});
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
