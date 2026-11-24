import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTick, setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { startFeishuHost } from '../../src/feishu-host.ts';
import type { FeishuCheckResult, FeishuHandlers, FeishuSelfTestView, FeishuSettingsView, FeishuTransport } from '../../src/feishu-types.ts';
import type { Managers } from '../../src/manager.ts';
import { Store } from '../../src/store.ts';

type Sdk = typeof import('../../src/feishu-sdk.ts');
type Host = Awaited<ReturnType<typeof startFeishuHost>>;
const original = { appId: 'cli_HostFixture', appSecret: 'first-synthetic-private', ownerOpenId: 'ou_fixtureOwner' };
const group = { chatId: 'oc_fixtureGroup', name: '合成群' };

function fixture(t: TestContext, checkFeishuConfig: Sdk['checkFeishuConfig'], legacy?: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'sb-feishu-verification-'));
  const store = new Store(':memory:');
  const ctx = { logger: { warn() {} }, on: () => () => {}, agents: { list: () => [] } } as unknown as Context;
  const managers = {} as Managers;
  let host: Host | undefined, handlers: FeishuHandlers | undefined, diagnoses = 0;
  const transport = (): FeishuTransport => ({
    start(next) { handlers = next; next.onConnection('ready'); },
    stop() { handlers = undefined; },
    async sendText() {},
    async createGroup() { return group; },
    async inspectGroup() { return group; },
    async diagnoseGroup() { diagnoses++; return { ordinaryTextGrant: 'missing', receiveSubscription: 'missing' }; },
  });
  if (legacy) writeFileSync(join(dir, 'super-bot.feishu.json'), JSON.stringify(original), { mode: 0o600 });
  t.after(async () => { await host?.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    async start() {
      await host?.close();
      host = await startFeishuHost(ctx, store, managers, legacy === true, dir, async () => ({
        createFeishuTransport: transport, checkFeishuConfig,
      }));
      return host;
    },
    handlers: () => handlers!,
    diagnoses: () => diagnoses,
    store,
  };
}

const settings = (host: Host) => host.invoke('feishu.settings.get', {}) as Promise<FeishuSettingsView>;
const save = (host: Host, configurationId: string, appSecret: string) =>
  host.invoke('feishu.settings.save', { configurationId, appId: original.appId, appSecret }) as Promise<FeishuSettingsView>;
const verify = (host: Host, configurationId: string) =>
  host.invoke('feishu.settings.verify', { configurationId }) as Promise<FeishuSettingsView>;

test('saved credential evidence ignores stale completions and draft checks and does not poll the API', async t => {
  const requests: Array<{ secret: string; signal?: AbortSignal; resolve(result: FeishuCheckResult): void }> = [];
  const f = fixture(t, (config, options) => new Promise(resolve => requests.push({ secret: config.appSecret, signal: options?.signal, resolve })));
  const host = await f.start();
  assert.equal((await settings(host)).credentials, 'unverified');
  const first = await save(host, (await settings(host)).configurationId, original.appSecret);
  const pendingOld = verify(host, first.configurationId);
  const stale = assert.rejects(pendingOld, { code: 'feishu-configuration-changed' });
  await nextTick();
  assert.deepEqual(requests.map(item => item.secret), [original.appSecret]);
  const switched = await save(host, first.configurationId, 'second-synthetic-private');
  assert.equal(switched.credentials, 'unverified');
  await nextTick();
  assert.equal(requests[0]?.signal?.aborted, true);
  requests[0]!.resolve({ credentials: 'passed' });
  await stale;
  assert.equal((await settings(host)).credentials, 'unverified');
  const pendingNew = verify(host, switched.configurationId);
  requests[1]!.resolve({ credentials: 'failed' });
  assert.equal((await pendingNew).credentials, 'failed');
  const draft = host.invoke('feishu.settings.check', { appId: 'cli_OtherDraft', appSecret: 'other-synthetic-private' });
  await nextTick();
  requests[2]!.resolve({ credentials: 'passed' });
  assert.deepEqual(await draft, { credentials: 'passed' });
  assert.equal((await settings(host)).credentials, 'failed');
  const retry = verify(host, switched.configurationId);
  await nextTick();
  requests[3]!.resolve({ credentials: 'passed' });
  assert.equal((await retry).credentials, 'passed');
  assert.equal((await settings(host)).credentials, 'passed');
  assert.deepEqual(requests.map(item => item.secret), [
    original.appSecret, 'second-synthetic-private', 'other-synthetic-private', 'second-synthetic-private',
  ]);
});

