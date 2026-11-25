/** P2 regressions through the installed management tool and real durable ledger.
 * Only the native host boundary is synthetic; no running host or user data is touched. */
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {ToolsService} from '@deepseek-ai/dsh-tools';
import {NativeToolExecutor} from '@deepseek-ai/dsh-tool-executor-native';
import type {Agent} from '@deepseek-ai/dsh-agent';
import {ToolCallId} from '@deepseek-ai/dsh-llm';
import {Managers} from '../../src/manager.ts';
import {DshExecution} from '../../src/dsh.ts';
import {Store} from '../../src/store.ts';
import {readEvidence} from '../../src/evidence.ts';

function fixture(t:TestContext,workspace=false,extra:(directory:string)=>Record<string,unknown>=()=>({})) {
  t.mock.timers.enable({apis:['Date','setInterval']});
  const root=realpathSync(process.cwd());mkdirSync(join(root,'.runtime'),{recursive:true});
  const directory=mkdtempSync(join(root,'.runtime','p2-adapter-')),database=join(directory,'ledger.sqlite');
  const extras=extra(directory);
  let store=new Store(database);
  const bot=store.createBot('bot',{name:'P2 Bot',instructions:'Synthetic regression only'});
  const manager=store.beginManager('manager',bot.id,directory);store.confirmManager(manager.id,manager.requestedSessionId);
  const listeners=new Map<string,Function[]>(),tools=new Map<string,any>(),agents=new Map<string,any>();
  // Use the installed DSH registry and native JSON transport, not a hand-written normalizer.
  const toolContext=new Context();toolContext.provide('systemPrompt',{tools:()=>()=>{}});
  const registry=new ToolsService(toolContext),executor=new NativeToolExecutor(toolContext),registrations:(()=>void)[]=[];
  const nativeAgent={id:manager.requestedSessionId} as Agent;
  const nativeResult=async(callId:string,args:Record<string,unknown>)=>{
    const signal=new AbortController().signal;
    const toolSet=await registry.resolve({agent:nativeAgent,modelSelection:{provider:'synthetic',model:'synthetic'},signal});
    try{return (await executor.execute({calls:[{type:'tool-call',id:ToolCallId(callId),name:'super_bot_manage',arguments:JSON.stringify(args)}],agent:nativeAgent,toolSet,signal})).results[0]!.result;}
    finally{toolSet.dispose();}
  };
  let delivered:any;
  const workerEvents=new Map<string,any[]>();
  const titles=new Map<any,any>();
  const ctx={
    permissionPresets:{set:()=>{}},
    sessionTitle:{get:(session:any)=>titles.get(session),rename:(session:any,title:string)=>{const value={title,source:{kind:'user'}};titles.set(session,value);return value;}},
    sessions:{get:(id:string)=>agents.get(id)?.session,flush:async()=>true},
    sessionPersistence:{open:async(id:string)=>({header:{id},read:async()=>({events:structuredClone(workerEvents.get(id)??[])}),close:async()=>{}})},
    effect:(callback:()=>unknown)=>callback(),
    on:(name:string,callback:Function)=>{const list=listeners.get(name)??[];list.push(callback);listeners.set(name,list);return ()=>{list.splice(list.indexOf(callback),1);};},
    tools:{register:(tool:any,options:any)=>{tools.set(tool.name,tool);const off=registry.register(tool,options);registrations.push(off);return off;}},
    agents:{get:(id:string)=>agents.get(id),list:()=>[],isOwnedBy:()=>false},jobs:{list:()=>[]},
    workingDirectory:{get:(session:any)=>session.header.cwd},
    sessionProjections:{snapshot:()=>({values:{modelSelection:{next:{provider:'synthetic',model:'synthetic'}}}})},
    workspaceRegistry:{create:async(cwd:string)=>({id:cwd,attachSession:async()=>{}})},
    sessionController:{
      create:async({workspaceId,sessionId}:{workspaceId:string;sessionId:string})=>{
        let resolveIdle:()=>void=()=>{},idle=Promise.resolve();
        const agent:any={id:sessionId,session:{id:sessionId,header:{cwd:workspaceId}},status:'idle',
          model:{current:()=>({provider:'synthetic',model:'synthetic'}),select:()=>{}},inbox:{nextTurn:[],nextStep:[],remove:()=>{}},
          ctx:{systemPrompt:{section:()=>()=>{}},tools:{restrict:()=>()=>{},guard:()=>()=>{}},on:()=>()=>{}},
          messages:[],
          followup:(message:any)=>{delivered=message;agent.messages.push(message);agent.status='running';agent.turn=(agent.turn??0)+1;void emit({type:'turn/start',data:{turn:agent.turn}},sessionId);idle=new Promise<void>(resolve=>{resolveIdle=resolve;});},
          whenIdle:()=>idle,finish:()=>{const ended=emit({type:'turn/end',data:{turn:agent.turn,reason:{kind:'completed'}}},sessionId);agent.status='idle';resolveIdle();return ended;},cancel:()=>{agent.status='idle';resolveIdle();}};
        agents.set(sessionId,agent);return {sessionId};
      },
      resolveAgent:async(sessionId:string)=>agents.has(sessionId)?{agent:agents.get(sessionId)}:{error:'synthetic missing session'},
    },
  } as unknown as Context;
  const options=()=>({fullAccess:workspace,...(workspace?{workspace:directory}:{}),...extras});
  let execution=new DshExecution(ctx,store,directory,options()),managers=new Managers(ctx,store,execution,directory,()=> 'https://example.test',options());
  const install=()=>{execution.install();managers.install();};install();
  const managerSession={id:manager.requestedSessionId};
  let managerTurn:number|undefined;
  const emit=async(event:any,sessionId=manager.requestedSessionId)=>{
    const session=agents.get(sessionId)?.session??(sessionId===managerSession.id?managerSession:{id:sessionId});
    if(sessionId===managerSession.id) {
      if(event.type==='turn/start')managerTurn=event.data.turn;
      if(event.type==='turn/end') {
        event={...event,data:{turn:managerTurn,...event.data}};
        managerTurn=undefined;
      }
    }
    if(sessionId!==manager.requestedSessionId||agents.has(sessionId)) {
      const events=workerEvents.get(sessionId)??[];
      event={...event,seq:events.length,...(event.type==='user/message'?{surfaceOp:'append'}:{})};
      events.push(event);workerEvents.set(sessionId,events);
    }
    for(const listener of listeners.get('session/event')??[])await listener(session,event);
  };
  const native=async(id:string,seq:number,text:string)=>{
    if(managerTurn===undefined)await emit({type:'turn/start',data:{turn:1}});
    await emit({type:'user/message',surfaceOp:'append',seq,data:{id,source:{kind:'user',rpcId:`rpc:${id}`},content:[{type:'text',text}]}});
  };
  return {get store(){return store;},get execution(){return execution;},bot,manager,directory,tools,emit,native,nativeResult,ctx,agents,get managers(){return managers;},
    schemas:()=>registry.schemas(),
    nativeCall:async(callId:string,args:Record<string,unknown>)=>{const result=await nativeResult(callId,args);assert.ok(!result.isError,JSON.stringify(result.error));return result.value as any;},
    delivered:()=>delivered,
    finish:async(taskId:string,files:string[],kind:'ready'|'waiting'='ready',text?:{summary:string;checks:string})=>{
      const run=store.latestRun(taskId)!,agent=agents.get(run.sessionId);
      await emit({type:'user/message',seq:1,data:agent.messages.at(-1)},run.sessionId);
      const report=await tools.get('super_bot_report').execute({kind,summary:kind==='ready'?'合成成果':'请补充语言',checks:'逐项回读',...text,files},{agent:agents.get(run.sessionId),callId:'ready',signal:new AbortController().signal,concludeTurn:()=>{}});
      agents.get(run.sessionId).finish();await new Promise<void>(resolve=>setImmediate(resolve));return report;
    },
    call:(callId:string,args:Record<string,unknown>,signal=new AbortController().signal)=>tools.get('super_bot_manage').execute(args,{agent:{id:manager.requestedSessionId},callId,signal}),
    reload:async()=>{await managers.dispose();await execution.dispose();registrations.splice(0).forEach(off=>off());listeners.clear();store.close();store=new Store(database);execution=new DshExecution(ctx,store,directory,options());managers=new Managers(ctx,store,execution,directory,()=> 'https://example.test',options());managerTurn=undefined;install();},
    close:async()=>{await managers.dispose();await execution.dispose();registrations.splice(0).forEach(off=>off());store.close();assert.equal(realpathSync(directory),directory);assert.ok(directory.startsWith(join(root,'.runtime','p2-adapter-')));rmSync(directory,{recursive:true,force:true});t.mock.timers.reset();},
  };
}

