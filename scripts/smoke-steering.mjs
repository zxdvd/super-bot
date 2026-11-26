/** Real isolated DSH RPC/event boundary; deterministic provider, never a production home. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {writeFile,readFile} from 'node:fs/promises';
import {hostClient} from './host-client.mjs';
const log=process.env.SUPER_BOT_TEST_LOG;
assert.ok(log?.includes('/reliability-'),'explicit isolated reliability host log required');
const client=await hostClient(log),prefix=`steering:${randomUUID()}`,observations=[],ownedSessions=[];
async function call(action,payload={}) {
  const res=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});
  const result=(await res.json()).result;assert.equal(result.ok,true,JSON.stringify(result));return result.value;
}
async function probe(action,sessionId,extra={}) {
  const res=await client.post('/api/super-bot-probe',{action,sessionId,...extra}),result=await res.json();
  assert.equal(result.ok,true,JSON.stringify(result));return result;
}
async function until(fn,label) {
  let last;for(let n=0;n<160;n++){last=await fn();if(last.ok)return last;await delay(50);}assert.fail(`${label}: ${JSON.stringify(last)}`);
}
const bot=await call('bot.create',{requestId:prefix+':bot',name:'隔离插话收敛回归',instructions:'No network, synthetic only.'});
async function start(goal) {
  const task=await call('task.create',{requestId:randomUUID(),botId:bot.id,goal,scope:'Own isolated files',acceptance:'Read file and report',reviewPolicy:'human'});
  const b=await call('session.prepare',{requestId:randomUUID(),id:task.id,expectedRowVersion:task.rowVersion});
  ownedSessions.push(b.sessionId);
  await probe('select-test-model',b.sessionId);await probe('install-scoped-probe',b.sessionId);
  const detail=await call('task.detail',{id:task.id});
  await call('task.dispatch',{requestId:randomUUID(),id:task.id,expectedRowVersion:detail.task.rowVersion});
  return {id:task.id,sid:b.sessionId};
}
async function snapshot(t,label) {
  const d=await call('task.detail',{id:t.id}),s=await probe('inspect-session',t.sid);
  const item={label,run:d.run.state,mode:d.task.controlMode,status:s.status,pending:s.pending,
    result:!!d.result,executedTools:s.executedTools,attentions:d.attentions.filter(a=>a.state==='open').map(a=>a.kind),
    events:s.events.map(e=>({seq:e.seq,type:e.type,...(e.type==='turn/start'?{turn:e.data.turn}:e.type==='turn/end'?{turn:e.data.turn,reason:e.data.reason.kind}:e.type==='user/message'?{id:e.data.id,source:e.data.source.kind}:{})})),
    scopedProbeCalls:s.scopedProbeCalls,aborted:s.stalledAborted};
  observations.push(item);console.log(JSON.stringify(item));
  await writeFile(log.replace('host.log',`observations-${scenario}.json`),JSON.stringify(observations,null,2));return {d,s};
}
const scenario=process.argv[2]??'steer';
try {
if(scenario==='restart-prepare') {
  const t=await start('STOP_PROBE');
  await until(async()=>({ok:(await call('task.detail',{id:t.id})).input.state==='entered'}),'restart input entered');
  const d=await call('task.detail',{id:t.id});
  await writeFile(log.replace('host.log','restart.json'),JSON.stringify({...t,runId:d.run.id,inputId:d.input.id}));
  await probe('checkpoint-session',t.sid);
  await snapshot(t,'restart: running before forced termination');
}else if(scenario==='restart-verify') {
  const t=JSON.parse(await readFile(log.replace('host.log','restart.json'),'utf8'));
  const end=await snapshot(t,'restart: after process restart');
  assert.equal(end.d.run.id,t.runId);assert.equal(end.d.input.id,t.inputId);
  assert.equal(end.d.run.state,'interrupted');assert.equal(end.d.task.status,'recovery');
  assert.equal(end.s.modelSteps,0);assert.equal(end.s.status,'idle');
  await delay(300);assert.equal((await probe('inspect-session',t.sid)).modelSteps,0,'restart never auto-replays input');
}else if(scenario==='steer'||scenario==='queue') {
  const t=await start('RELIABILITY_HOLD');
  await until(async()=>{const s=await probe('inspect-session',t.sid);return {ok:s.stalled};},'worker held');
  await probe('queue-native',t.sid,{text:scenario==='steer'?'Please check the title too.':'SCOPED_TOOL_PROBE NATIVE_HOLD_PROBE'});
  const queued=await snapshot(t,`${scenario}: queued during auto`);
  assert.equal(queued.d.run.state,'running');assert.equal(queued.d.task.controlMode,'auto');assert.equal(queued.s.stalledAborted,false);
  if(scenario==='steer') {
    assert.equal(queued.s.pendingItems[0].target,'next-turn');
    await probe('promote-steer',t.sid,{itemId:queued.s.pendingItems[0].id});
    const promoted=await snapshot(t,'steer: promoted');assert.equal(promoted.s.pendingItems[0].target,'next-step');
  }
  await probe('release-stalled-model',t.sid);
  await until(async()=>{const s=await probe('inspect-session',t.sid);return {ok:scenario==='queue'?s.stalled&&s.scopedProbeCalls===1:s.status==='idle'};},'worker/native converged');
  await until(async()=>{const d=await call('task.detail',{id:t.id});return {ok:d.run?.finishedAt!==null&&(scenario!=='queue'||d.task.controlMode==='manual')};},'durable automatic reconciliation');
  const end=await snapshot(t,`${scenario}: after auto end`);
  if(scenario==='steer') {
    assert.equal(end.d.run.state,'settled');assert.equal(end.d.task.controlMode,'auto');assert.ok(end.d.result);
    for(const tool of ['write','read','super_bot_report'])assert.ok(end.s.executedTools.includes(tool));
    assert.equal(end.s.events.filter(e=>e.type==='turn/start').length,1);
    assert.equal(end.s.events.filter(e=>e.type==='user/message'&&e.data.source.kind==='user').length,1);
  }else {
    assert.equal(end.d.run.state,'settled','automatic ready must settle before native follow-up');
    assert.equal(end.d.task.controlMode,'manual');assert.equal(end.s.stalledAborted,false);
    await probe('release-stalled-model',t.sid);
  }
}else if(scenario==='background') {
  const t=await start('READY_WITH_JOB_PROBE');
  await until(async()=>({ok:(await probe('inspect-session',t.sid)).status==='idle'}),'ready with background job');
  const before=await snapshot(t,'background: candidate but unresolved effect');
  assert.equal(before.d.run.state,'interrupted');assert.ok(before.d.result);
  assert.equal((await probe('ready-job-status',t.sid)).status,'running');
  await probe('queue-native',t.sid,{text:'SCOPED_TOOL_PROBE NATIVE_HOLD_PROBE'});
  await until(async()=>{const s=await probe('inspect-session',t.sid);return {ok:s.stalled&&s.scopedProbeCalls===1};},'native after unresolved background');
  const after=await snapshot(t,'background: native starts with old resource held');
  assert.equal(after.d.run.state,'interrupted');assert.equal(after.d.task.controlMode,'manual');
  assert.equal(after.s.stalledAborted,false);
  await probe('release-stalled-model',t.sid);
  await probe('ready-job-cancel',t.sid);await probe('ready-job-finish',t.sid);
}else if(scenario==='normal'||scenario==='error'||scenario==='missing') {
  const t=await start(scenario==='error'?'MODEL_FAILURE_PROBE':scenario==='missing'?'RELIABILITY_MISSING_REPORT':'Normal completion');
  await until(async()=>({ok:(await probe('inspect-session',t.sid)).status==='idle'}),'end');
  await until(async()=>({ok:(await call('task.detail',{id:t.id})).run?.finishedAt!==null}),'durable end reconciliation');
  const end=await snapshot(t,scenario);
  assert.equal(end.d.run.state,scenario==='normal'?'settled':'interrupted');
  if(scenario==='normal')assert.ok(end.d.result);else assert.equal(end.d.result,null);
}else if(scenario==='handoff') {
  const t=await start('UNRESPONSIVE_MODEL_PROBE');
  await until(async()=>({ok:(await probe('inspect-session',t.sid)).stalled}),'held worker');
  const d=await call('task.detail',{id:t.id}),stop={requestId:randomUUID(),id:t.id,expectedRowVersion:d.task.rowVersion};
  await call('task.stop',stop);
  await probe('queue-native',t.sid,{text:'SCOPED_TOOL_PROBE NATIVE_HOLD_PROBE'});
  const before=await snapshot(t,'handoff: cancellation converging');assert.equal(before.d.run.state,'cancelling');
  if(process.env.SUPER_BOT_TEST_FULL_ACCESS!=='true') {
    assert.equal((await probe('attempt-scoped-probe',t.sid)).scopedProbeCalls,0,'old files restrictions remain until auto turn converges');
  }
  await probe('release-stalled-model',t.sid);
  await until(async()=>{const s=await probe('inspect-session',t.sid);return {ok:s.stalled&&s.scopedProbeCalls===1};},'native scope released');
  await until(async()=>({ok:(await call('task.detail',{id:t.id})).run?.state==='cancelled'}),'durable cancellation reconciliation');
  const after=await snapshot(t,'handoff: native turn running');
  assert.equal(after.d.run.state,'cancelled');
  assert.equal(after.d.run.state,'cancelled');
  assert.equal(after.d.task.controlMode,'manual');assert.equal(after.s.stalledAborted,false);
  await call('task.stop',stop);
  assert.equal((await probe('inspect-session',t.sid)).stalledAborted,false,'duplicate old stop cannot cancel native');
  await probe('release-stalled-model',t.sid);
}
console.log(`PASS ${scenario}`);
} finally {
  for(const sid of ownedSessions)await probe('release-stalled-model',sid).catch(()=>{});
}

