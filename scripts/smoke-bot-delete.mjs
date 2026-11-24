// Run against a fresh, disposable DSH Web profile and ledger. Only synthetic Bots are deleted.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { hostClient } from './host-client.mjs';

const log = process.argv[2];
const { SUPER_BOT_TEST_PLAYWRIGHT: playwright, SUPER_BOT_TEST_BROWSER: executablePath } = process.env;
assert.ok(log && playwright && executablePath, 'Pass a fresh isolated host log and the Playwright/browser paths.');
const host = await hostClient(log);
const url = (await readFile(log, 'utf8')).match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/)?.[1];
assert.ok(url && new URL(url).origin === host.base, 'Use the isolated host launch link.');

async function call(action, payload = {}) {
  const response = await host.post('/api/super-bot', {
    type: 'client-request', rpcId: randomUUID(), method: 'super-bot', payload: { action, ...payload },
  });
  assert.equal(response.status, 200, action);
  const { result } = await response.json();
  assert.ok(result.ok, `${action}: ${JSON.stringify(result)}`);
  return result.value;
}
assert.deepEqual(await call('bot.list'), [], 'Start with a fresh isolated ledger.');

const { chromium } = await import(pathToFileURL(playwright).href);
const browser = await chromium.launch({ executablePath, args: ['--disable-background-networking'] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === host.base ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const button = name => page.getByRole('button', { name, exact: true });
  const heading = name => page.getByRole('heading', { name, exact: true });
  const botRow = name => page.locator('.bot-row').filter({ has: page.getByText(name, { exact: true }) });
  const home = async () => {
    await button('Super Bot').click();
    await heading('你想一起做点什么？').waitFor();
  };
  const settings = async () => {
    await button('设置与维护').click();
    await heading('职责与参考材料').waitFor();
  };
  const chatSettings = async () => {
    await page.getByRole('button', { name: /打开或收起当前 Bot 的工作/ }).click();
    await settings();
  };

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await button('Continue').click({ timeout: 1500 }).catch(() => {});
  await home();
  await heading('创建你的第一个 Bot').waitFor();
  assert.equal(await button('删除 Bot').count(), 0);
  const name = '合成删除样例', otherName = '合成保留样例';
  await page.getByLabel('给它起个名字').fill(name);
  await button('创建并聊天').click();
  await chatSettings();
  await button('删除 Bot').click();
  await page.getByText(new RegExp(`删除「${name}」`)).waitFor();
  // Let multiple genuine Workspace polls replace the settings' Bot object.
  await page.waitForTimeout(10500);
  assert.equal(await heading('职责与参考材料').count(), 1);
  assert.equal(await heading('飞书群').count(), 1);
  await button('确认删除 Bot').waitFor();
  await button('返回').click();
  const [bot] = await call('bot.list');
  assert.equal(bot.name, name);
  assert.equal((await call('bot.for-session', { sessionId: bot.managerSessionId })).id, bot.id);
  await button('← 返回聊天').click();

  const other = await call('bot.create', { requestId: randomUUID(), name: otherName, instructions: '仅用于隔离测试' });
  await home();
  await botRow(name).getByRole('button', { name: '工作', exact: true }).click();
  await settings();
  await button('删除 Bot').click();
  await page.getByLabel('选择 Bot').selectOption(other.id);
  await heading(otherName).first().waitFor();
  assert.equal(await button('确认删除 Bot').count(), 0);
  await page.getByLabel('选择 Bot').selectOption(bot.id);
  assert.equal(await button('确认删除 Bot').count(), 0);

  await button('返回这个 Bot 聊天 →').click();
  await chatSettings();
  await button('删除 Bot').click();
  const task = await call('task.create', {
    requestId: randomUUID(), botId: bot.id, goal: '合成未结束任务', scope: '仅测试', acceptance: '手动确认', startPaused: true,
    reviewPolicy: 'human',
  });
  await button('确认删除 Bot').click();
  await page.getByRole('alert').filter({ hasText: '未结束或待核对的任务' }).waitFor();
  await button('强制删除 Bot').click();
  await page.getByText(new RegExp(`强制删除「${name}」.*1 项未结束任务.*请求停止`)).waitFor();
  await button('返回').click();
  assert.equal((await call('task.detail', { id: task.id })).task.lifecycle, 'open');
  await button('强制删除 Bot').click();
  await button('确认强制删除 Bot').click();
  await heading('你想一起做点什么？').waitFor();
  await botRow(otherName).waitFor();
  assert.deepEqual((await call('bot.list')).map(bot => bot.id), [other.id]);
  assert.equal(await call('bot.for-session', { sessionId: bot.managerSessionId }), null);
  assert.equal((await call('task.detail', { id: task.id })).task.lifecycle, 'cancelled');

  await botRow(otherName).getByRole('button', { name: '工作', exact: true }).click();
  await settings();
  await button('删除 Bot').click();
  await button('确认删除 Bot').click();
  await heading('创建你的第一个 Bot').waitFor();
  assert.deepEqual(await call('bot.list'), []);
  console.log('PASS DSH Web delete confirmation, cancel, polling, Bot switch, late blocker, force, surviving Bot, and empty home');
} finally {
  await browser.close();
}