for(const [label,fields] of Object.entries({omitted:{},'empty scope':{scope:''},'empty acceptance':{acceptance:''},'both empty':{scope:'',acceptance:''}}))test(`respond native tool accepts ${label} optional fields for a bound Worker question`,async t=>{
  const f=fixture(t);try {
    const schema=f.schemas().find(tool=>tool.name==='super_bot_manage')!.parameters as any;
    assert.deepEqual(schema.required,['action']);assert.deepEqual(schema.properties.scope,{type:'string'});assert.deepEqual(schema.properties.acceptance,{type:'string'});
    await f.native('request',1,'按原范围写介绍。');
    const created=await f.nativeCall('create',{action:'create',dispatch:false,goal:'介绍',scope:'原范围',acceptance:'回读'});
    const prepared=await f.nativeCall('prepare',{action:'dispatch',taskId:created.task.id,expectedRowVersion:created.task.rowVersion});
    await f.nativeCall('dispatch',{action:'dispatch',taskId:created.task.id,expectedRowVersion:prepared.task.rowVersion});await f.finish(created.task.id,[],'waiting');
    const before=await f.nativeCall('detail',{action:'detail',taskId:created.task.id}),attention=before.attentions.find((a:any)=>a.kind==='input'&&a.state==='open');
    assert.ok(before.binding);assert.equal(before.task.scope,'原范围');assert.equal(before.task.acceptance,'回读');
    await f.emit({type:'turn/start',data:{turn:2}});await f.native('answer',4,'使用中文。');
    const args={action:'respond',taskId:created.task.id,attentionId:attention.id,expectedRowVersion:before.task.rowVersion};
    const first=await f.nativeCall('answer',{...args,...fields});assert.equal(first.input.content,'使用中文。');
    for(const retryFields of [{},{scope:''},{acceptance:''},{scope:'',acceptance:''}]){
      const retry=await f.nativeCall('answer',{...args,...retryFields});assert.deepEqual(retry,first);
    }
    const after=await f.nativeCall('after',{action:'detail',taskId:created.task.id});
    assert.equal(after.task.taskRevision,before.task.taskRevision);assert.equal(after.task.scope,'原范围');assert.equal(after.task.acceptance,'回读');
    assert.equal(after.events.filter((e:any)=>e.kind==='attention.answered').length,1);
    const detached=await f.execution.endTaskLink('session.detach','detach',created.task.id,after.task.rowVersion);
    for(const retryFields of [{},{scope:''},{acceptance:''},{scope:'',acceptance:''}]){
      const retry=await f.nativeCall('answer',{...args,...retryFields});assert.deepEqual(retry.input,first.input);assert.equal(retry.task.rowVersion,detached.rowVersion);
    }
    await f.reload();await f.native('answer',4,'使用中文。');
    assert.deepEqual((await f.nativeCall('answer',{...args,scope:'',acceptance:''})).input,first.input);
    const resumed=f.store.controlTask('resume',created.task.id,detached.rowVersion,'auto');
    const rebound=await f.nativeCall('rebind',{action:'dispatch',taskId:created.task.id,expectedRowVersion:resumed.rowVersion});assert.equal(rebound.prepared,true);
    assert.deepEqual((await f.nativeCall('answer',args)).input,first.input);
    assert.equal(f.store.taskDetail(created.task.id).events.filter(e=>e.kind==='attention.answered').length,1);
  }finally{await f.close();}
});

test('respond native tool delivers an empty-field answer to the bound Worker without revising authorization',async t=>{
  const f=fixture(t);try {
    await f.native('request',1,'按原范围写介绍。');
    const created=await f.nativeCall('create',{action:'create',dispatch:false,goal:'介绍',scope:'原范围',acceptance:'回读'});
    const prepared=await f.nativeCall('prepare',{action:'dispatch',taskId:created.task.id,expectedRowVersion:created.task.rowVersion});
    await f.nativeCall('dispatch',{action:'dispatch',taskId:created.task.id,expectedRowVersion:prepared.task.rowVersion});await f.finish(created.task.id,[],'waiting');
    const before=f.store.taskDetail(created.task.id),attention=before.attentions.find(a=>a.kind==='input'&&a.state==='open')!;
    await f.emit({type:'turn/start',data:{turn:2}});await f.native('answer',4,'使用中文。');
    const answered=await f.nativeCall('answer',{action:'respond',taskId:created.task.id,attentionId:attention.id,expectedRowVersion:before.task.rowVersion,scope:'',acceptance:''});
    const continued=await f.nativeCall('continue',{action:'dispatch',taskId:created.task.id,expectedRowVersion:answered.task.rowVersion});
    assert.equal(continued.run.inputId,answered.input.id);assert.equal(continued.run.sessionId,before.binding!.sessionId);assert.equal(continued.run.taskRevision,before.task.taskRevision);
    assert.ok(f.delivered().content[0].text.includes('使用中文。'));
    await f.finish(created.task.id,[],'waiting');
    const after=await f.nativeCall('after',{action:'detail',taskId:created.task.id});
    assert.equal(after.input.id,answered.input.id);assert.equal(after.input.state,'entered');assert.equal(after.attentions.find((a:any)=>a.id===attention.id).state,'resolved');
    assert.equal(after.task.scope,'原范围');assert.equal(after.task.acceptance,'回读');assert.equal(after.task.taskRevision,before.task.taskRevision);
  }finally{await f.close();}
});

test('respond native tool keeps source, version, valued-input and invalid-type rejection boundaries',async t=>{
  const f=fixture(t);try {
    await f.native('request',1,'按原范围写介绍。');
    const created=await f.nativeCall('create',{action:'create',dispatch:false,goal:'介绍',scope:'原范围',acceptance:'回读'});
    const prepared=await f.nativeCall('prepare',{action:'dispatch',taskId:created.task.id,expectedRowVersion:created.task.rowVersion});
    await f.nativeCall('dispatch',{action:'dispatch',taskId:created.task.id,expectedRowVersion:prepared.task.rowVersion});await f.finish(created.task.id,[],'waiting');
    const before=await f.nativeCall('detail',{action:'detail',taskId:created.task.id}),attention=before.attentions.find((a:any)=>a.kind==='input'&&a.state==='open');
    const args={action:'respond',taskId:created.task.id,attentionId:attention.id,expectedRowVersion:before.task.rowVersion,scope:'',acceptance:''};
    const rejected=async(callId:string,data:Record<string,unknown>,message:string)=>{const result=await f.nativeResult(callId,data);assert.equal(result.isError,true);assert.equal(result.error?.message,message);};
    await f.emit({type:'turn/start',data:{turn:2}});
    for(const source of [{kind:'super-bot-manager',botId:f.bot.id,managerId:f.manager.id,eventId:'missing'},{kind:'synthetic-automatic',rpcId:'not-native'},{kind:'user'}]){
      await f.emit({type:'user/message',seq:2,data:{id:'automatic',source,content:[{type:'text',text:'自动通知不能授权回答'}]}});
      await rejected('automatic',args,'需要当前对话中的真实用户消息；自动通知不能代替用户提出新工作、回答或返工。');
    }
    await f.emit({type:'user/message',seq:3,data:{id:'foreign',source:{kind:'user',rpcId:'foreign'},content:[{type:'text',text:'其他对话'}]}},'other-session');
    await rejected('foreign-source',args,'需要当前对话中的真实用户消息；自动通知不能代替用户提出新工作、回答或返工。');
    await f.emit({type:'turn/end',data:{reason:{kind:'completed'}}});await f.emit({type:'turn/start',data:{turn:3}});
    await f.native('answer-last',6,'保留背景。');await f.native('answer-first',4,'使用中文。');await f.native('answer-first',8,'重复投递不能覆盖原文。');
    for(const [field,label] of [['scope','任务范围'],['acceptance','验收条件']]){
      for(const [index,value] of [null,false,0,[],{},' \t\n'].entries())await rejected(`invalid:${field}:${index}`,{...args,scope:undefined,acceptance:undefined,[field]:value},`请填写${label}。`);
      await rejected(`oversize:${field}`,{...args,scope:undefined,acceptance:undefined,[field]:'x'.repeat(10001)},`${label}不能超过 10000 字符。`);
      await rejected(`valued:${field}`,{...args,scope:undefined,acceptance:undefined,[field]:'扩大授权'},'执行会话已关联，不能通过补充缺项修改任务范围。');
    }
    await rejected('stale',{...args,expectedRowVersion:before.task.rowVersion-1},'任务已经更新，请刷新后回答。');
    assert.equal(f.store.getTask(created.task.id).rowVersion,before.task.rowVersion);assert.equal(f.store.pendingInput(created.task.id),null);
    const first=await f.nativeCall('answer',args);assert.equal(first.input.content,'使用中文。\n\n保留背景。');
    const after=await f.nativeCall('after',{action:'detail',taskId:created.task.id});
    assert.deepEqual(JSON.parse(after.events.find((e:any)=>e.kind==='attention.answered').data).source,{sessionId:f.manager.requestedSessionId,messageId:'answer-last',seq:6,text:'使用中文。\n\n保留背景。',messages:[{messageId:'answer-first',seq:4,text:'使用中文。'},{messageId:'answer-last',seq:6,text:'保留背景。'}]});
    await rejected('answered',{...args,expectedRowVersion:after.task.rowVersion},'问题已失效或已有回答。');
    await rejected('answer',{...args,scope:'改变已提交请求',acceptance:undefined},'同一请求标识不能用于不同的内容。');
    await f.native('new-source',9,'新来源不能借用旧回执。');await rejected('answer',args,'同一请求标识不能用于不同的内容。');
    await f.emit({type:'turn/end',data:{reason:{kind:'stop'}}});
    await rejected('answer',args,'需要当前对话中的真实用户消息；自动通知不能代替用户提出新工作、回答或返工。');
    assert.equal(f.store.taskDetail(created.task.id).events.filter(e=>e.kind==='attention.answered').length,1);
  }finally{await f.close();}
});

