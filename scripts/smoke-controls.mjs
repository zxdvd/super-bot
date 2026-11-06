/** Actual host: detach/revise/new session, cancellation, and live-run refusal. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const client=await hostClient(),prefix=`controls:${randomUUID()}`;
async function raw(action,payload={}){const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});assert.equal(response.status,200);return (await response.json()).result;}
async function call(action,payload={}){const result=await raw(action,payload);assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
async function detail(id){return call('task.detail',{id});}
const bot=await call('bot.create',{requestId:prefix+':bot',name:'任务控制探针',instructions:'合成文件，验证解除关联与取消。'});
let task=await call('task.create',{requestId:prefix+':task',botId:bot.id,goal:'第一版目标',scope:'本任务目录',acceptance:'生成说明',reviewPolicy:'human'});
const prepare={requestId:prefix+':prepare',id:task.id,expectedRowVersion:task.rowVersion};
const first=await call('session.prepare',prepare);task=(await detail(task.id)).task;
const detach={requestId:prefix+':detach',id:task.id,expectedRowVersion:task.rowVersion};
task=await call('session.detach',detach);assert.equal(task.controlMode,'paused');assert.equal((await call('session.detach',detach)).id,task.id);
assert.equal((await call('session.prepare',prepare)).state,'released');
assert.equal((await detail(task.id)).bindingHistory[0].sessionId,first.sessionId);
task=await call('task.revise',{requestId:prefix+':revise',id:task.id,expectedRowVersion:task.rowVersion,goal:'第二版目标：新文件说明',scope:'全新专用目录',acceptance:'生成并回读两项事实'});
assert.equal(task.taskRevision,2);
const second=await call('session.prepare',{requestId:prefix+':prepare-2',id:task.id,expectedRowVersion:task.rowVersion});
assert.equal(second.generation,2);assert.notEqual(second.sessionId,first.sessionId);assert.notEqual(second.cwd,first.cwd);
task=(await detail(task.id)).task;
task=await call('task.control',{requestId:prefix+':resume',id:task.id,expectedRowVersion:task.rowVersion,mode:'auto'});
await client.post('/api/super-bot-probe',{action:'select-test-model',sessionId:second.sessionId});
await call('task.dispatch',{requestId:prefix+':dispatch',id:task.id,expectedRowVersion:task.rowVersion});let state;
for(let n=0;n<100;n++){state=await detail(task.id);if(state.task.lifecycle==='review')break;await delay(100);}
assert.equal(state.task.lifecycle,'review');const resultId=state.result.id;
const cancel={requestId:prefix+':cancel',id:task.id,expectedRowVersion:state.task.rowVersion};
assert.equal((await call('task.cancel',cancel)).lifecycle,'cancelled');assert.equal((await call('task.cancel',cancel)).lifecycle,'cancelled');
state=await detail(task.id);assert.equal(state.result.id,resultId);assert.equal(state.result.humanAcceptedAt,null);
const oldSession=await client.post('/api/super-bot-probe',{action:'inspect-session',sessionId:first.sessionId});assert.equal(oldSession.status,200);
let live=await call('task.create',{requestId:prefix+':live',botId:bot.id,goal:'STOP_PROBE',scope:'专用目录',acceptance:'停止后才能取消',reviewPolicy:'human'});
const binding=await call('session.prepare',{requestId:prefix+':live-prepare',id:live.id,expectedRowVersion:live.rowVersion});
await client.post('/api/super-bot-probe',{action:'select-test-model',sessionId:binding.sessionId});live=(await detail(live.id)).task;
await call('task.dispatch',{requestId:prefix+':live-dispatch',id:live.id,expectedRowVersion:live.rowVersion});
state=await detail(live.id);
assert.equal((await raw('task.cancel',{requestId:prefix+':too-early',id:live.id,expectedRowVersion:state.task.rowVersion})).ok,false);
assert.equal((await raw('session.detach',{requestId:prefix+':detach-early',id:live.id,expectedRowVersion:state.task.rowVersion})).ok,false);
await call('task.stop',{requestId:prefix+':stop',id:live.id,expectedRowVersion:state.task.rowVersion});
for(let n=0;n<100;n++){state=await detail(live.id);if(state.run.state==='cancelled')break;await delay(100);}
assert.equal(state.run.state,'cancelled');assert.equal((await call('task.cancel',{requestId:prefix+':cancel-live',id:live.id,expectedRowVersion:state.task.rowVersion})).lifecycle,'cancelled');
console.log(JSON.stringify({ok:true,taskId:task.id,checks:['detach retains old session and pauses','old prepare replay cannot reattach','new goal gets new session and directory','cancel preserves unaccepted evidence','live cancel/detach refused','stop settles before cancellation']},null,2));
