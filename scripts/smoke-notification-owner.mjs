/** Owner-only resolution RPC against the real product plugin in a fresh reliability host. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostClient } from './host-client.mjs';
const log = process.env.SUPER_BOT_TEST_LOG;
assert.ok(log?.includes('/reliability-'));
const client = await hostClient(log);
const raw = async (action, payload = {}) =>
  (
    await (
      await client.post('/api/super-bot', {
        type: 'client-request',
        rpcId: randomUUID(),
        method: 'super-bot',
        payload: { action, ...payload },
      })
    ).json()
  ).result;
const call = async (action, payload = {}) => {
  const r = await raw(action, payload);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.value;
};
const probe = async (action, sid, text) => {
  const r = await (
    await client.post('/api/super-bot-probe', { action, sessionId: sid, text })
  ).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
};
const bot = await call('bot.create', {
  requestId: randomUUID(),
  name: 'Owner RPC isolated',
  instructions: 'Synthetic receipt only',
});
const manager = await call('manager.prepare', { requestId: randomUUID(), botId: bot.id });
await probe('select-test-model', manager.sessionId);
await probe('arm-crash', manager.sessionId, 'receipt-loss');
const task = await call('task.create', {
  requestId: randomUUID(),
  botId: bot.id,
  goal: 'Never dispatch this synthetic task',
  scope: 'No work',
  acceptance: 'No Worker calls',
  reviewPolicy: 'human',
});
const eventId = `manager-event:created:${task.id}`;
let info;
for (let i = 0; i < 250; i++) {
  info = await call('manager.status', { botId: bot.id });
  if (info.notifications.some((n) => n.id === eventId && n.state === 'unknown')) break;
  await delay(40);
}
assert.equal(info.uncertain, 1);
assert.equal(info.notifications.find((n) => n.id === eventId).attempts, 1);
const args = { botId: bot.id, eventId, acknowledged: true };
assert.equal(
  (
    await raw('manager.notification.resolve', {
      ...args,
      requestId: randomUUID(),
      resolution: 'retry-unsent',
    })
  ).error.code,
  'notification-uncertain',
);
assert.equal(
  (
    await raw('manager.notification.resolve', {
      ...args,
      requestId: randomUUID(),
      resolution: 'handled',
      acknowledged: false,
    })
  ).error.code,
  'confirmation-required',
);
const requestId = randomUUID();
const done = await call('manager.notification.resolve', {
  ...args,
  requestId,
  resolution: 'handled',
});
assert.equal(done.uncertain, 0);
await call('manager.notification.resolve', { ...args, requestId, resolution: 'handled' });
const detail = await call('task.detail', { id: task.id });
assert.equal(detail.run, null);
assert.equal(detail.result, null);
assert.equal(detail.task.rowVersion, task.rowVersion);
const native = await probe('inspect-session', manager.sessionId);
assert.equal(native.pending, 0);
console.log(
  JSON.stringify({
    label: 'owner RPC handles unknown without replay or task mutation',
    claimed: 1,
    automaticInputs: native.events.filter(
      (e) => e.type === 'user/message' && e.data.source.kind === 'super-bot-manager',
    ).length,
    modelCalls: native.modelSteps,
    uncertainAfter: done.uncertain,
  }),
);
console.log('PASS isolated owner notification resolution');