test('P2 incomplete unbound task can be completed by a real chat answer and dispatched',async t=>{
  const f=fixture(t);try {
    await f.native('request',1,'请安排一份介绍，范围和检查稍后补充。');
    const created=await f.nativeCall('create',{action:'create',dispatch:false,goal:'项目介绍'});
    const before=await f.call('before',{action:'detail',taskId:created.task.id});
    assert.equal(before.binding,null);assert.equal(before.task.status,'needs-input');
    const attention=before.attentions.find((a:any)=>a.kind==='input'&&a.state==='open');assert.ok(attention);
    await assert.rejects(f.call('early-dispatch',{action:'dispatch',taskId:created.task.id,expectedRowVersion:before.task.rowVersion}),{code:'not-ready'});
    await f.emit({type:'turn/start',data:{turn:2}});
    await f.native('scope-answer',5,'仅在任务目录写介绍；包含背景和结论，并回读检查。');
    const args={action:'respond',taskId:created.task.id,attentionId:attention.id,expectedRowVersion:before.task.rowVersion,scope:'仅在任务目录写介绍',acceptance:'包含背景和结论，并回读检查'};
    const completed=await f.nativeCall('complete',args);
    assert.equal(completed.task.scope,args.scope);assert.equal(completed.task.acceptance,args.acceptance);
    assert.equal(completed.task.taskRevision,2);assert.equal(completed.task.rowVersion,before.task.rowVersion+1);
    assert.equal(completed.task.status,'unscheduled');assert.equal(completed.task.reviewPolicy,'human');
    const after=await f.call('after',{action:'detail',taskId:created.task.id});
    assert.equal(after.attentions.find((a:any)=>a.id===attention.id).state,'resolved');
    assert.deepEqual(JSON.parse(after.events.find((e:any)=>e.kind==='task.revised').data).source,{sessionId:f.manager.requestedSessionId,messageId:'scope-answer',seq:5,text:'仅在任务目录写介绍；包含背景和结论，并回读检查。'});
    assert.deepEqual(await f.call('complete',args),completed);
    await assert.rejects(f.call('stale-completion',{...args,acceptance:'改变验收'}),{code:'version-conflict'});
    const prepared=await f.call('prepare',{action:'dispatch',taskId:created.task.id,expectedRowVersion:completed.task.rowVersion});assert.equal(prepared.prepared,true);
    const started=await f.call('start',{action:'dispatch',taskId:created.task.id,expectedRowVersion:prepared.task.rowVersion});
    assert.equal(started.run.taskRevision,2);
    const prompt=f.delivered().content[0].text;assert.ok(prompt.includes(args.scope));assert.ok(prompt.includes(args.acceptance));
    assert.deepEqual(await f.call('complete',args),completed,'committed completion retry remains safe after binding');
  }finally{await f.close();}
});

test('P2 completion keeps real multi-message sources, versions, existing scope and paused control across reopen',async t=>{
  const f=fixture(t);try {
    await f.native('request',1,'请写介绍，仅在已有范围内；验收要求稍后补充。');
    const created=await f.call('create',{action:'create',dispatch:false,goal:'固定目标',scope:'已有范围'});
    const before=f.store.taskDetail(created.task.id),attention=before.attentions[0]!;
    const args={action:'respond',taskId:created.task.id,attentionId:attention.id,expectedRowVersion:before.task.rowVersion,acceptance:'回读并含结论'};
    await f.emit({type:'turn/start',data:{turn:2}});
    await f.emit({type:'user/message',seq:2,data:{id:'automatic',source:{kind:'super-bot-manager',botId:f.bot.id,managerId:f.manager.id,eventId:'missing'},content:[{type:'text',text:'自动通知不能授权补充'}]}});
    await assert.rejects(f.call('automatic',args),{code:'human-message-required'});
    assert.equal(f.store.getTask(created.task.id).rowVersion,before.task.rowVersion);
    await f.emit({type:'turn/end',data:{reason:{kind:'completed'}}});await f.emit({type:'turn/start',data:{turn:3}});
    await f.native('answer-first',3,'保持既有范围。');await f.native('answer-last',4,'回读并含结论。');
    const paused=f.store.controlTask('pause',created.task.id,before.task.rowVersion,'paused');
    await assert.rejects(f.call('stale',args),{code:'version-conflict'});
    const current={...args,expectedRowVersion:paused.rowVersion};
    await assert.rejects(f.call('expanded',{...current,scope:'扩展到其他项目'}),{code:'scope-change'});
    assert.equal(f.store.getTask(created.task.id).rowVersion,paused.rowVersion);
    const completed=await f.call('complete',current);
    assert.equal(completed.task.goal,'固定目标');assert.equal(completed.task.scope,'已有范围');
    assert.equal(completed.task.controlMode,'paused');assert.equal(completed.task.status,'paused');assert.equal(completed.task.taskRevision,2);
    const revised=f.store.taskDetail(created.task.id).events.find(e=>e.kind==='task.revised')!;
    assert.deepEqual(JSON.parse(revised.data).source,{sessionId:f.manager.requestedSessionId,messageId:'answer-last',seq:4,text:'保持既有范围。\n\n回读并含结论。',messages:[{messageId:'answer-first',seq:3,text:'保持既有范围。'},{messageId:'answer-last',seq:4,text:'回读并含结论。'}]});
    await assert.rejects(f.call('old-attention',{...current,expectedRowVersion:completed.task.rowVersion}),{code:'attention-stale'});
    await assert.rejects(f.call('complete',{...current,acceptance:'另一要求'}),{code:'idempotency-conflict'});
    await assert.rejects(f.call('paused-dispatch',{action:'dispatch',taskId:created.task.id,expectedRowVersion:completed.task.rowVersion}),{code:'manager-stale'});
    await f.reload();await f.native('answer-first',3,'保持既有范围。');await f.native('answer-last',4,'回读并含结论。');
    assert.deepEqual(await f.call('complete',current),completed);
    assert.equal(f.store.taskDetail(created.task.id).events.filter(e=>e.kind==='task.revised').length,1);
  }finally{await f.close();}
});

test('P2 partial completion leaves a current question and cannot erase existing acceptance',async t=>{
  const f=fixture(t);try {
    await f.native('request',1,'范围和验收分两次补充。');
    const created=await f.nativeCall('create',{action:'create',dispatch:false,goal:'分次补充'}),before=f.store.taskDetail(created.task.id);
    await f.emit({type:'turn/start',data:{turn:2}});await f.native('acceptance',2,'先补验收：回读内容。');
    const firstArgs={action:'respond',taskId:created.task.id,attentionId:before.attentions[0]!.id,expectedRowVersion:before.task.rowVersion,acceptance:'回读内容'};
    const first=await f.nativeCall('acceptance',firstArgs);
    assert.equal(first.task.status,'needs-input');assert.equal(first.task.scope,'');assert.equal(first.task.taskRevision,2);
    const partial=f.store.taskDetail(created.task.id),next=partial.attentions.find(a=>a.state==='open')!;assert.equal(next.taskRevision,2);
    await f.emit({type:'turn/start',data:{turn:3}});await f.native('scope',3,'仅写任务目录。');
    const args={action:'respond',taskId:created.task.id,attentionId:next.id,expectedRowVersion:first.task.rowVersion,scope:'仅写任务目录'};
    await assert.rejects(f.call('erase',{...args,acceptance:''}),{code:'invalid-input'});
    const overwrite=await f.nativeResult('overwrite',{...args,acceptance:'替换已有验收'});assert.equal(overwrite.isError,true);assert.equal(overwrite.error?.message,'补充缺项不能覆盖已有范围或验收条件。');
    const complete=await f.nativeCall('scope',args);assert.equal(complete.task.status,'unscheduled');assert.equal(complete.task.acceptance,'回读内容');assert.equal(complete.task.taskRevision,3);
    assert.deepEqual(await f.nativeCall('scope',args),complete);
    await f.emit({type:'turn/start',data:{turn:4}});await f.native('acceptance',2,'先补验收：回读内容。');assert.deepEqual(await f.nativeCall('acceptance',firstArgs),first);
    await f.emit({type:'turn/start',data:{turn:5}});await f.native('scope',3,'仅写任务目录。');
    const prepared=await f.nativeCall('prepare',{action:'dispatch',taskId:created.task.id,expectedRowVersion:complete.task.rowVersion});assert.equal(prepared.prepared,true);
    assert.deepEqual(await f.nativeCall('scope',args),complete,'completion receipt survives a new execution binding');
    assert.equal(f.store.pendingInput(created.task.id),null);assert.equal(f.store.taskDetail(created.task.id).events.filter(e=>e.kind==='task.revised').length,2);
    const other=f.store.createBot('other-bot',{name:'Other',instructions:'Synthetic'}),foreign=f.store.createTask('other-task',{botId:other.id,goal:'其他 Bot',scope:'',acceptance:'',reviewPolicy:'human'});
    await assert.rejects(f.call('foreign-task',{...args,taskId:foreign.id}),{code:'manager-scope'});
    await assert.rejects(f.call('foreign-attention',{...args,attentionId:f.store.taskDetail(foreign.id).attentions[0]!.id}),{code:'manager-scope'});
  }finally{await f.close();}
});

