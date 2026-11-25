/** Real Store + installed native event/tool boundary; no host, credentials or model requests. */
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import {Store} from '../../src/store.ts';
import {Managers} from '../../src/manager.ts';
import type {DshExecution} from '../../src/dsh.ts';
import {collectEvidence} from '../../src/evidence.ts';
import {readLocalMirror} from '../../src/mirror-queries.ts';
import type {MirrorDetail} from '../../src/mirror.ts';

async function fixture(t:TestContext,fullAccess?:boolean,extra:Record<string,unknown>={},fileName='result.md') {
  t.mock.timers.enable({apis:['Date','setInterval']});
  const root=realpathSync(process.cwd());mkdirSync(join(root,'.runtime'),{recursive:true});
  const directory=mkdtempSync(join(root,'.runtime','delivery-adapter-'));let store=new Store(join(directory,'ledger.sqlite'));
  const bot=store.createBot('bot',{name:'Delivery Bot',instructions:'Synthetic work'});
  const manager=store.beginManager('manager',bot.id,directory);store.confirmManager(manager.id,manager.requestedSessionId);
  const task=store.createTask('task',{botId:bot.id,goal:'Write facts',scope:'Own files',acceptance:'Read facts',reviewPolicy:'human'});
  const b=store.beginBinding('binding',task.id,task.rowVersion,directory);store.confirmBinding(b.id,b.requestedSessionId);
  const run=store.reserveRun('run',task.id,store.getTask(task.id).rowVersion);store.saveRunMessage(run.id,'worker-input','{}');store.claimDispatch(run.id);store.inputEntered(run.id,'worker-input',1);
  const file=join(directory,fileName);writeFileSync(file,'Two checked facts');
  store.workerReport(run.id,'progress-1',{kind:'progress',summary:'File written'});
  store.workerReport(run.id,'progress-2',{kind:'progress',summary:'Checks passed'});
  const report=store.workerReport(run.id,'report',{kind:'ready',summary:'Facts written',checks:'Read facts',evidence:await collectEvidence(directory,[file])});store.settleRun(run.id);
  // The initial scheduling notification has already been handled before this ready event.
  store.db.prepare("UPDATE outbox SET state='done' WHERE id=?").run(`manager-event:created:${task.id}`);
  const ready=store.pendingManagerEvents(bot.id)[0]!;
  const events:any[]=[],durable:any[]=[];const listeners=new Map<string,Function>();let handler:Function=()=>{};
  let flushMode:'ok'|'false'|'throw'|'blocked'='ok',allowFlush:()=>void=()=>{},followups=0,dispatches=0,cancels=0,guard:Function=()=>undefined,resolveIdle:()=>void=()=>{};
  let idle=Promise.resolve();let allowed:string[]=[],prompt:()=>string=()=>'';
  const session:any={id:manager.requestedSessionId,header:{cwd:directory},meta:{}};
  const agent:any={id:session.id,session,status:'idle',model:{current:()=>({provider:'fake',model:'fake'}),select:()=>{}},inbox:{nextTurn:[],nextStep:[],remove:()=>{}},ctx:{tools:{restrict:(options:{allow:string[]})=>{allowed=options.allow;return ()=>{};},guard:(fn:Function)=>{guard=fn;return ()=>{};}},on:()=>()=>{},systemPrompt:{section:(section:{text:()=>string})=>{prompt=section.text;return ()=>{};}}},whenIdle:()=>idle,followup:(message:any)=>{followups++;agent.status='running';idle=new Promise<void>(resolve=>{resolveIdle=resolve;});agent.lastMessage=message;},cancel:()=>{cancels++;agent.status='idle';resolveIdle();}};
  const ctx={permissionPresets:{set:()=>{}},effect:(callback:()=>unknown)=>callback(),on:(name:string,callback:Function)=>{listeners.set(name,callback);return ()=>{};},agents:{list:()=>[agent]},tools:{register:(tool:any)=>{handler=tool.execute;return ()=>{};}},sessionController:{resolveAgent:async()=>({agent})},sessionProjections:{snapshot:()=>({values:{modelSelection:{next:{provider:'fake',model:'fake'}}}})},sessions:{flush:async()=>{if(flushMode==='blocked')await new Promise<void>(resolve=>{allowFlush=resolve;});if(flushMode==='throw')throw Error('Synthetic durability failure');if(flushMode==='false')return false;durable.splice(0,durable.length,...structuredClone(events));return true;}},sessionPersistence:{open:async()=>({read:async()=>({events:structuredClone(durable)}),close:async()=>{}})}} as unknown as Context;
  const execution={dispatch:async()=>{dispatches++;throw Error('Worker must not run on delivery recovery');},verifyResult:async()=>{}} as unknown as DshExecution;
  const retired:Managers[]=[];
  let managers=new Managers(ctx,store,execution,directory,()=> 'https://example.test',{fullAccess,...extra});managers.install();
  const emit=async(type:string,data:any,surfaceOp?:string)=>{const event={type,data,seq:events.length,time:Date.now(),...(surfaceOp?{surfaceOp}:{})};events.push(event);await listeners.get('session/event')?.(session,event);return event;};
  const emitForeign=(id:string,type:string,data:any)=>listeners.get('session/event')?.({id},{type,data,seq:0,time:Date.now(),surfaceOp:'append'});
  const pulse=async(ms=1000)=>{
    t.mock.timers.setTime(Date.now()+ms);
    await (managers as unknown as {pump():Promise<void>}).pump();
    await new Promise<void>(resolve=>setImmediate(resolve));
  };
  const call=(callId:string,args:Record<string,unknown>,sessionId=agent.id)=>handler(args,{agent:sessionId===agent.id?agent:{id:sessionId},callId,signal:new AbortController().signal});
  const enter=async(turn:number)=>{await emit('turn/start',{turn});const msg=agent.lastMessage;await emit('user/message',msg,'append');};
  const review=async(turn=1)=>{await emit('tool/call',{turn,step:0,callId:'review',name:'super_bot_manage',arguments:JSON.stringify({action:'review',taskId:task.id})});return call('review',{action:'review',taskId:task.id,expectedRowVersion:store.getTask(task.id).rowVersion,resultId:report.resultId,verdict:'human',note:'Read both facts'});};
  const resultLink=()=>`[查看完整交付](https://example.test/#super-bot-task=${task.id}&resultId=${report.resultId})`;
  const fileLink=()=>`[文件](https://example.test/api/super-bot-file?resultId=${report.resultId}&index=0)`;
  const text=()=>`两项事实已写好并回读。\n${resultLink()}`;
  const assistant=async(turn:number,content:any[]=[{type:'text',text:text()}],finish='stop',interrupted=false)=>emit('assistant/message',{turn,step:1,message:{id:`assistant-${events.length}`,role:'assistant',source:{kind:'model',provider:'fake',model:'fake'},content},stream:[{type:'chunk',time:Date.now(),chunk:{type:'finish',reason:{kind:finish}}}],...(interrupted?{interrupted:true}:{})},'append');
  const end=async(turn:number,success=true)=>{await emit('turn/end',{turn,reason:success?{kind:'completed'}:{kind:'error',error:{code:'SYNTHETIC_MODEL_FAILURE'}}});agent.status='idle';resolveIdle();await new Promise<void>(resolve=>setImmediate(resolve));};
  const repeatEnd=(turn:number)=>listeners.get('session/event')?.(session,
    events.find(event=>event.type==='turn/end'&&event.data.turn===turn));
  const state=()=>store.db.prepare('SELECT state,payload FROM outbox WHERE id=?').get(`manager-event:delivery:${report.resultId}`);
  return {allowed:()=>allowed,prompt:()=>prompt(),get store(){return store;},bot,manager,task,run,report,ready,agent,events,durable,pulse,enter,call,review,text,resultLink,fileLink,assistant,end,repeatEnd,state,emit,emitForeign,file,waitForChatDelivery:()=>managers.waitForChatDelivery(session.id),beginNative:()=>{agent.status='running';idle=new Promise<void>(resolve=>{resolveIdle=resolve;});},checkpoint:()=> (ctx.sessions as any).flush(session),reinstallWhileActive:()=>{retired.push(managers);managers=new Managers(ctx,store,execution,directory,()=> 'https://example.test',{fullAccess,...extra});managers.install();},guard:(name:string,args:Record<string,unknown>={})=>guard({name,arguments:args}),counts:()=>({followups,dispatches,cancels}),setFlush:(mode:typeof flushMode)=>{flushMode=mode;},unblockFlush:()=>allowFlush(),reload:async(reopen=false)=>{await managers.dispose();if(reopen){store.close();store=new Store(join(directory,'ledger.sqlite'));}managers=new Managers(ctx,store,execution,directory,()=> 'https://example.test',{fullAccess,...extra});managers.install();},close:async()=>{agent.status='idle';resolveIdle();await managers.dispose();for(const old of retired)await old.dispose();store.close();assert.ok(directory.startsWith(join(root,'.runtime','delivery-adapter-')));rmSync(directory,{recursive:true,force:true});t.mock.timers.reset();}};
}

