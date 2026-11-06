/** Idempotent synthetic UI fixture through product commands; no direct database edits. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const client=await hostClient(),prefix='ui-fixture-v1';
async function call(action,payload={}) {for(let n=0;n<100;n++){const response=await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}});const r=(await response.json()).result;if(!r.ok&&r.error.code==='capacity'){await delay(100);continue;}assert.equal(r.ok,true,JSON.stringify(r));return r.value;}assert.fail('capacity did not become available');}
const bot=await call('bot.create',{requestId:prefix+':b',name:'分页与统计夹具（100项）',instructions:'只含合成数据，用于检查分页、统计和筛选，不启用自动管理。'});
for(let i=0;i<100;i++) {
  let task=await call('task.create',{requestId:`${prefix}:t:${i}`,botId:bot.id,goal:`分页夹具 ${String(i+1).padStart(3,'0')}`,scope:i<10?'':'专用测试目录',acceptance:i<10?'':'文件包含两项事实',reviewPolicy:'human'});
  if(i>=10&&i<40)await call('task.control',{requestId:`${prefix}:pause:${i}`,id:task.id,expectedRowVersion:task.rowVersion,mode:'paused'});
  if(i<90)continue;
  let d=await call('task.detail',{id:task.id});if(['review','completed'].includes(d.task.lifecycle))continue;
  const binding=await call('session.prepare',{requestId:`${prefix}:session:${i}`,id:task.id,expectedRowVersion:d.task.rowVersion});
  await client.post('/api/super-bot-probe',{action:'select-test-model',sessionId:binding.sessionId});
  d=await call('task.detail',{id:task.id});await call('task.dispatch',{requestId:`${prefix}:dispatch:${i}`,id:task.id,expectedRowVersion:d.task.rowVersion});
  for(let n=0;n<100;n++){d=await call('task.detail',{id:task.id});if(d.task.lifecycle==='review')break;await delay(100);}
  assert.equal(d.task.lifecycle,'review');
  if(i>=95)await call('result.accept',{requestId:`${prefix}:accept:${i}`,id:task.id,expectedRowVersion:d.task.rowVersion,resultId:d.result.id});
}
const page=await call('task.list',{botId:bot.id,limit:100});assert.equal(page.total,100);assert.deepEqual(page.counts,{all:100,open:90,review:5,completed:5,cancelled:0});
console.log(JSON.stringify({ok:true,botId:bot.id,counts:page.counts,note:'Open includes 10 needing input, 30 paused, and 50 unscheduled.'},null,2));