for(const damage of ['modified','deleted'] as const)test(`P2 ${damage} evidence keeps manager detail readable but cannot be accepted or downloaded`,async t=>{
  const f=fixture(t);try {
    await f.native('request',1,'写两份合成文档并回读，等我确认。');
    const created=await f.call('create',{action:'create',dispatch:false,goal:'两份文档',scope:'任务目录',acceptance:'回读两份文档'});
    const prepared=await f.call('prepare',{action:'dispatch',taskId:created.task.id,expectedRowVersion:created.task.rowVersion});
    await f.call('dispatch',{action:'dispatch',taskId:created.task.id,expectedRowVersion:prepared.task.rowVersion});
    const binding=f.store.activeBinding(created.task.id)!,first=join(binding.cwd,'first.md'),second=join(binding.cwd,'second.md');
    writeFileSync(first,'原始第一份');writeFileSync(second,'原始第二份');
    const report=await f.finish(created.task.id,[first,second]);
    const before=await f.call('detail-before',{action:'detail',taskId:created.task.id});assert.equal(before.task.lifecycle,'review');assert.equal(before.files.length,2);
    assert.equal((await readEvidence(binding.cwd,before.result.evidence[1])).toString(),'原始第二份');
    if(damage==='modified')writeFileSync(second,'已改变且不应预览或下载的内容');else {assert.equal(realpathSync(second),join(binding.cwd,'second.md'));unlinkSync(second);}
    const after=await f.call('detail-after',{action:'detail',taskId:created.task.id});
    assert.deepEqual(after.task,before.task);assert.deepEqual(after.result,before.result);assert.deepEqual(after.attentions,before.attentions);assert.deepEqual(after.run,before.run);assert.deepEqual(after.events,before.events);
    assert.equal(after.evidenceValidation.status,'failed');assert.equal(after.evidenceValidation.code,damage==='modified'?'evidence-changed':'evidence-unavailable');assert.ok(after.evidenceValidation.message);
    assert.deepEqual(after.files,[],'no partially verified batch or changed bytes may escape');
    assert.equal(after.delivery.workUrl,`/#super-bot-task=${created.task.id}&resultId=${report.resultId}`);
    const expected={code:damage==='modified'?'evidence-changed':'evidence-unavailable'};
    await assert.rejects(f.execution.accept('accept-damaged',created.task.id,after.task.rowVersion,report.resultId),expected);
    await assert.rejects(f.call('manager-accept',{action:'review',taskId:created.task.id,expectedRowVersion:after.task.rowVersion,resultId:report.resultId,verdict:'accept',note:'不能忽略校验失败'}),expected);
    await assert.rejects(readEvidence(binding.cwd,after.result.evidence[1]),expected);
    assert.equal(f.store.resultById(report.resultId)?.humanAcceptedAt,null);assert.equal(f.store.getTask(created.task.id).lifecycle,'review');
    const rework={action:'rework',taskId:created.task.id,expectedRowVersion:after.task.rowVersion,resultId:report.resultId};
    await f.emit({type:'turn/start',data:{turn:2}});await assert.rejects(f.call('automatic-rework',rework),{code:'human-message-required'});
    await f.native('real-rework',10,'证据失效，请按原范围重新生成并重新回读。');
    const revised=await f.call('real-rework',rework);assert.equal(revised.task.lifecycle,'open');assert.equal(f.store.pendingInput(created.task.id)?.content,'证据失效，请按原范围重新生成并重新回读。');
    assert.equal(f.store.resultById(report.resultId)?.humanAcceptedAt,null);
  }finally{await f.close();}
});

test('P2 same native message and normalized task intent is durable across different management call IDs',async t=>{
  const f=fixture(t);try {
    await f.native('human-request',7,'写一份介绍；另一个不同范围的任务也可以单独安排。');
    const args={action:'create',dispatch:false,goal:'项目介绍',scope:'任务目录',acceptance:'包含背景与结论'};
    const first=await f.call('create-first',args);
    const duplicate=await f.call('create-another-call',{...args,goal:'  项目介绍\n',scope:' 任务目录 ',acceptance:'包含背景与结论\n'});
    assert.deepEqual(duplicate,first);assert.equal((await f.call('list',{action:'list'})).total,1);
    assert.equal(f.store.taskDetail(first.task.id).events.filter(e=>e.kind==='task.created').length,1);
    assert.equal(f.store.pendingManagerEvents(f.bot.id).filter(e=>e.taskId===first.task.id).length,1);
    await f.reload();await f.native('human-request',7,'写一份介绍；另一个不同范围的任务也可以单独安排。');
    assert.deepEqual(await f.call('after-reopen',args),first);
    assert.equal((await f.call('list-after-reopen',{action:'list'})).total,1);
    const differentScope=await f.call('different-scope',{...args,scope:'另一个任务目录'});assert.notEqual(differentScope.task.id,first.task.id);
    const differentCriteria=await f.call('different-criteria',{...args,acceptance:'只含结论'});assert.notEqual(differentCriteria.task.id,first.task.id);
    const differentGoal=await f.call('different-goal',{...args,goal:'另一个目标'});assert.notEqual(differentGoal.task.id,first.task.id);
    await assert.rejects(f.call('create-first',{...args,goal:'同调用改参数仍是冲突'}),{code:'idempotency-conflict'});
    await f.emit({type:'turn/start',data:{turn:2}});await f.native('different-real-message',10,'请再写一份相同介绍。');
    const another=await f.call('new-message',args);assert.notEqual(another.task.id,first.task.id);
    assert.equal((await f.call('list-final',{action:'list'})).total,5);
    await f.emit({type:'turn/start',data:{turn:3}});
    await assert.rejects(f.call('automatic-cannot-reuse',args),{code:'human-message-required'});
  }finally{await f.close();}
});

test('P2 creation intent uses the full ordered native message identity and canonical empty fields',async t=>{
  const f=fixture(t);try {
    await f.native('last',3,'稍后补充范围和验收。');await f.native('first',1,'请写介绍。');
    const args={action:'create',dispatch:false,goal:'介绍'},first=await f.call('first',args);
    assert.deepEqual(await f.call('canonical-empty',{...args,goal:' 介绍 ',scope:'',acceptance:''}),first);
    await f.reload();await f.native('first',1,'请写介绍。');await f.native('last',3,'稍后补充范围和验收。');
    assert.deepEqual(await f.call('reordered-native-replay',args),first);
    const origin=f.store.taskDetail(first.task.id).events.find(e=>e.kind==='task.created')!;
    assert.deepEqual(JSON.parse(origin.data).source.messages,[{messageId:'first',seq:1,text:'请写介绍。'},{messageId:'last',seq:3,text:'稍后补充范围和验收。'}]);
    await f.native('new-human-steer',4,'另一个真实补充。');
    assert.notEqual((await f.call('new-message-set',args)).task.id,first.task.id);
    await f.emit({type:'turn/start',data:{turn:2}});await f.native('new-message-same-text',5,'请写介绍。');
    assert.notEqual((await f.call('identical-text-not-identity',args)).task.id,first.task.id);
    assert.equal((await f.call('list',{action:'list'})).total,3);
  }finally{await f.close();}
});

test('P2 task intent receipt rolls back with a failed outer command receipt',async t=>{
  const f=fixture(t);try {
    await f.native('request',1,'请写介绍，范围稍后补充。');const args={action:'create',dispatch:false,goal:'介绍'};
    f.store.db.exec("CREATE TRIGGER p2_fail_receipt BEFORE INSERT ON requests WHEN NEW.id LIKE 'manager:%:fault' BEGIN SELECT RAISE(ABORT,'synthetic command receipt failure'); END");
    await assert.rejects(f.call('fault',args),/synthetic command receipt failure/);
    assert.equal((await f.call('list-after-fault',{action:'list'})).total,0);assert.equal(f.store.pendingManagerEvents(f.bot.id).length,0);
    f.store.db.exec('DROP TRIGGER p2_fail_receipt');
    const created=await f.call('after-fault',args);assert.ok(created.task.id);
    assert.equal((await f.call('retry-different-id',args)).task.id,created.task.id);
    assert.equal((await f.call('list-final',{action:'list'})).total,1);
    assert.equal(f.store.taskDetail(created.task.id).events.filter(e=>e.kind==='task.created').length,1);
  }finally{await f.close();}
});

test('P2 committed Worker answer retry keeps its original command kind after the binding is detached',async t=>{
  const f=fixture(t);try {
    await f.native('request',1,'按原范围写介绍。');
    const created=await f.call('create',{action:'create',dispatch:false,goal:'介绍',scope:'原范围',acceptance:'回读'});
    const prepared=await f.call('prepare',{action:'dispatch',taskId:created.task.id,expectedRowVersion:created.task.rowVersion});
    await f.call('dispatch',{action:'dispatch',taskId:created.task.id,expectedRowVersion:prepared.task.rowVersion});await f.finish(created.task.id,[],'waiting');
    const before=f.store.taskDetail(created.task.id),attention=before.attentions.find(a=>a.kind==='input'&&a.state==='open')!;
    await f.emit({type:'turn/start',data:{turn:2}});await f.native('answer',4,'使用中文。');
    const args={action:'respond',taskId:created.task.id,attentionId:attention.id,expectedRowVersion:before.task.rowVersion};
    const first=await f.call('answer',args);assert.equal(first.input.content,'使用中文。');
    const detached=await f.execution.endTaskLink('session.detach','detach',created.task.id,first.task.rowVersion);assert.equal(f.store.activeBinding(created.task.id),null);
    const retry=await f.call('answer',args);assert.deepEqual(retry.input,first.input);assert.equal(retry.task.rowVersion,detached.rowVersion);
    assert.equal(f.store.taskDetail(created.task.id).events.filter(e=>e.kind==='attention.answered').length,1);assert.equal(f.store.pendingInput(created.task.id),null);
  }finally{await f.close();}
});