test('model failure after committed review supplements final delivery without executing Worker or review again',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();
    assert.equal(f.store.getTask(f.task.id).managerReviewed,true);assert.equal(f.state()?.state,'pending');
    await f.end(1,false);
    assert.equal(f.store.db.prepare('SELECT state FROM outbox WHERE id=?').get(f.ready.id)?.state,'unknown');
    await f.reload();await f.pulse();assert.equal(f.counts().followups,2);await f.enter(2);
    const retryNotice=f.agent.lastMessage.content[0].text;
    assert.ok(retryNotice.includes(f.resultLink()));
    assert.doesNotMatch(retryNotice,/super-bot-file/);
    assert.equal((await f.call('detail',{action:'detail',taskId:f.task.id})).result.id,f.report.resultId);
    for(const action of ['dispatch','review','create','respond','rework'])await assert.rejects(f.call(`forbidden-${action}`,{action,taskId:f.task.id}),{code:'delivery-only'});
    await f.assistant(2);await f.end(2);
    assert.equal(f.state()?.state,'done');assert.ok(JSON.parse(String(f.state()?.payload)).chatDelivery.messageId);
    await f.pulse();assert.equal(f.counts().followups,2);assert.equal(f.counts().dispatches,0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM reviews').get()?.n,1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM runs').get()?.n,1);
    assert.equal(f.store.runResult(f.run.id)?.humanAcceptedAt,null);
  }finally{await f.close();}
});

test('DF-13 a selected delivery checks its own durable receipt even behind more than fifty newer rows',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();await f.assistant(1);
    f.setFlush('false');await f.end(1);assert.equal(f.state()?.state,'pending');
    t.mock.timers.setTime(Date.now()+1);
    for(let i=0;i<51;i++)f.store.enqueueManager(f.bot.id,`later:${i}`,'Later lower-priority notice',null);
    f.setFlush('ok');await f.pulse();
    assert.equal(f.state()?.state,'done');
    assert.match(f.agent.lastMessage.source.eventId,/^manager-event:later:/);
    assert.equal(f.counts().dispatches,0);
  }finally{await f.close();}
});

test('the original review turn can deliver without an extra wake, but never before the durability barrier',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();
    const links={方案:'https://example.feishu.cn/docx/fixture'};
    const {delivery}=await f.call('artifacts',{action:'deliver',taskId:f.task.id,resultId:f.report.resultId,text:'两项事实已写好并回读。',links});
    const reply=await f.assistant(1,[{type:'text',text:delivery.markdown}]);
    // An adapter observing the same turn/end may begin waiting before the Manager listener runs.
    let settled=false;
    const view=f.waitForChatDelivery().then(()=>{settled=true;});
    f.setFlush('blocked');const closing=f.end(1);
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.state()?.state,'pending');
    assert.equal(settled,false);
    assert.deepEqual(f.store.chatDeliveries(f.agent.id,1,reply.seq+1),[]);
    const inboxTask=()=>f.store.taskInbox(f.bot.id).items.find(task=>task.id===f.task.id);
    assert.equal(inboxTask()?.deliveredAt,undefined);
    f.unblockFlush();await closing;await view;assert.equal(f.state()?.state,'done');
    assert.equal(inboxTask()?.deliveredAt,Date.now());
    assert.equal(inboxTask()?.lifecycle,'review');
    assert.equal(f.store.taskDetail(f.task.id).task.deliveredAt,Date.now());
    const detail=()=>f.store.taskDetail(f.task.id);
    assert.equal(detail().progress.worker?.summary,'Checks passed');
    assert.equal(detail().progress.worker?.runId,f.run.id);
    assert.equal(typeof detail().progress.worker?.at,'number');
    assert.equal(typeof detail().progress.inputEnteredAt,'number');
    assert.equal(detail().progress.acceptance,null);
    assert.equal(detail().progress.reload,null);
    const mirrored=readLocalMirror(f.store,{op:'detail',botId:f.bot.id,id:f.task.id});
    assert.ok(typeof mirrored==='object'&&'progress' in mirrored);
    assert.deepEqual(mirrored.progress,detail().progress);
    f.store.acceptResult('human',f.task.id,detail().task.rowVersion,f.report.resultId!);
    assert.deepEqual(detail().progress.acceptance,{actor:'user',at:Date.now()});
    assert.equal(detail().task.deliveredAt,Date.now());
    const receipt=JSON.parse(String(f.state()?.payload)).chatDelivery;
    assert.equal(f.durable[receipt.seq].data.message.id,receipt.messageId);
    assert.equal(f.durable[receipt.endSeq].data.reason.kind,'completed');
    const coordinates=[f.agent.id,receipt.turn,receipt.endSeq] as const;
    const artifacts=[{taskId:f.task.id,resultId:f.report.resultId,links}];
    assert.deepEqual(f.store.chatDeliveries(...coordinates),artifacts);
    assert.deepEqual(f.store.chatDeliveries(...coordinates,receipt.messageId),artifacts);
    assert.deepEqual(f.store.chatDeliveries(...coordinates,'another-reply'),[]);
    assert.deepEqual(f.store.chatDeliveries(f.agent.id,receipt.turn,receipt.endSeq-1),[]);
    assert.deepEqual(f.store.chatDeliveries(f.agent.id,receipt.turn+1,receipt.endSeq),[]);
    assert.deepEqual(f.store.chatDeliveries('another-session',receipt.turn,receipt.endSeq),[]);
    await f.pulse();assert.equal(f.counts().followups,1);assert.equal(f.counts().dispatches,0);
  }finally{await f.close();}
});

