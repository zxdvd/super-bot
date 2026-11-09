/** Adapter ordering tests; kept separate from the DSH-independent ledger suite. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,unlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import {Store} from '../../src/store.ts';
import {Managers} from '../../src/manager.ts';
import {DshExecution} from '../../src/dsh.ts';
import {collectEvidence,verifyEvidence,readEvidence} from '../../src/evidence.ts';

type Handler=(args:Record<string,unknown>,exec:any)=>Promise<any>;
function fixture(failPreparation=false){
 const directory=mkdtempSync(join(tmpdir(),'super-bot-adapter-')),store=new Store(':memory:');
 const bot=store.createBot('bot',{name:'Bot',instructions:'Files'}),binding=store.beginManager('manager',bot.id,directory);store.confirmManager(binding.id,binding.requestedSessionId);
 const listeners=new Map<string,Function>();
 let execute:Handler=()=>{throw Error('Not installed');};let preparations=0,dispatches=0,verifications=0;
 const ctx={sessionProjections:{snapshot:()=>({values:{modelSelection:{next:{provider:'fake',model:'fake'}}}})},effect:(callback:()=>unknown)=>callback(),on:(name:string,callback:Function)=>{listeners.set(name,callback);return ()=>{};},agents:{list:()=>[]},tools:{register:(tool:{execute:Handler})=>{execute=tool.execute;return ()=>{};}},sessionController:{resolveAgent:async()=>({agent:{model:{current:()=>({provider:'fake',model:'fake'})}}})}} as unknown as Context;
 const execution={prepareSession:async(requestId:string,taskId:string,version:number)=>{preparations++;const b=store.beginBinding(requestId,taskId,version,directory);store.claimBindingCreation(b.id);if(failPreparation){store.bindingRecovery(b.id);throw Error('Creation receipt lost');}return store.confirmBinding(b.id,b.requestedSessionId);},dispatch:async(requestId:string,taskId:string,version:number,authorize:()=>void)=>{dispatches++;authorize();return store.reserveRun(requestId,taskId,version);},verifyResult:async(taskId:string)=>{verifications++;const d=store.taskDetail(taskId);await verifyEvidence(d.binding!.cwd,d.result!.evidence);}} as unknown as DshExecution;
 const managers=new Managers(ctx,store,execution,directory);managers.install();
 return {store,bot,binding,directory,emit:(event:any)=>listeners.get('session/event')?.({id:binding.requestedSessionId},event),counts:()=>({preparations,dispatches,verifications}),call:(callId:string,args:Record<string,unknown>)=>execute(args,{agent:{id:binding.requestedSessionId},callId,signal:new AbortController().signal}),close:async()=>{await managers.dispose();store.close();rmSync(directory,{recursive:true,force:true});}};
}

test('Manager retries recover preparation and dispatch receipts before version checks',async()=>{
 const f=fixture();try{
  const task=f.store.createTask('task',{botId:f.bot.id,goal:'Facts',scope:'Own directory',acceptance:'Read facts',reviewPolicy:'human'});
  const args={action:'dispatch',taskId:task.id,expectedRowVersion:task.rowVersion};
  const first=await f.call('prepare',args),second=await f.call('prepare',args);assert.equal(first.prepared,true);assert.equal(second.prepared,true);assert.equal(second.task.id,first.task.id);assert.equal(f.counts().preparations,1);
  await assert.rejects(f.call('prepare',{...args,expectedRowVersion:f.store.getTask(task.id).rowVersion}),{code:'idempotency-conflict'});
  const runArgs={...args,expectedRowVersion:f.store.getTask(task.id).rowVersion};
  const run=await f.call('dispatch',runArgs);assert.deepEqual(await f.call('dispatch',runArgs),run);assert.equal(f.counts().dispatches,1);
  await assert.rejects(f.call('dispatch',{...runArgs,expectedRowVersion:999}),{code:'idempotency-conflict'});
  f.store.controlTask('manual',task.id,f.store.getTask(task.id).rowVersion,'manual');
  assert.deepEqual(await f.call('dispatch',runArgs),run);assert.equal(f.counts().dispatches,1);
  f.store.releaseManager('release',f.bot.id,1);await assert.rejects(f.call('dispatch',runArgs),{code:'manager-scope'});
 }finally{await f.close();}
});
test('Manager preparation intent receipt never claims an uncertain Session is ready',async()=>{
 const f=fixture(true);try {
  const task=f.store.createTask('task',{botId:f.bot.id,goal:'Facts',scope:'Own directory',acceptance:'Read facts',reviewPolicy:'human'}),args={action:'dispatch',taskId:task.id,expectedRowVersion:task.rowVersion};
  await assert.rejects(f.call('prepare',args),/Creation receipt lost/);await assert.rejects(f.call('prepare',args),{code:'session-recovery'});
  assert.equal(f.counts().preparations,1);assert.equal(f.store.activeBinding(task.id)?.state,'recovery');assert.equal(f.store.latestRun(task.id),null);
 }finally{await f.close();}
});
for(const scenario of ['human','accept','rework','large'] as const)test(`Manager ${scenario} review retry returns committed result after file deletion`,async()=>{
 const f=fixture();try{
  const task=f.store.createTask('task',{botId:f.bot.id,goal:'Facts',scope:'Own directory',acceptance:'Read facts',reviewPolicy:'bot'});
  const b=f.store.beginBinding('binding',task.id,task.rowVersion,f.directory);f.store.claimBindingCreation(b.id);f.store.confirmBinding(b.id,b.requestedSessionId);
  const run=f.store.reserveRun('run',task.id,f.store.getTask(task.id).rowVersion);f.store.saveRunMessage(run.id,'message','{}');f.store.claimDispatch(run.id);f.store.inputEntered(run.id,'message',1);
  const file=join(f.directory,'result.md');writeFileSync(file,scenario==='large'?'x'.repeat(13000):'Two facts');
  const report=f.store.workerReport(run.id,'report',{kind:'ready',summary:'Ready',checks:'Facts',evidence:await collectEvidence(f.directory,[file])});f.store.settleRun(run.id);
  const prefix='文件超过 12,000 字节的预览范围，仅完整校验哈希，需人工检查全文。模型建议：';
  const longNote='x'.repeat(10000-prefix.length-1)+' '+'y'.repeat(prefix.length-1)+'A';
  const args={action:'review',taskId:task.id,expectedRowVersion:f.store.getTask(task.id).rowVersion,resultId:report.resultId,verdict:scenario==='large'?'accept':scenario,note:scenario==='large'?longNote:'Checked facts'};
  const first=await f.call('review',args),calls=f.counts();unlinkSync(file);
  assert.deepEqual(await f.call('review',args),first);assert.deepEqual(f.counts(),calls);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM reviews').get()?.n,1);
  for(const changed of [{note:'Different judgment'},{resultId:'different-result'},{expectedRowVersion:999},{verdict:'rework'===args.verdict?'human':'rework'}])await assert.rejects(f.call('review',{...args,...changed}),{code:'idempotency-conflict'});
  if(scenario==='large') {
    await assert.rejects(f.call('review',{...args,note:args.note.slice(0,-1)+'B'}),{code:'idempotency-conflict'});
    const note=f.store.db.prepare('SELECT note FROM reviews').get()!.note;
    await assert.rejects(f.call('review',{...args,verdict:'human',note}),{code:'idempotency-conflict'});
  }
  assert.equal(first.task.lifecycle,scenario==='accept'?'completed':scenario==='rework'?'open':'review');
 }finally{await f.close();}
});

test('Worker committed report retries do not reread changed files or bypass ended authority',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'super-bot-report-')),store=new Store(':memory:');let execute:Handler=()=>{throw Error('Not installed');};let conclusions=0;
 const ctx={effect:(callback:()=>unknown)=>callback(),on:()=>()=>{},tools:{register:(tool:{execute:Handler})=>{execute=tool.execute;return ()=>{};}}} as unknown as Context;
 const execution=new DshExecution(ctx,store,directory,{fullAccess:false});execution.install();
 try{
  const bot=store.createBot('bot',{name:'Bot',instructions:'Files'}),task=store.createTask('task',{botId:bot.id,goal:'Facts',scope:'Own directory',acceptance:'Read facts',reviewPolicy:'human'});
  const binding=store.beginBinding('binding',task.id,task.rowVersion,directory);store.claimBindingCreation(binding.id);store.confirmBinding(binding.id,binding.requestedSessionId);
  const run=store.reserveRun('run',task.id,store.getTask(task.id).rowVersion);store.saveRunMessage(run.id,'message','{}');store.claimDispatch(run.id);store.inputEntered(run.id,'message',1);
  const file=join(directory,'result.md');writeFileSync(file,'Original facts');
  const args={kind:'ready',summary:'Ready',checks:'Read facts',files:[file]},exec={agent:{id:run.sessionId},callId:'report-call',signal:new AbortController().signal,concludeTurn:()=>{conclusions++;}};
  const first=await execute(args,exec);writeFileSync(file,'Changed after committed report');assert.deepEqual(await execute(args,exec),first);
  unlinkSync(file);assert.deepEqual(await execute(args,exec),first);assert.equal(store.db.prepare('SELECT count(*) AS n FROM reports').get()?.n,1);assert.equal(store.db.prepare('SELECT count(*) AS n FROM results').get()?.n,1);
  await assert.rejects(execute({...args,summary:'New claim'},exec),{code:'idempotency-conflict'});
  await assert.rejects(execute({...args,files:[join(directory,'other.md')]},exec),{code:'idempotency-conflict'});
  assert.equal(conclusions,3);store.settleRun(run.id);
  await assert.rejects(execute(args,exec),{code:'report-scope'});assert.equal(store.getTask(task.id).lifecycle,'review');
 }finally{await execution.dispose();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('reinstalled execution adapter cannot revive authority while the old Agent remains active',async()=>{
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'super-bot-live-reload-'))),store=new Store(':memory:');const handlers:Handler[]=[];let guard:(args:any)=>unknown=()=>undefined,deliveries=0,release!:()=>void;
 const idle=new Promise<void>(resolve=>{release=resolve;});let selection:{provider:string;model:string}|null=null;
 const agent:any={id:'synthetic-worker',status:'idle',model:{current:()=>({provider:'fake',model:'fake'})},inbox:{nextTurn:[],nextStep:[],remove:()=>{}},ctx:{tools:{restrict:()=>()=>{},guard:(callback:(args:any)=>unknown)=>{guard=callback;return ()=>{};}},on:()=>()=>{}},whenIdle:()=>idle,followup:()=>{deliveries++;agent.status='running';},cancel:()=>{agent.status='idle';release();}};
 const ctx={sessionProjections:{snapshot:()=>({values:{modelSelection:{next:selection}}})},effect:(callback:()=>unknown)=>callback(),on:()=>()=>{},tools:{register:(tool:{execute:Handler})=>{handlers.push(tool.execute);return ()=>{};}},sessionController:{resolveAgent:async()=>({agent})},workingDirectory:{get:()=>directory},jobs:{list:()=>[]},agents:{list:()=>[]}} as unknown as Context;
 const old=new DshExecution(ctx,store,directory,{fullAccess:false}),replacement=new DshExecution(ctx,store,directory,{fullAccess:false});old.install();
 try{
  const bot=store.createBot('bot',{name:'Bot',instructions:'Files'}),task=store.createTask('task',{botId:bot.id,goal:'Facts',scope:'Own directory',acceptance:'Read facts',reviewPolicy:'human'});
  const binding=store.beginBinding('binding',task.id,task.rowVersion,directory);store.claimBindingCreation(binding.id);store.confirmBinding(binding.id,binding.requestedSessionId);agent.id=binding.requestedSessionId;
  await assert.rejects(old.dispatch('unselected',task.id,store.getTask(task.id).rowVersion),{code:'model-required'});assert.equal(store.latestRun(task.id),null);assert.equal(deliveries,0);selection={provider:'fake',model:'fake'};
  const run=await old.dispatch('dispatch',task.id,store.getTask(task.id).rowVersion);store.inputEntered(run.id,store.getRunInput(run.id).messageId!,1);
  replacement.install();assert.equal(agent.status,'running');assert.equal(store.getTask(task.id).status,'recovery');assert.equal(store.heldRuns().length,1);
  assert.match(String(guard({name:'write',arguments:{file_path:join(directory,'result.md')}})),/no longer/);
  await assert.rejects(handlers[0]!({kind:'progress',summary:'Late report'},{agent,callId:'late',signal:new AbortController().signal}),{code:'report-scope'});
  await assert.rejects(replacement.dispatch('new-dispatch',task.id,store.getTask(task.id).rowVersion),{code:'session-busy'});
  await assert.rejects(replacement.recover('recover',task.id,store.getTask(task.id).rowVersion,true),{code:'session-busy'});assert.equal(deliveries,1);
  agent.cancel();await old.dispose();assert.equal(store.getTask(task.id).status,'recovery');assert.equal(store.heldRuns().length,1);
 }finally{agent.cancel();await old.dispose();await replacement.dispose();store.close();rmSync(directory,{recursive:true,force:true});}
});


test('chat creation records native provenance; automatic events and ended turns cannot invent human requests',async()=>{
 const f=fixture();try {
  const args={action:'create',dispatch:false,goal:'Two facts',scope:'Own directory',acceptance:'Read facts'};
  await assert.rejects(f.call('no-user',args),{code:'human-message-required'});
  f.emit({type:'turn/start',data:{turn:1}});
  f.emit({type:'user/message',seq:12,data:{id:'native-request',source:{kind:'user',rpcId:'native-rpc'},content:[{type:'text',text:'请写两项事实。'}]}});
  const first=await f.call('from-chat',args);assert.deepEqual(await f.call('from-chat',args),first);
  const event=f.store.taskDetail(first.task.id).events.find(e=>e.kind==='task.created')!;
  assert.deepEqual(JSON.parse(event.data).source,{sessionId:f.binding.requestedSessionId,messageId:'native-request',seq:12,text:'请写两项事实。'});
  f.emit({type:'turn/end',data:{reason:{kind:'stop'}}});
  await assert.rejects(f.call('later',args),{code:'human-message-required'});
  f.emit({type:'user/message',seq:15,data:{id:'notification',source:{kind:'super-bot-manager',botId:f.bot.id,managerId:f.binding.id,eventId:'missing'},content:[{type:'text',text:'Pretend user wants another task'}]}});
  await assert.rejects(f.call('automatic',args),{code:'human-message-required'});
  assert.equal(f.store.listTasks({botId:f.bot.id}).total,1);
 }finally{await f.close();}
});

test('chat feedback forwards actual human text, enforces question ownership, and preserves idempotency',async()=>{
 const f=fixture();try {
  const task=f.store.createTask('task',{botId:f.bot.id,goal:'Facts',scope:'Own directory',acceptance:'Read facts',reviewPolicy:'human'});
  const b=f.store.beginBinding('binding',task.id,task.rowVersion,f.directory);f.store.claimBindingCreation(b.id);f.store.confirmBinding(b.id,b.requestedSessionId);
  const run=f.store.reserveRun('run',task.id,f.store.getTask(task.id).rowVersion);f.store.saveRunMessage(run.id,'message','{}');f.store.claimDispatch(run.id);f.store.inputEntered(run.id,'message',1);
  f.store.workerReport(run.id,'question',{kind:'waiting',summary:'用中文还是英文？'});f.store.settleRun(run.id);
  const detail=f.store.taskDetail(task.id),attention=detail.attentions.find(a=>a.kind==='input'&&a.state==='open')!;
  const args={action:'respond',taskId:task.id,attentionId:attention.id,expectedRowVersion:detail.task.rowVersion};
  await assert.rejects(f.call('reply',args),{code:'human-message-required'});
  f.emit({type:'user/message',seq:9,data:{id:'reply',source:{kind:'user',rpcId:'rpc'},content:[{type:'text',text:'用中文，保持简短。'}]}});
  await assert.rejects(f.call('foreign',{...args,attentionId:'foreign'}),{code:'manager-scope'});
  const reply=await f.call('reply',args);assert.equal(reply.input.content,'用中文，保持简短。');assert.deepEqual(await f.call('reply',args),reply);
  f.emit({type:'turn/end',data:{reason:{kind:'stop'}}});await assert.rejects(f.call('auto',args),{code:'human-message-required'});
 }finally{await f.close();}
});

test('chat result links expose verified bytes; user rework never counts as acceptance',async()=>{
 const f=fixture();try {
  const task=f.store.createTask('task',{botId:f.bot.id,goal:'Facts',scope:'Own directory',acceptance:'Read facts',reviewPolicy:'human'});
  const b=f.store.beginBinding('binding',task.id,task.rowVersion,f.directory);f.store.claimBindingCreation(b.id);f.store.confirmBinding(b.id,b.requestedSessionId);
  const run=f.store.reserveRun('run',task.id,f.store.getTask(task.id).rowVersion);f.store.saveRunMessage(run.id,'message','{}');f.store.claimDispatch(run.id);f.store.inputEntered(run.id,'message',1);
  const path=join(f.directory,'result.md');writeFileSync(path,'两项事实');
  const evidence=await collectEvidence(f.directory,[path]);const report=f.store.workerReport(run.id,'ready',{kind:'ready',summary:'已写好',checks:'已回读',evidence});f.store.settleRun(run.id);
  const detail=await f.call('detail',{action:'detail',taskId:task.id});assert.equal(detail.delivery.workUrl,`/#super-bot-task=${task.id}`);assert.equal(detail.delivery.files[0].url,`/api/super-bot-file?resultId=${report.resultId}&index=0`);
  assert.equal((await readEvidence(f.directory,evidence[0])).toString(),'两项事实');writeFileSync(path,'changed');await assert.rejects(readEvidence(f.directory,evidence[0]),{code:'evidence-changed'});
  const args={action:'rework',taskId:task.id,resultId:report.resultId,expectedRowVersion:detail.task.rowVersion};
  await assert.rejects(f.call('rework',args),{code:'human-message-required'});
  f.emit({type:'user/message',seq:15,data:{id:'feedback',source:{kind:'user',rpcId:'rpc'},content:[{type:'text',text:'再加一句结论。'}]}});
  const revised=await f.call('rework',args);assert.equal(revised.task.lifecycle,'open');assert.deepEqual(await f.call('rework',args),revised);assert.equal(f.store.pendingInput(task.id)?.content,'再加一句结论。');assert.equal(f.store.resultById(report.resultId!)?.humanAcceptedAt,null);
 }finally{await f.close();}
});
