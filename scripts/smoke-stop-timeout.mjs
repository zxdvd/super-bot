/** A deterministic provider deliberately ignores abort until the test releases it. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const client=await hostClient(),prefix=`stop-timeout:${randomUUID()}`;
async function raw(action,payload={}) {const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});assert.equal(response.status,200);return (await response.json()).result;}
async function call(action,payload={}) {const result=await raw(action,payload);assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
async function probe(action,sessionId) {const response=await client.post('/api/super-bot-probe',{action,sessionId});assert.equal(response.status,200);return response.json();}
const bot=await call('bot.create',{requestId:prefix+':bot',name:'停止超时故障探针',instructions:'合成模型不访问网络。'});
const task=await call('task.create',{requestId:prefix+':task',botId:bot.id,goal:'UNRESPONSIVE_MODEL_PROBE',scope:'仅合成任务目录',acceptance:'不能把取消回执当作完成',reviewPolicy:'human'});
const binding=await call('session.prepare',{requestId:prefix+':prepare',id:task.id,expectedRowVersion:task.rowVersion});await probe('select-test-model',binding.sessionId);
try {
  let detail=await call('task.detail',{id:task.id});await call('task.dispatch',{requestId:prefix+':dispatch',id:task.id,expectedRowVersion:detail.task.rowVersion});
  let native;for(let n=0;n<100;n++){native=await probe('inspect-session',binding.sessionId);if(native.stalled)break;await delay(100);}assert.equal(native.stalled,true);
  detail=await call('task.detail',{id:task.id});const stopAt=Date.now();
  await call('task.stop',{requestId:prefix+':stop',id:task.id,expectedRowVersion:detail.task.rowVersion});
  detail=await call('task.detail',{id:task.id});assert.equal(detail.task.status,'stopping');assert.equal(detail.run.finishedAt,null);
  assert.equal((await raw('run.recover',{requestId:prefix+':too-soon',id:task.id,expectedRowVersion:detail.task.rowVersion,acknowledged:true})).ok,false);
  for(let n=0;n<150;n++){detail=await call('task.detail',{id:task.id});if(detail.task.status==='recovery')break;await delay(100);}
  assert.equal(detail.task.status,'recovery');assert.equal(detail.run.state,'interrupted');assert.match(detail.run.note,/10 秒/);assert.ok(detail.run.finishedAt-stopAt>=9500);
  assert.equal((await probe('inspect-session',binding.sessionId)).stalled,true);assert.equal(detail.result,null);
  const stillBusy=await raw('run.recover',{requestId:prefix+':still-busy',id:task.id,expectedRowVersion:detail.task.rowVersion,acknowledged:true});assert.equal(stillBusy.ok,false);
  await probe('release-stalled-model',binding.sessionId);
  for(let n=0;n<100;n++){native=await probe('inspect-session',binding.sessionId);if(native.status==='idle')break;await delay(100);}assert.equal(native.status,'idle');
  detail=await call('task.detail',{id:task.id});assert.equal(detail.run.state,'interrupted');assert.equal(detail.task.status,'recovery');
  const recovered=await call('run.recover',{requestId:prefix+':recover',id:task.id,expectedRowVersion:detail.task.rowVersion,acknowledged:true});assert.equal(recovered.status,'paused');
  console.log(JSON.stringify({ok:true,taskId:task.id,sessionId:binding.sessionId,stopTimeoutMs:detail.run.finishedAt-stopAt,checks:['cancel receipt leaves native provider active','ten-second timeout produces recovery','active provider prevents recovery release','late convergence never converts unknown Run into success','explicit quiet recovery leaves task paused']},null,2));
}finally {await probe('release-stalled-model',binding.sessionId);}