for(const mode of ['false','throw'] as const)test(`a ${mode} durability result cannot mark delivered or trigger another model before reconciliation`,async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();await f.assistant(1);f.setFlush(mode);await f.end(1);
    assert.equal(f.state()?.state,'pending');assert.equal(f.durable.length,0);
    await f.pulse();assert.equal(f.state()?.state,'pending');assert.equal(f.counts().followups,1);
    f.setFlush('ok');await f.reload(true);await f.pulse(30000);
    assert.equal(f.state()?.state,'done');assert.equal(f.counts().followups,1);
  }finally{await f.close();}
});

for(const variant of ['acknowledgement','wrong-result','reasoning-only','tool-call','max-tokens','interrupted','aborted'] as const)test(`${variant} is not final result delivery`,async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();
    const content=variant==='acknowledgement'?[{type:'text',text:'已开始，稍后回来。'}]:variant==='wrong-result'?[{type:'text',text:f.text().replaceAll(f.report.resultId!,'old-result')}]:variant==='reasoning-only'?[{type:'reasoning',text:f.text()}]:variant==='tool-call'?[{type:'text',text:f.text()},{type:'tool-call',id:'another-call',name:'super_bot_manage',arguments:'{}'}]:[{type:'text',text:f.text()}];
    await f.assistant(1,content,variant==='max-tokens'?'max-tokens':variant==='aborted'?'aborted':'stop',variant==='interrupted');await f.end(1);
    assert.equal(f.state()?.state,'pending');assert.equal(f.counts().dispatches,0);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='manager.delivered' AND json_extract(data,'$.resultId')=?").get(f.report.resultId!)?.n,0);
  }finally{await f.close();}
});

test('flush succeeds then SQLite receipt fails: actual reopen reconciles the durable final, never calls the model twice',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();
    f.store.db.exec("CREATE TRIGGER fail_chat_receipt BEFORE INSERT ON events WHEN NEW.kind='manager.delivered' BEGIN SELECT RAISE(ABORT,'chat receipt fault'); END");
    await f.assistant(1);await f.end(1);
    assert.equal(f.state()?.state,'pending');assert.ok(f.durable.some(event=>event.type==='assistant/message'));
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='manager.delivered'").get()?.n,0);
    f.store.db.exec('DROP TRIGGER fail_chat_receipt');await f.reload(true);await f.pulse();
    assert.equal(f.state()?.state,'done');assert.equal(f.counts().followups,1);assert.equal(f.counts().dispatches,0);
    const after=f.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='manager.delivered'").get()?.n;
    await f.pulse();assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='manager.delivered'").get()?.n,after);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM reviews').get()?.n,1);
  }finally{await f.close();}
});

test('a persisted visible final with no durable turn/end is uncertain, not blindly redelivered',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();await f.assistant(1);await f.checkpoint();
    f.agent.cancel();await f.reload(true);await f.pulse();
    assert.equal(f.state()?.state,'unknown');assert.equal(f.counts().followups,1);assert.equal(f.counts().dispatches,0);
    assert.match(f.store.managerInfo(f.bot.id).problem!.message,/核对/);await f.pulse();assert.equal(f.counts().followups,1);
  }finally{await f.close();}
});

test('Bot queries are allowed normally but denied throughout delivery-only recovery',async t=>{
  const f=await fixture(t,true);try {
    assert.equal(f.guard('bash',{command:'pwd',timeoutMs:1000}),undefined);await f.pulse();await f.enter(1);await f.review();await f.end(1,false);
    await f.pulse();await f.enter(2);
    for(const name of ['skill','bash','read','read_image','job_output','job_list','job_kill','write','edit','subagent','super_bot_report'])assert.match(String(f.guard(name)),/Delivery-only/);
    assert.equal(f.guard('super_bot_manage'),undefined);
    await assert.rejects(f.call('foreign-detail',{action:'detail',taskId:'not-this-result'}),{code:'delivery-only'});
    await assert.rejects(f.call('dispatch',{action:'dispatch',taskId:f.task.id,expectedRowVersion:f.store.getTask(f.task.id).rowVersion}),{code:'delivery-only'});
    await f.assistant(2);await f.end(2);
    assert.equal(f.state()?.state,'done');assert.equal(f.guard('bash',{command:'pwd',timeoutMs:1000}),undefined);assert.equal(f.counts().dispatches,0);
  }finally{await f.close();}
});

for(const kind of ['interrupted','forked','error'] as const)test(`a persisted final with ${kind} closer is uncertain, not a fresh delivery`,async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();await f.assistant(1);
    await f.emit('turn/end',{turn:1,reason:kind==='error'?{kind,error:{code:'SYNTHETIC'}}:{kind}});
    f.agent.cancel();await f.reload(true);await f.pulse();
    assert.equal(f.state()?.state,'unknown');assert.equal(f.counts().followups,1);assert.equal(f.counts().dispatches,0);
  }finally{await f.close();}
});

test('reinstalling while an old delivery Agent is still active restores read-only authority from the ledger',async t=>{
  const f=await fixture(t,true);try {
    await f.pulse();await f.enter(1);await f.review();await f.end(1,false);await f.pulse();await f.enter(2);
    assert.equal(f.agent.status,'running');assert.match(String(f.guard('bash')),/Delivery-only/);
    f.reinstallWhileActive();
    assert.match(String(f.guard('bash')),/Delivery-only/);assert.match(String(f.guard('write')),/Delivery-only/);
    await assert.rejects(f.call('after-reinstall',{action:'dispatch',taskId:f.task.id,expectedRowVersion:f.store.getTask(f.task.id).rowVersion}),{code:'delivery-only'});
    await f.assistant(2);await f.end(2);assert.equal(f.state()?.state,'done');assert.equal(f.counts().dispatches,0);
  }finally{await f.close();}
});

for(const busy of ['running','user-inbox'] as const)test(`delivery reconciliation rechecks ${busy} after asynchronous persistence before claiming a wake`,async t=>{
  const f=await fixture(t,true);try {
    await f.pulse();await f.enter(1);await f.review();await f.end(1,false);
    f.setFlush('blocked');const pumping=f.pulse();await new Promise<void>(resolve=>setImmediate(resolve));
    if(busy==='running')f.agent.status='running';else f.agent.inbox.nextTurn.push({id:'real-user-pending'});
    f.unblockFlush();await pumping;
    assert.equal(f.counts().followups,1);assert.equal(f.state()?.state,'pending');assert.equal(f.guard('bash',{command:'pwd',timeoutMs:1000}),undefined);
  }finally{await f.close();}
});

