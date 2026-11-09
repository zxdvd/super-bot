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

async function fixture(t:TestContext,fullAccess?:boolean) {
  t.mock.timers.enable({apis:['Date','setInterval']});
  const root=realpathSync(process.cwd());mkdirSync(join(root,'.runtime'),{recursive:true});
  const directory=mkdtempSync(join(root,'.runtime','delivery-adapter-'));let store=new Store(join(directory,'ledger.sqlite'));
  const bot=store.createBot('bot',{name:'Delivery Bot',instructions:'Synthetic work'});
  const manager=store.beginManager('manager',bot.id,directory);store.confirmManager(manager.id,manager.requestedSessionId);
  const task=store.createTask('task',{botId:bot.id,goal:'Write facts',scope:'Own files',acceptance:'Read facts',reviewPolicy:'human'});
  const b=store.beginBinding('binding',task.id,task.rowVersion,directory);store.confirmBinding(b.id,b.requestedSessionId);
  const run=store.reserveRun('run',task.id,store.getTask(task.id).rowVersion);store.saveRunMessage(run.id,'worker-input','{}');store.claimDispatch(run.id);store.inputEntered(run.id,'worker-input',1);
  const file=join(directory,'result.md');writeFileSync(file,'Two checked facts');
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
  let managers=new Managers(ctx,store,execution,directory,()=> 'https://example.test',{fullAccess});managers.install();
  const emit=async(type:string,data:any,surfaceOp?:string)=>{const event={type,data,seq:events.length,time:Date.now(),...(surfaceOp?{surfaceOp}:{})};events.push(event);await listeners.get('session/event')?.(session,event);return event;};
  const pulse=async(ms=1000)=>{t.mock.timers.tick(ms);await new Promise<void>(resolve=>setImmediate(resolve));};
  const call=(callId:string,args:Record<string,unknown>)=>handler(args,{agent,callId,signal:new AbortController().signal});
  const enter=async(turn:number)=>{await emit('turn/start',{turn});const msg=agent.lastMessage;await emit('user/message',msg,'append');};
  const review=async(turn=1)=>{await emit('tool/call',{turn,step:0,callId:'review',name:'super_bot_manage',arguments:JSON.stringify({action:'review',taskId:task.id})});return call('review',{action:'review',taskId:task.id,expectedRowVersion:store.getTask(task.id).rowVersion,resultId:report.resultId,verdict:'human',note:'Read both facts'});};
  const text=()=>`已写好，两项事实已检查；真实模型质量尚未验证，待你确认。\n[文件](https://example.test/api/super-bot-file?resultId=${report.resultId}&index=0)\n[查看成果并确认](https://example.test/#super-bot-task=${task.id})`;
  const assistant=async(turn:number,content:any[]=[{type:'text',text:text()}],finish='stop',interrupted=false)=>emit('assistant/message',{turn,step:1,message:{id:`assistant-${events.length}`,role:'assistant',source:{kind:'model',provider:'fake',model:'fake'},content},stream:[{type:'chunk',time:Date.now(),chunk:{type:'finish',reason:{kind:finish}}}],...(interrupted?{interrupted:true}:{})},'append');
  const end=async(turn:number,success=true)=>{await emit('turn/end',{turn,reason:success?{kind:'completed'}:{kind:'error',error:{code:'SYNTHETIC_MODEL_FAILURE'}}});agent.status='idle';resolveIdle();await new Promise<void>(resolve=>setImmediate(resolve));};
  const state=()=>store.db.prepare('SELECT state,payload FROM outbox WHERE id=?').get(`manager-event:delivery:${report.resultId}`);
  return {allowed:()=>allowed,prompt:()=>prompt(),get store(){return store;},bot,manager,task,run,report,ready,agent,events,durable,pulse,enter,call,review,text,assistant,end,state,emit,beginNative:()=>{agent.status='running';idle=new Promise<void>(resolve=>{resolveIdle=resolve;});},checkpoint:()=> (ctx.sessions as any).flush(session),reinstallWhileActive:()=>{retired.push(managers);managers=new Managers(ctx,store,execution,directory,()=> 'https://example.test',{fullAccess});managers.install();},guard:(name:string,args:Record<string,unknown>={})=>guard({name,arguments:args}),counts:()=>({followups,dispatches,cancels}),setFlush:(mode:typeof flushMode)=>{flushMode=mode;},unblockFlush:()=>allowFlush(),reload:async(reopen=false)=>{await managers.dispose();if(reopen){store.close();store=new Store(join(directory,'ledger.sqlite'));}managers=new Managers(ctx,store,execution,directory,()=> 'https://example.test',{fullAccess});managers.install();},close:async()=>{agent.status='idle';resolveIdle();await managers.dispose();for(const old of retired)await old.dispose();store.close();assert.ok(directory.startsWith(join(root,'.runtime','delivery-adapter-')));rmSync(directory,{recursive:true,force:true});t.mock.timers.reset();}};
}

