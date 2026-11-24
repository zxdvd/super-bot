import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { GROUP_EVIDENCE_KEY_PREFIX } from '../src/feishu-group-evidence.ts';
import { FeishuGroups } from '../src/feishu-groups.ts';
import type { FeishuGroup, FeishuTransport } from '../src/feishu-types.ts';
import { AppError } from '../src/model.ts';
import { Store } from '../src/store.ts';

const config = { appId: 'cli_fixture', ownerOpenId: 'ou_fixture' };
const existing = { chatId: 'oc_existing', name: '现有群' };

function createBot(store: Store, name: string): string {
  return store.createBot(`bot:${name}`, { name, instructions: '合成测试 Bot' }).id;
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function fakeTransport() {
  const chats = new Map([[existing.chatId, existing], ['oc_other', { chatId: 'oc_other', name: '另一个群' }]]);
  const creations = new Map<string, FeishuGroup>();
  const creationCalls: string[] = [], inspections: string[] = [];
  const transport: Pick<FeishuTransport, 'inspectGroup' | 'createGroup'> = {
    async createGroup(name, uuid) {
      creationCalls.push(uuid);
      const prior = creations.get(uuid);
      if (prior) return prior;
      const group = { chatId: `oc_created_${creations.size}`, name };
      creations.set(uuid, group);
      chats.set(group.chatId, group);
      return group;
    },
    async inspectGroup(chatId) {
      inspections.push(chatId);
      const group = chats.get(chatId);
      if (!group) throw new AppError('feishu-bot-not-in-group', '机器人未在群内。');
      return group;
    },
  };
  return { transport, chats, creations, creationCalls, inspections };
}

function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const remote = fakeTransport();
  const groups = new FeishuGroups(store, config, remote.transport);
  return { store, groups, remote, first: createBot(store, '第一个'), second: createBot(store, '第二个') };
}

test('preview uses the verified group name and bind checks membership again before committing', async t => {
  const { groups, remote, first, second } = fixture(t);
  await assert.rejects(groups.preview(first, 'https://feishu.cn/chat'), { code: 'feishu-chat-id' });
  await assert.rejects(groups.preview(first, 'oc_unknown'), { code: 'feishu-bot-not-in-group' });
  assert.deepEqual(remote.inspections, ['oc_unknown']);
  const preview = await groups.preview(first, ` ${existing.chatId} `);
  assert.equal(preview.name, existing.name);
  assert.equal(groups.get(first), null);
  await assert.rejects(groups.bind(second, preview.confirmationToken), { code: 'feishu-preview-expired' });
  remote.chats.delete(existing.chatId);
  await assert.rejects(groups.bind(first, preview.confirmationToken), { code: 'feishu-bot-not-in-group' });
  assert.equal(groups.get(first), null);
  remote.chats.set(existing.chatId, { ...existing, name: '改名后的同一个群' });
  const binding = await groups.bind(first, preview.confirmationToken);
  assert.equal(binding.name, '改名后的同一个群');
  assert.equal(binding.id, preview.confirmationToken);
  assert.deepEqual(await groups.bind(first, preview.confirmationToken), binding);
  assert.deepEqual(groups.findByChat(existing.chatId), binding);
  assert.equal(remote.inspections.filter(chat => chat === existing.chatId).length, 3);
});

test('concurrent confirmations cannot claim one chat twice and stale actions cannot revive an unbound group', async t => {
  const { groups, remote, first, second } = fixture(t);
  const stale = await groups.preview(first, 'oc_other');
  const one = await groups.preview(first, existing.chatId);
  const two = await groups.preview(second, existing.chatId);
  await assert.rejects(groups.bind(first, stale.confirmationToken), { code: 'feishu-preview-expired' });
  const [firstBinding, conflict] = await Promise.allSettled([
    groups.bind(first, one.confirmationToken), groups.bind(second, two.confirmationToken),
  ]);
  assert.equal(firstBinding.status, 'fulfilled');
  assert.equal(conflict.status, 'rejected');
  assert.equal((conflict as PromiseRejectedResult).reason.code, 'feishu-chat-bound');
  const binding = (firstBinding as PromiseFulfilledResult<NonNullable<ReturnType<typeof groups.get>>>).value;
  const revoked: string[] = [];
  const stopListening = groups.onUnbound(id => { assert.equal(groups.get(first), null); revoked.push(id); });
  groups.unbind(first, binding.id);
  stopListening();
  assert.deepEqual(revoked, [binding.id]);
  assert.equal(groups.get(first), null);
  assert.ok(remote.chats.has(existing.chatId));
  await assert.rejects(groups.bind(first, one.confirmationToken), { code: 'feishu-preview-expired' });
  const refreshed = await groups.preview(first, existing.chatId);
  const rebound = await groups.bind(first, refreshed.confirmationToken);
  assert.notEqual(rebound.id, binding.id);
  assert.throws(() => groups.unbind(first, binding.id), { code: 'feishu-binding-changed' });
  assert.deepEqual(groups.get(first), rebound);
});

