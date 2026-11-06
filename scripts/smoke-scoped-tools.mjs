/** A scoped registration can survive DSH's global allow-mask; monotonic guards must still refuse it. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const client=await hostClient(),prefix=`scoped:${randomUUID()}`;
async function call(action,payload={}){const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});assert.equal(response.status,200);const result=(await response.json()).result;assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
async function probe(action,sessionId,extra={}){const response=await client.post('/api/super-bot-probe',{action,sessionId,...extra});const result=await response.json();assert.equal(result.ok,true,JSON.stringify(result));return result;}
const bot=await call('bot.create',{requestId:prefix+':bot',name:'作用域扩展工具边界探针',instructions:'仅合成能力边界测试。'});
const task=await call('task.create',{requestId:prefix+':task',botId:bot.id,goal:'SCOPED_TOOL_PROBE',scope:'专用目录',acceptance:'拒绝额外工具，允许正常文件工作',reviewPolicy:'human'});
const binding=await call('session.prepare',{requestId:prefix+':prepare',id:task.id,expectedRowVersion:task.rowVersion});
await probe('select-test-model',binding.sessionId);await probe('install-scoped-probe',binding.sessionId);
const current=(await call('task.detail',{id:task.id})).task;
await call('task.dispatch',{requestId:prefix+':dispatch',id:task.id,expectedRowVersion:current.rowVersion});let detail;
for(let n=0;n<100;n++){detail=await call('task.detail',{id:task.id});if(detail.task.lifecycle==='review')break;await delay(100);}
assert.equal(detail.task.lifecycle,'review');
const worker=await probe('inspect-session',binding.sessionId);assert.equal(worker.scopedProbeAttempts,1);assert.equal(worker.scopedProbeCalls,0);
const manager=await call('manager.prepare',{requestId:prefix+':manager',botId:bot.id});
await probe('select-test-model',manager.sessionId);await probe('install-scoped-probe',manager.sessionId);
await probe('native-prompt',manager.sessionId,{text:'SCOPED_TOOL_PROBE：尝试合成额外工具。'});
const managed=await probe('inspect-session',manager.sessionId);assert.equal(managed.scopedProbeAttempts,1);assert.equal(managed.scopedProbeCalls,0);
console.log(JSON.stringify({ok:true,taskId:task.id,workerSession:binding.sessionId,managerSession:manager.sessionId,checks:['real agent-scoped tool visible to the fake model','Worker attempt refused by guard','Manager attempt refused by guard','authorized file task still produces candidate']},null,2));
