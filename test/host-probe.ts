/** Deterministic adapter inside the real, isolated DSH host. Never shipped in lib/. */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-workspace';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'super-bot-probe': { kind: 'super-bot-probe'; inputId: string };
  }
}
export const name = 'super-bot-probe';
export const inject = ['llm','tools','sessionController','workspaceRegistry','connection'];
const provider = 'super-bot-probe';
const toolName = 'super_bot_probe_report';

class ProbeAdapter extends LlmAdapter {
  calls: {sessionId?: string; ids: string[]; tools: string[]}[] = [];
  async listModels() { return [{provider,id:'deterministic',name:'Super Bot 测试模型（无网络）'}]; }
  async resolveModel(p:string,m:string) { return {provider:p,id:m,name:m,context:{contextWindow:200000},defaultMaxTokens:1000}; }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    this.calls.push({sessionId:options.sessionId,ids:options.messages.flatMap(m=>m.id?[m.id]:[]),tools:(options.tools??[]).map(t=>t.name)});
    const lastUser = options.messages.filter(m=>m.role==='user'&&m.source?.kind==='super-bot-probe').at(-1);
    const text = lastUser?.content.filter(b=>b.type==='text').map(b=>b.text).join('') ?? '';
    const userIndex=options.messages.indexOf(lastUser!);
    const alreadyCalled = options.messages.slice(userIndex+1).some(m=>m.role==='tool');
    if (text.includes('CALL_REPORT') && !alreadyCalled) {
      const id=ToolCallId(randomUUID());
      yield {type:'block-start',index:0,blockType:'tool-call'};
      yield {type:'tool-call-delta',index:0,id,name:toolName,argumentsDelta:'{}'};
      yield {type:'block-end',index:0,block:{type:'tool-call',id,name:toolName,arguments:'{}'}};
      yield {type:'finish',reason:{kind:'tool-calls'}};
      return;
    }
    yield {type:'block-start',index:0,blockType:'text'};
    yield {type:'text-delta',index:0,text:'Deterministic probe response.'};
    yield {type:'block-end',index:0,block:{type:'text',text:'Deterministic probe response.'}};
    yield {type:'finish',reason:{kind:'stop'}};
  }
}