for(const change of ['aborted','replaced'] as const)test(`P2 evidence failure fallback still rejects ${change} authority after asynchronous preview`,async t=>{
  const f=fixture(t);try {
    await f.native('request',1,'写一份合成文档。');
    const created=await f.call('create',{action:'create',dispatch:false,goal:'介绍',scope:'任务目录',acceptance:'回读'});
    const prepared=await f.call('prepare',{action:'dispatch',taskId:created.task.id,expectedRowVersion:created.task.rowVersion});
    await f.call('dispatch',{action:'dispatch',taskId:created.task.id,expectedRowVersion:prepared.task.rowVersion});
    const file=join(f.store.activeBinding(created.task.id)!.cwd,'result.md');writeFileSync(file,'原始文档');await f.finish(created.task.id,[file]);
    const before=f.store.taskDetail(created.task.id);writeFileSync(file,'已修改');
    const abort=new AbortController(),pending=f.call('preview',{action:'detail',taskId:created.task.id},abort.signal);
    if(change==='aborted')abort.abort(new Error('synthetic detail abort'));else f.store.releaseManager('replace',f.bot.id,f.manager.generation);
    await assert.rejects(pending,change==='aborted'?{message:'synthetic detail abort'}:{code:'manager-scope'});
    const after=f.store.taskDetail(created.task.id);assert.deepEqual(after.task,before.task);assert.deepEqual(after.result,before.result);
  }finally{await f.close();}
});


test('configured workspace dispatches two tasks into independent directories',async t=>{
  const f=fixture(t,true);try {
    const tasks=[1,2].map(n=>f.store.createTask(`parallel-${n}`,{botId:f.bot.id,goal:`Task ${n}`,scope:'Own files',acceptance:'Read files',reviewPolicy:'human'}));
    for(const task of tasks) {
      const prepared=await f.call(`prepare-${task.id}`,{action:'dispatch',taskId:task.id,expectedRowVersion:task.rowVersion});
      const started=await f.call(`start-${task.id}`,{action:'dispatch',taskId:task.id,expectedRowVersion:prepared.task.rowVersion});
      assert.ok(started.run);
    }
    assert.equal(f.store.heldRuns().length,2);
    const directories=tasks.map(task=>f.store.activeBinding(task.id)!.cwd);
    assert.notEqual(directories[0],directories[1]);
    assert.ok(directories.every(cwd=>cwd.startsWith(join(f.directory,'.super-bot-workspaces'))));
  }finally{await f.close();}
});


test('legacy bindings in the same directory defer only while capacity is full',async t=>{
  const f=fixture(t);try {
    f.store.setBotCapacity('one-slot',f.bot.id,null,1);
    const tasks=[1,2].map(n=>f.store.createTask(`legacy-${n}`,{botId:f.bot.id,goal:`Legacy ${n}`,scope:'Own files',acceptance:'Read files',reviewPolicy:'human'}));
    for(const task of tasks) {
      const binding=f.store.beginBinding(`binding-${task.id}`,task.id,task.rowVersion,f.directory);
      await f.ctx.sessionController.create({workspaceId:f.directory as any,sessionId:binding.requestedSessionId as any});
      f.store.confirmBinding(binding.id,binding.requestedSessionId);
    }
    const first=await f.call('first',{action:'dispatch',taskId:tasks[0].id,expectedRowVersion:f.store.getTask(tasks[0].id).rowVersion});
    const deferred=await f.call('second',{action:'dispatch',taskId:tasks[1].id,expectedRowVersion:f.store.getTask(tasks[1].id).rowVersion});
    assert.equal(deferred.reason,'capacity');assert.equal(deferred.capacityScope,'bot');assert.equal(f.store.latestRun(tasks[1].id),null);
    f.store.db.exec("UPDATE outbox SET state='done' WHERE kind='manager.notify' AND id NOT LIKE 'manager-event:capacity:%'");
    assert.ok(f.store.pendingManagerEvents(f.bot.id)[0].id.startsWith('manager-event:capacity:'));
    await f.ctx.sessionController.create({workspaceId:f.directory as any,sessionId:f.manager.requestedSessionId as any});
    await (f.managers as any).pump();assert.equal(f.agents.get(f.manager.requestedSessionId).status,'idle');
    const input=f.store.getRunInput(first.run.id);await f.emit({type:'user/message',seq:1,data:JSON.parse(input.messageJson!)},first.run.sessionId);
    f.store.workerReport(first.run.id,'failed',{kind:'failed',summary:'Synthetic stop'});
    f.agents.get(first.run.sessionId).finish();await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(f.store.dispatchBlocker(tasks[1].id),null);
    await (f.managers as any).pump();assert.equal(f.agents.get(f.manager.requestedSessionId).status,'running');
    f.agents.get(f.manager.requestedSessionId).finish();
  }finally{await f.close();}
});

test('create dispatches in one step with inferred fields and retries reuse the same run',async t=>{
  const f=fixture(t);try {
    await f.native('request',1,'写一份简短介绍。');
    const created=await f.call('create-one-step',{action:'create',goal:'简短介绍'});
    assert.ok(created.run,JSON.stringify(created));assert.equal(created.run.taskId,created.task.id);
    assert.ok(created.task.scope&&created.task.acceptance);
    assert.equal(f.store.taskDetail(created.task.id).attentions.filter((a:any)=>a.state==='open').length,0);
    assert.equal(f.store.db.prepare('SELECT state FROM outbox WHERE id=?').get(`manager-event:created:${created.task.id}`)?.state,'done');
    const retry=await f.call('create-one-step',{action:'create',goal:'简短介绍'});
    assert.equal(retry.run.id,created.run.id);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM runs').get()?.n,1);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM tasks').get()?.n,1);
  }finally{await f.close();}
});

test('one-step create keeps explicit Bot fields and queues instead of failing when capacity is full',async t=>{
  const f=fixture(t,true);try {
    f.store.setBotCapacity('two-slots',f.bot.id,null,2);
    await f.native('request',1,'并行写三份介绍。');
    const results:any[]=[];
    for(const n of [1,2,3])results.push(await f.call(`create-${n}`,{action:'create',goal:`介绍 ${n}`,scope:`只写 doc-${n}.md`,acceptance:'回读'}));
    assert.ok(results[0].run&&results[1].run);assert.equal(results[2].deferred,true);assert.equal(results[2].task.scope,'只写 doc-3.md');
    assert.equal(results[2].capacityScope,'bot');
    assert.equal(results[2].task.acceptance,'回读');
    assert.equal(f.store.latestRun(results[2].task.id),null);
    assert.ok(f.store.pendingManagerEvents(f.bot.id).some((e:any)=>e.id.startsWith(`manager-event:capacity:${results[2].task.id}`)));
  }finally{await f.close();}
});

const work=(directory:string)=>{const path=join(directory,'work');mkdirSync(path,{recursive:true});return path;};

async function parallelFixture(t:TestContext,botLimit=2){
  const f=fixture(t,false,directory=>({allowedRoots:[work(directory)]}));
  t.after(()=>f.close());
  f.store.setBotCapacity('initial-limit',f.bot.id,null,botLimit);
  const root=work(f.directory);
  const dir=(name:string)=>{const path=join(root,name);mkdirSync(path,{recursive:true});return path;};
  const create=(name:string,path:string)=>f.call(`parallel-create:${name}`,{action:'create',goal:name,workdir:{mode:'existing',path}});
  const dispatch=(name:string,taskId:string)=>f.call(name,{action:'dispatch',taskId,expectedRowVersion:f.store.getTask(taskId).rowVersion});
  const pump=()=> (f.managers as unknown as {pump():Promise<void>}).pump();
  const notice=(id:string)=>f.store.managerNotifications(f.bot.id).find(event=>event.id===id);
  const openManager=async()=>{
    await f.ctx.sessionController.create({workspaceId:f.directory as any,sessionId:f.manager.requestedSessionId as any});
    return f.agents.get(f.manager.requestedSessionId);
  };
  const endManager=async(agent:any,text:string)=>{
    await f.emit({type:'assistant/message',surfaceOp:'append',data:{turn:agent.turn,
      message:{id:`reply-${agent.turn}`,source:{kind:'model'},content:[{type:'text',text}]},
      stream:[{type:'chunk',chunk:{type:'finish',reason:{kind:'stop'}}}]}},agent.id);
    await agent.finish();await new Promise<void>(resolve=>setImmediate(resolve));
  };
  const enterManager=(agent:any)=>f.emit({type:'user/message',data:agent.messages.at(-1)},agent.id);
  await f.native('parallel-request',1,'合成并行任务');
  return {f,root,dir,create,dispatch,pump,notice,openManager,enterManager,endManager};
}

