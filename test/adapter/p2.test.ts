/** P2 regressions through the installed management tool and real durable ledger.
 * Only the native host boundary is synthetic; no running host or user data is touched. */
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync,unlinkSync} from 'node:fs';
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

function fixture(t:TestContext,workspace=false) {
  t.mock.timers.enable({apis:['setInterval']});
  const root=realpathSync(process.cwd());mkdirSync(join(root,'.runtime'),{recursive:true});
  const directory=mkdtempSync(join(root,'.runtime','p2-adapter-')),database=join(directory,'ledger.sqlite');
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
  const titles=new Map<any,any>();
  const ctx={
    permissionPresets:{set:()=>{}},
    sessionTitle:{get:(session:any)=>titles.get(session),rename:(session:any,title:string)=>{const value={title,source:{kind:'user'}};titles.set(session,value);return value;}},
    sessions:{get:(id:string)=>agents.get(id)?.session,flush:async()=>true},
    effect:(callback:()=>unknown)=>callback(),
    on:(name:string,callback:Function)=>{const list=listeners.get(name)??[];list.push(callback);listeners.set(name,list);return ()=>{list.splice(list.indexOf(callback),1);};},
    tools:{register:(tool:any,options:any)=>{tools.set(tool.name,tool);const off=registry.register(tool,options);registrations.push(off);return off;}},
    agents:{list:()=>[],isOwnedBy:()=>false},jobs:{list:()=>[]},
    workingDirectory:{get:(session:any)=>session.header.cwd},
    sessionProjections:{snapshot:()=>({values:{modelSelection:{next:{provider:'synthetic',model:'synthetic'}}}})},
    workspaceRegistry:{create:async(cwd:string)=>({id:cwd,attachSession:async()=>{}})},
    sessionController:{
      create:async({workspaceId,sessionId}:{workspaceId:string;sessionId:string})=>{
        let resolveIdle:()=>void=()=>{},idle=Promise.resolve();
        const agent:any={id:sessionId,session:{id:sessionId,header:{cwd:workspaceId}},status:'idle',
          model:{current:()=>({provider:'synthetic',model:'synthetic'}),select:()=>{}},inbox:{nextTurn:[],nextStep:[],remove:()=>{}},
          ctx:{systemPrompt:{section:()=>()=>{}},tools:{restrict:()=>()=>{},guard:()=>()=>{}},on:()=>()=>{}},
          followup:(message:any)=>{delivered=message;agent.status='running';idle=new Promise<void>(resolve=>{resolveIdle=resolve;});},
          whenIdle:()=>idle,finish:()=>{agent.status='idle';resolveIdle();},cancel:()=>{agent.status='idle';resolveIdle();}};
        agents.set(sessionId,agent);return {sessionId};
      },
      resolveAgent:async(sessionId:string)=>agents.has(sessionId)?{agent:agents.get(sessionId)}:{error:'synthetic missing session'},
    },
  } as unknown as Context;
  let execution=new DshExecution(ctx,store,directory,{fullAccess:workspace,...(workspace?{workspace:directory}:{})}),managers=new Managers(ctx,store,execution,directory,()=> 'https://example.test');
  const install=()=>{execution.install();managers.install();};install();
  const emit=async(event:any,sessionId=manager.requestedSessionId)=>{for(const listener of listeners.get('session/event')??[])await listener({id:sessionId},event);};
  const native=async(id:string,seq:number,text:string)=>emit({type:'user/message',seq,data:{id,source:{kind:'user',rpcId:`rpc:${id}`},content:[{type:'text',text}]}});
  return {get store(){return store;},get execution(){return execution;},bot,manager,directory,tools,emit,native,nativeResult,ctx,agents,get managers(){return managers;},
    schemas:()=>registry.schemas(),
    nativeCall:async(callId:string,args:Record<string,unknown>)=>{const result=await nativeResult(callId,args);assert.ok(!result.isError,JSON.stringify(result.error));return result.value as any;},
    delivered:()=>delivered,
    finish:async(taskId:string,files:string[],kind:'ready'|'waiting'='ready')=>{
      const run=store.latestRun(taskId)!;await emit({type:'user/message',seq:1,data:delivered},run.sessionId);
      const report=await tools.get('super_bot_report').execute({kind,summary:kind==='ready'?'合成成果':'请补充语言',checks:'逐项回读',files},{agent:agents.get(run.sessionId),callId:'ready',signal:new AbortController().signal,concludeTurn:()=>{}});
      agents.get(run.sessionId).finish();await new Promise<void>(resolve=>setImmediate(resolve));return report;
    },
    call:(callId:string,args:Record<string,unknown>,signal=new AbortController().signal)=>tools.get('super_bot_manage').execute(args,{agent:{id:manager.requestedSessionId},callId,signal}),
    reload:async()=>{await managers.dispose();await execution.dispose();registrations.splice(0).forEach(off=>off());listeners.clear();store.close();store=new Store(database);execution=new DshExecution(ctx,store,directory,{fullAccess:workspace,...(workspace?{workspace:directory}:{})});managers=new Managers(ctx,store,execution,directory,()=> 'https://example.test');install();},
    close:async()=>{await managers.dispose();await execution.dispose();registrations.splice(0).forEach(off=>off());store.close();assert.equal(realpathSync(directory),directory);assert.ok(directory.startsWith(join(root,'.runtime','p2-adapter-')));rmSync(directory,{recursive:true,force:true});t.mock.timers.reset();},
  };
}

