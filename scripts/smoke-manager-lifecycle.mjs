/** Historical Manager requests must never select a model for a newer configuration. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {writeFile} from 'node:fs/promises';
import {hostClient} from './host-client.mjs';
const client=await hostClient(),prefix=`manager-lifecycle:${randomUUID()}`;
async function call(action,payload={}){const result=(await(await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}})).json()).result;assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
async function probe(action,sessionId){const result=await(await client.post('/api/super-bot-probe',{action,sessionId})).json();assert.equal(result.ok,true,JSON.stringify(result));return result;}
async function quiet(botId,sessionId){let value;for(let n=0;n<100;n++){const info=await call('manager.status',{botId});const session=await probe('inspect-session',sessionId);value={info,session};if(info.pending===0&&session.status==='idle'&&session.pending===0)return;await delay(100);}assert.fail(JSON.stringify(value));}
const bot=await call('bot.create',{requestId:prefix+':bot',name:'管理回执代数验证',instructions:'不访问真实模型，只核对历史请求。'});
const prepare={requestId:prefix+':prepare',botId:bot.id},first=await call('manager.prepare',prepare);
await probe('select-test-model',first.sessionId);await quiet(bot.id,first.sessionId);
const replace={requestId:prefix+':replace',botId:bot.id,expectedGeneration:first.generation},second=await call('manager.replace',replace);await quiet(bot.id,second.sessionId);
await call('bot.update',{requestId:prefix+':update',id:bot.id,expectedRevision:1,name:'管理回执新配置',instructions:'新配置需要自己明确选择模型。',referencePaths:[]});
const historical=await call('manager.prepare',prepare);assert.equal(historical.id,first.id);assert.equal(historical.state,'released');
const third=await call('manager.prepare',{requestId:prefix+':fresh',botId:bot.id});
const before=await call('manager.status',{botId:bot.id});
const retried=await call('manager.replace',replace);assert.equal(retried.id,second.id);assert.equal(retried.state,'released');
assert.equal((await call('manager.prepare',prepare)).id,first.id);
await delay(2200);
const after=await call('manager.status',{botId:bot.id}),session=await probe('inspect-session',third.sessionId);
assert.equal(after.binding.id,third.id);assert.equal(third.configRevision,2);assert.ok(after.pending>0);assert.equal(after.hourlyWakes,before.hourlyWakes);assert.match(after.problem.message,/选择并配置模型/);assert.equal(session.modelSteps,0);assert.equal(session.status,'idle');assert.equal((await call('task.list',{botId:bot.id})).total,0);
const result={ok:true,botId:bot.id,generations:[first.generation,second.generation,third.generation],currentSessionId:third.sessionId,checks:['normal replacement inherits only the original selected test model','released prepare returns its original generation','old replacement returns its own released generation','new configuration remains unselected with pending notification and zero model calls']};
await writeFile('.runtime/manager-lifecycle-evidence.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