test('app and owner changes isolate routes; only re-confirmed conflicts move to the new identity', async t => {
  const { store, groups, remote, first, second } = fixture(t);
  const prior = await groups.bind(first, (await groups.preview(first, existing.chatId)).confirmationToken);
  const unaffected = await groups.bind(second, (await groups.preview(second, 'oc_other')).confirmationToken);
  const receipt = JSON.stringify({ plainTextAt: 100, botMentionAt: null });
  store.set(GROUP_EVIDENCE_KEY_PREFIX + prior.id, receipt);
  store.set(GROUP_EVIDENCE_KEY_PREFIX + unaffected.id, receipt);
  const third = createBot(store, '新账号的 Bot');
  const otherApp = new FeishuGroups(store, { ...config, appId: 'cli_other' }, remote.transport);
  const otherOwner = new FeishuGroups(store, { ...config, ownerOpenId: 'ou_other' }, remote.transport);
  for (const changed of [otherApp, otherOwner]) {
    assert.equal(changed.get(first), null);
    assert.equal(changed.findByChat(existing.chatId), null);
    await assert.rejects(changed.bind(first, prior.id), { code: 'feishu-preview-expired' });
  }
  const preview = await otherOwner.preview(third, existing.chatId);
  assert.deepEqual(groups.get(first), prior);
  assert.deepEqual(groups.get(second), unaffected);
  const moved = await otherOwner.bind(third, preview.confirmationToken);
  assert.equal(moved.chatId, existing.chatId);
  assert.equal(groups.get(first), null);
  assert.deepEqual(groups.get(second), unaffected);
  assert.equal(groups.findByChat(existing.chatId), null);
  assert.deepEqual(otherOwner.findByChat(existing.chatId), moved);
  assert.equal(store.get(GROUP_EVIDENCE_KEY_PREFIX + prior.id), null);
  assert.equal(store.get(GROUP_EVIDENCE_KEY_PREFIX + moved.id), null);
  assert.equal(store.get(GROUP_EVIDENCE_KEY_PREFIX + unaffected.id), receipt);
  assert.equal(store.db.prepare('SELECT count(*) AS total FROM feishu_group_bindings').get()?.total, 2);
});

test('concurrent create and a crash before a response reuse the durable UUID and retire stale request IDs', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'super-bot-feishu-test-'));
  const file = join(folder, 'ledger.sqlite');
  let store = new Store(file);
  t.after(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });
  const first = createBot(store, '持久建群');
  const remote = fakeTransport();
  const lostAck = latch();
  const before = new FeishuGroups(store, config, { ...remote.transport, async createGroup(name, uuid) {
    await remote.transport.createGroup(name, uuid);
    await lostAck.promise;
    throw new AppError('feishu-timeout', '响应超时。');
  } });
  const firstCall = before.create(first, '持久群', 'first-request');
  const secondCall = before.create(first, '持久群', 'second-request');
  await assert.rejects(before.create(first, '其他名称', 'third-request'), { code: 'feishu-create-pending' });
  assert.equal(remote.creationCalls.length, 1);
  lostAck.release();
  await Promise.all([assert.rejects(firstCall, { code: 'feishu-timeout' }), assert.rejects(secondCall, { code: 'feishu-timeout' })]);
  assert.equal(before.get(first), null);
  store.close();
  store = new Store(file);
  const after = new FeishuGroups(store, config, remote.transport);
  const bound = await after.create(first, '持久群', 'second-request');
  assert.equal(remote.creations.size, 1);
  assert.deepEqual(remote.creationCalls, [bound.id, bound.id]);
  assert.deepEqual(await after.create(first, '持久群', 'first-request'), bound);
  after.unbind(first, bound.id);
  await assert.rejects(after.create(first, '持久群', 'second-request'), { code: 'feishu-create-stale' });
  const newBinding = await after.create(first, '持久群', 'fresh-request');
  assert.notEqual(newBinding.id, bound.id);
  assert.equal(remote.creations.size, 2);
});

test('creation resumes group verification once the chat is known and expired ambiguous requests are never replayed', async t => {
  const { store, remote, first, second } = fixture(t);
  const lostAck = new AppError('feishu-timeout', '响应超时。');
  let failedInspections = 0;
  const groups = new FeishuGroups(store, config, { ...remote.transport,
    async inspectGroup() { failedInspections++; throw lostAck; },
  });
  await assert.rejects(groups.create(first, '已创建群', 'known'), { code: 'feishu-timeout' });
  assert.equal(failedInspections, 1);
  const resumed = new FeishuGroups(store, config, remote.transport);
  await resumed.create(first, '已创建群', 'known');
  assert.equal(remote.creationCalls.length, 1);

  const uncertain = new FeishuGroups(store, config, { ...remote.transport, async createGroup(name, id) {
    await remote.transport.createGroup(name, id);
    throw lostAck;
  } });
  await assert.rejects(uncertain.create(second, '结果未知群', 'unknown'), { code: 'feishu-timeout' });
  store.db.prepare('UPDATE feishu_group_creations SET startedAt=? WHERE botId=?').run(Date.now() - 11 * 60 * 60 * 1000, second);
  await assert.rejects(resumed.create(second, '结果未知群', 'unknown'), { code: 'feishu-create-unknown' });
  const chat = remote.creations.get(remote.creationCalls[1]!)!;
  const preview = await resumed.preview(second, chat.chatId);
  const recovered = await resumed.bind(second, preview.confirmationToken);
  assert.equal(recovered.chatId, chat.chatId);
  await assert.rejects(resumed.create(second, '结果未知群', 'unknown'), { code: 'feishu-create-stale' });
  assert.equal(remote.creationCalls.length, 2);
});