test('model failure after committed review supplements final delivery without executing Worker or review again',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();
    assert.equal(f.store.getTask(f.task.id).managerReviewed,true);assert.equal(f.state()?.state,'pending');
    await f.end(1,false);
    assert.equal(f.store.db.prepare('SELECT state FROM outbox WHERE id=?').get(f.ready.id)?.state,'unknown');
    await f.reload();await f.pulse();assert.equal(f.counts().followups,2);await f.enter(2);
    assert.equal((await f.call('detail',{action:'detail',taskId:f.task.id})).result.id,f.report.resultId);
    for(const action of ['dispatch','review','create','respond','rework'])await assert.rejects(f.call(`forbidden-${action}`,{action,taskId:f.task.id}),{code:'delivery-only'});
    await f.assistant(2);await f.end(2);
    assert.equal(f.state()?.state,'done');assert.ok(JSON.parse(String(f.state()?.payload)).chatDelivery.messageId);
    await f.pulse();assert.equal(f.counts().followups,2);assert.equal(f.counts().dispatches,0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM reviews').get()?.n,1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM runs').get()?.n,1);
    assert.equal(f.store.runResult(f.run.id)?.humanAcceptedAt,null);
  }finally{await f.close();}
});

test('the original review turn can deliver without an extra wake, but never before the durability barrier',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();await f.assistant(1);
    f.setFlush('blocked');const closing=f.end(1);
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.state()?.state,'pending');
    f.unblockFlush();await closing;assert.equal(f.state()?.state,'done');
    const receipt=JSON.parse(String(f.state()?.payload)).chatDelivery;
    assert.equal(f.durable[receipt.seq].data.message.id,receipt.messageId);
    assert.equal(f.durable[receipt.endSeq].data.reason.kind,'completed');
    await f.pulse();assert.equal(f.counts().followups,1);assert.equal(f.counts().dispatches,0);
  }finally{await f.close();}
});

for(const mode of ['false','throw'] as const)test(`a ${mode} durability result cannot mark delivered or trigger another model before reconciliation`,async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();await f.assistant(1);f.setFlush(mode);await f.end(1);
    assert.equal(f.state()?.state,'pending');assert.equal(f.durable.length,0);
    await f.pulse();assert.equal(f.state()?.state,'pending');assert.equal(f.counts().followups,1);
    f.setFlush('ok');await f.reload(true);await f.pulse();
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
    else {assert.match(f.prompt(),/Run short read-only\/status queries directly/);assert.match(f.prompt(),/code\/file changes, multi-step work or long-running tasks, create and dispatch a Task/);assert.doesNotMatch(f.prompt(),/完整权限未开启/);}
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

test('delivery recognizes relative links and reordered queries without a matching host origin',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();
    await f.assistant(1,[{type:'text',text:`已写好并检查，待你确认。 [文件](/api/super-bot-file?index=0&amp;resultId=${f.report.resultId}) [查看成果](http://127.0.0.1:49999/#super-bot-task=${f.task.id})`}]);
    await f.end(1);
    assert.equal(f.state()?.state,'done');await f.pulse();assert.equal(f.counts().followups,1);
  }finally{await f.close();}
});


test('duplicate turn/end callbacks and reload preserve backoff and never wake twice for the same ended input',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();await f.end(1);await f.pulse();await f.enter(2);
    await f.assistant(2,[{type:'text',text:'已完成，未附链接。'}]);await f.end(2);
    const deadline=JSON.parse(String(f.state()?.payload)).nextAttemptAt;
    await f.emit('turn/end',{turn:2,reason:{kind:'completed'}});await f.reload(true);
    assert.equal(JSON.parse(String(f.state()?.payload)).nextAttemptAt,deadline);
    await f.pulse(29000);assert.equal(f.counts().followups,2);
    await f.pulse(1000);assert.equal(f.counts().followups,3);
    await f.emit('turn/end',{turn:2,reason:{kind:'completed'}});await f.pulse(60000);
    assert.equal(f.counts().followups,3);assert.equal(f.state()?.state,'sending');
    await f.enter(3);await f.assistant(3);await f.end(3);assert.equal(f.state()?.state,'done');
  }finally{await f.close();}
});