test('ordinary capacity wake can dispatch a new answer after a previous recovery instruction was consumed',async t=>{
  const {f,root,create,dispatch,pump,openManager,enterManager,endManager}=await parallelFixture(t);
  const holder=await create('Holder',root),work=await create('Work with a newer question',root);
  f.store.setBotCapacity('one-slot',f.bot.id,2,1);
  await f.finish(work.task.id,[],'waiting');
  f.store.settleManagerEvent(`manager-event:settled:${work.run.id}`);
  const question=f.store.taskDetail(work.task.id).pendingQuestions[0]!;
  const answer=f.store.respondAttention('new-answer',question.id,f.store.getTask(work.task.id).rowVersion,'用中文');
  f.store.settleManagerEvent(`manager-event:answer:${answer.id}`);
  f.store.set(`recovery-instruction:${work.task.id}`,JSON.stringify({id:'consumed',runId:work.run.id,
    taskRevision:work.run.taskRevision,priorRunId:'earlier-run',source:{sessionId:f.manager.sessionId,messageId:'earlier',seq:0,text:'Old request'}}));
  assert.equal((await dispatch('queued-answer',work.task.id)).deferred,true);
  await f.finish(holder.task.id,[],'waiting');
  f.store.settleManagerEvent(`manager-event:settled:${holder.run.id}`);
  const manager=await openManager();
  await pump();
  assert.match(manager.messages.at(-1).source.eventId,/^manager-event:capacity:/);
  await enterManager(manager);
  const restarted=await dispatch('capacity-answer',work.task.id);
  assert.equal(restarted.run.inputId,answer.id);
  await endManager(manager,'已把新的回答交给 Worker。');
});

for(const waiters of [1,12]){
  test(`DF-13 pump skips ${waiters} older capacity waits for independent Worker notification`,async t=>{
    const {f,dir,create,pump,notice,openManager,enterManager,endManager}=await parallelFixture(t);
    const independent=await create('Independent',dir('independent'));
    const file=join(dir('independent'),'result.md');writeFileSync(file,'Independent evidence');
    const shared=dir('shared'),holder=await create('Holder',shared);
    assert.ok(holder.run);
    f.store.setBotCapacity('lower-limit',f.bot.id,2,1); // The holder occupies the remaining slot after settlement.
    const waiting=[];
    for(let i=0;i<waiters;i++){
      const queued=await create(`Queued ${i}`,shared);
      assert.equal(queued.reason,'capacity');
      waiting.push(`manager-event:capacity:${queued.task.id}:${queued.task.rowVersion}`);
    }
    t.mock.timers.tick(1);
    await f.finish(independent.task.id,[file]);
    const ready=f.store.taskDetail(independent.task.id),settled=`manager-event:settled:${independent.run.id}`;
    const manager=await openManager();
    await pump();
    assert.deepEqual(manager.messages.map((message:any)=>message.source.eventId),[settled]);
    assert.ok(waiting.every(id=>notice(id)?.state==='pending'),'older blocked waits keep their place');
    await pump();assert.equal(manager.messages.length,1,'one Manager wake per Bot while the native turn is active');
    await enterManager(manager);
    await f.call('review-independent',{action:'review',taskId:ready.task.id,expectedRowVersion:ready.task.rowVersion,
      resultId:ready.result!.id,verdict:'human',note:'Evidence read'});
    await endManager(manager,'Independent Worker result examined');
    assert.equal(notice(settled),undefined,'the independent settlement has a durable native reply');
    const deliveryId=`manager-event:delivery:${ready.result!.id}`;
    assert.equal(notice(deliveryId)?.state,'pending','a review alone does not deliver');
    await pump();assert.equal(manager.messages.at(-1).source.eventId,deliveryId);
    await enterManager(manager);
    const {delivery}=await f.call('deliver-independent',{action:'deliver',taskId:ready.task.id,resultId:ready.result!.id,text:'Evidence ready'});
    await endManager(manager,delivery.markdown);
    assert.equal(notice(deliveryId),undefined,'independent delivery has a durable native final receipt');
  });
}

test('DF-13 A wake dispatches B, whose same attention appears only once in automatic Manager replies',async t=>{
  const {f,root,dir,create,dispatch,pump,notice,openManager,enterManager,endManager}=await parallelFixture(t);
  const holders=[await create('First holder',root),await create('Second holder',root)];
  const a=await create('A',dir('a'));
  t.mock.timers.tick(1);
  const b=await create('B',dir('b'));
  const oldB=`manager-event:capacity:${b.task.id}:${b.task.rowVersion}`;
  assert.equal(a.deferred,true);assert.equal(b.deferred,true);assert.equal(notice(oldB)?.state,'pending');
  for(const holder of holders){
    await f.finish(holder.task.id,[],'waiting');
    f.store.settleManagerEvent(`manager-event:settled:${holder.run.id}`);
  }
  const manager=await openManager();
  await pump();
  assert.equal(manager.messages.at(-1).source.eventId,`manager-event:capacity:${a.task.id}:${a.task.rowVersion}`);
  await enterManager(manager);
  const aStarted=await dispatch('start-a',a.task.id),bStarted=await dispatch('start-b',b.task.id);
  assert.ok(aStarted.run&&bStarted.run);assert.equal(f.store.heldRuns().length,2);
  t.mock.timers.tick(1);
  await f.finish(b.task.id,[],'waiting');
  const question=f.store.taskDetail(b.task.id).pendingQuestions[0]!;
  assert.equal(question.id,`run:${bStarted.run.id}`);
  await endManager(manager,'A and B started');

  const displayed:string[]=[];
  const notices:string[]=[];
  for(let i=0;i<2;i++){
    await pump();
    if(manager.status!=='running')break;
    notices.push(manager.messages.at(-1).source.eventId);
    await enterManager(manager);
    const detail=await f.call(`read-B-question:${i}`,{action:'detail',taskId:b.task.id});
    displayed.push(...detail.pendingQuestions.map((item:any)=>item.id));
    await endManager(manager,detail.pendingQuestions.map((item:any)=>item.markdown).join('\n')||'No current question');
    t.mock.timers.tick(1);
  }
  assert.deepEqual(displayed,[question.id],`native followups: ${notices.join(', ')}`);
  assert.deepEqual(notices,[`manager-event:settled:${bStarted.run.id}`]);
  assert.equal(notice(oldB),undefined,'B dispatch fulfilled its old capacity intent');
  const explicit=await f.call('explicit-B-detail',{action:'detail',taskId:b.task.id});
  assert.equal(explicit.pendingQuestions[0]?.id,question.id,'an explicit detail request still shows the open question');
  const answer=f.store.respondAttention('answer-B',question.id,f.store.getTask(b.task.id).rowVersion,'Use Chinese');
  await pump();
  assert.equal(manager.messages.at(-1).source.eventId,`manager-event:answer:${answer.id}`);
  await enterManager(manager);
  const next=await dispatch('continue-B',b.task.id);
  await endManager(manager,'B continues with the answer');
  await f.finish(b.task.id,[],'waiting');
  await pump();await enterManager(manager);
  const later=await f.call('new-B-detail',{action:'detail',taskId:b.task.id});
  assert.deepEqual(later.pendingQuestions.map((item:any)=>item.id),[`run:${next.run.id}`]);
  await endManager(manager,later.pendingQuestions[0].markdown);
});

test('DF-13 pump and dispatch preserve FIFO when there is one execution slot',async t=>{
  const {f,root,dir,create,dispatch,pump,openManager,enterManager,endManager}=await parallelFixture(t,1);
  const holder=await create('Root holder',root),parent=dir('parent'),child=dir('parent/child');
  const a=await create('First waiter',parent);t.mock.timers.tick(1);
  const b=await create('Second waiter',child);
  await f.finish(holder.task.id,[],'waiting');
  f.store.settleManagerEvent(`manager-event:settled:${holder.run.id}`);
  const manager=await openManager();
  await pump();await enterManager(manager);
  assert.equal(manager.messages.at(-1).source.eventId,`manager-event:capacity:${a.task.id}:${a.task.rowVersion}`);
  const premature=await dispatch('try-B-before-A',b.task.id);
  assert.equal(premature.holderTaskId,a.task.id);
  assert.ok((await dispatch('start-FIFO-A',a.task.id)).run);
  await endManager(manager,'First waiter started');
  await pump();assert.equal(manager.messages.length,1,'B waits while A occupies the slot');
  await f.finish(a.task.id,[],'waiting');
  f.store.settleManagerEvent(`manager-event:settled:${f.store.latestRun(a.task.id)!.id}`);
  await pump();await enterManager(manager);
  assert.equal(manager.messages.at(-1).source.eventId,`manager-event:capacity:${b.task.id}:${b.task.rowVersion}`);
  assert.ok((await dispatch('start-FIFO-B',b.task.id)).run);
  await endManager(manager,'Second waiter started');
});

