import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const client=await hostClient(),prefix=`manager-rework:${randomUUID()}`;
async function call(action,payload={}){const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});assert.equal(response.status,200);const result=(await response.json()).result;assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
const bot=await call('bot.create',{requestId:prefix+':bot',name:'自动返工与额度探针',instructions:'合成文件，有限返工，不使用网络。'});
let manager=await call('manager.prepare',{requestId:prefix+':manager',botId:bot.id});
const selection=await client.post('/api/super-bot-probe',{action:'select-test-model',sessionId:manager.sessionId});assert.equal(selection.status,200);
const one=await call('task.create',{requestId:prefix+':one',botId:bot.id,goal:'MANAGER_REWORK_PROBE 一次返工',scope:'专用目录',acceptance:'两项事实及修订说明',reviewPolicy:'human'});
const loop=await call('task.create',{requestId:prefix+':loop',botId:bot.id,goal:'MANAGER_REWORK_LOOP 额度边界',scope:'专用目录',acceptance:'有限返工后转人工',reviewPolicy:'human'});
async function waitFor(test,label){let value;for(let n=0;n<400;n++){value=await test();if(value.ok)return value;await delay(100);}assert.fail(`${label}: ${JSON.stringify(value)}`);}
const settled=await waitFor(async()=>{const a=await call('task.detail',{id:one.id}),b=await call('task.detail',{id:loop.id});return {ok:a.task.lifecycle==='review'&&a.task.managerReviewed&&b.task.lifecycle==='review'&&b.task.controlMode==='paused',one:a,loop:b};},'automatic rework');
const runCount=detail=>detail.events.filter(event=>event.kind==='run.queued').length;
assert.equal(runCount(settled.one),2);assert.equal(runCount(settled.loop),3);
assert.equal(settled.one.result.evidence[0].bytes,176);assert.equal(settled.one.result.humanAcceptedAt,null);
assert.ok(settled.loop.attentions.some(attention=>attention.state==='open'&&attention.question.includes('已达 2 次')));
assert.equal(settled.one.task.taskRevision,1);assert.equal(settled.loop.task.taskRevision,1);
await delay(1200);
manager=await call('manager.replace',{requestId:prefix+':replace',botId:bot.id,expectedGeneration:manager.generation});
const latest=await call('task.detail',{id:loop.id});
await call('task.control',{requestId:prefix+':resume',id:loop.id,expectedRowVersion:latest.task.rowVersion,mode:'auto'});
await waitFor(async()=>{const state=await call('task.detail',{id:loop.id});return {ok:state.task.controlMode==='paused',state};},'replacement preserves cap');
const after=await call('task.detail',{id:loop.id});assert.equal(runCount(after),3);assert.equal(after.task.taskRevision,1);
const large=await call('task.create',{requestId:prefix+':large',botId:bot.id,goal:'LARGE_RESULT_PROBE 部分预览',scope:'专用目录',acceptance:'完整检查全文后验收',reviewPolicy:'bot'});
const partial=await waitFor(async()=>{const state=await call('task.detail',{id:large.id});return {ok:state.task.lifecycle==='review'&&state.task.managerReviewed,state};},'truncated preview requires human review');
assert.ok(partial.state.result.evidence[0].bytes>12000);assert.equal(partial.state.result.humanAcceptedAt,null);
assert.ok(partial.state.attentions.some(attention=>attention.state==='open'&&attention.question.includes('12,000')));
console.log(JSON.stringify({ok:true,botId:bot.id,oneTask:one.id,cappedTask:loop.id,largeTask:large.id,checks:['automatic evidence-driven rework creates distinct Run/Result','human policy still requires acceptance','two-rework cap pauses instead of looping','manager replacement and explicit resume do not reset cap','truncated file preview cannot automatically complete a task']},null,2));
