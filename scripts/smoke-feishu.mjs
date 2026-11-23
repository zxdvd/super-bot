// Real DSH profiles and deterministic model. Only the Feishu SDK transport is stubbed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { authenticateHost } from './host-client.mjs';
import { existingGroup, fixtureCredentials } from '../test/feishu-host-transport.ts';

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
const credentials = name => join(profile(name), 'super-bot.feishu.json');
async function configure(name, enabled) {
  const dir = profile(name), data = join(home, 'super-bot', name);
  await mkdir(join(dir, 'node_modules/@zxdvd'), { recursive: true });
  await linkAlternateDSH(dir);
  await symlink(bundle, join(dir, 'node_modules/@zxdvd/super-bot'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `super-bot-${name}`, private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@zxdvd/super-bot'] } } }));
  await configurePatch(name, enabled, data);
  await writeFile(credentials(name), JSON.stringify(fixtureCredentials), { mode: 0o600 });
}
async function configurePatch(name, enabled, data = join(home, 'super-bot', name)) {
  await writeFile(join(profile(name), 'cordis.patch.yml'), JSON.stringify([
    { id: 'hmr', disabled: true },
    { id: 'super-bot', config: { dataDir: data, fullAccess: false, ...(enabled ? { feishu: { enabled: true } } : {}) } },
    { insert: [{ id: 'super-bot-contract-probe', name: '@zxdvd/super-bot/feishu-probe-model' }] },
  ]));
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
  assert.ok(!(await readFile(state.path, 'utf8')).includes(fixtureCredentials.appSecret), 'No credential in host logs');
  children.delete(name);
}

const productPath = '/api/super-bot';
const commandBody = (action, data) => ({ type: 'client-request', rpcId: randomUUID(), method: 'super-bot', payload: { action, ...data } });
async function rpc(client, action, args, headers) {
  const response = await client.post(productPath, commandBody(action, args), headers);
  assert.equal(response.status, 200, `Owner RPC ${action} (see ${base})`);
  const body = await response.text();
  assert.ok(!body.includes(fixtureCredentials.appSecret));
  assert.ok(!body.includes(fixtureCredentials.ownerOpenId));
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
    await page.goto(host.url, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 1500 }).catch(() => {});
    return { browser, page };
  } catch (error) { await browser.close(); throw error; }
}
async function openBotRow(page, bot) {
  await page.getByRole('button', { name: 'Super Bot', exact: true }).click({ timeout: 15000 });
  return page.locator('.bot-row').filter({ hasText: bot.name });
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

let ui;

try {
  await Promise.all([configure(primary, true), configure(secondary, false)]);
  let [host, other] = await Promise.all([launch(primary, 'first'), launch(secondary, 'disabled')]);
  const a = await bot(host, '合成 Bot A'), b = await bot(host, '合成 Bot B'), c = await bot(other, '默认关闭的 Bot');
  const aSession = await manager(host, a), bSession = await manager(host, b);
  assert.equal((await feishu(host, 'sent')).starts, 1);
  assert.equal((await status(other, c)).connection, 'disabled');
  assert.equal((await feishu(other, 'sent')).starts, 0);
  assert.equal((await rpc(other, 'feishu.create', { botId: c.id, name: '未启用', requestId: randomUUID() })).ok, false);

  const body = commandBody('feishu.status', { botId: a.id });
  const denied = await fetch(host.base + productPath, { redirect: 'manual', method: 'POST',
    headers: { origin: host.base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.notEqual(denied.status, 200);
  assert.notEqual((await host.post(productPath, body, { origin: 'http://127.0.0.1:4' })).status, 200);
  assert.equal((await rpc(host, 'feishu.status', { botId: a.id, owner: 'desktop' })).ok, false);
  assert.equal((await rpc(host, 'feishu.status', { botId: c.id })).ok, false);

  ui = await launchBrowser(host);
  const create = { botId: a.id, name: '飞书合成私有群', requestId: randomUUID() };
  if (ui) {
    const section = await openFeishu(ui, a);
    await section.getByRole('button', { name: '新建私有群', exact: true }).click();
    await section.getByLabel('私有群名称').fill(create.name);
    await section.getByRole('button', { name: '创建并绑定', exact: true }).click();
    await section.getByRole('link', { name: '在飞书打开群', exact: true }).waitFor();
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
  const unbound = await bot(host, '合成未绑定 Bot');
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
  await receive(host, groupA, answer, { senderOpenId: 'ou_fixtureOther' });
  await receive(host, groupA, answer, { createdAt: groupA.boundAt - 1 });
  assert.equal((await detail()).pendingQuestions[0].id, before.pendingQuestions[0].id);
  const answerId = 'om_fixtureAnswer';
  await receive(host, groupA, answer, { messageId: answerId });
  await receive(host, groupA, answer, { messageId: answerId });
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
  assert.equal((await sent(host, groupA, answer)).length, 0, 'Feishu input has no echo');
  await wait(async () => (await model(host, 'inspect-session', { sessionId: aSession })).assistantTexts
    .some(text => text.includes(ready.result.id)), 'result linked from original native chat');
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

  const bMarker = 'FEISHU_SMOKE_GROUP_B';
  await receive(host, groupB, bMarker);
  await hasSent(host, groupB, `已收到 ${bMarker}`);
  assert.equal((await sent(host, groupA, bMarker)).length, 0);
  assert.ok((await events(host, bSession)).some(item => item.type === 'user/message' && item.data.content[0].text === bMarker));
  assert.equal((await call(host, 'task.list', { botId: b.id })).total, 0);
  console.log('PASS Web task → Feishu question and answer → same Web result; native transcript, dedupe and two-group isolation');

  await feishu(host, 'fail-send', { fail: true });
  await prompt(host, bSession, 'FEISHU_SMOKE_DELIVERY_FAIL');
  const error = await wait(async () => (await status(host, b)).error, 'safe delivery error');
  assert.ok(error && !error.includes(fixtureCredentials.appSecret));
  if (ui) {
    const section = await openFeishu(ui, b);
    await section.getByText(error, { exact: true }).waitFor({ timeout: 10000 });
  }
  await feishu(host, 'fail-send', { fail: false });
  await feishu(host, 'connection', { connection: 'reconnecting' });
  assert.equal((await status(host, b)).connection, 'reconnecting');
  if (ui) await ui.page.getByText('正在重连', { exact: true }).waitFor({ timeout: 10000 });
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
  host = await launch(primary, 'restart');
  assert.equal((await status(host, a)).binding.id, groupA.id);
  assert.equal((await status(host, b)).binding.id, groupB.id);
  await receive(host, groupA, answer, { messageId: answerId });
  await receive(host, groupB, 'FEISHU_SMOKE_RESTART_BACKLOG', { createdAt: missed });
  await receive(host, groupB, 'FEISHU_SMOKE_RESTARTED');
  await hasSent(host, groupB, '已收到 FEISHU_SMOKE_RESTARTED');
  assert.equal((await sent(host, groupB, 'RESTART_BACKLOG')).length, 0);
  assert.equal((await events(host, aSession)).filter(feishuInput).length, 1);

  await feishu(host, 'connection', { connection: 'reconnecting' });
  assert.equal((await call(host, 'feishu.unbind', { botId: b.id, bindingId: groupB.id })).binding, null);
  const stale = Date.now();
  await receive(host, groupB, 'FEISHU_SMOKE_UNBOUND');
  await delay(50);
  await feishu(host, 'connection', { connection: 'reconnected' });
  const next = await call(host, 'feishu.preview', { botId: b.id, chatId: groupB.chatId });
  const rebound = (await call(host, 'feishu.bind', { botId: b.id, confirmationToken: next.confirmationToken })).binding;
  assert.notEqual(rebound.id, groupB.id);
  assert.equal((await rpc(host, 'feishu.unbind', { botId: b.id, bindingId: groupB.id })).ok, false);
  await receive(host, rebound, 'FEISHU_SMOKE_OLD_BINDING', { createdAt: stale });
  await receive(host, rebound, 'FEISHU_SMOKE_REBOUND');
  await hasSent(host, rebound, '已收到 FEISHU_SMOKE_REBOUND');
  assert.equal((await sent(host, rebound, 'UNBOUND')).length, 0);
  assert.equal((await sent(host, rebound, 'OLD_BINDING')).length, 0);

  await stop(secondary);
  await configurePatch(secondary, true);
  await chmod(credentials(secondary), 0o644);
  other = await launch(secondary, 'bad-permissions');
  assert.match((await status(other, c)).error, /凭证/);
  assert.equal((await status(other, c)).connection, 'offline');
  assert.equal((await feishu(other, 'sent')).starts, 0);
  assert.equal((await status(host, b)).connection, 'ready');
  console.log(`PASS owner-only API, profile isolation, delivery errors, reconnect, restart, and unbind/rebind (evidence ${base})`);
} finally {
  await ui?.browser.close();
  await Promise.all([...children.keys()].map(stop));
}