test('a newly created group can become visible on a bounded retry shared by concurrent requests', async t => {
  const { store, groups, first, remote } = fixture(t);
  const prior = await groups.bind(first, (await groups.preview(first, existing.chatId)).confirmationToken);
  groups.unbind(first, prior.id);
  const checked = latch();
  const reads: string[] = [];
  const creating = new FeishuGroups(store, config, { ...remote.transport, async inspectGroup(chatId) {
    reads.push(chatId);
    assert.equal(store.db.prepare('SELECT chatId FROM feishu_group_creations WHERE botId=?').get(first)?.chatId, chatId);
    if (reads.length === 1) {
      checked.release();
      throw new AppError('feishu-bot-not-in-group', '机器人入群尚未可见。');
    }
    return remote.transport.inspectGroup(chatId);
  } });
  const firstCall = creating.create(first, '正在同步的群', 'creating-one');
  await checked.promise;
  const duplicate = creating.create(first, '正在同步的群', 'creating-two');
  creating.unbind(first, prior.id);
  assert.equal(creating.get(first), null);
  const [binding, replay] = await Promise.all([firstCall, duplicate]);
  assert.deepEqual(replay, binding);
  assert.deepEqual(reads, [binding.chatId, binding.chatId]);
  assert.deepEqual(remote.creationCalls, [binding.id]);
});

test('when group visibility retries are exhausted, the original name resumes the same chat', async t => {
  const { store, first, remote } = fixture(t);
  const reads: string[] = [];
  let visible = false;
  const groups = new FeishuGroups(store, config, { ...remote.transport, async inspectGroup(chatId) {
    reads.push(chatId);
    if (!visible) throw new AppError('feishu-bot-not-in-group', '机器人尚未加入群。');
    return remote.transport.inspectGroup(chatId);
  } });
  await assert.rejects(groups.create(first, '仍待确认的群', 'original'), {
    code: 'feishu-created-not-visible', message: /核对机器人已入群，再用原群名称重试/,
  });
  const [createdId] = remote.creationCalls;
  const created = remote.creations.get(createdId!)!;
  assert.equal(groups.get(first), null);
  assert.deepEqual(reads, Array(4).fill(created.chatId));
  visible = true;
  const recovered = await groups.create(first, '仍待确认的群', 'retry');
  assert.equal(recovered.chatId, created.chatId);
  assert.deepEqual(remote.creationCalls, [recovered.id]);
});

test('stopping during a visibility retry keeps the known chat available for restart without another read', async t => {
  const { store, first, remote } = fixture(t);
  const checked = latch();
  let active = true, inspections = 0;
  const groups = new FeishuGroups(store, config, { ...remote.transport, async inspectGroup() {
    inspections++;
    checked.release();
    throw new AppError('feishu-bot-not-in-group', '机器人入群尚未可见。');
  } }, () => active);
  const creating = groups.create(first, '停止后仍可核验的群', 'shutdown');
  await checked.promise;
  await new Promise(resolve => setImmediate(resolve));
  active = false;
  await assert.rejects(creating, { code: 'feishu-stopped' });
  assert.equal(groups.get(first), null);
  assert.equal(inspections, 1);
  const restarted = new FeishuGroups(store, config, remote.transport);
  const binding = await restarted.create(first, '停止后仍可核验的群', 'shutdown');
  assert.deepEqual(remote.creationCalls, [binding.id]);
});

test('shutdown prevents a late confirmation or creation from committing a binding', async t => {
  const { store, first, second, remote } = fixture(t);
  let active = true;
  const reply = latch();
  const groups = new FeishuGroups(store, config, { ...remote.transport, async inspectGroup(chatId) {
    if (remote.inspections.includes(chatId) || chatId.startsWith('oc_created')) await reply.promise;
    return remote.transport.inspectGroup(chatId);
  } }, () => active);
  const preview = await groups.preview(first, existing.chatId);
  const binding = groups.bind(first, preview.confirmationToken);
  const creation = groups.create(second, '关闭前建群', 'closing');
  await new Promise(resolve => setImmediate(resolve));
  active = false;
  reply.release();
  await Promise.all([assert.rejects(binding, { code: 'feishu-stopped' }), assert.rejects(creation, { code: 'feishu-stopped' })]);
  assert.equal(groups.get(first), null);
  assert.equal(groups.get(second), null);
  const restarted = new FeishuGroups(store, config, remote.transport);
  await restarted.create(second, '关闭前建群', 'closing');
  assert.equal(remote.creationCalls.length, 1);
});
