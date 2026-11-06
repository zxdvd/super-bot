/** A ready file report cannot settle a Run while its real job registry is active. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const client=await hostClient(),prefix=`background:${randomUUID()}`;
async function raw(action,payload={}) {const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});assert.equal(response.status,200);return (await response.json()).result;}
async function call(action,payload={}) {const result=await raw(action,payload);assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
async function probe(action,sessionId) {const response=await client.post('/api/super-bot-probe',{action,sessionId});assert.equal(response.status,200);const result=await response.json();assert.equal(result.ok,true);return result;}
const bot=await call('bot.create',{requestId:prefix+':bot',name:'成果仍有后台活动探针',instructions:'合成任务，无外部进程。'});
const task=await call('task.create',{requestId:prefix+':task',botId:bot.id,goal:'READY_WITH_JOB_PROBE',scope:'专用目录',acceptance:'文件与后台活动均核对',reviewPolicy:'bot'});
const binding=await call('session.prepare',{requestId:prefix+':prepare',id:task.id,expectedRowVersion:task.rowVersion});await probe('select-test-model',binding.sessionId);
let jobCreated=false;
try {
  let detail=await call('task.detail',{id:task.id});await call('task.dispatch',{requestId:prefix+':dispatch',id:task.id,expectedRowVersion:detail.task.rowVersion});
  for(let n=0;n<100;n++){detail=await call('task.detail',{id:task.id});if(detail.task.status==='recovery')break;await delay(100);}
  assert.equal(detail.task.status,'recovery');assert.equal(detail.task.lifecycle,'open');assert.equal(detail.run.state,'interrupted');assert.ok(detail.result);assert.match(detail.run.note,/后台工作/);
  assert.equal((await probe('inspect-session',binding.sessionId)).status,'idle');
  assert.equal((await probe('ready-job-status',binding.sessionId)).status,'running');jobCreated=true;
  const accept={id:task.id,expectedRowVersion:detail.task.rowVersion,resultId:detail.result.id};
  assert.equal((await raw('result.accept',{requestId:prefix+':accept',...accept})).error.code,'job-active');
  assert.equal((await raw('run.recover',{requestId:prefix+':recover-active',id:task.id,expectedRowVersion:detail.task.rowVersion,acknowledged:true})).error.code,'job-active');
  assert.equal((await probe('ready-job-cancel',binding.sessionId)).status,'stopping');
  assert.equal((await raw('run.recover',{requestId:prefix+':recover-stopping',id:task.id,expectedRowVersion:detail.task.rowVersion,acknowledged:true})).error.code,'job-active');
  assert.equal((await probe('ready-job-finish',binding.sessionId)).status,'killed');
  const recovered=await call('run.recover',{requestId:prefix+':recover',id:task.id,expectedRowVersion:detail.task.rowVersion,acknowledged:true});assert.equal(recovered.status,'paused');
  const late=await raw('result.accept',{requestId:prefix+':late-accept',...accept,expectedRowVersion:recovered.rowVersion});assert.equal(late.ok,false);
  assert.equal((await call('task.detail',{id:task.id})).task.lifecycle,'open');
  console.log(JSON.stringify({ok:true,taskId:task.id,sessionId:binding.sessionId,checks:['ready report and idle Agent do not imply settled background work','active and stopping jobs prevent acceptance/recovery','job cancellation receipt does not free responsibility','explicit recovery pauses without reviving old ready candidate']},null,2));
}finally{if(jobCreated)await probe('ready-job-finish',binding.sessionId);}