for(const delivered of [false,true])test(`legacy pending attempt 14 is reconciled without a fresh wake (delivered=${delivered})`,async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();await f.end(1);await f.pulse();await f.enter(2);
    if(delivered)await f.assistant(2,[{type:'text',text:f.text().replaceAll('https://example.test','http://127.0.0.1:45555')}]);
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

for(const variant of ['wrong-task','missing-index','wrong-path','bare-identifiers'])test(`${variant} cannot masquerade as a linked delivery`,async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();
    const text=variant==='wrong-task'?f.text().replaceAll(f.task.id,'another-task'):variant==='missing-index'?f.text().replace('&index=0',''):variant==='wrong-path'?f.text().replace('/api/super-bot-file','/wrong-file'): `已完成 resultId=${f.report.resultId} taskId=${f.task.id}`;
    await f.assistant(1,[{type:'text',text}]);await f.end(1);assert.equal(f.state()?.state,'pending');
  }finally{await f.close();}
});

test('explicit deliver closes the notification in one call, renders relative links and needs no link matching',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();assert.equal(f.state()?.state,'pending');
    const args={action:'deliver',taskId:f.task.id,resultId:f.report.resultId,text:'两项事实已写好；检查通过，真实模型质量未验证。'};
    const first=await f.call('deliver',args);
    assert.equal(f.state()?.state,'done');assert.equal(JSON.parse(String(f.state()?.payload)).chatDelivery.explicit,true);
    assert.deepEqual(first.delivery.files,[{name:'result.md',url:`/api/super-bot-file?resultId=${f.report.resultId}&index=0`}]);
    assert.equal(first.delivery.workUrl,`/#super-bot-task=${f.task.id}`);assert.equal(first.delivery.humanAcceptanceRequired,true);
    assert.ok(first.delivery.markdown.includes(`(/api/super-bot-file?resultId=${f.report.resultId}&index=0)`));
    assert.ok(!first.delivery.markdown.includes('example.test'));
    assert.deepEqual(await f.call('deliver',args),first);
    assert.deepEqual(await f.call('deliver-again',args),first);
    await assert.rejects(f.call('deliver',{...args,text:'different'}),{code:'idempotency-conflict'});
    // The model's visible reply has no links at all; delivery is still settled and nothing wakes again.
    await f.assistant(1,[{type:'text',text:'请查看上面的交付卡片。'}]);await f.end(1);
    for(let i=0;i<5;i++)await f.pulse(60000);
    assert.equal(f.counts().followups,1);assert.equal(f.counts().dispatches,0);
    assert.equal(f.store.taskDetail(f.task.id).events.filter((e:any)=>e.kind==='manager.delivered'&&JSON.stringify(e).includes(String(f.report.resultId))).length,1);
    assert.equal(f.store.runResult(f.run.id)?.humanAcceptedAt,null);
    await f.reload(true);assert.deepEqual(await f.call('deliver-after-reopen',args),first);
  }finally{await f.close();}
});

test('delivery-only recovery may call deliver for its own result only',async t=>{
  const f=await fixture(t);try {
    await f.pulse();await f.enter(1);await f.review();await f.end(1,false);
    await f.reload();await f.pulse();assert.equal(f.counts().followups,2);await f.enter(2);
    await assert.rejects(f.call('wrong-result',{action:'deliver',taskId:f.task.id,resultId:'other',text:'x'}),{code:'delivery-only'});
    const value=await f.call('scoped',{action:'deliver',taskId:f.task.id,resultId:f.report.resultId,text:'补交付'});
    assert.equal(value.delivery.resultId,f.report.resultId);assert.equal(f.state()?.state,'done');
    await f.assistant(2,[{type:'text',text:'已交付。'}]);await f.end(2);await f.pulse(120000);
    assert.equal(f.counts().followups,2);assert.equal(f.counts().dispatches,0);
  }finally{await f.close();}
});