test('a Review binds delivery to native call order, never an earlier linked final even when wall clock moves backward',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);const old=await f.assistant(1);old.time=Date.now()+60000;await f.end(1);
    await f.emit('turn/start',{turn:2});await f.review(2);await f.end(2);
    assert.equal(f.state()?.state,'pending');assert.equal(f.store.getTask(f.task.id).managerReviewed,true);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='manager.delivered' AND json_extract(data,'$.resultId')=?").get(f.report.resultId!)?.n,0);
  }finally{await f.close();}
});

test('a retained native Inbox delivery restores its read-only scope without a second pump and releases it after the native turn',async t=>{
  const f=await fixture(t,true);try {
    await f.pulse();await f.enter(1);await f.review();await f.end(1,false);await f.pulse();
    const retained=f.agent.lastMessage;f.agent.cancel();f.agent.inbox.nextTurn.push(retained);
    f.reinstallWhileActive();await new Promise<void>(resolve=>setImmediate(resolve));
    f.agent.inbox.nextTurn.length=0;f.beginNative();await f.enter(2);
    await f.emit('user/message',{id:'real-steer',source:{kind:'user',rpcId:'native-rpc'},content:[{type:'text',text:'顺便检查一下。'}]},'append');
    assert.match(String(f.guard('bash')),/Delivery-only/);
    await assert.rejects(f.call('no-rerun',{action:'dispatch',taskId:f.task.id,expectedRowVersion:f.store.getTask(f.task.id).rowVersion}),{code:'delivery-only'});
    await f.assistant(2);await f.end(2);assert.equal(f.state()?.state,'done');
    assert.equal(f.guard('bash',{command:'pwd',timeoutMs:1000}),undefined,'query tools return after delivery');
    assert.equal(f.counts().followups,2);assert.equal(f.counts().dispatches,0);
  }finally{await f.close();}
});

for(const mode of [undefined,true,false])test(`Bot query tools and routing follow fullAccess=${mode}`,async t=>{
  const f=await fixture(t,mode);try {
    const native=['skill','bash','read','read_image','job_output','job_list','job_kill'];
    assert.deepEqual(f.allowed(),mode===false?['super_bot_manage']:[...native,'super_bot_manage']);
    assert.equal(f.guard('super_bot_manage'),undefined);
    for(const name of native) {
      const result=f.guard(name,name==='bash'?{command:'lark-cli --help',timeoutMs:30000}:{});
      if(mode===false)assert.match(String(result),/Bot Shell.*fullAccess: false/);else assert.equal(result,undefined);
    }
    for(const name of ['write','edit','subagent','subagent_fork','Worker','super_bot_report','external_plugin_tool'])assert.match(String(f.guard(name)),mode===false?/fullAccess: false/:/not available.*Worker/);
    assert.match(f.prompt(),/lark-cli/);assert.match(f.prompt(),/Never ask the user to enable a tool channel/);
    if(mode===false){assert.match(f.prompt(),/Bot Shell 与 Worker 完整权限未开启/);assert.match(f.prompt(),/fullAccess: true.*cordis.patch.yml/);assert.match(f.prompt(),/BEFORE creating or dispatching/);}
    else {
      assert.match(f.prompt(),/Run short read-only\/status queries directly/);
      assert.match(f.prompt(),/read the target, make only the requested edit, and read it back/);
      assert.match(f.prompt(),/use a research subagent only if the host actually provides one/);
      assert.match(f.prompt(),/Delegate substantive modifications, multi-step work, long-running work and full verification as Worker Tasks/);
      assert.match(f.prompt(),/Use respond for an open question and rework for an eligible result/);
      assert.match(f.prompt(),/If the Worker is running and there is no current input route, tell the user/);
      assert.doesNotMatch(f.prompt(),/完整权限未开启/);
    }
  }finally{await f.close();}
});

test('Bot Bash requires explicit bounded foreground queries or nonblocking background mode',async t=>{
  const f=await fixture(t);try {
    for(const timeoutMs of [1,5000,30000])assert.equal(f.guard('bash',{command:'git status --short',timeoutMs}),undefined);
    for(const timeoutMs of [0,-1,30001,60000,Infinity,NaN,'1000',null])assert.match(String(f.guard('bash',{command:'pwd',timeoutMs})),/timeoutMs.*30000/);
    for(const run_in_background of [undefined,false,'true'])assert.match(String(f.guard('bash',{command:'pwd',run_in_background})),/pass timeoutMs/);
    assert.equal(f.guard('bash',{command:'pwd',run_in_background:true}),undefined);
    assert.match(String(f.guard('bash',{command:'pwd',run_in_background:true,timeoutMs:60000})),/timeoutMs/);
  }finally{await f.close();}
});

test('Bot noWait rejects common sleep commands without forbidding text that mentions sleep',async t=>{
  const f=await fixture(t);try {
    for(const command of ['sleep 1',' /bin/sleep 1','pwd; sleep 1','pwd && sleep 1','(sleep 1)','if true; then sleep 1; fi','while true; do sleep 1; done','env sleep 1','command sleep 1','pwd\nsleep 1']) {
      assert.match(String(f.guard('bash',{command,timeoutMs:1000})),/Do not sleep/);
      assert.match(String(f.guard('bash',{command,run_in_background:true})),/Do not sleep/);
    }
    for(const command of ['echo sleep','git show -- sleep.md',"printf 'sleep is not a command here'"])assert.equal(f.guard('bash',{command,timeoutMs:1000}),undefined);
  }finally{await f.close();}
});

test('Bot job output permits snapshots and at most five seconds of explicit waiting',async t=>{
  const f=await fixture(t);try {
    for(const args of [{},{wait:false},{wait:false,timeout_ms:60000},{wait:true,timeout_ms:1},{wait:true,timeout_ms:5000}])assert.equal(f.guard('job_output',args),undefined);
    for(const timeout_ms of [undefined,0,-1,5001,30000,Infinity,NaN,'5000',null])assert.match(String(f.guard('job_output',{wait:true,timeout_ms})),/at most 5000/);
  }finally{await f.close();}
});

test('revoking the Manager prevents every query tool as well as ledger mutations',async t=>{
  const f=await fixture(t);try {
    f.store.releaseManager('replace',f.bot.id,1);
    for(const name of ['skill','bash','read','read_image','job_output','job_list','job_kill','super_bot_manage'])assert.match(String(f.guard(name,{command:'pwd',timeoutMs:1000})),/no longer has management authority/);
  }finally{await f.close();}
});

for(const variant of ['missing','shortened'])test(`${variant} delivery links cannot cause unbounded wakes across turns and ledger reopen`,async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();await f.end(1);
    let turn=1;
    for(let n=0;n<8;n++) {
      await f.pulse(120000);
      if(f.agent.status==='running') {
        await f.enter(++turn);await f.assistant(turn,[{type:'text',text:variant==='missing'?'成果已完成，稍后请查看工作面板。':`已完成 [文件](/api/super-bot-file?resultId=${f.report.resultId}) [成果](#super-bot-task=${f.task.id})`}]);await f.end(turn);
      }
      await f.reload(true);
    }
    assert.equal(f.counts().followups,4,'one original review wake plus at most three delivery-only wakes');
    assert.equal(f.state()?.state,'unknown');
    assert.match(f.store.managerInfo(f.bot.id).problem?.message??'',/交付.*3|3.*交付/);
    const problem=f.store.managerInfo(f.bot.id).problem;await f.pulse(3600000);await f.reload(true);await f.pulse();
    assert.deepEqual(f.store.managerInfo(f.bot.id).problem,problem);assert.equal(f.counts().followups,4);
    // A later actual reply can satisfy the obligation; exhaustion does not fabricate delivery or block proof.
    await f.emit('turn/start',{turn:++turn});await f.assistant(turn);await f.end(turn);
    assert.equal(f.state()?.state,'done');assert.equal(f.counts().followups,4);
  }finally{await f.close();}
});

