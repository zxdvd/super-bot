import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const client=await hostClient();const prefix=`workflow:${randomUUID()}`;
async function call(action,payload={}) {const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});const result=(await response.json()).result;assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
const bot=await call('bot.create',{requestId:prefix+':b',name:'问题与返工探针',instructions:'只处理合成文档'});
let task=await call('task.create',{requestId:prefix+':t',botId:bot.id,goal:'ASK_PROBE',scope:'专用目录',acceptance:'文档有两项事实，按回答确定读者',reviewPolicy:'human'});
const binding=await call('session.prepare',{requestId:prefix+':s',id:task.id,expectedRowVersion:task.rowVersion});
assert.equal((await client.post('/api/super-bot-probe',{action:'select-test-model',sessionId:binding.sessionId})).status,200);
async function detail(){return call('task.detail',{id:task.id});}
async function dispatch(key) {const d=await detail();return call('task.dispatch',{requestId:prefix+key,id:task.id,expectedRowVersion:d.task.rowVersion});}
async function settled() {let d;for(let n=0;n<100;n++){d=await detail();if(d.run?.finishedAt)break;await delay(100);}assert.equal(d.run?.state,'settled',JSON.stringify(d));return d;}
await dispatch(':first');let d=await settled();assert.equal(d.task.status,'needs-input');
const question=d.attentions.find(a=>a.state==='open');assert.equal(question.kind,'input');
const answer={requestId:prefix+':answer',attentionId:question.id,expectedRowVersion:d.task.rowVersion,text:'面向刚加入项目的同事'};
const input=await call('attention.respond',answer);assert.equal((await call('attention.respond',answer)).id,input.id);
d=await detail();assert.equal(d.input.state,'accepted');assert.equal(d.attentions.find(a=>a.id===question.id).state,'responding');
const answeredRun=await dispatch(':answered');assert.equal(answeredRun.inputId,input.id);
d=await settled();assert.equal(d.task.lifecycle,'review');assert.equal(d.attentions.find(a=>a.id===question.id).state,'resolved');
const firstResult=d.result;
await call('result.reject',{requestId:prefix+':reject',id:task.id,expectedRowVersion:d.task.rowVersion,resultId:firstResult.id,text:'补充修订说明'});
d=await detail();assert.equal(d.task.lifecycle,'open');assert.equal(d.input.kind,'rework');
const rework=await dispatch(':rework');assert.notEqual(rework.id,answeredRun.id);
d=await settled();assert.equal(d.task.taskRevision,1);assert.notEqual(d.result.id,firstResult.id);
assert.match(await readFile(d.result.evidence[0].path,'utf8'),/修订/);
await call('result.accept',{requestId:prefix+':accept',id:task.id,expectedRowVersion:d.task.rowVersion,resultId:d.result.id});
assert.equal((await detail()).task.lifecycle,'completed');
console.log(JSON.stringify({ok:true,taskId:task.id,checks:['question becomes persistent attention','answer saved once and resolves only after entry','rework creates new run and result without changing goal revision','revised file accepted']},null,2));
