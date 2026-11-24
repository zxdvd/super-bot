// Real DSH profiles and deterministic model. Only the Feishu SDK transport is stubbed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { authenticateHost } from './host-client.mjs';
import { alternateCredentials, existingGroup, fixtureCredentials } from '../test/feishu-host-transport.ts';
import { artifactDeliveryText, artifactEditReply, artifactGoal, artifactLinks, artifactReference,
  replacementMr, supplementalDoc } from '../test/delivery-link-fixture.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, '.runtime'), { recursive: true });
const base = await mkdtemp(join(root, '.runtime/feishu-smoke-'));
const home = join(base, 'super-bot/.runtime/dsh');
const shellHome = join(base, 'os-home');
const env = { PATH: process.env.PATH, HOME: shellHome, DSH_HOME: home, TMPDIR: shellHome, DSH_TELEMETRY_DISABLED: '1' };
await mkdir(shellHome);
const alternateModules = process.env.SUPER_BOT_TEST_DSH_NODE_MODULES;
const hostModules = alternateModules ? resolve(alternateModules) : join(root, 'node_modules');
const cli = join(hostModules, '@deepseek-ai/dsh/lib/bin.js');
const bundle = join(base, 'bundle'), lib = join(bundle, 'lib');
await mkdir(lib, { recursive: true });
async function linkAlternateDSH(parent) {
  if (!alternateModules) return;
  await mkdir(join(parent, 'node_modules'), { recursive: true });
  await symlink(join(hostModules, '@deepseek-ai'), join(parent, 'node_modules/@deepseek-ai'));
}
await linkAlternateDSH(bundle);
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
manifest.exports['./feishu-probe-model'] = './lib/model.js';
await writeFile(join(bundle, 'package.json'), JSON.stringify(manifest));
await copyFile(join(root, 'cordis.patch.yml'), join(bundle, 'cordis.patch.yml'));

function command(args, options) {
  const child = spawn(process.execPath, args, { cwd: root, env, ...options });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error(`Command ${args[0]} failed (${code})`)));
  });
}
await command([join(root, 'scripts/build.mjs')], { env: { ...env, SUPER_BOT_BUILD_OUTDIR: lib }, stdio: 'inherit' });
const buildOptions = { bundle: true, platform: 'node', format: 'esm', packages: 'external', absWorkingDir: root };
await Promise.all([
  build({ ...buildOptions, entryPoints: ['test/host-probe.ts'], outfile: join(lib, 'model.js') }),
  build({ ...buildOptions, entryPoints: ['test/feishu-host-probe.ts'], outfile: join(lib, 'index.js'),
    plugins: [{ name: 'synthetic-feishu-transport', setup(builder) {
      builder.onResolve({ filter: /^\.\/feishu-sdk\.ts$/ }, () => ({ path: join(root, 'test/feishu-host-transport.ts') }));
    } }] }),
]);

