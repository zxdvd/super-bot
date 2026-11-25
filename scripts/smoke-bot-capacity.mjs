/** Ordinary Worker admission in a fresh DSH Web profile, using a deterministic local model. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, open, readFile, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { authenticateHost } from './host-client.mjs';

const { SUPER_BOT_TEST_PLAYWRIGHT: playwright, SUPER_BOT_TEST_BROWSER: executablePath } = process.env;
assert.ok(playwright && executablePath && isAbsolute(playwright) && isAbsolute(executablePath),
  'Set absolute paths to Playwright and a Chromium browser');
const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, '.runtime'), { recursive: true });
const base = await mkdtemp(join(root, '.runtime/capacity-smoke-'));
const home = join(base, 'super-bot/.runtime/dsh'), shellHome = join(base, 'os-home');
const profile = join(home, 'profiles', 'worker-capacity'), dataDir = join(home, 'super-bot/capacity');
const bundle = join(base, 'bundle'), lib = join(bundle, 'lib');
const hostLog = join(base, 'host.log');
const env = { PATH: process.env.PATH, HOME: shellHome, DSH_HOME: home, TMPDIR: shellHome, DSH_TELEMETRY_DISABLED: '1' };
await Promise.all([
  mkdir(join(profile, 'node_modules/@zxdvd'), { recursive: true }),
  mkdir(lib, { recursive: true }),
  mkdir(shellHome),
]);
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
manifest.exports['./capacity-probe-model'] = './lib/model.js';
await Promise.all([
  writeFile(join(bundle, 'package.json'), JSON.stringify(manifest)),
  copyFile(join(root, 'cordis.patch.yml'), join(bundle, 'cordis.patch.yml')),
  symlink(bundle, join(profile, 'node_modules/@zxdvd/super-bot')),
  writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'super-bot-capacity-smoke', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@zxdvd/super-bot'] } } })),
  writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'hmr', disabled: true },
    // Old profiles may still contain this key. It must not constrain any Bot.
    { id: 'super-bot', config: { dataDir, fullAccess: false, maxRunningTasks: 1 } },
    { insert: [{ id: 'super-bot-contract-probe', name: '@zxdvd/super-bot/capacity-probe-model' }] },
  ])),
]);
const building = spawn(process.execPath, ['scripts/build.mjs'], {
  cwd: root, env: { ...env, SUPER_BOT_BUILD_OUTDIR: lib }, stdio: 'inherit',
});
await Promise.all([
  new Promise((resolve, reject) => {
    building.once('error', reject);
    building.once('close', code => code === 0 ? resolve() : reject(Error('Isolated build failed')));
  }),
  build({ absWorkingDir: root, bundle: true, entryPoints: ['test/host-probe.ts'], platform: 'node',
    format: 'esm', packages: 'external', outfile: join(lib, 'model.js') }),
]);

async function wait(query, label) {
  for (let i = 0; i < 230; i++) {
    const value = await query();
    if (value) return value;
    await delay(100);
  }
  assert.fail(`Timed out: ${label} (see ${base})`);
}
const cli = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const log = await open(hostLog, 'wx', 0o600);
const child = spawn(process.execPath, [cli, '--profile', 'worker-capacity', '--host', '127.0.0.1', '--no-open', '--port', '0'],
  { cwd: root, env, stdio: ['ignore', log.fd, log.fd] });
let exited = false, spawnError, browser;
const exit = new Promise(resolve => {
  child.once('error', error => { spawnError = error; });
  child.once('close', () => { exited = true; resolve(); });
});

try {
  const url = await wait(async () => {
    assert.ok(!spawnError && !exited, `Isolated DSH startup failed (see ${base})`);
    return (await readFile(hostLog, 'utf8')).match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/)?.[1];
  }, 'native Web startup');
  const client = await authenticateHost(url);
  async function rpc(action, payload) {
    const response = await client.post('/api/super-bot', {
      type: 'client-request', rpcId: randomUUID(), method: 'super-bot', payload: { action, ...payload },
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  }
  async function call(action, payload) {
    const result = await rpc(action, payload);
    assert.ok(result.ok, `${action}: ${JSON.stringify(result)}`);
    return result.value;
  }
  async function selectModel(sessionId) {
    const response = await client.post('/api/super-bot-probe', { action: 'select-test-model', sessionId });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  }
  const createBot = name => call('bot.create', { requestId: randomUUID(), name, instructions: '仅处理隔离测试中的合成文档。' });
  const capacity = bot => call('bot.capacity.get', { botId: bot.id });
  const detail = id => call('task.detail', { id });
  const dispatch = (id, expectedRowVersion) => rpc('task.dispatch', { id, expectedRowVersion, requestId: randomUUID() });
  async function prepare(bot, goal) {
    const task = await call('task.create', { requestId: randomUUID(), botId: bot.id, goal,
      scope: '专用任务目录', acceptance: '核对执行状态', reviewPolicy: 'human' });
    const binding = await call('session.prepare', { requestId: randomUUID(), id: task.id, expectedRowVersion: task.rowVersion });
    await selectModel(binding.sessionId);
    return (await detail(task.id)).task;
  }
  const a = await createBot('合成容量 Bot A'), b = await createBot('合成容量 Bot B');
  const slots = [];
  const defaults = { maxRunningTasks: null, botLimit: 5, botHeld: 0 };
  function verifyHeld(states, count) {
    assert.equal(states.length, count);
    assert.ok(states.every(state => state.run?.state === 'running' && state.runHeld && state.input?.state === 'entered'));
    assert.equal(new Set(states.map(state => state.binding.sessionId)).size, count);
  }
  const heldTasks = () => Promise.all(slots.map(task => detail(task.id)));
  const waitForRunning = task => wait(async () => {
    const state = await detail(task.id);
    return state.run?.state === 'running' && state.runHeld && state.input?.state === 'entered' && state;
  }, `Worker input for ${task.goal}`);
  const waitForCapacity = task => wait(async () => {
    const state = await detail(task.id);
    return state.wait?.scope === 'bot' && state.autoDispatchPending && state.run === null;
  }, `Bot capacity wait for ${task.goal}`);
  async function startHeld(bot, suffix) {
    const task = await prepare(bot, `STOP_PROBE ${suffix}`);
    slots.push(task);
    const started = await dispatch(task.id, task.rowVersion);
    assert.ok(started.ok, JSON.stringify(started));
    await waitForRunning(task);
  }
  try {
    assert.deepEqual(await capacity(a), defaults);
    assert.deepEqual(await capacity(b), defaults);
    for (let i = 1; i <= 5; i++) await startHeld(a, `A${i}`);
    const sixth = await prepare(a, 'STOP_PROBE A6');
    assert.equal((await dispatch(sixth.id, sixth.rowVersion)).error.code, 'capacity');
    assert.equal((await detail(sixth.id)).run, null);
    const manager = await call('manager.prepare', { requestId: randomUUID(), botId: a.id });
    await selectModel(manager.sessionId);
    await waitForCapacity(sixth);
    for (let i = 1; i <= 5; i++) await startHeld(b, `B${i}`);
    verifyHeld(await heldTasks(), 10);
    assert.deepEqual(await capacity(a), { ...defaults, botHeld: 5 });
    assert.deepEqual(await capacity(b), { ...defaults, botHeld: 5 });
    await waitForCapacity(sixth);
    slots.push(sixth);

    const { chromium } = await import(pathToFileURL(playwright).href);
    browser = await chromium.launch({ executablePath, env, args: [
      '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    ] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === client.base ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const settings = page.getByRole('button', { name: '设置与维护', exact: true });
    const workerHeading = page.getByRole('heading', { name: 'Worker 并发', exact: true });
    const inputLabel = '同时执行的 Worker 任务上限';
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 1500 }).catch(() => {});
    await page.getByRole('button', { name: 'Super Bot', exact: true }).click();
    await page.locator('.bot-row').filter({ hasText: a.name }).locator('.bot-open').click();
    await page.getByRole('button', { name: /打开或收起当前 Bot 的工作/ }).click();
    await settings.click();
    const section = page.locator('.sb-section').filter({ has: workerHeading });
    const input = section.getByLabel(inputLabel, { exact: true });
    const save = section.getByRole('button', { name: '保存 Worker 上限', exact: true });
    const saved = section.getByText('已保存 Worker 上限。', { exact: true });
    assert.equal(await input.inputValue(), '');
    await section.getByText('5/5', { exact: true }).waitFor();
    assert.doesNotMatch(await section.innerText(), /宿主共享/);
    await input.fill('6');
    // Let at least two normal Workspace polls pass with a live draft in the chat sidebar.
    await page.waitForTimeout(10500);
    assert.equal(await workerHeading.count(), 1);
    assert.equal(await page.getByRole('heading', { name: '飞书群', exact: true }).count(), 1);
    assert.equal(await page.getByLabel(inputLabel, { exact: true }).count(), 1);
    assert.equal(await input.inputValue(), '6');
    await save.click();
    await saved.waitFor();
    assert.equal((await capacity(a)).maxRunningTasks, 6);
    await waitForRunning(sixth);
    await section.getByText('6/6', { exact: true }).waitFor();
    await input.fill('');
    await save.click();
    await saved.waitFor();
    await section.getByText('6/5', { exact: true }).waitFor();
    assert.deepEqual(await capacity(a), { ...defaults, botHeld: 6 });
    assert.deepEqual(await capacity(b), { ...defaults, botHeld: 5 });
    verifyHeld(await heldTasks(), 11);
    await settings.click();
    await workerHeading.waitFor({ state: 'hidden' });
    await settings.click();
    assert.equal(await input.inputValue(), '');
    await section.getByText('6/5', { exact: true }).waitFor();
    assert.equal(await workerHeading.count(), 1);
    console.log(`PASS native Web: two Bots each held five Workers, A6 waited and started after raising A's limit, ` +
      `restoring the default kept eleven Workers, and the chat sidebar kept a single capacity form (evidence ${base})`);
  } finally {
    for (const task of slots) {
      const { task: current, run } = await detail(task.id);
      if (!run || run.finishedAt !== null) continue;
      await call('task.stop', { requestId: randomUUID(), id: current.id, expectedRowVersion: current.rowVersion });
      await wait(async () => (await detail(task.id)).run.state === 'cancelled', 'synthetic Worker cleanup');
    }
  }
} finally {
  try { await browser?.close(); }
  finally {
    if (!exited) child.kill('SIGTERM');
    const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 5000);
    await exit;
    clearTimeout(timer);
    await log.close();
  }
}