test('a different port or a root-relative native path requires a fresh exact Web link',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();
    const url=`https://example.test/#super-bot-task=${f.task.id}&resultId=${f.report.resultId}`;
    await f.assistant(1,[{type:'text',text:`[成果](${url.replace('https://example.test','')}) [成果](${url.replace('https://example.test','http://127.0.0.1:49999')})`}]);
    await f.end(1);assert.equal(f.state()?.state,'pending');
    await f.pulse();await f.enter(2);
    await f.assistant(2,[{type:'text',text:`[查看完整交付](${url})`}]);
    await f.end(2);assert.equal(f.state()?.state,'done');
  }finally{await f.close();}
});


test('the exact result link from detail is sufficient even with an attached file',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();
    const detail=await f.call('detail',{action:'detail',taskId:f.task.id});
    assert.equal(detail.delivery.chatMarkdown,f.resultLink());
    assert.equal(detail.delivery.files.length,1);
    await f.assistant(1,[{type:'text',text:detail.delivery.chatMarkdown}]);await f.end(1);
    assert.equal(f.state()?.state,'done');assert.equal(f.counts().followups,1);
  }finally{await f.close();}
});

test('duplicate turn/end callbacks and reload preserve backoff and never wake twice for the same ended input',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();await f.end(1);await f.pulse();await f.enter(2);
    await f.assistant(2,[{type:'text',text:'已完成，未附链接。'}]);await f.end(2);
    const deadline=JSON.parse(String(f.state()?.payload)).nextAttemptAt;
    await f.repeatEnd(2);await f.reload(true);
    assert.equal(JSON.parse(String(f.state()?.payload)).nextAttemptAt,deadline);
    await f.pulse(29000);assert.equal(f.counts().followups,2);
    await f.pulse(1000);assert.equal(f.counts().followups,3);
    await f.repeatEnd(2);await f.pulse(60000);
    assert.equal(f.counts().followups,3);assert.equal(f.state()?.state,'sending');
    await f.enter(3);await f.assistant(3);await f.end(3);assert.equal(f.state()?.state,'done');
  }finally{await f.close();}
});

for(const delivered of [false,true])test(`legacy pending attempt 14 is reconciled without a fresh wake (delivered=${delivered})`,async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();await f.end(1);await f.pulse();await f.enter(2);
    if(delivered)await f.assistant(2);
    // Durable native end, but simulate a crash before its adapter callback / old version requeue.
    f.events.push({type:'turn/end',data:{turn:2,reason:{kind:'completed'}},seq:f.events.length,time:Date.now()});await f.checkpoint();
    f.store.db.prepare("UPDATE outbox SET state='pending',attempts=14 WHERE id=?").run(`manager-event:delivery:${f.report.resultId}`);
    await f.reload(true);await f.pulse();
    assert.equal(f.state()?.state,delivered?'done':'unknown');assert.equal(f.counts().followups,2);
    const problem=f.store.managerInfo(f.bot.id).problem;
    for(let n=0;n<3;n++){await f.pulse(3600000);await f.reload(true);}
    assert.equal(f.counts().followups,2);assert.deepEqual(f.store.managerInfo(f.bot.id).problem,problem);
  }finally{await f.close();}
});

for(const variant of ['wrong-task','file-only','wrong-path','query','bare-identifiers','wrong-explicit-result','empty-explicit-result','duplicate-explicit-result','fenced-code','inline-code','external-host','only-text','image'] as const)test(`${variant} cannot masquerade as a linked delivery`,async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();
    const wrong='00000000-0000-0000-0000-000000000000';
    const text=variant==='wrong-task'?f.text().replaceAll(f.task.id,'another-task'):
      variant==='file-only'?f.fileLink():
      variant==='wrong-path'?f.text().replace('/#super-bot-task','/other#super-bot-task'):
      variant==='query'?f.text().replace('/#super-bot-task','/?unrelated=1#super-bot-task'):
      variant==='bare-identifiers'?`已完成 resultId=${f.report.resultId} taskId=${f.task.id}`:
      variant==='fenced-code'?`成果链接如下\n\`\`\`md\n${f.text()}\n\`\`\``:
      variant==='inline-code'?f.text().split('\n').map(line=>`\`${line}\``).join('\n'):
      variant==='external-host'?f.text().replaceAll('https://example.test','https://elsewhere.test'):
      variant==='only-text'?f.text().replaceAll(/\[([^\]]+)\]\(([^)]+)\)/g,'\\[$1\\]（$2）'):
      variant==='image'?f.text().replaceAll('[','!['):
      variant==='wrong-explicit-result'?f.text().replace(`&resultId=${f.report.resultId})`,`&resultId=${wrong})`):
      variant==='empty-explicit-result'?f.text().replace(`&resultId=${f.report.resultId})`,'&resultId=)'):
      f.text().replace(`&resultId=${f.report.resultId})`,`&resultId=${f.report.resultId}&resultId=${wrong})`);
    await f.assistant(1,[{type:'text',text}]);await f.end(1);assert.equal(f.state()?.state,'pending');
  }finally{await f.close();}
});

test('DF-14 registered deliver succeeds but the native final must contain the exact result link',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();assert.equal(f.state()?.state,'pending');
    const args={action:'deliver',taskId:f.task.id,resultId:f.report.resultId,text:'两项事实已写好；检查通过，真实模型质量未验证。'};
    const first=await f.call('deliver',args);
    assert.equal(f.state()?.state,'pending');assert.equal(JSON.parse(String(f.state()?.payload)).chatDelivery,undefined);
    assert.deepEqual(first.delivery.files,[{name:'result.md',url:`/api/super-bot-file?resultId=${f.report.resultId}&index=0`}]);
    assert.equal(first.delivery.workUrl,`/#super-bot-task=${f.task.id}&resultId=${f.report.resultId}`);assert.equal(first.delivery.humanAcceptanceRequired,true);
    assert.match(f.prompt(),/Reply in this conversation with the returned delivery\.markdown/);
    assert.doesNotMatch(f.prompt(),/delivery\.(?:workUrl|files)/);
    assert.equal(first.delivery.resultLink,f.resultLink());
    assert.equal(first.delivery.markdown,`${args.text}\n\n${f.resultLink()}`);
    assert.deepEqual(await f.call('deliver',args),first);
    assert.deepEqual(await f.call('deliver-again',args),first);
    await assert.rejects(f.call('deliver',{...args,text:'different'}),{code:'idempotency-conflict'});
    // A tool response may be hidden inside the native turn's process.
    await f.assistant(1,[{type:'text',text:'请查看上面的交付卡片。'}]);await f.end(1);
    assert.notEqual(f.state()?.state,'done','工具成功但最终回复缺少成果链接，交付义务仍应存在');
    await f.pulse();await f.enter(2);
    await f.assistant(2,[{type:'text',text:first.delivery.markdown}]);await f.end(2);
    assert.equal(f.state()?.state,'done');
    assert.equal(f.counts().followups,2);assert.equal(f.counts().dispatches,0);
    assert.equal(f.store.taskDetail(f.task.id).events.filter((e:any)=>e.kind==='manager.delivered'&&JSON.stringify(e).includes(String(f.report.resultId))).length,1);
    assert.equal(f.store.runResult(f.run.id)?.humanAcceptedAt,null);
    await f.reload(true);assert.deepEqual(await f.call('deliver-after-reopen',args),first);
  }finally{await f.close();}
});

