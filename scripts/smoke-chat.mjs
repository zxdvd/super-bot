/** Deterministic model on the real host: validates wiring, not language quality. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {hostClient} from './host-client.mjs';
const client=await hostClient(),prefix=`chat:${randomUUID()}`;
async function call(action,payload={}) {
  const r=await (await client.post('/api/super-bot',{type:'client-request',rpcId:randomUUID(),method:'super-bot',payload:{action,...payload}})).json();
  assert.equal(r.result.ok,true,JSON.stringify(r));return r.result.value;
}
async function probe(body){const r=await (await client.post('/api/super-bot-probe',body)).json();assert.equal(r.ok,true,JSON.stringify(r));return r;}
async function wait(test,label){for(let n=0;n<250;n++){const value=await test();if(value)return value;await delay(100);}assert.fail(`Timed out: ${label}`);}
const bot=await call('bot.create',{requestId:prefix,name:'聊天交付试用',instructions:'接收文档工作并在原对话交付。'});
const manager=await call('manager.prepare',{requestId:prefix+':chat',botId:bot.id});
await probe({action:'select-test-model',sessionId:manager.sessionId});
const say=text=>probe({action:'native-prompt',sessionId:manager.sessionId,text});
const inspect=()=>probe({action:'inspect-session',sessionId:manager.sessionId});
const page=()=>call('task.list',{botId:bot.id});
await say('你好，请简短介绍职责。');assert.equal((await page()).total,0);
const request='请写一份简短的说明，包含两项事实，完成后给我文件。';await say(request);
const task=await wait(async()=>{const p=await page();assert.ok(p.total<=1);return p.items.find(t=>t.lifecycle==='review'&&t.managerReviewed);},'chat creates and completes one task');
let detail=await call('task.detail',{id:task.id});
const source=JSON.parse(detail.events.find(e=>e.kind==='task.created').data).source;
assert.equal(source.text,request);assert.equal(source.sessionId,manager.sessionId);
const download=`/api/super-bot-file?resultId=${detail.result.id}&index=0`;
await wait(async()=>{const session=await inspect();return session.status==='idle'&&session.assistantTexts.some(text=>text.includes(download)&&text.includes(`#super-bot-task=${task.id}`)&&text.includes('等待你确认'));},'delivery in original chat');
assert.equal(detail.result.humanAcceptedAt,null);
const file=await client.get(download);assert.equal(file.status,200);assert.match(await file.text(),/事实一/);
assert.equal((await client.get(download.replace('index=0','index=99'))).status,404);
const unauthenticated=await fetch(client.base+download,{redirect:'manual'});assert.notEqual(unauthenticated.status,200);
const oldResult=detail.result.id;
await say('再加一句结论。');
detail=await wait(async()=>{const d=await call('task.detail',{id:task.id});return d.result?.id!==oldResult&&d.task.lifecycle==='review'&&d.task.managerReviewed&&d;},'chat rework returns a new result');
assert.equal((await page()).total,1);assert.equal(detail.result.humanAcceptedAt,null);
assert.equal(detail.input.content,'再加一句结论。');
await wait(async()=>{const s=await inspect();return s.status==='idle'&&!s.pending;},'manager idle after delivery');
await call('result.accept',{requestId:prefix+':accept',id:task.id,expectedRowVersion:detail.task.rowVersion,resultId:detail.result.id});
assert.ok((await call('task.detail',{id:task.id})).result.humanAcceptedAt);
await say('请写一份说明，先确认读者。');
const questionTask=await wait(async()=>{const p=await page();return p.items.find(t=>t.status==='needs-input');},'worker question');
await wait(async()=>{const s=await inspect();return s.status==='idle'&&s.assistantTexts.some(t=>t.includes('请说明文档面向谁'));},'question in Bot chat');
await say('读者是新同事，保持简短。');
const answered=await wait(async()=>{const d=await call('task.detail',{id:questionTask.id});return d.task.lifecycle==='review'&&d.task.managerReviewed&&d;},'chat answer continues execution');
assert.equal(answered.input.content,'读者是新同事，保持简短。');assert.equal((await page()).total,2);
const result={ok:true,model:'deterministic fixture; no real-model quality claim',botId:bot.id,sessionId:manager.sessionId,taskId:questionTask.id,resultId:answered.result.id,checks:['ordinary chat creates no task','native message provenance','chat request automatically dispatches','readable delivery and verified download in same chat','unauthenticated file access denied','chat rework reuses task','acceptance remains an explicit user action','Worker question and human answer stay in Bot chat']};
await writeFile('.runtime/chat-smoke.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
