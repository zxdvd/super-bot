/** Native human work starts only after old automatic authority converges. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const client=await hostClient(),prefix=`handoff:${randomUUID()}`;
async function call(action,payload={}) {const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});assert.equal(response.status,200);const result=(await response.json()).result;assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
async function probe(action,sessionId,text) {const response=await client.post('/api/super-bot-probe',{action,sessionId,text});assert.equal(response.status,200);const result=await response.json();assert.equal(result.ok,true);return result;}
async function nativeUntil(sessionId,condition) {let state;for(let n=0;n<150;n++){state=await probe('inspect-session',sessionId);if(condition(state))return state;await delay(100);}assert.fail(JSON.stringify(state));}
const bot=await call('bot.create',{requestId:prefix+':bot',name:'人工接管边界探针',instructions:'仅合成任务。'});
const task=await call('task.create',{requestId:prefix+':task',botId:bot.id,goal:'UNRESPONSIVE_MODEL_PROBE',scope:'自己的目录',acceptance:'旧请求不得干扰新人工工作',reviewPolicy:'human'});
const binding=await call('session.prepare',{requestId:prefix+':prepare',id:task.id,expectedRowVersion:task.rowVersion});
await probe('select-test-model',binding.sessionId);await probe('install-scoped-probe',binding.sessionId);
try {
  let detail=await call('task.detail',{id:task.id});await call('task.dispatch',{requestId:prefix+':dispatch',id:task.id,expectedRowVersion:detail.task.rowVersion});
  await nativeUntil(binding.sessionId,state=>state.stalled);
  detail=await call('task.detail',{id:task.id});const stop={requestId:prefix+':stop',id:task.id,expectedRowVersion:detail.task.rowVersion};await call('task.stop',stop);
  await probe('queue-native',binding.sessionId,'人工接管，不重放旧任务。');
  await probe('queue-native',binding.sessionId,'SCOPED_TOOL_PROBE NATIVE_HOLD_PROBE');
  detail=await call('task.detail',{id:task.id});assert.equal(detail.task.controlMode,'manual');assert.equal(detail.run.state,'interrupted');
  const pending=await probe('inspect-session',binding.sessionId);assert.equal(pending.stalled,true);assert.ok(pending.pending>=2);
  assert.equal((await probe('attempt-scoped-probe',binding.sessionId)).scopedProbeCalls,0,'old authority must still deny extra tools while abort has not converged');
  await probe('release-stalled-model',binding.sessionId);
  const human=await nativeUntil(binding.sessionId,state=>state.scopedProbeCalls===1&&state.stalled&&!state.stalledAborted);
  assert.equal(human.pending,0);assert.equal(human.status,'running');
  await call('task.stop',stop);await delay(200);
  const replayed=await probe('inspect-session',binding.sessionId);assert.equal(replayed.stalledAborted,false,'old stop receipt cannot cancel the new human turn');assert.equal(replayed.status,'running');
  await probe('release-stalled-model',binding.sessionId);await nativeUntil(binding.sessionId,state=>state.status==='idle');
  detail=await call('task.detail',{id:task.id});assert.equal(detail.run.state,'interrupted');assert.equal(detail.result,null);assert.equal(detail.task.controlMode,'manual');
  await call('run.recover',{requestId:prefix+':recover',id:task.id,expectedRowVersion:detail.task.rowVersion,acknowledged:true});
  console.log(JSON.stringify({ok:true,taskId:task.id,sessionId:binding.sessionId,checks:['guards persist before cancelled driver becomes idle','native queued messages survive handoff','new human turn has native tools after old driver settles','duplicate old stop does not cancel new human turn','old Run stays interrupted until explicit recovery']},null,2));
}finally{await probe('release-stalled-model',binding.sessionId);}
