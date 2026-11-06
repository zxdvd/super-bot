/** Existing native history is authorized explicitly; attachment itself never runs work. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const client=await hostClient(),prefix=`attach:${randomUUID()}`;
async function raw(action,payload={}) {const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});assert.equal(response.status,200);return (await response.json()).result;}
async function call(action,payload={}) {const result=await raw(action,payload);assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
async function probe(action,payload={}) {const response=await client.post('/api/super-bot-probe',{action,...payload});assert.equal(response.status,200);const result=await response.json();assert.equal(result.ok,true,JSON.stringify(result));return result;}
async function waitFor(id,condition) {let state;for(let n=0;n<200;n++){state=await call('task.detail',{id});if(condition(state))return state;await delay(100);}assert.fail(JSON.stringify(state));}
const bot=await call('bot.create',{requestId:prefix+':bot',name:'已有会话授权探针',instructions:'仅无网络合成文件。'});
const task=await call('task.create',{requestId:prefix+':task',botId:bot.id,goal:'继续已有会话生成两项事实',scope:'明确授权的会话当前目录',acceptance:'保留历史且生成可回读说明',reviewPolicy:'human'});
const existing=await probe('create-attach-session',{text:'pending'});
const inspected=await call('session.inspect',{id:task.id,sessionId:existing.sessionId});assert.equal(inspected.quiet,false);
const grant={id:task.id,expectedRowVersion:task.rowVersion,sessionId:existing.sessionId,cwd:inspected.cwd,fullHistoryApproved:true,directoryApproved:true};
const busy=await raw('session.attach',{requestId:prefix+':busy',...grant});assert.equal(busy.error.code,'session-busy');assert.equal((await call('task.detail',{id:task.id})).binding,null);
await probe('clear-attach-pending',{sessionId:existing.sessionId});
assert.equal((await call('session.inspect',{id:task.id,sessionId:existing.sessionId})).quiet,true);
const missing=await raw('session.attach',{requestId:prefix+':no-history',...grant,fullHistoryApproved:false});assert.equal(missing.error.code,'confirmation-required');
await probe('change-test-directory',{sessionId:existing.sessionId});await probe('clear-directory-notices',{sessionId:existing.sessionId});
const changed=await raw('session.attach',{requestId:prefix+':changed',...grant});assert.equal(changed.error.code,'working-directory-changed');
await probe('restore-test-directory',{sessionId:existing.sessionId});await probe('clear-directory-notices',{sessionId:existing.sessionId});
const before=await probe('inspect-session',{sessionId:existing.sessionId});
const duplicate=await Promise.all([call('session.attach',{requestId:prefix+':attach',...grant}),call('session.attach',{requestId:prefix+':attach',...grant})]);
const binding=duplicate[0];assert.equal(duplicate[1].id,binding.id);
assert.equal((await call('session.attach',{requestId:prefix+':attach',...grant})).id,binding.id);
let detail=await call('task.detail',{id:task.id});assert.equal(detail.task.status,'paused');assert.equal(detail.run,null);
await delay(1200);const after=await probe('inspect-session',{sessionId:existing.sessionId});assert.equal(after.modelSteps,before.modelSteps);assert.deepEqual(after.historyMessageIds,before.historyMessageIds);
assert.ok(after.historyMessageIds.includes(existing.historyMessageId));
const resumed=await call('task.control',{requestId:prefix+':resume',id:task.id,expectedRowVersion:detail.task.rowVersion,mode:'auto'});
await call('task.dispatch',{requestId:prefix+':dispatch',id:task.id,expectedRowVersion:resumed.rowVersion});
detail=await waitFor(task.id,state=>state.task.lifecycle==='review');assert.equal(detail.input.state,'entered');assert.equal(detail.result.evidence.length,1);
const history=await probe('inspect-session',{sessionId:existing.sessionId});assert.equal(history.historyMessageIds.filter(id=>id===existing.historyMessageId).length,1);
const otherBot=await call('bot.create',{requestId:prefix+':other-bot',name:'另一个关联边界 Bot',instructions:'合成任务。'});
const other=await call('task.create',{requestId:prefix+':other',botId:otherBot.id,goal:'不得接管原任务',scope:'自己的目录',acceptance:'拒绝越界',reviewPolicy:'human'});
assert.equal((await raw('session.inspect',{id:other.id,sessionId:existing.sessionId})).error.code,'session-owned');
const rework=await call('result.reject',{requestId:prefix+':rework',id:task.id,expectedRowVersion:detail.task.rowVersion,resultId:detail.result.id,text:'仅测试解绑，暂不投递。'});
await call('session.detach',{requestId:prefix+':detach',id:task.id,expectedRowVersion:rework.rowVersion});
assert.equal((await call('session.attach',{requestId:prefix+':attach',...grant})).state,'released');
assert.equal((await call('task.detail',{id:task.id})).binding,null);
assert.equal((await raw('session.inspect',{id:other.id,sessionId:existing.sessionId})).error.code,'session-owned');
const contested=await probe('create-attach-session');
const contender=await call('task.create',{requestId:prefix+':contender',botId:bot.id,goal:'同一会话的并发竞争',scope:'授权目录',acceptance:'仅一项关联成功',reviewPolicy:'human',startPaused:true});
const races=await Promise.all([other,contender].map((candidate,index)=>raw('session.attach',{requestId:prefix+':race-'+index,id:candidate.id,expectedRowVersion:candidate.rowVersion,sessionId:contested.sessionId,cwd:contested.cwd,fullHistoryApproved:true,directoryApproved:true})));
assert.equal(races.filter(result=>result.ok).length,1);assert.equal(races.find(result=>!result.ok).error.code,'session-owned');
const fork=await probe('create-attach-session',{text:'fork'});
const forkTask=await call('task.create',{requestId:prefix+':fork-task',botId:bot.id,goal:'关联普通会话分支',scope:'分支当前目录',acceptance:'保留历史',reviewPolicy:'human',startPaused:true});
assert.equal((await call('session.inspect',{id:forkTask.id,sessionId:fork.sessionId})).quiet,true);
await call('session.attach',{requestId:prefix+':fork-attach',id:forkTask.id,expectedRowVersion:forkTask.rowVersion,sessionId:fork.sessionId,cwd:fork.cwd,fullHistoryApproved:true,directoryApproved:true});
console.log(JSON.stringify({ok:true,taskId:task.id,sessionId:existing.sessionId,checks:['busy native Session refused without binding','explicit history and directory grants required','changed directory requires fresh inspection','attachment preserves history and pauses with no model call','explicit resume executes one new input','other Bot and detached-history reuse refused','old request cannot reattach a released binding','concurrent same request creates one binding','concurrent cross-Bot claims yield exactly one owner']},null,2));
