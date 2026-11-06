/** Changes the real effective DSH directory, not merely the immutable Session header. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const client=await hostClient(),prefix=`directory:${randomUUID()}`;
async function raw(action,payload={}){const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});assert.equal(response.status,200);return (await response.json()).result;}
async function call(action,payload={}){const result=await raw(action,payload);assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
async function probe(action,sessionId){const response=await client.post('/api/super-bot-probe',{action,sessionId});const result=await response.json();assert.equal(result.ok,true,JSON.stringify(result));return result;}
async function waitFor(id,test){let state;for(let n=0;n<100;n++){state=await call('task.detail',{id});if(test(state))return state;await delay(100);}assert.fail(JSON.stringify(state));}
const bot=await call('bot.create',{requestId:prefix+':bot',name:'当前工作目录边界探针',instructions:'合成文件，无网络。'});
async function prepared(goal,key){const task=await call('task.create',{requestId:prefix+':'+key,botId:bot.id,goal,scope:'仅任务专用目录',acceptance:'不受原生当前目录改变影响',reviewPolicy:'human'});const binding=await call('session.prepare',{requestId:prefix+':prepare:'+key,id:task.id,expectedRowVersion:task.rowVersion});await probe('select-test-model',binding.sessionId);return {task:(await call('task.detail',{id:task.id})).task,binding};}
const {task,binding}=await prepared('STOP_PROBE','active');
const run=await call('task.dispatch',{requestId:prefix+':dispatch',id:task.id,expectedRowVersion:task.rowVersion});
await waitFor(task.id,state=>state.input.state==='entered');
const changed=await probe('change-test-directory',binding.sessionId);assert.notEqual(changed.cwd,binding.cwd);
let state=await waitFor(task.id,state=>state.run.state==='interrupted');assert.equal(state.task.status,'recovery');
await probe('clear-directory-notices',binding.sessionId);
for(let n=0;n<100;n++){if((await probe('inspect-session',binding.sessionId)).status==='idle')break;await delay(100);}
state=await call('task.detail',{id:task.id});
let paused=await call('run.recover',{requestId:prefix+':recover',id:task.id,expectedRowVersion:state.task.rowVersion,acknowledged:true});
const resumed=await call('task.control',{requestId:prefix+':resume',id:task.id,expectedRowVersion:paused.rowVersion,mode:'auto'});
const refused=await raw('task.dispatch',{requestId:prefix+':wrong-directory',id:task.id,expectedRowVersion:resumed.rowVersion});assert.equal(refused.ok,false);assert.equal(refused.error.code,'working-directory-changed');
assert.equal((await call('task.detail',{id:task.id})).run.id,run.id);
assert.equal(existsSync(join(changed.cwd,'result.md')),false);
await probe('restore-test-directory',binding.sessionId);await probe('clear-directory-notices',binding.sessionId);
const next=await call('task.dispatch',{requestId:prefix+':correct-directory',id:task.id,expectedRowVersion:resumed.rowVersion});assert.notEqual(next.id,run.id);
state=await waitFor(task.id,state=>state.input.state==='entered');await call('task.stop',{requestId:prefix+':stop',id:task.id,expectedRowVersion:state.task.rowVersion});await waitFor(task.id,state=>state.run.state==='cancelled');
const relative=await prepared('RELATIVE_PATH_PROBE','relative');
await call('task.dispatch',{requestId:prefix+':relative-dispatch',id:relative.task.id,expectedRowVersion:relative.task.rowVersion});
const denied=await waitFor(relative.task.id,state=>state.task.status==='recovery');assert.equal(denied.result,null);assert.equal(existsSync(join(relative.binding.cwd,'result.md')),false);
await call('run.recover',{requestId:prefix+':relative-recover',id:relative.task.id,expectedRowVersion:denied.task.rowVersion,acknowledged:true});
console.log(JSON.stringify({ok:true,taskId:task.id,relativeTask:relative.task.id,checks:['effective directory change interrupts active authority','directory mismatch cannot reserve another Run','restoring directory permits an explicit new Run','relative file arguments are refused before writing']},null,2));
