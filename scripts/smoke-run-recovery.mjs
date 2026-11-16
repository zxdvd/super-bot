/** Test-only fault windows around a real isolated DSH process. Never sends model work on verify. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {hostClient} from './host-client.mjs';
const log=process.env.SUPER_BOT_TEST_LOG;assert.ok(log?.includes('/reliability-'));
const [phase,window]=process.argv.slice(2),record=join(dirname(log),`crash-${window}.json`),client=await hostClient(log);
const raw=async(action,payload={})=>(await (await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}})).json()).result;
const call=async(action,payload={})=>{const r=await raw(action,payload);assert.equal(r.ok,true,JSON.stringify(r));return r.value;};
const probe=async(action,sid,text)=>{const r=await (await client.post('/api/super-bot-probe',{action,sessionId:sid,text})).json();assert.equal(r.ok,true,JSON.stringify(r));return r;};
async function until(fn,label) {let value;for(let i=0;i<200;i++){value=await fn();if(value.ok)return value;await delay(30);}assert.fail(`${label}: ${JSON.stringify(value)}`);}
if(phase==='prepare') {
  const bot=await call('bot.create',{requestId:randomUUID(),name:`Crash ${window}`,instructions:'Synthetic isolated crash only'});
  const goal=window==='unknown-job'?'READY_WITH_JOB_PROBE':window==='receipt-loss'?'STOP_PROBE':'Recovery ready candidate';
  const task=await call('task.create',{requestId:randomUUID(),botId:bot.id,goal,scope:'Own isolated files',acceptance:'Read then report',reviewPolicy:'human'});
  const binding=await call('session.prepare',{requestId:randomUUID(),id:task.id,expectedRowVersion:task.rowVersion}),sid=binding.sessionId;
  await probe('select-test-model',sid);await probe('arm-crash',sid,window);
  const before=await call('task.detail',{id:task.id});
  const dispatch={requestId:randomUUID(),id:task.id,expectedRowVersion:before.task.rowVersion};
  const result=await raw('task.dispatch',dispatch);
  assert.equal(result.ok,window!=='receipt-loss',JSON.stringify(result));
  await until(async()=>{
    const d=await call('task.detail',{id:task.id}),native=await probe('crash-inspect',sid);
    const ok=window==='ready-before-end'?native.held&&!!d.result:window==='end-durable'?native.held&&native.end?.data.reason.kind==='completed':window==='settled'?d.run?.state==='settled':window==='pending-input'?d.run?.state==='interrupted':d.run?.state==='interrupted';
    return {ok,state:d.run?.state,held:native.held,end:native.end?.data.reason.kind};
  },`prepare ${window}`);
  if(window!=='end-durable')await probe('checkpoint-session',sid);
  const d=await call('task.detail',{id:task.id}),native=await probe('crash-inspect',sid);
  if(window==='pending-input'){const s=await probe('inspect-session',sid);assert.equal(s.pending,2);assert.equal(d.input.state,'unknown');}
  if(window==='ready-before-end'){assert.equal(native.end,null);assert.equal(d.runTurn.endSeq,null);assert.equal(d.run.state,'running');}
  if(window==='end-durable'){assert.equal(d.runTurn.quiet,1);assert.equal(d.runTurn.endSeq,native.end.seq);assert.equal(d.run.state,'running');}
  if(window==='unknown-job'){assert.equal(d.runTurn.quiet,0);assert.equal(d.runHeld,true);}
  await writeFile(record,JSON.stringify({taskId:task.id,sid,runId:d.run.id,inputId:d.input.id,dispatch,window,resultId:d.result?.id??null}));
  console.log(JSON.stringify({phase,window,run:d.run.state,locked:d.runHeld,proof:d.runTurn,end:native.end?.data.reason.kind??null}));
}else if(phase==='verify') {
  const saved=JSON.parse(await readFile(record,'utf8'));
  const d=(await until(async()=>{const d=await call('task.detail',{id:saved.taskId});return {ok:!['running','queued','cancelling'].includes(d.run.state),d};},`verify ${window}`)).d;
  const settled=['end-durable','settled'].includes(window),native=await probe('crash-inspect',saved.sid);
  assert.equal(d.run.id,saved.runId);assert.equal(d.input.id,saved.inputId);assert.equal(d.run.state,settled?'settled':'interrupted');
  assert.equal(d.runHeld,!settled);assert.equal(d.result?.id??null,saved.resultId);assert.equal(d.result?.humanAcceptedAt??null,null);
  if(window==='end-durable')assert.equal(d.task.controlMode,'paused');
  if(window==='pending-input'){const s=await probe('inspect-session',saved.sid);assert.equal(s.pending,1,'retain human input only');assert.ok(!s.pendingItems.some(i=>i.id===d.input.messageId));}
  assert.equal(d.events.filter(e=>e.kind==='run.settled').length,settled?1:0);
  assert.equal(native.modelCalls,0);assert.ok(native.inputs<=1);
  assert.equal((await call('task.dispatch',saved.dispatch)).id,saved.runId,'lost receipt retry never re-dispatches');
  const after=await probe('crash-inspect',saved.sid);assert.equal(after.modelCalls,0);assert.equal(after.inputs,native.inputs);
  console.log(JSON.stringify({phase,window,run:d.run.state,locked:d.runHeld,mode:d.task.controlMode,modelCalls:after.modelCalls,automaticInputs:after.inputs}));
}else throw Error('prepare|verify and a crash window are required');
console.log(`PASS crash ${phase} ${window}`);