function input(text:string) { return createUserMessage({content:[{type:'text',text}],source:{kind:'super-bot-probe',inputId:randomUUID()}}); }
async function bounded<T>(promise:Promise<T>,label:string):Promise<T> {
  let timer:ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Timeout: ${label}`)),15000);})]); }
  finally { clearTimeout(timer!); }
}

export function apply(ctx:Context) {
  // This fixture refuses to start under the user's normal home.
  const home=process.env.DSH_HOME;
  if (!home?.endsWith('/super-bot/.runtime/dsh')) throw new Error('Probe requires the dedicated Super Bot test home');
  const adapter=new ProbeAdapter();
  ctx.effect(()=>ctx.llm.registerAdapter([provider],adapter));
  const allowed=new Set<string>(); const executed:string[]=[];
  ctx.effect(()=>ctx.tools.register({name:toolName,description:'Synthetic identity probe; no external effects.',
    parameters:{type:'object',properties:{},additionalProperties:false},
    output:{schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},render:()=>[{type:'text',text:'Probe accepted'}]},
    async execute(_args,exec){assert.ok(exec.agent);assert.ok(allowed.has(exec.agent.id));executed.push(exec.agent.id);exec.concludeTurn();return {ok:true};},
  },{when:({agent})=>allowed.has(agent.id)}));
  let running=false;
  async function run() {
    if(running) throw new Error('Probe already running');
    running=true; const agents:Agent[]=[]; const checks:string[]=[];
    try {
      const cwd=join(home!,'super-bot','contract-probes'); await mkdir(cwd,{recursive:true});
      const workspace=await ctx.workspaceRegistry.create(cwd,'Super Bot 契约探针');
      async function makeAgent() {
        const {sessionId}=await ctx.sessionController.create({workspaceId:workspace.id});
        const resolved=await ctx.sessionController.resolveAgent(sessionId);
        if('error' in resolved) throw new Error(JSON.stringify(resolved.error));
        const agent=resolved.agent;agents.push(agent);agent.model.select({provider,model:'deterministic'});
        // Prevent accidental calls to unrelated tools even if the fixture is edited incorrectly.
        agent.ctx.tools.restrict({allow:[toolName]}); return agent;
      }
      const worker=await makeAgent();allowed.add(worker.id);
      const message=input('Identity roundtrip');
      worker.send(message,'next-turn',false);
      assert.equal(worker.inbox.nextTurn[0]?.id,message.id);
      assert.equal(worker.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===message.id).length,0);
      checks.push('queued input is not consumed');
      // Wake through a distinct message: the parked message must retain its original identity.
      worker.followup(input('Wake queued input'));
      await bounded(worker.whenIdle(),'identity roundtrip');
      const consumed=worker.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===message.id);
      assert.equal(consumed.length,1);
      assert.deepEqual(consumed[0]?.data,message);
      assert.ok(adapter.calls.some(c=>c.sessionId===worker.id&&c.ids.includes(message.id)));
      checks.push('message id and source survive inbox, session log, and model request');
      worker.followup(input('CALL_REPORT'));await bounded(worker.whenIdle(),'worker report');
      assert.equal(executed.filter(id=>id===worker.id).length,1);
      assert.ok(adapter.calls.some(c=>c.sessionId===worker.id&&c.tools.includes(toolName)));
      checks.push('worker tool executes with native agent identity');
      const outsider=await makeAgent();outsider.followup(input('CALL_REPORT'));
      await bounded(outsider.whenIdle(),'unauthorized tool attempt');
      assert.ok(adapter.calls.some(c=>c.sessionId===outsider.id), JSON.stringify(outsider.session.snapshotEvents()));
      assert.ok(adapter.calls.filter(c=>c.sessionId===outsider.id).every(c=>!c.tools.includes(toolName)));
      assert.equal(executed.filter(id=>id===outsider.id).length,0);
      assert.ok(outsider.session.snapshotEvents().some(e=>e.type==='tool/result'), JSON.stringify(outsider.session.snapshotEvents()));
      checks.push('another session cannot see or dispatch the worker tool');
      const paused=await makeAgent();
      let entered!:()=>void;const atPreparation=new Promise<void>(resolve=>{entered=resolve;});
      const unhook=paused.ctx.on('agent/pre-step',async(payload,next)=>{
        entered();await new Promise<void>(resolve=>{if(payload.signal.aborted)resolve();else payload.signal.addEventListener('abort',()=>resolve(),{once:true});});
        payload.signal.throwIfAborted();return next();
      });
      const preparing=input('Cancel while preparing');paused.followup(preparing);
      await bounded(atPreparation,'preparation entry');
      const queued=input('Pending plugin input');const human=input('Preserve other producer input');
      paused.send(queued,'next-turn',false);paused.send(human,'next-turn',false);
      paused.cancel({kind:'user'},{keepInbox:true});await bounded(paused.whenIdle(),'preparation cancellation');unhook();
      assert.equal(paused.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===preparing.id).length,0);
      // rc.1 removes the claimed ordinary input before pre-step and does NOT restore it.
      // Absence from inbox therefore cannot mean consumed, even with keepInbox=true.
      assert.equal([...paused.inbox.nextTurn,...paused.inbox.nextStep].some(m=>m.id===preparing.id),false);
      assert.ok(paused.inbox.nextTurn.some(m=>m.id===queued.id));
      checks.push('LIMITED: cancelled claimed input is absent from inbox and has no user/message; recovery must not infer consumption');
      assert.equal(paused.inbox.remove(queued.id),true);
      assert.ok(paused.inbox.nextTurn.some(m=>m.id===human.id));
      checks.push('targeted input removal preserves unrelated input');
      // The test has no reason to execute this remaining synthetic message.
      paused.inbox.remove(human.id);
      const result={ok:true,checks,sessionIds:agents.map(a=>a.id),at:new Date().toISOString()};
      await writeFile(join(home!,'super-bot','contract-probe-result.json'),JSON.stringify(result,null,2));
      return result;
    } finally {for(const agent of agents){allowed.delete(agent.id);agent.cancel({kind:'user'},{keepInbox:true});}running=false;}
  }
  ctx.effect(()=>ctx.connection.fetch.register({path:'/api/super-bot-probe',methods:['POST'],requestBody:'buffered',
    fetch:async()=>{try{return Response.json(await run());}catch(error){return Response.json({ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined},{status:500});}},
  }));
}