const primary = 'feishu-primary', secondary = 'feishu-secondary';
const profile = name => join(home, 'profiles', name);
const legacyFile = name => join(profile(name), 'super-bot.feishu.json');
const settingsFile = name => join(profile(name), 'super-bot.json');
const patchFile = name => join(profile(name), 'cordis.patch.yml');
async function configure(name) {
  const dir = profile(name), data = join(home, 'super-bot', name);
  await mkdir(join(dir, 'node_modules/@zxdvd'), { recursive: true });
  await linkAlternateDSH(dir);
  await symlink(bundle, join(dir, 'node_modules/@zxdvd/super-bot'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `super-bot-${name}`, private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@zxdvd/super-bot'] } } }));
  await configurePatch(name, false, data);
}
async function configurePatch(name, enabled, data = join(home, 'super-bot', name)) {
  await writeFile(patchFile(name), JSON.stringify([
    { id: 'hmr', disabled: true },
    { id: 'super-bot', config: { dataDir: data, fullAccess: false, ...(enabled ? { feishu: { enabled: true } } : {}) } },
    { insert: [{ id: 'super-bot-contract-probe', name: '@zxdvd/super-bot/feishu-probe-model' }] },
  ]));
}
async function writeLegacy(name, credentials) {
  await writeFile(legacyFile(name), JSON.stringify(credentials), { mode: 0o600 });
}

const children = new Map();
async function wait(query, label, attempts = 230) {
  for (let i = 0; i < attempts; i++) {
    const result = await query();
    if (result) return result;
    await delay(100);
  }
  assert.fail(`Timed out: ${label} (see ${base})`);
}
async function launch(name, generation) {
  const path = join(base, `${name}-${generation}.log`);
  const file = await open(path, 'wx', 0o600);
  const child = spawn(process.execPath, [cli, '--profile', name, '--host', '127.0.0.1', '--no-open', '--port', '0'],
    { cwd: root, env, stdio: ['ignore', file.fd, file.fd] });
  const state = { child, file, path, exited: false, error: undefined };
  state.exit = new Promise(resolve => {
    child.once('error', error => { state.error = error; });
    child.once('close', () => { state.exited = true; resolve(); });
  });
  children.set(name, state);
  const url = await wait(async () => {
    assert.ok(!state.error && !state.exited, `Isolated ${name} failed to start (see ${path})`);
    return (await readFile(path, 'utf8')).match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/)?.[1];
  }, `${name} native ready`);
  return { ...await authenticateHost(url), url };
}
async function stop(name) {
  const state = children.get(name);
  if (!state) return;
  if (!state.exited) state.child.kill('SIGTERM');
  const timer = setTimeout(() => { if (!state.exited) state.child.kill('SIGKILL'); }, 5000);
  await state.exit;
  clearTimeout(timer);
  await state.file.close();
  assertNoSecret(await readFile(state.path, 'utf8'));
  children.delete(name);
}

const productPath = '/api/super-bot';
const commandBody = (action, data) => ({ type: 'client-request', rpcId: randomUUID(), method: 'super-bot', payload: { action, ...data } });
function assertNoSecret(text) {
  for (const { appSecret } of [fixtureCredentials, alternateCredentials]) {
    assert.ok(!text.includes(appSecret), 'App Secret must not be exposed');
  }
}
async function rpc(client, action, args) {
  const response = await client.post(productPath, commandBody(action, args));
  assert.equal(response.status, 200, `Owner RPC ${action} (see ${base})`);
  const body = await response.text();
  assertNoSecret(body);
  if (!action.startsWith('feishu.settings.')) assert.ok(!body.includes(fixtureCredentials.ownerOpenId));
  return JSON.parse(body).result;
}
async function call(client, action, data = {}) {
  const result = await rpc(client, action, data);
  assert.ok(result.ok, `${action}: ${JSON.stringify(result)}`);
  return result.value;
}
async function probe(client, path, action, payload) {
  const result = await (await client.post(path, { action, ...payload })).json();
  assert.ok(result.ok, `${action}: ${JSON.stringify(result)}`);
  return result;
}
const feishu = (client, action, payload) => probe(client, '/api/super-bot-feishu-probe', action, payload);
const model = (client, action, payload) => probe(client, '/api/super-bot-probe', action, payload);
const settings = (client, action = 'get', data) => call(client, `feishu.settings.${action}`, data);
const settingsRpc = (client, action, data) => rpc(client, `feishu.settings.${action}`, data);
const credentials = ({ appId, appSecret }) => ({ appId, appSecret });
const beginFields = ({ configurationId, testStartToken }) => ({
  configurationId, sessionId: randomUUID(), startToken: testStartToken,
});
const sessionFields = ({ configurationId, sessionId }) => ({ configurationId, sessionId });
const privateChatId = 'oc_fixturePrivate';
const receivePrivate = (client, text, overrides = {}) => feishu(client, 'receive-private', { privateMessage: {
  appId: fixtureCredentials.appId, chatId: privateChatId, senderOpenId: fixtureCredentials.ownerOpenId,
  messageId: `om_${randomUUID()}`, createdAt: Date.now(), text, ...overrides,
} });
async function bindSelf(client) {
  const request = beginFields(await settings(client));
  const opened = await settings(client, 'test.start', request);
  assert.deepEqual(await settings(client, 'test.start', request), opened);
  const competing = await settingsRpc(client, 'test.start', { ...request, sessionId: randomUUID() });
  assert.equal(competing.error.code, 'feishu-test-busy');
  const session = sessionFields(request);
  await delay(5);
  await receivePrivate(client, '合成本人消息');
  const observed = await wait(async () => {
    const test = await settings(client, 'test.status', session);
    return test.state === 'sent' && test;
  }, 'private test send result');
  const confirmation = { ...session, confirmationToken: observed.candidate.confirmationToken };
  const attempts = await Promise.all([settingsRpc(client, 'test.confirm', confirmation), settingsRpc(client, 'test.confirm', confirmation)]);
  assert.equal(attempts.filter(result => result.ok).length, 1);
  assert.equal(attempts.find(result => !result.ok).error.code, 'feishu-configuration-changed');
  return attempts.find(result => result.ok).value;
}
async function transportStats(client) {
  const { starts, stops, inspections, creations, checks, sent } = await feishu(client, 'sent');
  return { starts, stops, inspections, creations, checks, sends: sent.length };
}
const status = (client, bot) => call(client, 'feishu.status', { botId: bot.id });
const bot = (client, name) => call(client, 'bot.create', { requestId: randomUUID(), name, instructions: '只处理隔离测试中的合成文档。' });
async function manager(client, bot) {
  const { sessionId } = await call(client, 'manager.prepare', { requestId: randomUUID(), botId: bot.id });
  await model(client, 'select-test-model', { sessionId });
  return sessionId;
}
const events = async (client, sessionId) => (await feishu(client, 'events', { sessionId })).page.records.map(frame => frame.event);
const feishuInput = item => item.type === 'user/message' && item.data.source.kind === 'user'
  && typeof item.data.source.feishuMessageId === 'string' && !('rpcId' in item.data.source);
const receive = async (client, group, text, options = {}) => feishu(client, 'receive', { message: {
  chatId: group.chatId, senderOpenId: fixtureCredentials.ownerOpenId, createdAt: Date.now(),
  messageId: `om_${randomUUID()}`, text, ...options,
} });
const sent = async (client, group, marker) => (await feishu(client, 'sent')).sent.filter(item =>
  item.chatId === group.chatId && item.text.includes(marker));
const hasSent = (client, group, marker) => wait(async () => (await sent(client, group, marker)).length, `group text ${marker}`);
const prompt = (client, sessionId, text) => model(client, 'native-prompt', { sessionId, text });

async function smokeDeliveryLinks(host, ownerBot, group, sessionId) {
  await prompt(host, sessionId, artifactGoal);
  const { items: [task], total } = await call(host, 'task.list', { botId: ownerBot.id, q: artifactGoal });
  assert.equal(total, 1);
  const detail = () => call(host, 'task.detail', { id: task.id, sessionId });
  const original = await wait(async () => {
    const value = await detail();
    return value.chatDelivery?.state === 'delivered' && value;
  }, 'formal delivery with explicit artifacts in the native chat');
  await hasSent(host, group, artifactDeliveryText);
  const resultId = original.result.id;
  const resultLink = `${host.base}/#super-bot-task=${task.id}&resultId=${resultId}`;
  assert.equal(original.deliveredResult.id, resultId);
  assert.equal(original.deliveredResult.deliveryText, artifactDeliveryText);
  assert.equal(original.task.lifecycle, 'review');
  assert.equal(original.result.humanAcceptedAt, null);
  assert.deepEqual(original.deliveredResult.links, artifactLinks);
  assert.ok(original.result.checks.includes(artifactReference));
  const originalMessages = await sent(host, group, artifactDeliveryText);
  assert.equal(originalMessages.length, 1);
  assert.ok(originalMessages[0].text.includes(resultLink));
  const receipts = original.events.filter(event => event.kind === 'manager.delivered' && JSON.parse(event.data).resultId);
  assert.equal(receipts.length, 1);

  const nonLinkState = async value => {
    const { rowVersion, ...taskState } = value.task;
    const { links, ...delivery } = value.deliveredResult;
    const notifications = await call(host, 'manager.status', { botId: ownerBot.id });
    return { task: taskState, run: value.run, result: value.result, delivery, attentions: value.attentions,
      chatDelivery: value.chatDelivery, events: value.events, notifications };
  };
  const baseline = await nonLinkState(original);
  const add = `请更新这项交付 ${resultLink}，新增交付物“飞书文档 · 联调纪要” ${supplementalDoc}。`;
  const addedLinks = { ...artifactLinks, '飞书文档 · 联调纪要': supplementalDoc };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const beforeMessages = (await sent(host, group, '')).length;
    await prompt(host, sessionId, add);
    await wait(async () => (await sent(host, group, artifactEditReply)).length === attempt, `chat link patch ${attempt}`);
    const patched = await detail();
    assert.deepEqual(patched.deliveredResult.links, addedLinks);
    assert.equal(patched.task.rowVersion, original.task.rowVersion + 1);
    assert.deepEqual(await nonLinkState(patched), baseline);
    assert.deepEqual((await sent(host, group, '')).slice(beforeMessages).map(row => row.text),
      [`网页用户\n${add}`, artifactEditReply]);
  }

  await call(host, 'result.accept', { requestId: randomUUID(), id: task.id, resultId, sessionId,
    expectedRowVersion: original.task.rowVersion + 1 });
  const accepted = await detail();
  assert.equal(accepted.task.lifecycle, 'completed');
  assert.ok(accepted.result.humanAcceptedAt);
  const acceptedBaseline = await nonLinkState(accepted);
  const previousMessages = (await sent(host, group, '')).length;
  const amend = `请更新这项交付 ${resultLink}，把“后端 MR”换成 ${replacementMr}，移除“飞书文档 · 联调方案”。`;
  await receive(host, group, amend, { receiptKind: 'plain' });
  await wait(async () => (await sent(host, group, artifactEditReply)).length === 3, 'accepted result patched in Feishu chat');
  const updated = await detail();
  const correctedLinks = { ...addedLinks, '后端 MR': replacementMr };
  delete correctedLinks['飞书文档 · 联调方案'];
  assert.deepEqual(updated.deliveredResult.links, correctedLinks);
  assert.equal(updated.task.rowVersion, accepted.task.rowVersion + 1);
  assert.deepEqual(await nonLinkState(updated), acceptedBaseline);
  assert.deepEqual((await sent(host, group, '')).slice(previousMessages).map(row => row.text), [artifactEditReply]);
  assert.deepEqual(await sent(host, group, artifactDeliveryText), originalMessages);
  console.log('PASS four explicit artifacts, Web add and retry, Feishu correction after acceptance, unchanged receipt, notifications and Worker run');
  return updated.deliveredResult;
}