for(const [label,fields] of Object.entries({omitted:{},'empty scope':{scope:''},'empty acceptance':{acceptance:''},'both empty':{scope:'',acceptance:''}}))test(`respond native tool accepts ${label} optional fields for a bound Worker question`,async t=>{
  const f=fixture(t);try {
    const schema=f.schemas().find(tool=>tool.name==='super_bot_manage')!.parameters as any;
    assert.deepEqual(schema.required,['action']);assert.deepEqual(schema.properties.scope,{type:'string'});assert.deepEqual(schema.properties.acceptance,{type:'string'});
    await f.native('request',1,'按原范围写介绍。');
    const created=await f.nativeCall('create',{action:'create',goal:'介绍',scope:'原范围',acceptance:'回读'});
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
    const created=await f.nativeCall('create',{action:'create',goal:'介绍',scope:'原范围',acceptance:'回读'});
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
    const created=await f.nativeCall('create',{action:'create',goal:'介绍',scope:'原范围',acceptance:'回读'});
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
    const created=await f.nativeCall('create',{action:'create',goal:'项目介绍'});
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
    const created=await f.call('create',{action:'create',goal:'固定目标',scope:'已有范围'});
    const before=f.store.taskDetail(created.task.id),attention=before.attentions[0]!;
    const args={action:'respond',taskId:created.task.id,attentionId:attention.id,expectedRowVersion:before.task.rowVersion,acceptance:'回读并含结论'};
    await f.emit({type:'turn/start',data:{turn:2}});
    await f.emit({type:'user/message',seq:2,data:{id:'automatic',source:{kind:'super-bot-manager',botId:f.bot.id,managerId:f.manager.id,eventId:'missing'},content:[{type:'text',text:'自动通知不能授权补充'}]}});
    await assert.rejects(f.call('automatic',args),{code:'human-message-required'});
    assert.equal(f.store.getTask(created.task.id).rowVersion,before.task.rowVersion);
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
    const created=await f.nativeCall('create',{action:'create',goal:'分次补充'}),before=f.store.taskDetail(created.task.id);
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
    const created=await f.call('create',{action:'create',goal:'两份文档',scope:'任务目录',acceptance:'回读两份文档'});
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
    assert.equal(after.delivery.workUrl,`/#super-bot-task=${created.task.id}`);
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
    const args={action:'create',goal:'项目介绍',scope:'任务目录',acceptance:'包含背景与结论'};
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
    const args={action:'create',goal:'介绍'},first=await f.call('first',args);
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
    await f.native('request',1,'请写介绍，范围稍后补充。');const args={action:'create',goal:'介绍'};
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
    const created=await f.call('create',{action:'create',goal:'介绍',scope:'原范围',acceptance:'回读'});
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
    const created=await f.call('create',{action:'create',goal:'介绍',scope:'任务目录',acceptance:'回读'});
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


test('overlapping legacy bindings defer and pump waits for both capacity and directory release',async t=>{
  const f=fixture(t);try {
    const tasks=[1,2].map(n=>f.store.createTask(`legacy-${n}`,{botId:f.bot.id,goal:`Legacy ${n}`,scope:'Own files',acceptance:'Read files',reviewPolicy:'human'}));
    for(const task of tasks) {
      const binding=f.store.beginBinding(`binding-${task.id}`,task.id,task.rowVersion,f.directory);
      await f.ctx.sessionController.create({workspaceId:f.directory as any,sessionId:binding.requestedSessionId as any});
      f.store.confirmBinding(binding.id,binding.requestedSessionId);
    }
    const first=await f.call('first',{action:'dispatch',taskId:tasks[0].id,expectedRowVersion:f.store.getTask(tasks[0].id).rowVersion});
    const deferred=await f.call('second',{action:'dispatch',taskId:tasks[1].id,expectedRowVersion:f.store.getTask(tasks[1].id).rowVersion});
    assert.equal(deferred.deferred,true);assert.equal(f.store.latestRun(tasks[1].id),null);
    f.store.db.exec("UPDATE outbox SET state='done' WHERE kind='manager.notify' AND id NOT LIKE 'manager-event:capacity:%'");
    assert.ok(f.store.pendingManagerEvents(f.bot.id)[0].id.startsWith('manager-event:capacity:'));
    await f.ctx.sessionController.create({workspaceId:f.directory as any,sessionId:f.manager.requestedSessionId as any});
    await (f.managers as any).pump();assert.equal(f.agents.get(f.manager.requestedSessionId).status,'idle');
    const input=f.store.getRunInput(first.run.id);await f.emit({type:'user/message',seq:1,data:{id:input.messageId,source:{kind:'super-bot',runId:first.run.id,inputId:input.id}}},first.run.sessionId);
    f.store.workerReport(first.run.id,'failed',{kind:'failed',summary:'Synthetic stop'});
    f.agents.get(first.run.sessionId).finish();await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(f.store.dispatchBlocker(tasks[1].id),null);
    await (f.managers as any).pump();assert.equal(f.agents.get(f.manager.requestedSessionId).status,'running');
    f.agents.get(f.manager.requestedSessionId).finish();
  }finally{await f.close();}
});