test('confirming genuine private receipt and send persists proof with no extra credential check', async t => {
  let checks = 0;
  const f = fixture(t, async () => { checks++; return { credentials: 'passed' }; });
  let host = await f.start();
  const configured = await save(host, (await settings(host)).configurationId, original.appSecret);
  await nextTick();
  assert.equal((await settings(host)).credentials, 'passed');
  const sessionId = randomUUID();
  const test = { configurationId: configured.configurationId, sessionId, startToken: configured.testStartToken! };
  await host.invoke('feishu.settings.test.start', test);
  await delay(2);
  f.handlers().onPrivateMessage!({ appId: original.appId, senderOpenId: original.ownerOpenId, chatId: 'oc_fixturePrivate',
    messageId: 'om_testPrivate', createdAt: Date.now(), text: '私人测试合成正文' });
  await nextTick();
  const result = await host.invoke('feishu.settings.test.status', {
    configurationId: configured.configurationId, sessionId,
  }) as FeishuSelfTestView;
  assert.equal(result.state, 'sent');
  assert.ok('candidate' in result);
  assert.equal((await settings(host)).privateTest, 'untested');
  const confirmed = await host.invoke('feishu.settings.test.confirm', {
    configurationId: configured.configurationId, sessionId, confirmationToken: result.candidate.confirmationToken,
  }) as FeishuSettingsView;
  assert.equal(confirmed.credentials, 'passed');
  assert.equal(confirmed.privateTest, 'passed');
  assert.ok(confirmed.privateTestAt);
  assert.doesNotMatch(JSON.stringify(confirmed), /私人测试合成正文|first-synthetic-private/);
  assert.equal(checks, 1);
  host = await f.start();
  await nextTick();
  assert.equal((await settings(host)).privateTestAt, confirmed.privateTestAt);
  assert.equal(checks, 2);
});

test('group diagnosis only runs for an eligible explicit request and does not contradict observed mentions', async t => {
  const f = fixture(t, async () => ({ credentials: 'passed' }), true);
  const host = await f.start();
  assert.equal((await settings(host)).selfBinding, 'bound');
  assert.equal((await settings(host)).privateTest, 'untested');
  const bot = f.store.createBot('fixture-bot', { name: '合成 Bot', instructions: '核对权限' });
  const botId = bot.id;
  const preview = await host.invoke('feishu.preview', { botId, chatId: group.chatId }) as { confirmationToken: string };
  const status = await host.invoke('feishu.bind', { botId, confirmationToken: preview.confirmationToken }) as { binding: { id: string } };
  const bindingId = status.binding.id;
  assert.equal(f.diagnoses(), 0);
  await host.invoke('feishu.status', { botId });
  await assert.rejects(host.invoke('feishu.diagnose', { botId, bindingId: 'old' }), { code: 'feishu-binding-changed' });
  assert.equal(f.diagnoses(), 0);
  assert.deepEqual(await host.invoke('feishu.diagnose', { botId, bindingId }), {
    ordinaryTextGrant: 'missing', receiveSubscription: 'missing',
  });
  await delay(2);
  const message = { senderOpenId: original.ownerOpenId, chatId: group.chatId, createdAt: Date.now(), text: '合成文本' };
  await f.handlers().onMessage({ ...message, messageId: 'om_fixtureMention', receiptKind: 'bot-mention' });
  assert.deepEqual(await host.invoke('feishu.diagnose', { botId, bindingId }), {
    ordinaryTextGrant: 'missing', receiveSubscription: 'unknown',
  });
  await f.handlers().onMessage({ ...message, messageId: 'om_fixturePlain', receiptKind: 'plain' });
  await assert.rejects(host.invoke('feishu.diagnose', { botId, bindingId }), { code: 'feishu-diagnosis-not-needed' });
  assert.equal(f.diagnoses(), 2);
});