async function launchBrowser(host) {
  const { SUPER_BOT_TEST_PLAYWRIGHT: playwright, SUPER_BOT_TEST_BROWSER: executablePath } = process.env;
  if (!playwright && !executablePath) return;
  assert.ok(playwright && executablePath, 'Set absolute paths to Playwright and a Chromium browser.');
  const { chromium } = await import(pathToFileURL(playwright).href);
  const browser = await chromium.launch({ executablePath, env });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === host.base ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.clock.install();
    await page.goto(host.url, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 1500 }).catch(() => {});
    return { browser, page };
  } catch (error) { await browser.close(); throw error; }
}
async function openBotRow(page, bot) {
  await page.getByRole('button', { name: 'Super Bot', exact: true }).click({ timeout: 15000 });
  return page.locator('.bot-row').filter({ hasText: bot.name });
}
async function openSettings(page) {
  await page.getByRole('button', { name: 'Super Bot', exact: true }).click({ timeout: 15000 });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '飞书', exact: true }).waitFor();
  return {
    appId: page.getByLabel('App ID', { exact: true }),
    secret: page.getByLabel('App Secret', { exact: true }),
    check: page.getByRole('button', { name: '检测配置', exact: true }),
    save: page.getByRole('button', { name: '保存并连接', exact: true }),
  };
}
async function openFeishu(panel, bot) {
  const { page } = panel;
  const row = await openBotRow(page, bot);
  await row.getByRole('button', { name: '工作', exact: true }).click({ timeout: 10000 });
  await page.getByRole('button', { name: '设置与维护', exact: true }).click({ timeout: 10000 });
  const section = page.locator('.sb-section').filter({ has: page.getByRole('heading', { name: '飞书群', exact: true }) });
  await section.getByText('连接就绪', { exact: true }).waitFor({ timeout: 10000 });
  return section;
}
async function openFeishuFromSettings(panel, bot) {
  const { page } = panel;
  await openSettings(page);
  await page.getByRole('button', { name: '去验证群同步', exact: true }).click();
  await page.getByLabel('选择要验证的 Bot', { exact: true }).selectOption({ label: bot.name });
  await page.getByRole('button', { name: '打开飞书群设置', exact: true }).click();
  await page.getByRole('heading', { name: bot.name, exact: true, level: 1 }).waitFor();
  await page.getByRole('button', { name: '← 飞书设置', exact: true }).waitFor();
  await page.getByRole('button', { name: '返回这个 Bot 聊天 →', exact: true }).waitFor();
  const section = page.locator('.sb-section').filter({ has: page.getByRole('heading', { name: '飞书群', exact: true }) });
  await section.getByText('连接就绪', { exact: true }).waitFor();
  return section;
}

let ui;

