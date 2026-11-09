/** Native session/event -> installed management tool; no private adapter state. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Context} from '@deepseek-ai/cordis';
import {Managers} from '../../src/manager.ts';
import {Store} from '../../src/store.ts';
import type {DshExecution} from '../../src/dsh.ts';

type Handler=(args:Record<string,unknown>,exec:any)=>Promise<any>;
function fixture(){
  // All domain fixtures are in memory; this suite never creates files outside the repository.
  const directory=process.cwd(),store=new Store(':memory:');
  const bot=store.createBot('bot',{name:'Bot',instructions:'Synthetic chat adapter fixture'});
  const manager=store.beginManager('manager',bot.id,directory);store.confirmManager(manager.id,manager.requestedSessionId);
  const listeners=new Map<string,Function>();let execute:Handler=async()=>{throw Error('Tool not installed');};
  const ctx={effect:(callback:()=>unknown)=>callback(),on:(name:string,callback:Function)=>{listeners.set(name,callback);return ()=>{};},agents:{list:()=>[]},tools:{register:(tool:{execute:Handler})=>{execute=tool.execute;return ()=>{};}}} as unknown as Context;
  const managers=new Managers(ctx,store,{} as DshExecution,directory);managers.install();
  const emit=(event:any,sessionId=manager.requestedSessionId)=>listeners.get('session/event')!({id:sessionId},event);
  const native=(id:string,seq:number,text:string)=>emit({type:'user/message',seq,data:{id,source:{kind:'user',rpcId:`rpc:${id}`},content:[{type:'text',text}]}});
  const source=(taskId:string,kind:string)=>{
    const event=store.taskDetail(taskId).events.find(event=>event.kind===kind);assert.ok(event,`Missing ${kind}`);
    return JSON.parse(event.data).source;
  };
  const enterRun=(taskId:string,label:string)=>{
    if(!store.activeBinding(taskId)){
      const binding=store.beginBinding(`binding:${label}`,taskId,store.getTask(taskId).rowVersion,directory);
      store.claimBindingCreation(binding.id);store.confirmBinding(binding.id,binding.requestedSessionId);
    }
    const run=store.reserveRun(`run:${label}`,taskId,store.getTask(taskId).rowVersion);
    store.saveRunMessage(run.id,`worker:${label}`,'{}');store.claimDispatch(run.id);store.inputEntered(run.id,`worker:${label}`,1);return run;
  };
  return {store,bot,manager,emit,native,source,enterRun,
    call:(callId:string,args:Record<string,unknown>)=>execute(args,{agent:{id:manager.requestedSessionId},callId,signal:new AbortController().signal}),
    close:async()=>{await managers.dispose();store.close();}};
}

test('native multi-message turns preserve ordered, deduplicated full sources for create, respond and rework',async()=>{
  const f=fixture();try{
    const sessionId=f.manager.requestedSessionId;
    f.emit({type:'turn/start',data:{turn:1}});
    f.native('request-last',13,'第三条：附上结论。');
    f.native('request-first',11,'第一条：请写项目介绍。');
    f.emit({type:'user/message',seq:12,data:{id:'request-middle',source:{kind:'user',rpcId:'rpc:middle'},content:[{type:'text',text:'第二条：保留背景。'},{type:'image',url:'synthetic://ignored'},{type:'text',text:'这里是补充原文。'}]}});
    f.native('request-first',11,'第一条：请写项目介绍。'); // Exact native-event redelivery.
    f.native('request-first',90,'ID 重投不得替换原文');
    f.native('same-sequence',12,'seq 重投不得插入');
    f.emit({type:'user/message',seq:14,data:{id:'automatic',source:{kind:'super-bot-manager',botId:f.bot.id,managerId:f.manager.id,eventId:'missing'},content:[{type:'text',text:'自动通知不能成为请求。'}]}});
    f.emit({type:'user/message',seq:15,data:{id:'no-rpc',source:{kind:'user'},content:[{type:'text',text:'缺少原生 rpcId。'}]}});
    f.emit({type:'turn/start',data:{turn:1}},'other-session');
    f.emit({type:'user/message',seq:17,data:{id:'foreign',source:{kind:'user',rpcId:'foreign'},content:[{type:'text',text:'另一个会话。'}]}},'other-session');
    const createArgs={action:'create',dispatch:false,goal:'项目介绍',scope:'本地合成文档',acceptance:'包含背景和结论'};
    const created=await f.call('create',createArgs);
    assert.deepEqual(f.source(created.task.id,'task.created'),{
      sessionId,messageId:'request-last',seq:13,
      text:'第一条：请写项目介绍。\n\n第二条：保留背景。\n这里是补充原文。\n\n第三条：附上结论。',
      messages:[
        {messageId:'request-first',seq:11,text:'第一条：请写项目介绍。'},
        {messageId:'request-middle',seq:12,text:'第二条：保留背景。\n这里是补充原文。'},
        {messageId:'request-last',seq:13,text:'第三条：附上结论。'},
      ],
    });
    assert.deepEqual(await f.call('create',createArgs),created);
    const waiting=f.enterRun(created.task.id,'question');
    f.store.workerReport(waiting.id,'question',{kind:'waiting',summary:'用什么语言，保留哪些内容？'});f.store.settleRun(waiting.id);
    f.emit({type:'turn/end',data:{reason:{kind:'stop'}}});f.emit({type:'turn/start',data:{turn:2}});
    f.native('answer-last',24,'保留背景和结论。');f.native('answer-first',22,'用中文。');
    f.native('answer-first',25,'重复 ID 不应该覆盖');f.native('answer-duplicate-seq',24,'重复 seq 不应该追加');
    const detail=f.store.taskDetail(created.task.id),attention=detail.attentions.find(item=>item.kind==='input'&&item.state==='open')!;
    const answerArgs={action:'respond',taskId:created.task.id,attentionId:attention.id,expectedRowVersion:detail.task.rowVersion,note:'模型改写的回答不可使用'};
    const answer=await f.call('respond',answerArgs);assert.equal(answer.input.content,'用中文。\n\n保留背景和结论。');
    assert.deepEqual(f.source(created.task.id,'attention.answered'),{sessionId,messageId:'answer-last',seq:24,text:'用中文。\n\n保留背景和结论。',messages:[{messageId:'answer-first',seq:22,text:'用中文。'},{messageId:'answer-last',seq:24,text:'保留背景和结论。'}]});
    assert.deepEqual(await f.call('respond',answerArgs),answer);
    const ready=f.enterRun(created.task.id,'ready');
    const report=f.store.workerReport(ready.id,'ready',{kind:'ready',summary:'合成成果已提交',checks:'仅用于适配边界',evidence:[{path:'synthetic-result.md',sha256:'0'.repeat(64),bytes:1}]});f.store.settleRun(ready.id);
    f.emit({type:'turn/end',data:{reason:{kind:'stop'}}});f.emit({type:'turn/start',data:{turn:3}});
    f.native('rework-first',31,'再精简一些。');f.native('rework-last',32,'再精简一些。');
    const reworkArgs={action:'rework',taskId:created.task.id,resultId:report.resultId,expectedRowVersion:f.store.getTask(created.task.id).rowVersion,note:'模型缩写不可代替原文'};
    const reworked=await f.call('rework',reworkArgs);assert.equal(f.store.pendingInput(created.task.id)?.content,'再精简一些。\n\n再精简一些。');
    assert.deepEqual(f.source(created.task.id,'result.rejected'),{sessionId,messageId:'rework-last',seq:32,text:'再精简一些。\n\n再精简一些。',messages:[{messageId:'rework-first',seq:31,text:'再精简一些。'},{messageId:'rework-last',seq:32,text:'再精简一些。'}]});
    assert.deepEqual(await f.call('rework',reworkArgs),reworked);assert.equal(f.store.resultById(report.resultId!)?.humanAcceptedAt,null);
  }finally{await f.close();}
});

test('turn boundaries clear human authority while automatic and other-session messages never grant it',async()=>{
  const f=fixture();try{
    const args={action:'create',dispatch:false,goal:'合成任务',scope:'当前仓库',acceptance:'检查来源'};
    f.native('previous',1,'上一轮用户请求');f.emit({type:'turn/start',data:{turn:1}});
    await assert.rejects(f.call('after-start',args),{code:'human-message-required'});
    f.emit({type:'user/message',seq:3,data:{id:'other',source:{kind:'user',rpcId:'other-rpc'},content:[{type:'text',text:'另一个会话的请求'}]}},'other-session');
    for(const source of [{kind:'super-bot-manager',botId:f.bot.id,managerId:f.manager.id,eventId:'missing'},{kind:'synthetic-automatic',rpcId:'not-native'},{kind:'user'}]){
      f.emit({type:'user/message',seq:4,data:{id:'not-human',source,content:[{type:'text',text:'不能授权创建'}]}});
      await assert.rejects(f.call('not-human',args),{code:'human-message-required'});
    }
    f.native('current-first',5,'当前第一条');f.native('current-last',6,'当前第二条');
    const created=await f.call('current',args);assert.equal(f.source(created.task.id,'task.created').text,'当前第一条\n\n当前第二条');
    f.emit({type:'turn/end',data:{reason:{kind:'stop'}}});
    await assert.rejects(f.call('after-end',args),{code:'human-message-required'});
    f.emit({type:'turn/start',data:{turn:2}});
    f.emit({type:'user/message',seq:9,data:{id:'automatic-only',source:{kind:'super-bot-manager',botId:f.bot.id,managerId:f.manager.id,eventId:'missing'},content:[{type:'text',text:'上一轮真实用户不能授权这一轮自动通知'}]}});
    await assert.rejects(f.call('automatic-only',args),{code:'human-message-required'});
    f.native('single',10,'新轮次唯一用户原文');const next=await f.call('single',args);
    assert.deepEqual(f.source(next.task.id,'task.created'),{sessionId:f.manager.requestedSessionId,messageId:'single',seq:10,text:'新轮次唯一用户原文'});
    assert.equal(f.store.listTasks({botId:f.bot.id}).total,2);
  }finally{await f.close();}
});

test('long multi-message sources are never truncated and oversized feedback fails without partial writes',async()=>{
  const f=fixture();try{
    const first='前'.repeat(6000)+'FIRST-TAIL',last='后'.repeat(5000)+'LAST-TAIL',full=`${first}\n\n${last}`;
    f.emit({type:'turn/start',data:{turn:1}});f.native('long-first',11,first);f.native('long-last',12,last);
    const args={action:'create',dispatch:false,goal:'超限回答边界',scope:'当前仓库',acceptance:'完整来源，不得静默截断'};
    const created=await f.call('long-create',args);
    assert.deepEqual(f.source(created.task.id,'task.created'),{
      sessionId:f.manager.requestedSessionId,messageId:'long-last',seq:12,text:full,
      messages:[{messageId:'long-first',seq:11,text:first},{messageId:'long-last',seq:12,text:last}],
    });
    assert.ok(full.length>10000);assert.ok(f.source(created.task.id,'task.created').text.endsWith('LAST-TAIL'));
    const waiting=f.enterRun(created.task.id,'long-question');
    f.store.workerReport(waiting.id,'question',{kind:'waiting',summary:'请提供完整回答'});f.store.settleRun(waiting.id);
    const detail=f.store.taskDetail(created.task.id),attention=detail.attentions.find(item=>item.kind==='input'&&item.state==='open')!;
    await assert.rejects(f.call('long-respond',{action:'respond',taskId:created.task.id,attentionId:attention.id,expectedRowVersion:detail.task.rowVersion}),{code:'invalid-input',message:'回答不能超过 10000 字符。'});
    assert.equal(f.store.getTask(created.task.id).rowVersion,detail.task.rowVersion);
    assert.equal(f.store.taskDetail(created.task.id).attentions.find(item=>item.id===attention.id)?.state,'open');
    assert.equal(f.store.pendingInput(created.task.id),null);assert.ok(!f.store.taskDetail(created.task.id).events.some(event=>event.kind==='attention.answered'));
    const candidate=await f.call('long-rework-create',{...args,goal:'超限返工边界'}),ready=f.enterRun(candidate.task.id,'long-ready');
    const report=f.store.workerReport(ready.id,'ready',{kind:'ready',summary:'合成成果',checks:'仅用于长度边界',evidence:[{path:'synthetic-long-result.md',sha256:'0'.repeat(64),bytes:1}]});f.store.settleRun(ready.id);
    const version=f.store.getTask(candidate.task.id).rowVersion;
    await assert.rejects(f.call('long-rework',{action:'rework',taskId:candidate.task.id,resultId:report.resultId,expectedRowVersion:version}),{code:'invalid-input',message:'返工要求不能超过 10000 字符。'});
    assert.equal(f.store.getTask(candidate.task.id).rowVersion,version);assert.equal(f.store.getTask(candidate.task.id).lifecycle,'review');
    assert.equal(f.store.pendingInput(candidate.task.id),null);assert.ok(!f.store.taskDetail(candidate.task.id).events.some(event=>event.kind==='result.rejected'));
    assert.equal(f.store.resultById(report.resultId!)?.humanAcceptedAt,null);
  }finally{await f.close();}
});
