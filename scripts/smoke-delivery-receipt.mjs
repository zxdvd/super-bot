/** Real DSH host with the deterministic DF-14 provider in test/host-probe.ts. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';

assert.ok(process.argv[2], 'Pass the isolated host startup log');
const client = await hostClient(process.argv[2]);
const call = async (action, payload = {}) => {
  const r = await (await client.post('/api/super-bot', {
    type: 'client-request', rpcId: randomUUID(), method: 'super-bot', payload: { action, ...payload },
  })).json();
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  return r.result.value;
};
const probe = async (action, payload) => {
  const r = await (await client.post('/api/super-bot-probe', { action, ...payload })).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
};
async function waitFor(read, label) {
  for (let i = 0; i < 120; i++) {
    const result = await read();
    if (result) return result;
    await delay(100);
  }
  assert.fail(`Timed out: ${label}`);
}

const bot = await call('bot.create', { requestId: randomUUID(), name: 'DF-14 receipt', instructions: 'Synthetic files only' });
const { sessionId } = await call('manager.prepare', { requestId: randomUUID(), botId: bot.id });
const say = text => probe('native-prompt', { sessionId, text });
const inspect = () => probe('inspect-session', { sessionId });
const status = () => call('manager.status', { botId: bot.id });
await probe('select-test-model', { sessionId });
await say('DF14_RECEIPT_PROBE');
const task = await waitFor(async () => {
  const { items } = await call('task.list', { botId: bot.id });
  return items.find(item => item.managerReviewed);
}, 'Worker result reviewed');
const detail = () => call('task.detail', { id: task.id, sessionId });
const ready = await detail();
const resultId = ready.result.id, eventId = `manager-event:delivery:${resultId}`;
const workUrl = `${client.base}/#super-bot-task=${task.id}&resultId=${resultId}`;
const filePath = `/api/super-bot-file?resultId=${resultId}&index=0`;
const withoutLink = await waitFor(async () => {
  const log = await inspect();
  const tool = log.toolResults.find(result => !result.message.isError && result.message.content.some(
    block => block.type === 'text' && block.text.includes(`](${workUrl})`)));
  return tool && log.status === 'idle' && log.assistantTexts.includes('请查看上面的交付卡片。') && log;
}, 'successful tool result and final reply without a link');
assert.equal(withoutLink.assistantTexts.some(text => text.includes(workUrl)), false);
const pending = await detail();
const notices = (await status()).notifications;
assert.equal(notices.find(notice => notice.id === eventId)?.state, 'pending',
  'successful registered deliver followed by a linkless native final must retain its obligation');
assert.equal(pending.chatDelivery.state, 'pending');
const cap = await waitFor(async () => {
  const info = await status();
  return info.problem?.message.includes('1 次上限') && info;
}, 'pending-delivery wake cap diagnostic');
assert.equal(cap.hourlyWakes, 1);
assert.match((await detail()).chatDelivery.reason, /每小时自动唤醒上限/);
const scoped = await call('task.detail', { id: task.id, resultId, sessionId });
assert.equal(scoped.linkedResultBelongs, true);
assert.equal(scoped.result.id, resultId);
const file = await client.get(filePath);
assert.equal(file.status, 200);
assert.match(await file.text(), /事实一/);
console.log('PASS real tool/result, linkless native final, pending reviewable result, authenticated download and wake-cap diagnostic');

await say(`DF14_SHOW_RESULT:${task.id}`);
const delivered = await waitFor(async () => {
  const current = await detail();
  return current.chatDelivery.state === 'delivered' && current;
}, 'native final receipt');
const log = await inspect();
assert.ok(log.assistantTexts.some(text => text.includes(workUrl) && !text.includes(client.base + filePath)));
assert.equal(delivered.result.humanAcceptedAt, null);
assert.equal(delivered.run.id, ready.run.id);
assert.equal((await status()).hourlyWakes, 1);
const receipts = delivered.events.filter(event => event.kind === 'manager.delivered' && JSON.parse(event.data).resultId === resultId);
assert.equal(receipts.length, 1);
const receipt = JSON.parse(receipts[0].data);
assert.equal(receipt.sessionId, sessionId);
assert.equal(log.events.find(event => event.seq === receipt.endSeq)?.data.reason.kind, 'completed');
// An ordinary later reply with the same exact links cannot add another delivery receipt.
await say(`DF14_SHOW_RESULT:${task.id}`);
assert.equal((await detail()).events.filter(event => event.kind === 'manager.delivered' && JSON.parse(event.data).resultId === resultId).length, 1);
console.log('PASS same-session exact native final, one receipt across repetition, one Worker Run, no human acceptance');