test('DF-14 Markdown reference definitions in a different native text block do not create a link',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();
    const file=f.fileLink(),work=f.resultLink();
    const destination=work.slice(work.indexOf('(')+1,-1);
    await f.assistant(1,[{type:'text',text:`${file}\n[查看完整交付][result]`},{type:'text',text:`\n[result]: ${destination}`}]);
    await f.end(1);assert.equal(f.state()?.state,'pending');
    await f.pulse();await f.enter(2);
    await f.assistant(2,[{type:'text',text:file},{type:'text',text:work}]);
    await f.end(2);assert.equal(f.state()?.state,'done');
  }finally{await f.close();}
});

test('a filename containing Markdown punctuation stays in the exact result rather than the reply',async t=>{
  const f=await fixture(t,undefined,{},'result]draft.md');try {
    await f.pulse();await f.enter(1);await f.review();
    const {delivery}=await f.call('deliver',{action:'deliver',taskId:f.task.id,resultId:f.report.resultId,text:'合成文件'});
    assert.equal(delivery.files[0].name,'result]draft.md');
    assert.equal(delivery.markdown,`合成文件\n\n${f.resultLink()}`);
    await f.assistant(1,[{type:'text',text:delivery.markdown}]);await f.end(1);
    assert.equal(f.store.taskDetail(f.task.id).chatDelivery?.state,'delivered');
  }finally{await f.close();}
});

test('DF-14 an explicit first delivery keeps an obligation and binds it to the native tool call',async t=>{
  const f=await fixture(t);try {
    await f.emit('turn/start',{turn:1});await f.assistant(1);await f.end(1);
    await f.emit('turn/start',{turn:2});
    const args={action:'deliver',taskId:f.task.id,resultId:f.report.resultId,text:'已回读成果'};
    await f.emit('tool/call',{turn:2,step:0,name:'super_bot_manage',callId:'first',arguments:JSON.stringify(args)});
    const {delivery}=await f.call('first',args);
    await f.end(2);assert.equal(f.state()?.state,'pending');
    await f.emit('turn/start',{turn:3});await f.assistant(3,[{type:'text',text:delivery.markdown}]);await f.end(3);
    assert.equal(f.state()?.state,'done');assert.equal(f.counts().followups,0);
    assert.equal(f.store.getTask(f.task.id).managerReviewed,false);
    assert.equal(f.store.runResult(f.run.id)?.humanAcceptedAt,null);
  }finally{await f.close();}
});

for(const complete of [false,true])test(`DF-14 restart after the entered deliver tool (durable final=${complete})`,async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();await f.end(1);await f.pulse();await f.enter(2);
    const args={action:'deliver',taskId:f.task.id,resultId:f.report.resultId,text:'合成回包'};
    await f.emit('tool/call',{turn:2,step:0,name:'super_bot_manage',callId:'deliver',arguments:JSON.stringify(args)});
    const first=await f.call('deliver',args);
    await f.emit('tool/result',{turn:2,step:0,message:{content:[{type:'text',text:first.delivery.markdown}]}},'append');
    if(complete) {
      await f.assistant(2,[{type:'text',text:first.delivery.markdown}]);
      f.events.push({type:'turn/end',data:{turn:2,reason:{kind:'completed'}},seq:f.events.length,time:Date.now()});
    }
    await f.checkpoint();assert.equal(f.state()?.state,'entered');
    f.agent.cancel();await f.reload(true);await f.pulse();
    assert.equal(f.state()?.state,complete?'done':'unknown');
    assert.equal(f.store.taskDetail(f.task.id).chatDelivery?.state,complete?'delivered':'uncertain');
    assert.deepEqual(await f.call('deliver',args),first);
    await f.reload(true);await f.pulse(120000);
    assert.equal(f.state()?.state,complete?'done':'unknown');
    assert.equal(f.counts().followups,2);assert.equal(f.counts().dispatches,0);
    assert.equal(f.store.runResult(f.run.id)?.humanAcceptedAt,null);
  }finally{await f.close();}
});

for(const proof of ['tool-only','missing-index','legacy-files','historical-exact'] as const)test(`DF-14 rechecks a legacy receipt (${proof})`,async t=>{
  const f=await fixture(t);try {
    const visible=proof==='legacy-files'||proof==='historical-exact';
    await f.pulse();await f.enter(1);await f.review();
    const {delivery}=await f.call('legacy',{action:'deliver',taskId:f.task.id,resultId:f.report.resultId,text:'历史成果'});
    const work=proof==='historical-exact'?f.resultLink():f.resultLink().replace(`&resultId=${f.report.resultId})`,')');
    const file=proof==='missing-index'?f.fileLink().replace('&index=0',''):f.fileLink();
    await f.assistant(1,[{type:'text',text:proof==='tool-only'?'查看工具卡片。':`${file}\n${work}`}]);
    // Persist the native turn closed by the old host without the current reconciler running on it first.
    f.events.push({type:'turn/end',data:{turn:1,reason:{kind:'completed'}},seq:f.events.length,time:Date.now()});
    await f.checkpoint();f.agent.cancel();
    const old={sessionId:f.agent.id,explicit:true,requestId:'legacy',delivery};
    f.store.db.prepare(`UPDATE outbox SET state='done',
      payload=json_set(json_remove(payload,'$.exactResultLink'),'$.chatDelivery',json(?)) WHERE id=?`)
      .run(JSON.stringify(old),`manager-event:delivery:${f.report.resultId}`);
    await f.reload(true);await f.pulse();
    assert.equal(f.state()?.state,visible?'done':'unknown');
    assert.deepEqual(JSON.parse(String(f.state()?.payload)).legacyDelivery,old);
    const deliveryStatus=f.store.taskDetail(f.task.id).chatDelivery;
    assert.equal(deliveryStatus?.state,visible?'delivered':'uncertain');
    await f.reload(true);await f.pulse();assert.equal(f.counts().followups,1);
  }finally{await f.close();}
});