for(const mode of ['dispatch retries','detail only','detail then raise before receipt'] as const)
test(`lowering a Bot limit during its capacity wake preserves FIFO with ${mode}`,async t=>{
  const {f,root,create,dispatch,pump,notice,openManager,enterManager,endManager}=await parallelFixture(t,1);
  const holder=await create('Holder',root),first=await create('First waiter',root);
  t.mock.timers.tick(1);
  const second=await create('Second waiter',root);
  assert.ok(holder.run);
  assert.equal(first.reason,'capacity');
  assert.equal(second.reason,'capacity');
  const original=`manager-event:capacity:${first.task.id}:${first.task.rowVersion}`;
  const secondNotice=`manager-event:capacity:${second.task.id}:${second.task.rowVersion}`;
  const waitSequence=()=>f.store.db.prepare('SELECT seq FROM waits WHERE taskId=?').get(first.task.id)?.seq;
  const sequence=waitSequence();
  assert.ok(sequence);

  const manager=await openManager();
  f.store.setBotCapacity('raise-to-two',f.bot.id,1,2);
  await pump();
  assert.deepEqual(manager.messages.map((message:any)=>message.source.eventId),[original]);
  await enterManager(manager);
  assert.equal(notice(original)?.state,'entered');

  f.store.setBotCapacity('lower-to-one',f.bot.id,2,1);
  if(mode==='dispatch retries') {
    const deferred=await dispatch('defer-first',first.task.id);
    assert.equal(deferred.reason,'capacity');
    assert.equal(deferred.capacityScope,'bot');
    assert.deepEqual(await dispatch('defer-first',first.task.id),deferred);
    assert.deepEqual(await dispatch('defer-first-again',first.task.id),deferred);
  } else {
    const detail=await f.call('detail-first',{action:'detail',taskId:first.task.id});
    assert.equal(detail.wait?.code,'capacity');
    assert.equal(detail.wait?.scope,'bot');
  }
  assert.equal(f.store.latestRun(first.task.id),null);
  assert.equal(waitSequence(),sequence);
  const retries=f.store.pendingManagerEvents(f.bot.id).filter(event=>event.id.startsWith(`${original}:`));
  assert.equal(retries.length,1,'the blocked waiter has a single pending capacity notice');
  assert.equal(notice(original)?.state,'entered');
  const retry=retries[0].id;
  if(mode==='detail then raise before receipt') {
    f.store.setBotCapacity('raise-again',f.bot.id,1,2);
    await pump();
    assert.equal(manager.messages.length,1,'the original native wake still owns the active turn');
    assert.equal(notice(retry)?.state,'pending');
  }

  await endManager(manager,'The Bot is still at its Worker limit');
  assert.equal(notice(original),undefined,'the old capacity notice has its own durable receipt');
  assert.equal(notice(retry)?.state,'pending');
  assert.equal(notice(secondNotice)?.state,'pending');
  if(mode!=='detail then raise before receipt') {
    await pump();await pump();
    assert.equal(manager.messages.length,1);
    f.store.setBotCapacity('raise-again',f.bot.id,1,2);
  }

  await pump();
  assert.deepEqual(manager.messages.map((message:any)=>message.source.eventId),[original,retry]);
  await enterManager(manager);
  assert.equal((await dispatch('try-second-first',second.task.id)).holderTaskId,first.task.id);
  const started=await dispatch('start-first',first.task.id);
  assert.ok(started.run);
  assert.equal(f.store.latestRun(second.task.id),null);
  await endManager(manager,'The first waiter started');
  await pump();
  assert.equal(manager.messages.length,2,'the holder and first waiter now occupy both slots');
  await f.finish(first.task.id,[],'waiting');
  f.store.settleManagerEvent(`manager-event:settled:${started.run.id}`);
  await pump();
  assert.deepEqual(manager.messages.map((message:any)=>message.source.eventId),[original,retry,secondNotice]);
  await enterManager(manager);
  assert.ok((await dispatch('start-second',second.task.id)).run);
  await endManager(manager,'The second waiter started');
});

test('DF-13 unknown Worker enqueue retains recovery and only a confirmed retry fulfills the old intent',async t=>{
  const {f,root,dir,create,dispatch,pump,notice,openManager,enterManager,endManager}=await parallelFixture(t,1);
  const holder=await create('Root holder',root),task=await create('Retry after recovery',dir('retry'));
  const old=`manager-event:capacity:${task.task.id}:${task.task.rowVersion}`;
  await f.finish(holder.task.id,[],'waiting');
  f.store.settleManagerEvent(`manager-event:settled:${holder.run.id}`);
  const binding=f.store.activeBinding(task.task.id)!,worker=f.agents.get(binding.sessionId!);
  const followup=worker.followup;
  worker.followup=()=>{throw Error('Synthetic Worker receipt lost');};
  await assert.rejects(dispatch('unknown-start',task.task.id),/Synthetic Worker receipt lost/);
  const unknown=f.store.latestRun(task.task.id)!;
  assert.equal(unknown.state,'interrupted');assert.equal(notice(old)?.state,'pending');
  assert.equal(f.store.getRunInput(unknown.id).state,'unknown');
  const manager=await openManager();
  await pump();await enterManager(manager);
  assert.equal(manager.messages.at(-1).source.eventId,`manager-event:recovery:${unknown.id}`);
  await endManager(manager,'Recovery requires user confirmation');
  await pump();assert.equal(manager.messages.length,1);
  assert.ok(f.store.heldRuns().some(run=>run.id===unknown.id),'unknown execution keeps its execution slot');
  worker.followup=followup;
  const version=f.store.getTask(task.task.id).rowVersion;
  const continuation={attentionId:`run:${unknown.id}`,bindingId:binding.id,expectedBindingGeneration:binding.generation};
  const resumed=await f.execution.recover('resume-confirmed',task.task.id,version,true,continuation);
  assert.notEqual(resumed.id,unknown.id);assert.equal(notice(old),undefined);
  assert.equal((await f.execution.recover('resume-confirmed',task.task.id,version,true,continuation)).id,resumed.id);
  assert.equal(worker.messages.length,1);
});
test('DF-13 reopen fulfills only a legacy unsent intent with a newer Worker receipt',async t=>{
  const {f,dir,create,dispatch,pump,notice,openManager,enterManager,endManager}=await parallelFixture(t,1);
  const shared=dir('legacy');
  const holder=await create('Legacy holder',shared),queued=await create('Legacy waiter',shared);
  const id=`manager-event:capacity:${queued.task.id}:${queued.task.rowVersion}`;
  f.store.enqueueManager(f.bot.id,`capacity:${queued.task.id}:1`,'Old Manager receipt lost',queued.task.id);
  const uncertain=`manager-event:capacity:${queued.task.id}:1`;
  const message={id:'lost-manager-message',source:{kind:'super-bot-manager',botId:f.bot.id,managerId:f.manager.id,eventId:uncertain}};
  assert.equal(f.store.claimManagerEvent(uncertain,message.id,JSON.stringify(message)),true);
  t.mock.timers.tick(1);
  await f.finish(holder.task.id,[],'waiting');
  f.store.settleManagerEvent(`manager-event:settled:${holder.run.id}`);
  const {run}=await dispatch('start-legacy',queued.task.id);
  await f.finish(queued.task.id,[],'waiting');
  assert.equal(notice(uncertain)?.state,'sending','Worker admission cannot prove that a Manager message was received');
  f.store.db.prepare("UPDATE outbox SET state='pending',payload=json_remove(payload,'$.fulfilledByRunId') WHERE id=?").run(id);
  f.store.db.prepare("UPDATE outbox SET payload=json_remove(payload,'$.dispatchRowVersion') WHERE id=?").run(`input:${run.inputId}`);
  t.mock.timers.tick(1);
  f.store.enqueueManager(f.bot.id,`capacity:${queued.task.id}:999`,'A later intent',queued.task.id);
  const later=`manager-event:capacity:${queued.task.id}:999`;
  await f.reload();
  assert.equal(notice(id),undefined);
  assert.equal(notice(uncertain)?.state,'unknown');
  assert.equal(notice(later)?.state,'pending');
  const manager=await openManager();
  await pump();await enterManager(manager);
  assert.deepEqual(manager.messages.map((msg:any)=>msg.source.eventId),[`manager-event:settled:${run.id}`]);
  await endManager(manager,'One question after restart');
});

