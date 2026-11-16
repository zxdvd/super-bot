/** Isolated-only notification harness: real Manager adapter, native Agent, events and persistence. */
import type {Context} from '@deepseek-ai/cordis';
import {LlmAdapter,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import type {Agent} from '@deepseek-ai/dsh-agent';
import {SessionId,type SessionStore} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {Store} from '../src/store.ts';
import {Managers} from '../src/manager.ts';
import {DshExecution} from '../src/dsh.ts';
export const name='super-bot-notification-probe';
export const inject=['sessionPersistence','sessions','llm','tools','sessionController','workspaceRegistry','connection','agents','jobs','workingDirectory','sessionProjections','sessionTitle','permissionPresets','systemPrompt'];
const provider='super-bot-notification-probe';
class Provider extends LlmAdapter {
  calls=new Map<string,number>();
  async listModels(){return [{provider,id:'deterministic',name:'No network notification probe'}];}
  async resolveModel(p:string,m:string){return {provider:p,id:m,name:m,context:{contextWindow:200000},defaultMaxTokens:1000};}
  async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
    options.signal?.throwIfAborted();if(options.sessionId)this.calls.set(options.sessionId,(this.calls.get(options.sessionId)??0)+1);
    const text='Synthetic notification received; no task or external action.';
    yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};
    yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};
  }
}
export function apply(ctx:Context,config:{fullAccess?:boolean}={}) {
  const home=process.env.DSH_HOME;assert.ok(home);assert.ok(home.includes('/reliability-notify-')&&home.endsWith('/super-bot/.runtime/dsh'));
  const dir=join(home,'super-bot'),store=new Store(join(dir,'notification-ledger.sqlite')),adapter=new Provider();
  let reads=0;const arms=new Map<string,string>(),held=new Set<string>();
  ctx.effect(()=>ctx.llm.registerAdapter([provider],adapter));
  ctx.on('agent/created',({agent})=>{const cwd=agent.session.header.cwd;if(cwd?.startsWith(dir+'/')&&!existsSync(join(cwd,'.git')))execFileSync('git',['init','--quiet','--template=','--initial-branch=main',cwd]);});
  ctx.on('session/flush',async session=>{if(arms.get(session.id)==='end-durable'&&session.snapshotEvents().some(e=>e.type==='turn/end'&&e.data.reason.kind==='completed')){held.add(session.id);await new Promise<void>(()=>{});}});
  const facade=new Proxy(ctx,{get(target,key){
    if(key==='sessionPersistence')return new Proxy(target.sessionPersistence,{get(service,method){if(method==='open')return (...args:Parameters<typeof service.open>)=>{reads++;return service.open(...args);};const value=Reflect.get(service,method,service);return typeof value==='function'?value.bind(service):value;}});
    return Reflect.get(target,key,target);
  }});
  const execution=new DshExecution(facade,store,dir,{fullAccess:config.fullAccess}),managers=new Managers(facade,store,execution,dir,()=>'',{fullAccess:config.fullAccess,managerWakesPerHour:1});
  managers.install();ctx.effect(()=>async()=>{await managers.dispose();await execution.dispose();store.close();});
  ctx.effect(()=>ctx.connection.fetch.register({path:'/api/super-bot-notification-probe',methods:['POST'],requestBody:'buffered',fetch:async request=>{
    try {
      const body=await request.json() as {action:string;botId?:string;sessionId?:string;eventId?:string;window?:string;requestId?:string};
      if(body.action==='create'){const bot=store.createBot(randomUUID(),{name:'Isolated notification',instructions:'Synthetic only'});store.enqueueManager(bot.id,`notice:${bot.id}`,'Synthetic notice',null);return Response.json({ok:true,botId:bot.id,eventId:`manager-event:notice:${bot.id}`});}
      assert.ok(body.botId);const bot=store.getBot(body.botId);
      if(body.action==='prepare'){const b=await managers.prepare(`prepare:${bot.id}`,bot.id);return Response.json({ok:true,sessionId:b.sessionId});}
      const binding=store.activeManager(bot.id),sid=binding?.sessionId??body.sessionId;
      if(body.action==='select'||body.action==='arm'||body.action==='inspect-agent') {
        assert.ok(sid);const r=await ctx.sessionController.resolveAgent(SessionId(sid));assert.ok('agent' in r);const agent=r.agent;
        if(body.action==='select')agent.model.select({provider,model:'deterministic'});
        if(body.action==='arm') {
          assert.ok(body.window);arms.set(agent.id,body.window);
          if(body.window==='accepted-before-entry') {
            const followup=agent.followup.bind(agent);
            agent.followup=message=>{agent.followup=followup;agent.send(message,'next-turn',false);agent.send(createUserMessage({source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:'Retained isolated human input'}]}),'next-turn',false);held.add(agent.id);};
          }
        }
        return Response.json({ok:true,pending:agent.inbox.nextTurn.length+agent.inbox.nextStep.length,status:agent.status,calls:adapter.calls.get(agent.id)??0});
      }
      if(body.action==='disable'){assert.ok(binding);store.releaseManager(`disable:${bot.id}`,bot.id,binding.generation);}
      if(body.action==='enqueue')store.enqueueManager(bot.id,`second:${bot.id}`,'Second synthetic notice',null);
      if(body.action==='advance') {
        // Only scheduling clocks in THIS isolated ledger. Budgets and message IDs remain untouched.
        store.db.prepare("UPDATE outbox SET payload=json_set(payload,'$.nextAttemptAt',0,'$.nextReconcileAt',0) WHERE kind='manager.notify' AND json_extract(payload,'$.botId')=?").run(bot.id);
      }
      if(body.action==='expire-cap') {
        store.db.prepare("UPDATE events SET createdAt=? WHERE kind='manager.wake' AND json_extract(data,'$.botId')=?").run(Date.now()-3600001,bot.id);
        store.db.prepare("UPDATE outbox SET payload=json_set(payload,'$.nextAttemptAt',0) WHERE kind='manager.notify' AND json_extract(payload,'$.botId')=?").run(bot.id);
      }
      if(body.action==='checkpoint'){assert.ok(sid);const r=await ctx.sessionController.resolveAgent(SessionId(sid));assert.ok('agent' in r);await (ctx.sessions as unknown as SessionStore).flush(r.agent.session);}
      if(['pump','advance','expire-cap'].includes(body.action))await (managers as unknown as {pump():Promise<void>}).pump();
      let events:any[]=[];
      if(sid){const handle=await ctx.sessionPersistence.open(SessionId(sid),'read');try{events=[...(await handle.read()).events];}finally{await handle.close();}}
      const notices=store.db.prepare("SELECT id,state,attempts,payload FROM outbox WHERE kind='manager.notify' AND json_extract(payload,'$.botId')=? ORDER BY createdAt,id").all(bot.id).map(row=>{const p=JSON.parse(String(row.payload));return {id:row.id,state:row.state,attempts:row.attempts,messageId:p.messageId,reconcileAttempts:p.reconcileAttempts,nextAttemptAt:p.nextAttemptAt};});
      return Response.json({ok:true,botId:bot.id,sessionId:sid,notices,reads,held:sid?held.has(sid):false,calls:sid?adapter.calls.get(sid)??0:0,inputs:events.filter(e=>e.type==='user/message'&&e.data.source.kind==='super-bot-manager').map(e=>e.data.id),completed:events.some(e=>e.type==='turn/end'&&e.data.reason.kind==='completed'),tasks:store.db.prepare('SELECT count(*) n FROM tasks').get()?.n});
    }catch(error){return Response.json({ok:false,error:error instanceof Error?error.message:'Harness failure'});}
  }}));
}