test('DF-14 known delivery is checked without an extra wake at the hourly cap, with an accessible version while pending',async t=>{
  const f=await fixture(t,undefined,{managerWakesPerHour:1});try {
    assert.equal(f.store.taskDetail(f.task.id).chatDelivery?.state,'awaiting-review');
    await f.pulse();await f.enter(1);await f.review();
    const {delivery}=await f.call('draft',{action:'deliver',taskId:f.task.id,resultId:f.report.resultId,text:'已回读这份成果'});
    await f.assistant(1,[{type:'text',text:'链接尚未给出。'}]);await f.end(1);await f.pulse();
    assert.match(f.store.managerInfo(f.bot.id).problem?.message??'',/1 次上限/);
    assert.match(f.store.taskDetail(f.task.id).chatDelivery?.reason??'',/每小时自动唤醒上限/);
    assert.equal(f.store.taskDetail(f.task.id).result?.id,delivery.resultId);
    assert.equal(f.store.taskDetail(f.task.id).chatDelivery?.state,'pending');
    await f.emit('turn/start',{turn:2});await f.assistant(2,[{type:'text',text:delivery.markdown}]);await f.end(2);
    assert.equal(f.store.taskDetail(f.task.id).chatDelivery?.state,'delivered');assert.equal(f.counts().followups,1);
    assert.equal(f.store.managerInfo(f.bot.id).problem,null);
    assert.equal(f.counts().dispatches,0);assert.equal(f.store.runResult(f.run.id)?.humanAcceptedAt,null);
  }finally{await f.close();}
});

test('DF-14 exact links whose bytes changed remain uncertain until the original version can be opened',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();
    writeFileSync(f.file,'Different bytes');await f.assistant(1);await f.end(1);
    assert.equal(f.state()?.state,'unknown');
    assert.match(f.store.taskDetail(f.task.id).chatDelivery?.reason??'',/当前文件无法按该版本打开/);
    writeFileSync(f.file,'Two checked facts');await f.pulse();
    assert.equal(f.state()?.state,'done');assert.equal(f.counts().followups,1);assert.equal(f.counts().dispatches,0);
  }finally{await f.close();}
});

test('DF-14 rejects foreign Bot, Task and native session and leaves an obsolete result untouched',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();
    const other=f.store.createBot('other',{name:'Other Bot',instructions:'Synthetic only'});
    const manager=f.store.beginManager('other-manager',other.id,'/synthetic/other');
    f.store.confirmManager(manager.id,manager.requestedSessionId);
    const otherTask=f.store.createTask('wrong-task',{botId:f.bot.id,goal:'Other task',scope:'Own files',acceptance:'Read',reviewPolicy:'human'});
    f.store.settleManagerEvent(`manager-event:created:${otherTask.id}`);
    const args={action:'deliver',taskId:f.task.id,resultId:f.report.resultId,text:'合成回包'};
    await assert.rejects(f.call('other-bot',args,manager.requestedSessionId),{code:'manager-scope'});
    await assert.rejects(f.call('worker',args,f.run.sessionId),{code:'manager-scope'});
    await assert.rejects(f.call('wrong-task',{...args,taskId:otherTask.id}),{code:'result-stale'});
    await f.call('deliver',args);await f.end(1);await f.pulse();
    const input=f.agent.lastMessage;assert.equal(f.state()?.state,'sending');
    await f.emitForeign(manager.requestedSessionId,'user/message',input);assert.equal(f.state()?.state,'sending');
    f.agent.cancel();await f.reload(true);await f.pulse();
    assert.equal(f.state()?.state,'unknown');assert.equal(f.counts().followups,2);
    f.store.rejectResult('rework',f.task.id,f.store.getTask(f.task.id).rowVersion,f.report.resultId!,'改成新版');
    await assert.rejects(f.call('deliver',args),{code:'result-stale'});
    await f.emit('turn/start',{turn:3});await f.assistant(3);await f.end(3);
    assert.equal(f.state()?.state,'superseded');assert.equal(f.store.resultById(f.report.resultId!)?.humanAcceptedAt,null);
    assert.equal(f.counts().dispatches,0);
  }finally{await f.close();}
});

test('automatic question notice and detail use the exact pending Worker question, even with two waiting tasks',async t=>{
  const f=await fixture(t);try {
    f.store.settleManagerEvent(f.ready.id);
    function ask(key:string,text:string) {
      const task=f.store.createTask(`task-${key}`,{botId:f.bot.id,goal:key,scope:'Synthetic files',acceptance:'Readback',reviewPolicy:'human'});
      const binding=f.store.beginBinding(`binding-${key}`,task.id,task.rowVersion,`/synthetic/${key}`);
      f.store.confirmBinding(binding.id,binding.requestedSessionId);
      f.store.settleManagerEvent(`manager-event:created:${task.id}`);
      return askAgain(key,task.id,text);
    }
    function askAgain(key:string,taskId:string,text:string) {
      const run=f.store.reserveRun(`run-${key}`,taskId,f.store.getTask(taskId).rowVersion);
      f.store.saveRunMessage(run.id,`message-${key}`,'{}');f.store.claimDispatch(run.id);f.store.inputEntered(run.id,`message-${key}`,1);
      f.store.workerReport(run.id,`ask-${key}`,{kind:'waiting',summary:text});f.store.settleRun(run.id);
      const attentionId=`run:${run.id}`;
      return {taskId,attentionId,eventId:`manager-event:settled:${run.id}`,
        url:`https://example.test/#super-bot-task=${taskId}&attentionId=${encodeURIComponent(attentionId)}`};
    }
    const a=ask('a','读者是谁？'),b=ask('b','使用哪个标题？');
    const argsFor=(q:typeof a)=>({action:'respond',taskId:q.taskId,attentionId:q.attentionId,expectedRowVersion:f.store.getTask(q.taskId).rowVersion});
    const detail=await f.call('detail-a',{action:'detail',taskId:a.taskId});
    assert.deepEqual(detail.pendingQuestions.map((p:any)=>p.markdown),[`[回答](${a.url})`]);
    assert.match(detail.questionReplyInstruction,/可见回复.*原样引用/);
    const clarification=f.store.createTask('unbound',{botId:f.bot.id,goal:'Clarification',scope:'',acceptance:'',reviewPolicy:'human'});
    f.store.settleManagerEvent(`manager-event:created:${clarification.id}`);
    assert.deepEqual((await f.call('clarify',{action:'detail',taskId:clarification.id})).pendingQuestions,[]);
    f.store.settleManagerEvent(b.eventId);
    await f.pulse();assert.equal(f.agent.lastMessage.source.eventId,a.eventId);
    assert.ok(f.agent.lastMessage.content[0].text.includes(`[回答](${a.url})`));
    assert.ok(!f.agent.lastMessage.content[0].text.includes(b.url));
    await f.enter(1);
    assert.deepEqual((await f.call('automatic-other',{action:'detail',taskId:b.taskId})).pendingQuestions,[]);
    await assert.rejects(f.call('no-human',argsFor(a)),{code:'human-message-required'});
    await f.assistant(1,[{type:'text',text:`读者是谁？\n[回答](${a.url})`}]);await f.end(1);
    await f.emit('turn/start',{turn:2});
    await f.emit('user/message',{id:'human-2',source:{kind:'user',rpcId:'human'},content:[{type:'text',text:`新同事。 [原问题](${a.url})`}]},'append');
    await assert.rejects(f.call('misrouted',argsFor(b)),{code:'attention-scope'});
    await assert.rejects(f.call('wrong-pair',{...argsFor(a),attentionId:b.attentionId}),{code:'manager-scope'});
    const answer=(await f.call('answer-a',argsFor(a))).input;
    assert.equal(answer.attentionId,a.attentionId);assert.equal(f.store.pendingInput(b.taskId),null);
    await assert.rejects(f.call('already-answered',argsFor(a)),{code:'attention-stale'});
    f.store.settleManagerEvent(`manager-event:answer:${answer.id}`);
    const answerB=f.store.respondAttention('answer-b',b.attentionId,f.store.getTask(b.taskId).rowVersion,'标题 B');
    f.store.settleManagerEvent(`manager-event:answer:${answerB.id}`);
    const next=askAgain('another-b',b.taskId,'文档多长？');
    f.store.settleManagerEvent(next.eventId);
    // Simulate the never-claimed earlier notice becoming eligible after a newer question was written.
    f.store.db.prepare("UPDATE outbox SET state='pending' WHERE id=? AND attempts=0").run(b.eventId);
    await f.pulse();assert.equal(f.agent.lastMessage.source.eventId,b.eventId);
    assert.match(f.agent.lastMessage.content[0].text,/已回答或失效/);
    assert.ok(!f.agent.lastMessage.content[0].text.includes(next.url));
    await f.enter(3);
    assert.deepEqual((await f.call('stale-detail',{action:'detail',taskId:b.taskId})).pendingQuestions,[]);
    await f.end(3);
    assert.deepEqual((await f.call('current-detail',{action:'detail',taskId:b.taskId})).pendingQuestions.map((q:any)=>q.id),[next.attentionId]);
  }finally{await f.close();}
});