test('Bot can dispatch two Workers into the same existing directory',async t=>{
  const {f,root,create}=await parallelFixture(t);
  const first=await create('改登录',root),second=await create('改注册',root);
  assert.ok(first.run&&second.run);
  assert.notEqual(first.run.sessionId,second.run.sessionId);
  for(const started of [first,second]) {
    assert.match(started.workdir,/existing/);
    assert.equal(f.store.activeBinding(started.task.id)?.cwd,root);
    assert.match(f.agents.get(started.run.sessionId).messages[0].content[0].text,/Working directory: .* \(existing directory/);
  }
  assert.deepEqual(new Set(f.store.heldRuns().map(run=>run.id)),new Set([first.run.id,second.run.id]));
  const file=join(root,'register.md');writeFileSync(file,'Registration evidence');
  await f.finish(second.task.id,[file]);
  assert.equal(f.store.taskDetail(second.task.id).result?.evidence[0]?.path,file);
  assert.equal(f.store.taskDetail(first.task.id).runHeld,true);
  assert.equal(f.store.taskDetail(first.task.id).result,null);
});

test('code delivery from native chat preserves a dirty Git baseline and reports only attributable work', async t => {
  const f = fixture(t, true, directory => ({ allowedRoots: [work(directory)] }));
  t.after(f.close);
  const repo = join(f.directory, 'work', 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 5_000 });
  const app = join(repo, 'app.mjs'), notes = join(repo, 'review.md'), overlap = join(repo, 'overlap.mjs');
  const initial = 'export const staged = 0;\nexport const local = 0;\nexport const feature = false;\n';
  const staged = initial.replace('staged = 0', 'staged = 1');
  const dirty = staged.replace('local = 0', 'local = 1');
  git('init', '--quiet', '--template=');
  writeFileSync(app, initial);
  writeFileSync(overlap, 'export const value = 0;\n');
  git('add', 'app.mjs', 'overlap.mjs');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Synthetic starting point');
  writeFileSync(app, staged);
  git('add', 'app.mjs');
  writeFileSync(app, dirty);
  writeFileSync(notes, 'Existing untracked review\n');
  writeFileSync(overlap, 'export const value = 1;\n');
  const head = git('rev-parse', 'HEAD').trim();
  const openingStatus = git('status', '--short', '--', 'app.mjs', 'overlap.mjs', 'review.md');
  assert.equal(openingStatus, 'MM app.mjs\n M overlap.mjs\n?? review.md\n');
  const openingApp = readFileSync(app, 'utf8');
  const openingCopy = join(f.directory, 'app-before.mjs');
  writeFileSync(openingCopy, openingApp);
  const indexBefore = git('diff', '--cached', '--binary');

  await f.native('request-code', 1, '只修改 app.mjs 中的 feature，保留已有编辑并报告验证结果。');
  const { task, run } = await f.nativeCall('create-code', {
    action: 'create', goal: 'Enable the app feature', workdir: { mode: 'existing', path: repo },
  });
  assert.ok(run);
  const prompt = f.delivered().content[0].text;
  assert.match(prompt, /For code work, .*before editing, record the opening Git HEAD and relevant staged, unstaged, and untracked changes/);
  assert.match(prompt, /Compare with the opening state/);
  assert.match(prompt, /If you cannot attribute a change, say so/);
  assert.match(prompt, /commands actually run, their outcomes, and what remains unverified/);
  assert.match(prompt, /matching native load receipt for this result and build/);
  assert.match(prompt, /For ordinary non-code work, keep the report brief/);
  assert.match(f.schemas().find(tool => tool.name === 'super_bot_manage')!.description!, /matching native receipt in detail\.progress\.reload/);

  const modifiedApp = openingApp.replace('feature = false', 'feature = true');
  writeFileSync(app, modifiedApp);
  // Simulate an unobserved editor's overlapping change. The report leaves attribution open.
  writeFileSync(overlap, 'export const value = 2;\n');
  execFileSync(process.execPath, ['--check', 'app.mjs'], { cwd: repo, timeout: 5_000 });
  git('diff', '--check');
  const delta = spawnSync('git', ['diff', '--no-index', '--', openingCopy, app], { cwd: repo, encoding: 'utf8', timeout: 5_000 });
  assert.equal(delta.status, 1, delta.stderr);
  const taskDiff = delta.stdout.split('\n').filter(line => /^[+-]export /.test(line)).join('\n');
  assert.equal(taskDiff, '-export const feature = false;\n+export const feature = true;');
  const fact = [
    `Opening Git HEAD ${head}`,
    `Existing related changes\n${openingStatus.trimEnd()}`,
    `Task diff against the opening file\n${taskDiff}`,
    'The later edit to overlap.mjs cannot be attributed using the recorded evidence.',
  ].join('\n\n');
  const proof = join(repo, 'facts.md');
  writeFileSync(proof, fact);
  const summary = 'Enabled feature in app.mjs. See facts.md for the opening HEAD and scoped delta.';
  const checks = 'Ran node --check app.mjs and git diff --check. Both exited 0.\nWeb and Desktop loading unverified.';
  const report = await f.finish(task.id, [proof, app], 'ready', { summary, checks });
  const detail = await f.nativeCall('detail-code', { action: 'detail', taskId: task.id });
  assert.equal(detail.result.id, report.resultId);
  assert.equal(detail.result.summary, summary);
  assert.equal(detail.result.checks, checks);
  assert.equal(detail.progress.reload, null);
  assert.equal(detail.evidenceValidation.status, 'verified');
  assert.deepEqual(detail.files.map((file: { path: string; text: string }) => [file.path, file.text]), [[proof, fact], [app, modifiedApp]]);
  assert.deepEqual(detail.files[0].text.split('\n\n').slice(2), [
    `Task diff against the opening file\n${taskDiff}`, 'The later edit to overlap.mjs cannot be attributed using the recorded evidence.',
  ]);
  const headDiff = git('diff', 'HEAD', '--', 'app.mjs');
  assert.match(headDiff, /\+export const staged = 1;/);
  assert.match(headDiff, /\+export const local = 1;/);
  assert.equal(readFileSync(app, 'utf8').replace('feature = true', 'feature = false'), openingApp);
  assert.equal(readFileSync(notes, 'utf8'), 'Existing untracked review\n');
  assert.equal(git('diff', '--cached', '--binary'), indexBefore);
  assert.equal(git('rev-parse', 'HEAD').trim(), head);

  const { delivery } = await f.nativeCall('deliver-code', {
    action: 'deliver', taskId: task.id, resultId: report.resultId, text: `${summary}\n${checks}`,
  });
  assert.match(delivery.markdown, /Web and Desktop loading unverified/);
  assert.ok(delivery.markdown.includes(`resultId=${report.resultId}`));
  assert.match(delivery.markdown, /\[查看完整交付\]/);
  assert.doesNotMatch(delivery.markdown, /super-bot-file/);
  assert.deepEqual(delivery.files.map((file: { name: string }) => file.name), ['facts.md', 'app.mjs']);
  assert.equal(detail.task.lifecycle, 'review');
  assert.equal(detail.result.humanAcceptedAt, null);
});

test('workdir requests outside allowedRoots are rejected with a stable code and no session',async t=>{
  const f=fixture(t,false,directory=>({allowedRoots:[join(directory,'allowed')]}));try {
    mkdirSync(join(f.directory,'allowed'));mkdirSync(join(f.directory,'other'));
    await f.native('request',1,'改 other。');
    const result=await f.call('wd-out',{action:'create',goal:'越界',workdir:{mode:'existing',path:join(f.directory,'other')}});
    assert.equal(result.run,undefined);assert.equal(result.dispatchError?.code??result.error?.code??result.code,'workdir-rejected',JSON.stringify(result));
    assert.equal(f.store.activeBinding(result.task.id),null);
    assert.ok(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='workdir.failed'").get()?.n);
    const bad=await f.nativeResult('wd-shape',{action:'create',goal:'坏参数',workdir:{mode:'hook',args:{x:'$(id)'}}});
    assert.ok(bad.isError||JSON.stringify(bad).includes('workdir-rejected'),JSON.stringify(bad));
  }finally{await f.close();}
});

test('hook provisioning runs once per dispatch request and records a cleanable workdir',async t=>{
  const f=fixture(t,false,directory=>({allowedRoots:[work(directory)],workdirHook:{create:'echo run >> "$SB_TASK_ID.count"; mkdir -p "ws/$SB_NAME"; echo "SB_WORKDIR=$PWD/ws/$SB_NAME"',remove:'rm -r "$SB_WORKDIR"',argNames:['repos']}}));try {
    await f.native('request',1,'在多仓工作区里改。');
    const created=await f.call('wd-hook',{action:'create',goal:'多仓修改',workdir:{mode:'hook',name:'multi',args:{repos:'a b'}}});
    assert.ok(created.run,JSON.stringify(created));
    const cwd=f.store.activeBinding(created.task.id)!.cwd;assert.equal(cwd,join(f.directory,'work','ws',`multi-${created.task.id.slice(0,8)}`));
    const retry=await f.call('wd-hook',{action:'create',goal:'多仓修改',workdir:{mode:'hook',name:'multi',args:{repos:'a b'}}});
    assert.equal(retry.run.id,created.run.id);
    const {readFileSync}=await import('node:fs');
    assert.equal(readFileSync(join(f.directory,'work',`${created.task.id}.count`),'utf8'),'run\n','hook is not rerun by an idempotent retry');
    await assert.rejects(f.execution.cleanupWorkdir(created.task.id),{code:'task-active'});
    await f.emit({type:'user/message',seq:1,data:f.delivered()},created.run.sessionId);
    f.store.workerReport(created.run.id,'failed',{kind:'failed',summary:'Synthetic stop'});
    f.agents.get(created.run.sessionId).finish();await new Promise<void>(resolve=>setImmediate(resolve));
    f.store.db.prepare("UPDATE attentions SET state='stale' WHERE taskId=?").run(created.task.id);
    f.store.cancelTask('cancel',created.task.id,f.store.getTask(created.task.id).rowVersion);
    const cleaned=await f.execution.cleanupWorkdir(created.task.id);
    assert.equal(cleaned.workdir?.state,'removed');assert.equal(existsSync(cwd),false);
    assert.equal(f.store.latestBinding(created.task.id)?.workdir?.state,'removed');
  }finally{await f.close();}
});