try {
  await Promise.all([configure(primary), configure(secondary)]);
  await writeLegacy(secondary, alternateCredentials);
  let [host, other] = await Promise.all([launch(primary, 'first'), launch(secondary, 'disabled')]);
  assert.deepEqual({ ...await settings(host), configurationId: undefined }, {
    appId: '', ownerOpenId: '', hasSecret: false, enabled: false, configurationId: undefined,
    selfBinding: 'unbound', connection: 'disabled', lastMessageAt: null, credentials: 'unverified', privateTest: 'untested',
  });
  const imported = await settings(other);
  assert.equal(imported.appId, alternateCredentials.appId);
  assert.equal(imported.ownerOpenId, alternateCredentials.ownerOpenId);
  assert.equal(imported.selfBinding, 'bound');
  assert.equal(imported.privateTest, 'untested');
  assert.equal(imported.hasSecret, true);
  assert.equal(imported.enabled, false);
  assert.equal((await stat(settingsFile(secondary))).mode & 0o777, 0o600);

  const a = await bot(host, '合成 Bot A'), b = await bot(host, '合成 Bot B'), c = await bot(other, '默认关闭的 Bot');
  ui = await launchBrowser(host);
  if (ui) {
    await (await openBotRow(ui.page, a)).waitFor();
    await ui.page.getByRole('button', { name: '新建 Bot', exact: true }).click();
    await ui.page.getByLabel('给它起个名字').fill('合成未保存草稿');
  }
  const fields = ui && await openSettings(ui.page);
  // The native welcome notice can update the patch before the Super Bot workflow begins.
  const patch = await readFile(patchFile(primary), 'utf8');
  if (ui) {
    await fields.appId.fill(fixtureCredentials.appId);
    await fields.secret.fill(fixtureCredentials.appSecret);
    assert.equal(await ui.page.getByLabel('Open ID', { exact: true }).count(), 0);
    await fields.check.click();
    await ui.page.getByText('凭证有效', { exact: true }).waitFor();
    assert.equal(await ui.page.getByText(/im:message.group_at_msg|im:chat:create/).count(), 0);
  } else {
    const report = await settings(host, 'check', credentials(fixtureCredentials));
    assert.equal(report.credentials, 'passed');
    assert.deepEqual(report, { credentials: 'passed' });
  }
  assert.equal((await settings(host)).enabled, false);
  await assert.rejects(stat(settingsFile(primary)), { code: 'ENOENT' });
  assert.equal(await readFile(patchFile(primary), 'utf8'), patch);
  assert.deepEqual(await transportStats(host), { starts: 0, stops: 0, checks: 1, creations: 0, inspections: 0, sends: 0 });
  if (ui) {
    await fields.save.click();
    await ui.page.getByText('连接就绪', { exact: true }).waitFor();
    await ui.page.getByText('凭证有效 · 本人未绑定', { exact: true }).waitFor();
    await ui.page.getByText('私聊收发未测试', { exact: true }).waitFor();
    assert.equal(await fields.secret.count(), 0);
    assertNoSecret(await ui.page.locator('body').innerText());
  } else await settings(host, 'save', { ...credentials(fixtureCredentials), configurationId: (await settings(host)).configurationId });
  const connected = await wait(async () => {
    const value = await settings(host);
    return value.credentials === 'passed' && value;
  }, 'fresh verification of saved credentials');
  assert.equal(connected.enabled, true);
  assert.equal(connected.connection, 'ready');
  assert.equal(connected.lastMessageAt, null);
  assert.equal(connected.selfBinding, 'unbound');
  const unboundFile = await readFile(settingsFile(primary), 'utf8');
  assert.ok(JSON.parse(unboundFile).feishu.appSecret === fixtureCredentials.appSecret, 'The saved credential is in the local file');
  assert.equal(JSON.parse(unboundFile).feishu.ownerOpenId, undefined);
  assert.equal((await stat(settingsFile(primary))).mode & 0o777, 0o600);
  assert.equal(await readFile(patchFile(primary), 'utf8'), patch);
  const started = await transportStats(host);
  assert.deepEqual(started, { starts: 1, stops: 0, checks: started.checks,
    creations: 0, inspections: 0, sends: 0 });
  const report = await settings(host, 'check', credentials(alternateCredentials));
  assert.equal(report.credentials, 'passed');
  assert.equal((await settings(host, 'check', { appId: fixtureCredentials.appId, appSecret: '' })).credentials, 'passed');
  assert.equal((await settings(host, 'check', { appId: fixtureCredentials.appId, appSecret: 'invalid-synthetic' })).credentials, 'failed');
  assert.equal((await settings(host, 'check', { appId: fixtureCredentials.appId, appSecret: 'unknown-synthetic' })).credentials, 'unverified');
  assert.deepEqual(await transportStats(host), { ...started, checks: started.checks + 4 });
  assert.deepEqual(await settings(host), connected);
  assert.ok(await readFile(settingsFile(primary), 'utf8') === unboundFile, 'Detection leaves settings byte-for-byte intact');
  assert.deepEqual(await settings(other), imported);
  console.log('PASS first-time settings, detection isolation, private persistence and disabled legacy import');

  const aSession = await manager(host, a), bSession = await manager(host, b);
  await receivePrivate(host, '未开启测试的私聊');
  assert.equal((await transportStats(host)).sends, 0);
  assert.equal((await status(host, a)).selfBinding, 'unbound');
  assert.equal((await rpc(host, 'feishu.preview', { botId: a.id, chatId: existingGroup.chatId })).error.code, 'feishu-self-unbound');
  const staleStart = beginFields(connected);
  if (ui) {
    await ui.page.getByRole('button', { name: '跳过测试', exact: true }).click();
    await ui.page.getByRole('button', { name: '跳过测试', exact: true }).waitFor({ state: 'hidden' });
    await ui.page.getByText('私聊收发未测试', { exact: true }).waitFor();
  } else await settings(host, 'test.skip', { configurationId: connected.configurationId });
  const skipped = await settings(host);
  assert.equal(skipped.selfBinding, 'skipped');
  assert.equal(skipped.privateTest, 'untested');
  assert.equal(skipped.ownerOpenId, '');
  assert.equal(JSON.parse(await readFile(settingsFile(primary), 'utf8')).feishu.selfTestSkipped, true);
  assert.equal((await settingsRpc(host, 'test.start', staleStart)).ok, false);
  assert.equal((await rpc(host, 'feishu.create', { botId: a.id, name: '未绑定', requestId: randomUUID() })).error.code,
    'feishu-self-unbound');
  assert.equal((await transportStats(host)).creations, 0);

  if (ui) {
    const page = ui.page;
    const text = '合成私聊任意一句';
    await page.getByRole('button', { name: '测试并绑定', exact: true }).click();
    await page.getByText(/请在飞书私聊这个应用的机器人/).waitFor();
    const openRobot = page.getByRole('link', { name: '在飞书打开机器人', exact: true });
    assert.equal(await openRobot.getAttribute('href', { timeout: 2000 }),
      `https://applink.feishu.cn/client/bot/open?appId=${fixtureCredentials.appId}`);
    await receivePrivate(host, '另一应用的私聊', { appId: alternateCredentials.appId });
    assert.equal((await transportStats(host)).sends, 0);
    await feishu(host, 'fail-send', { fail: true });
    await receivePrivate(host, text);
    await page.getByText(text, { exact: false }).waitFor();
    await page.getByText('已收到私聊，回发未确认', { exact: true }).waitFor();
    assert.equal(await page.getByText('私聊收发通过', { exact: true }).count(), 0);
    const candidateId = page.getByText(fixtureCredentials.ownerOpenId, { exact: true });
    assert.equal(await candidateId.isVisible(), false);
    await page.getByText('测试详情', { exact: true }).click();
    await candidateId.waitFor();
    assert.equal(await page.getByRole('button', { name: '确认这是本人', exact: true }).count(), 0);
    await feishu(host, 'fail-send', { fail: false });
    await page.getByRole('button', { name: '重试发送', exact: true }).click();
    await page.getByText('私聊收发通过', { exact: true }).waitFor();
    assert.equal((await settings(host)).ownerOpenId, '');
    assert.equal(JSON.parse(await readFile(settingsFile(primary), 'utf8')).feishu.ownerOpenId, undefined);
    await page.getByRole('button', { name: '确认这是本人', exact: true }).click();
    await page.getByText('凭证有效 · 本人已绑定', { exact: true }).waitFor();
    await page.getByText('此连接下的 Bot 共用本人身份', { exact: true }).waitFor();
    await page.getByRole('button', { name: '去验证群同步', exact: true }).waitFor();
    await page.getByRole('button', { name: '← 我的 Bot', exact: true }).click();
    assert.equal(await page.getByLabel('给它起个名字').inputValue(), '合成未保存草稿');
    await page.getByRole('button', { name: '取消', exact: true }).click();
  } else await bindSelf(host);
  const boundSelf = await settings(host);
  assert.equal(boundSelf.selfBinding, 'bound');
  assert.equal(boundSelf.privateTest, 'passed');
  assert.ok(Number.isSafeInteger(boundSelf.privateTestAt));
  assert.equal(boundSelf.ownerOpenId, fixtureCredentials.ownerOpenId);
  assert.equal((await status(host, a)).selfBinding, 'bound');
  assert.equal((await status(host, b)).selfBinding, 'bound');
  assert.equal((await events(host, aSession)).filter(feishuInput).length, 0);
  assert.equal((await events(host, bSession)).filter(feishuInput).length, 0);
  const privateReplies = (await feishu(host, 'sent')).sent;
  assert.equal(privateReplies.length, 1);
  assert.equal(privateReplies[0].chatId, privateChatId);
  assert.match(privateReplies[0].text, /已收到这条飞书私聊测试消息/);
  const savedFile = await readFile(settingsFile(primary), 'utf8');
  assert.equal(JSON.parse(savedFile).feishu.ownerOpenId, fixtureCredentials.ownerOpenId);
  assert.equal(JSON.parse(savedFile).feishu.selfTestSkipped, undefined);
  assert.equal((await feishu(host, 'sent')).starts, 2);
  console.log(ui ? 'PASS explicit private test and skip, failed send and retry, confirmation, and Bot isolation'
    : 'PASS explicit private test and skip, concurrent confirmation, and Bot isolation');
  assert.equal((await status(other, c)).connection, 'disabled');
  assert.equal((await feishu(other, 'sent')).starts, 0);
  assert.equal((await rpc(other, 'feishu.create', { botId: c.id, name: '未启用', requestId: randomUUID() })).ok, false);

  assert.equal((await rpc(host, 'feishu.status', { botId: c.id })).ok, false);

  const unbound = await bot(host, '合成未绑定 Bot');
  const unboundSession = await manager(host, unbound);
  assert.equal((await status(host, unbound)).binding, null);
  await prompt(host, unboundSession, 'FEISHU_SMOKE_UNBOUND_WEB');
  await wait(async () => (await model(host, 'inspect-session', { sessionId: unboundSession })).assistantTexts
    .some(text => text.includes('FEISHU_SMOKE_UNBOUND_WEB')), 'unbound Web reply');
  assert.equal((await transportStats(host)).sends, privateReplies.length);
  const create = { botId: a.id, name: '飞书合成私有群', requestId: randomUUID() };
  if (ui) {
    const section = await openFeishuFromSettings(ui, a);
    await section.getByRole('button', { name: '新建私有群', exact: true }).click();
    await section.getByLabel('私有群名称').fill(create.name);
    await section.getByRole('button', { name: '创建并绑定', exact: true }).click();
    await section.getByRole('link', { name: '在飞书打开群', exact: true }).waitFor();
    await section.getByText('请用本人账号在群里发送一条新文本，无需 @ 机器人。', { exact: true }).waitFor();
    await ui.page.getByRole('button', { name: '← 飞书设置', exact: true }).click();
    await ui.page.getByRole('button', { name: '去验证群同步', exact: true }).waitFor();
    await ui.page.getByRole('button', { name: '← 我的 Bot', exact: true }).click();
  }
  const groupA = (await call(host, 'feishu.create', create)).binding;
  assert.equal((await call(host, 'feishu.create', create)).binding.id, groupA.id);
  const preview = await call(host, 'feishu.preview', { botId: b.id, chatId: existingGroup.chatId });
  assert.equal(preview.name, existingGroup.name);
  assert.equal((await status(host, b)).binding, null, 'Preview does not bind or mirror');
  assert.equal((await rpc(host, 'feishu.bind', { botId: a.id, confirmationToken: preview.confirmationToken })).ok, false);
  let section;
  if (ui) {
    section = await openFeishu(ui, b);
    await section.getByRole('button', { name: '绑定已有群', exact: true }).click();
    await section.getByLabel('已有群的群 ID').fill(existingGroup.chatId);
    await section.getByRole('button', { name: '预览群名称', exact: true }).click();
    await section.getByText(existingGroup.name, { exact: true }).waitFor();
    await section.getByText(/该群的所有成员/).waitFor();
    assert.equal((await status(host, b)).binding, null);
    await section.getByRole('button', { name: '确认绑定', exact: true }).click();
    await section.getByRole('link', { name: '在飞书打开群', exact: true }).waitFor();
  } else await call(host, 'feishu.bind', { botId: b.id, confirmationToken: preview.confirmationToken });
  const groupB = (await status(host, b)).binding;
  assert.equal(groupB.url, `https://applink.feishu.cn/client/chat/open?openChatId=${groupB.chatId}`);
  if (ui) {
    const link = section.getByRole('link', { name: '在飞书打开群', exact: true });
    assert.equal(await link.getAttribute('href'), groupB.url);
    await ui.page.getByRole('button', { name: '← 我的 Bot', exact: true }).click();
  }
  assert.equal((await rpc(host, 'feishu.preview', { botId: unbound.id, chatId: existingGroup.chatId })).ok, false);

  const request = '请写一份说明，先确认读者。', question = '请说明文档面向谁？', answer = '读者是新同事，保持简短。';
  const page = () => call(host, 'task.list', { botId: a.id });
  if (ui) {
    const row = await openBotRow(ui.page, a);
    await row.locator('.bot-open').click({ timeout: 10000 });
    const composer = ui.page.locator('[data-composer-input]');
    await composer.click({ timeout: 10000 });
    await ui.page.keyboard.insertText(request);
    await composer.press('Enter');
  } else await prompt(host, aSession, request);
  await hasSent(host, groupA, request);
  await hasSent(host, groupA, question);
  assert.equal((await sent(host, groupB, question)).length, 0);
  assert.equal((await page()).total, 1);
  const [task] = (await page()).items;
  const detail = () => call(host, 'task.detail', { id: task.id, sessionId: aSession });
  const before = await detail();
  assert.equal(before.pendingQuestions.length, 1);
  await receive(host, groupA, answer, { senderOpenId: 'ou_fixtureOther', receiptKind: 'plain' });
  await receive(host, groupA, answer, { createdAt: groupA.boundAt - 1, receiptKind: 'plain' });
  assert.equal((await detail()).pendingQuestions[0].id, before.pendingQuestions[0].id);
  assert.deepEqual((await status(host, a)).evidence, { plainTextAt: null, botMentionAt: null });
  const answerId = 'om_fixtureAnswer';
  await receive(host, groupA, answer, { messageId: answerId, receiptKind: 'plain' });
  await receive(host, groupA, answer, { messageId: answerId, receiptKind: 'bot-mention' });
  const ready = await wait(async () => {
    const value = await detail();
    return value.task.lifecycle === 'review' && value.task.managerReviewed && value;
  }, 'same task reaches final review after Feishu answer');
  assert.equal(ready.input?.content, answer);
  assert.equal(ready.input?.attentionId, before.pendingQuestions[0].id);
  assert.equal((await page()).total, 1);
  assert.equal(ready.result.humanAcceptedAt, null);
  const file = await host.get(`/api/super-bot-file?resultId=${ready.result.id}&index=0`);
  assert.equal(file.status, 200);
  assert.match(await file.text(), /事实一/);
  const native = await events(host, aSession);
  const incoming = native.filter(feishuInput);
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].surfaceOp, 'append');
  assert.equal(incoming[0].data.source.feishuMessageId, answerId);
  assert.equal(incoming[0].data.content[0].text, answer);
  assert.equal((await sent(host, groupA, request)).length, 1);
  assert.equal((await sent(host, groupA, question)).length, 1);
  assert.equal((await sent(host, groupA, answer)).length, 0, 'Feishu input has no echo');
  const ordinary = (await status(host, a)).evidence;
  assert.ok(Number.isSafeInteger(ordinary.plainTextAt), 'The bound group records a plain text receipt');
  assert.equal(ordinary.botMentionAt, null, 'Duplicate redelivery cannot create a different evidence category');
  await wait(async () => (await model(host, 'inspect-session', { sessionId: aSession })).assistantTexts
    .some(text => text.includes(ready.result.id)), 'result linked from original native chat');
  const legacyDelivery = await wait(async () => {
    const value = await detail();
    return value.chatDelivery?.state === 'delivered' && value.deliveredResult?.id === ready.result.id && value;
  }, 'untagged native delivery receipt');
  assert.deepEqual(legacyDelivery.deliveredResult.links, {});
  if (ui) {
    const flow = ui.page.locator('[data-slot="conversation.chat.flow"]');
    try {
      await flow.getByText(answer, { exact: true }).waitFor({ timeout: 10000 });
      await flow.getByText(/等待你确认。/).last().waitFor({ timeout: 10000 });
    } catch (error) {
      await writeFile(join(base, 'browser-visible.txt'), await ui.page.locator('body').innerText());
      await ui.page.screenshot({ path: join(base, 'browser-failure.png') });
      throw error;
    }
    console.log('PASS browser group creation, binding confirmation, and Feishu input in original native chat');
  }
  const patchedDelivery = await smokeDeliveryLinks(host, a, groupA, aSession);

  const bMarker = 'FEISHU_SMOKE_GROUP_B';
  let groupBPanel;
  if (ui) {
    const groupAPanel = await openFeishu(ui, a);
    await groupAPanel.getByText('群消息接收通过（无需 @）', { exact: true }).waitFor();
    assert.equal(await groupAPanel.getByText('已收到 @ 机器人的消息', { exact: true }).count(), 0);
    await ui.page.getByRole('button', { name: '← 我的 Bot', exact: true }).click();
    groupBPanel = await openFeishu(ui, b);
    await groupBPanel.getByText('等待普通消息…', { exact: true }).waitFor();
    await ui.page.clock.fastForward(46_000);
    await groupBPanel.getByText('尚未收到普通消息', { exact: true }).waitFor();
    assert.equal(await groupBPanel.getByText(/应用缺少|暂时无法确认原因/).count(), 0);
    assert.equal((await feishu(host, 'sent')).diagnoses, 0, 'No automatic permission query when ordinary text times out');
    await groupBPanel.getByRole('button', { name: '排查普通消息', exact: true }).click();
    await groupBPanel.getByText(/应用缺少「接收群聊中所有消息」权限/).waitFor();
    await groupBPanel.getByText(/应用缺少「接收消息」事件订阅/).waitFor();
    assert.equal((await feishu(host, 'sent')).diagnoses, 1);
    await groupBPanel.getByRole('button', { name: '改用 @ 机器人测试', exact: true }).click();
    await groupBPanel.getByText('请在群里 @ 这个应用的机器人，再附上一句新文本。', { exact: true }).waitFor();
  }
  assert.deepEqual((await status(host, b)).evidence, { plainTextAt: null, botMentionAt: null });
  await receive(host, groupB, bMarker, { receiptKind: 'bot-mention' });
  await hasSent(host, groupB, `已收到 ${bMarker}`);
  assert.equal((await sent(host, groupA, bMarker)).length, 0);
  assert.ok((await events(host, bSession)).some(item => item.type === 'user/message' && item.data.content[0].text === bMarker));
  assert.equal((await call(host, 'task.list', { botId: b.id })).total, 0);
  assert.equal((await status(host, b)).evidence.plainTextAt, null);
  assert.ok(Number.isSafeInteger((await status(host, b)).evidence.botMentionAt));
  if (groupBPanel) {
    await groupBPanel.getByText('@ 消息可用，普通消息仍未验证', { exact: true }).waitFor();
    assert.equal(await groupBPanel.getByText(/群消息接收通过|双向通过/).count(), 0);
    assert.equal(await groupBPanel.getByText(/应用缺少「接收消息」事件订阅/).count(), 0);
    await groupBPanel.getByRole('button', { name: '排查普通消息', exact: true }).click();
    await groupBPanel.getByText(/应用缺少「接收群聊中所有消息」权限/).waitFor();
    assert.equal(await groupBPanel.getByText(/应用缺少「接收消息」事件订阅/).count(), 0);
    assert.equal((await feishu(host, 'sent')).diagnoses, 2);
    await feishu(host, 'unknown-diagnosis');
    await groupBPanel.getByRole('button', { name: '排查普通消息', exact: true }).click();
    await groupBPanel.getByText('暂时无法确认原因。请核对长连接、事件订阅和已发布的应用版本。', { exact: true }).waitFor();
    assert.equal(await groupBPanel.getByText(/应用缺少/).count(), 0);
    console.log('PASS browser connected settings navigation, scoped plain and mention evidence, and on-demand diagnosis');
  }
  console.log('PASS Web task → Feishu question and answer → same Web result; native transcript, dedupe and two-group isolation');

  await feishu(host, 'fail-send', { fail: true });
  await prompt(host, bSession, 'FEISHU_SMOKE_DELIVERY_FAIL');
  const error = await wait(async () => (await status(host, b)).error, 'safe delivery error');
  assert.ok(error && !error.includes(fixtureCredentials.appSecret));
  await groupBPanel?.getByText(error, { exact: true }).waitFor({ timeout: 10000 });
  await feishu(host, 'fail-send', { fail: false });
  await feishu(host, 'connection', { connection: 'reconnecting' });
  assert.equal((await status(host, b)).connection, 'reconnecting');
  if (ui) {
    await ui.page.getByText('正在重连', { exact: true }).waitFor({ timeout: 10000 });
    await ui.page.getByRole('button', { name: '← 我的 Bot', exact: true }).click();
    await openSettings(ui.page);
    await ui.page.getByText('凭证有效 · 本人已绑定', { exact: true }).waitFor();
    await ui.page.getByText('长连接 · 正在重连', { exact: true }).filter({ visible: true }).waitFor();
  }
  await ui?.browser.close();
  ui = undefined;
  const missed = Date.now();
  await receive(host, groupB, 'FEISHU_SMOKE_DURING_DISCONNECT');
  await delay(50);
  await feishu(host, 'connection', { connection: 'reconnected' });
  await receive(host, groupB, 'FEISHU_SMOKE_OFFLINE_BACKLOG', { createdAt: missed });
  await receive(host, groupB, 'FEISHU_SMOKE_RECONNECTED');
  await hasSent(host, groupB, '已收到 FEISHU_SMOKE_RECONNECTED');
  assert.equal((await sent(host, groupB, 'DISCONNECT')).length, 0);
  assert.equal((await sent(host, groupB, 'OFFLINE_BACKLOG')).length, 0);

  await stop(primary);
  await writeLegacy(primary, alternateCredentials);
  host = await launch(primary, 'restart');
  const afterRestart = await settings(host);
  assert.equal(afterRestart.appId, fixtureCredentials.appId);
  assert.equal(afterRestart.ownerOpenId, fixtureCredentials.ownerOpenId);
  assert.equal(afterRestart.hasSecret, true);
  assert.equal(afterRestart.connection, 'ready');
  assert.equal(afterRestart.privateTest, 'passed');
  assert.ok(await readFile(settingsFile(primary), 'utf8') === savedFile, 'New settings take precedence over the legacy file');
  ui = await launchBrowser(host);
  if (ui) {
    const { appId, secret } = await openSettings(ui.page);
    await ui.page.getByText('凭证有效 · 本人已绑定', { exact: true }).waitFor();
    const owner = ui.page.getByText(fixtureCredentials.ownerOpenId, { exact: true });
    const privateStatus = ui.page.getByText('私聊收发通过', { exact: true });
    assert.equal(await owner.isVisible(), false);
    assert.equal(await privateStatus.isVisible(), false);
    await ui.page.getByText('连接详情', { exact: true }).click();
    await owner.waitFor();
    await privateStatus.waitFor();
    await ui.page.getByText('连接就绪', { exact: true }).waitFor();
    await ui.page.getByText('连接详情', { exact: true }).click();
    await ui.page.getByRole('button', { name: '编辑凭证', exact: true }).click();
    assert.equal(await appId.inputValue(), fixtureCredentials.appId);
    assert.equal(await secret.inputValue(), '');
    assertNoSecret(await ui.page.locator('body').innerText());
    await ui.page.getByRole('button', { name: '取消编辑', exact: true }).click();
    await ui.page.getByRole('button', { name: '← 我的 Bot', exact: true }).click();
    groupBPanel = await openFeishu(ui, b);
    await groupBPanel.getByText('@ 消息可用，普通消息仍未验证', { exact: true }).waitFor();
    console.log('PASS browser homepage settings detection, save and reload without returning App Secret');
  } else groupBPanel = undefined;
  assert.equal((await status(host, a)).binding.id, groupA.id);
  assert.equal((await status(host, b)).binding.id, groupB.id);
  await receive(host, groupA, answer, { messageId: answerId });
  await receive(host, groupB, 'FEISHU_SMOKE_RESTART_BACKLOG', { createdAt: missed });
  await receive(host, groupB, 'FEISHU_SMOKE_RESTARTED');
  await hasSent(host, groupB, '已收到 FEISHU_SMOKE_RESTARTED');
  assert.equal((await sent(host, groupB, 'RESTART_BACKLOG')).length, 0);
  const afterReconnect = (await events(host, aSession)).filter(feishuInput);
  assert.equal(afterReconnect.length, 2);
  assert.equal(afterReconnect.filter(event => event.data.source.feishuMessageId === answerId).length, 1);
  const restoredDetail = await call(host, 'task.detail', { id: patchedDelivery.taskId, sessionId: aSession });
  assert.deepEqual(restoredDetail.deliveredResult, patchedDelivery);
  assert.equal(restoredDetail.chatDelivery.state, 'delivered');
  assert.equal((await sent(host, groupA, artifactDeliveryText)).length, 0);

  await feishu(host, 'connection', { connection: 'reconnecting' });
  if (groupBPanel) {
    await groupBPanel.getByText('正在重连', { exact: true }).waitFor();
    await groupBPanel.getByRole('button', { name: '解绑', exact: true }).click();
    await groupBPanel.getByRole('button', { name: '确认解绑', exact: true }).click();
    await groupBPanel.getByRole('link', { name: '在飞书打开群', exact: true }).waitFor({ state: 'hidden' });
  } else await call(host, 'feishu.unbind', { botId: b.id, bindingId: groupB.id });
  assert.equal((await status(host, b)).binding, null);
  assert.equal((await status(host, b)).evidence, null);
  const stale = Date.now();
  await receive(host, groupB, 'FEISHU_SMOKE_UNBOUND', { receiptKind: 'bot-mention' });
  await delay(50);
  await feishu(host, 'connection', { connection: 'reconnected' });
  if (groupBPanel) {
    await groupBPanel.getByRole('button', { name: '绑定已有群', exact: true }).click();
    await groupBPanel.getByLabel('已有群的群 ID').fill(groupB.chatId);
    await groupBPanel.getByRole('button', { name: '预览群名称', exact: true }).click();
    await groupBPanel.getByRole('button', { name: '确认绑定', exact: true }).click();
    await groupBPanel.getByText('等待普通消息…', { exact: true }).waitFor();
    assert.equal(await groupBPanel.getByText(/群消息接收通过|@ 消息可用|应用缺少|暂时无法确认原因/).count(), 0);
  } else {
    const next = await call(host, 'feishu.preview', { botId: b.id, chatId: groupB.chatId });
    await call(host, 'feishu.bind', { botId: b.id, confirmationToken: next.confirmationToken });
  }
  const rebound = (await status(host, b)).binding;
  assert.notEqual(rebound.id, groupB.id);
  assert.equal((await rpc(host, 'feishu.unbind', { botId: b.id, bindingId: groupB.id })).ok, false);
  await receive(host, rebound, 'FEISHU_SMOKE_OLD_BINDING', { createdAt: stale, receiptKind: 'bot-mention' });
  assert.deepEqual((await status(host, b)).evidence, { plainTextAt: null, botMentionAt: null });
  await receive(host, rebound, 'FEISHU_SMOKE_REBOUND', { receiptKind: 'plain' });
  await hasSent(host, rebound, '已收到 FEISHU_SMOKE_REBOUND');
  assert.equal((await sent(host, rebound, 'UNBOUND')).length, 0);
  assert.equal((await sent(host, rebound, 'OLD_BINDING')).length, 0);
  if (groupBPanel) {
    await groupBPanel.getByText('群消息接收通过（无需 @）', { exact: true }).waitFor();
    assert.equal(await groupBPanel.getByText('已收到 @ 机器人的消息', { exact: true }).count(), 0);
    await ui.browser.close();
    ui = undefined;
  }

  const current = await wait(async () => {
    const view = await settings(host);
    return view.credentials === 'passed' && view;
  }, 'existing credentials verified after restart');
  const beforeSwitch = await transportStats(host);
  assert.equal((await settingsRpc(host, 'save', {
    appId: current.appId, configurationId: current.configurationId, ownerOpenId: alternateCredentials.ownerOpenId,
  })).error.code, 'feishu-settings-input');
  assert.equal((await settingsRpc(host, 'save', {
    appId: alternateCredentials.appId, configurationId: current.configurationId,
  })).error.code, 'feishu-settings-input');
  assert.deepEqual(await settings(host), current);
  assert.deepEqual(await transportStats(host), beforeSwitch);
  await settings(host, 'save', { appId: current.appId, configurationId: current.configurationId });
  assert.equal((await status(host, a)).binding.id, groupA.id);
  assert.deepEqual(await transportStats(host), beforeSwitch, 'Saving the same credentials does not reconnect or request a new token');

  const switched = await settings(host, 'save', { ...credentials(alternateCredentials), configurationId: current.configurationId });
  assert.equal(switched.connection, 'ready');
  assert.equal(switched.selfBinding, 'unbound');
  assert.equal(switched.privateTest, 'untested');
  assert.equal(switched.ownerOpenId, '');
  assert.equal((await status(host, a)).binding, null);
  assert.equal((await status(host, b)).binding, null);
  await wait(async () => (await settings(host)).credentials === 'passed', 'fresh verification after switching apps');
  assert.deepEqual(await transportStats(host), { ...beforeSwitch, starts: beforeSwitch.starts + 1,
    stops: beforeSwitch.stops + 1, checks: beforeSwitch.checks + 1 });
  const alternateTest = beginFields(switched);
  await settings(host, 'test.start', alternateTest);
  await receivePrivate(host, '原应用的私聊');
  assert.equal((await settings(host, 'test.status', sessionFields(alternateTest))).state, 'waiting');

  const restored = await settings(host, 'save', {
    ...credentials(fixtureCredentials), configurationId: switched.configurationId,
  });
  assert.equal(restored.selfBinding, 'unbound');
  assert.equal((await settingsRpc(host, 'test.status', sessionFields(alternateTest))).error.code, 'feishu-configuration-changed');
  assert.equal((await settingsRpc(host, 'save', {
    ...credentials(alternateCredentials), configurationId: switched.configurationId,
  })).error.code, 'feishu-configuration-changed');
  await bindSelf(host);
  assert.equal((await status(host, a)).binding.id, groupA.id);
  assert.equal((await status(host, b)).binding.id, rebound.id);
  assert.equal(await readFile(patchFile(primary), 'utf8'), patch);

  // Re-create the pre-settings install in this isolated profile using its existing synthetic ledger.
  await stop(primary);
  await unlink(settingsFile(primary));
  await configurePatch(primary, true);
  await writeLegacy(primary, fixtureCredentials);
  host = await launch(primary, 'enabled-legacy');
  assert.equal((await settings(host)).enabled, true);
  assert.equal((await status(host, a)).binding.id, groupA.id);
  assert.equal((await status(host, b)).binding.id, rebound.id);
  assert.ok(JSON.parse(await readFile(settingsFile(primary), 'utf8')).feishu.enabled);

  await stop(secondary);
  await configurePatch(secondary, true);
  await writeLegacy(secondary, fixtureCredentials);
  other = await launch(secondary, 'disabled-legacy-restart');
  assert.deepEqual({ ...await settings(other), configurationId: imported.configurationId }, imported);
  assert.equal((await transportStats(other)).starts, 0);
  await stop(secondary);
  await chmod(settingsFile(secondary), 0o644);
  other = await launch(secondary, 'bad-permissions');
  assert.match((await settings(other)).error, /设置|凭证/);
  assert.notEqual((await status(other, c)).connection, 'ready');
  assert.equal((await feishu(other, 'sent')).starts, 0);
  assert.equal((await status(host, b)).connection, 'ready');
  if (process.env.SUPER_BOT_TEST_BROWSER) {
    const emptyName = 'feishu-navigation';
    await configure(emptyName);
    await configurePatch(emptyName, true);
    await writeLegacy(emptyName, fixtureCredentials);
    const empty = await launch(emptyName, 'single-bot-navigation');
    ui = await launchBrowser(empty);
    const page = ui.page;
    await openSettings(page);
    await page.getByText('凭证有效 · 本人已绑定', { exact: true }).waitFor();
    const privateStatus = page.getByText('私聊收发未测试', { exact: true });
    assert.equal(await privateStatus.isVisible(), false);
    await page.getByText('连接详情', { exact: true }).click();
    await privateStatus.waitFor();
    await page.getByRole('button', { name: '新建 Bot', exact: true }).click();
    await page.getByRole('heading', { name: '创建你的第一个 Bot', exact: true }).waitFor();
    const name = '合成验证入口 Bot';
    await page.getByLabel('给它起个名字').fill(name);
    await page.getByRole('button', { name: '创建并聊天', exact: true }).click();
    await page.getByRole('button', { name: '打开或收起当前 Bot 的工作', exact: true }).waitFor();
    await openSettings(page);
    await page.getByRole('button', { name: '去验证群同步', exact: true }).click();
    await page.getByRole('heading', { name, exact: true, level: 1 }).waitFor();
    await page.getByRole('heading', { name: '飞书群', exact: true }).waitFor();
    assert.equal(await page.getByLabel('选择要验证的 Bot', { exact: true }).count(), 0);
    await ui.browser.close();
    ui = undefined;
    console.log('PASS browser first Bot creation, one-Bot direct navigation and legacy identity details');
  }
  console.log(`PASS profile isolation, both legacy modes, application isolation, group retention, reconnect, restart and rebind (evidence ${base})`);
} catch (error) {
  if (ui) {
    await writeFile(join(base, 'browser-visible.txt'), await ui.page.locator('body').innerText()).catch(() => {});
    await ui.page.screenshot({ path: join(base, 'browser-failure.png') }).catch(() => {});
  }
  console.error(`Isolated smoke evidence: ${base}`);
  throw error;
} finally {
  await ui?.browser.close();
  await Promise.all([...children.keys()].map(stop));
}