test('delivery-only recovery may call deliver for its own result only',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();
    const args={action:'deliver',taskId:f.task.id,resultId:f.report.resultId,text:'写好两项事实'};
    const artifactLinks={方案:'https://example.feishu.cn/docx/fixture'};
    await f.call('first',{...args,links:artifactLinks});
    await f.end(1,false);
    await f.reload();await f.pulse();assert.equal(f.counts().followups,2);await f.enter(2);
    await assert.rejects(f.call('wrong-result',{action:'deliver',taskId:f.task.id,resultId:'other',text:'x'}),{code:'delivery-only'});
    await assert.rejects(f.call('new-links',{...args,links:{坏替换:'https://example.test/wrong'}}),{code:'delivery-only'});
    await assert.rejects(f.call('patch-links',{...args,action:'update_delivery_links',links:artifactLinks}),{code:'delivery-only'});
    const value=await f.call('scoped',{...args,text:'补交付'});
    assert.equal(value.delivery.resultId,f.report.resultId);assert.equal(f.state()?.state,'entered');
    await f.assistant(2,[{type:'text',text:'已交付。'}]);await f.end(2);assert.equal(f.state()?.state,'pending');
    await f.pulse(30000);assert.equal(f.counts().followups,3);await f.enter(3);
    await f.assistant(3,[{type:'text',text:value.delivery.markdown}]);await f.end(3);
    assert.equal(f.state()?.state,'done');assert.equal(f.counts().dispatches,0);
    const delivered=f.store.taskDetail(f.task.id).deliveredResult;
    assert.deepEqual(delivered?.links,artifactLinks);
    assert.equal(delivered?.deliveryText,args.text);
  }finally{await f.close();}
});

test('only the current owner turn can patch its referenced formal result, and the mirror reads that result',async t=>{
  const f=await fixture(t);try {
    const resultId=f.report.resultId!,taskId=f.task.id;
    const initial={MR:'https://git.example.test/team/project/-/merge_requests/7'};
    const deliver={action:'deliver',taskId,resultId,text:'写好两项事实',links:initial};
    await f.emit('turn/start',{turn:1});
    await f.emit('user/message',{id:'external-source',source:{kind:'user',rpcId:'external',principal:{id:'external'}},
      content:[{type:'text',text:'登记链接'}]},'append');
    await assert.rejects(f.call('untrusted-deliver',deliver),{code:'manager-scope'});
    await f.end(1);
    await f.pulse();await f.enter(2);await f.review(2);
    const version=f.store.getTask(taskId).rowVersion;
    const {delivery}=await f.call('delivery',deliver);
    const update={action:'update_delivery_links',taskId,resultId,expectedRowVersion:version,
      links:{方案:'https://example.feishu.cn/docx/fixture'}};
    assert.equal(f.store.taskDetail(taskId).deliveredResult,null);
    await assert.rejects(f.call('notification',update),{code:'human-message-required'});
    await f.assistant(2,[{type:'text',text:delivery.markdown}]);await f.end(2);

    await f.emit('turn/start',{turn:3});
    await f.emit('user/message',{id:'non-owner',source:{kind:'user',rpcId:'non-owner',principal:{id:'non-owner'}},
      content:[{type:'text',text:'添加链接'}]},'append');
    await assert.rejects(f.call('non-owner',update),{code:'human-message-required'});
    await f.end(3);

    await f.emit('turn/start',{turn:4});
    const owner={kind:'user',rpcId:'owner'};
    const workUrl=`https://example.test${delivery.workUrl}`;
    await f.emit('user/message',{id:'wrong-source',source:owner,
      content:[{type:'text',text:`更新这项交付 ${workUrl.replace(resultId,f.bot.id)}，添加链接`}]},'append');
    await assert.rejects(f.call('wrong-source',update),{code:'result-stale'});
    await f.emit('user/message',{id:'correct-source',source:owner,
      content:[{type:'text',text:`更新这项交付 ${workUrl}，添加方案链接`}]},'append');
    assert.deepEqual(await f.call('owner-update',update),{links:{...initial,...update.links}});
    const mirror=readLocalMirror(f.store,{op:'detail',id:taskId,botId:f.bot.id}) as MirrorDetail;
    assert.deepEqual(mirror.deliveredResult?.links,{...initial,...update.links});
    assert.equal(mirror.deliveredResult?.deliveryText,'写好两项事实');
    assert.equal(mirror.deliveredResult?.fileCount,1);
    assert.ok(!Object.hasOwn(mirror.deliveredResult??{},'evidence'));
    await f.end(4);
    await assert.rejects(f.call('owner-update',update),{code:'human-message-required'});
  }finally{await f.close();}
});

test('hitting the configurable hourly wake limit records one problem and stops waking',async t=>{
  const f=await fixture(t,undefined,{managerWakesPerHour:1});try {
    await f.pulse();assert.equal(f.counts().followups,1);await f.enter(1);await f.assistant(1,[{type:'text',text:'已查看。'}]);await f.end(1);
    f.store.enqueueManager(f.bot.id,'extra:1','合成后续通知',f.task.id);
    await f.pulse();assert.equal(f.counts().followups,1);
    const problem=f.store.managerInfo(f.bot.id).problem;assert.match(String(problem?.message),/1 次上限/);
    await f.pulse(5000);assert.deepEqual(f.store.managerInfo(f.bot.id).problem,problem);assert.equal(f.counts().followups,1);
    assert.equal(f.store.managerNotifications(f.bot.id).some((e:any)=>e.id==='manager-event:extra:1'&&e.state==='pending'),true);
  }finally{await f.close();}
});
