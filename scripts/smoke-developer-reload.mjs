// Run through smoke-mirror so both launchers use the same isolated fixture as the chat tests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function smokeDeveloperReload({ root, base, bundle, roles, configure, launch, rpc, call, makeBot, newTask, probe, wait }) {
  const { SUPER_BOT_TEST_PLAYWRIGHT: playwright, SUPER_BOT_TEST_BROWSER: executablePath } = process.env;
  assert.ok(playwright && executablePath, 'Set the Playwright module and Chromium executable paths');
  const { chromium } = await import(pathToFileURL(playwright));
  const browser = await chromium.launch({ executablePath });
  const proof = [];
  async function start(role) {
    const { profile, home } = roles[role];
    await mkdir(profile, { recursive: true });
    const link = execFileSync(process.execPath, [join(root, 'scripts/dev-profile-package.mjs'), role], {
      env: { ...process.env, DSH_HOME: home }, encoding: 'utf8',
    }).trim();
    assert.ok(link.startsWith('link:'));
    const bundleDir = link.slice(5);
    await configure(role, { bundleDir, probeModule: join(bundle, 'lib/probe.js') });
    const host = await launch(role, 'developer-reload');
    assert.equal((await rpc(host, 'developer.reload', { requestId: randomUUID() })).error.code, 'disabled');
    const bot = await makeBot(host, '开发重载测试'), task = await newTask(host, bot, '保持原聊天与任务');
    const page = await browser.newPage();
    await page.goto(host.launchUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 5000 }).catch(() => {});
    await page.getByRole('button', { name: 'Super Bot', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel('启用本端插件开发').click();
    await page.getByRole('button', { name: /重载本端 Super Bot/ }).waitFor();
    return { role, host, page, bot, task, client: join(bundleDir, 'lib/client.js') };
  }
  try {
    const web = await start('web'), desktop = await start('desktop');
    const task = await call(desktop.host, 'task.create', { requestId: randomUUID(), botId: desktop.bot.id,
      goal: 'RELIABILITY_HOLD', scope: '合成任务', acceptance: '核对执行收敛', reviewPolicy: 'human' });
    const worker = await call(desktop.host, 'session.prepare', { requestId: randomUUID(), id: task.id, expectedRowVersion: task.rowVersion });
    await probe(desktop.host, 'select-test-model', worker.sessionId);
    const beforeDispatch = await call(desktop.host, 'task.detail', { id: task.id });
    await call(desktop.host, 'task.dispatch', { requestId: randomUUID(), id: task.id, expectedRowVersion: beforeDispatch.task.rowVersion });
    const inspect = () => probe(desktop.host, 'inspect-session', worker.sessionId);
    await wait(async () => (await inspect()).stalled, 'synthetic Worker turn');
    await desktop.page.getByRole('button', { name: /重载本端 Super Bot/ }).click();
    await desktop.page.getByText(/重载失败：busy.*Worker/).waitFor();
    for (const [target, peer] of [[web, desktop], [web, desktop], [desktop, web], [desktop, web]]) {
      const { role, host, page, bot, task } = target;
      if (role === 'desktop' && (await inspect()).stalled) {
        await probe(host, 'release-stalled-model', worker.sessionId);
        await wait(async () => (await inspect()).status === 'idle', 'Worker completed its original turn');
      }
      const digest = async () => createHash('sha256').update(await readFile(peer.client)).digest('hex');
      const before = await digest(), prior = await call(host, 'developer.get');
      await page.getByRole('button', { name: /重载本端 Super Bot/ }).click();
      const job = await wait(async () => {
        const state = await call(host, 'developer.get').catch(() => undefined), op = state?.operation;
        if (!op || op.id === prior.operation?.id || op.state === 'running') return;
        assert.equal(op.state, 'applied', op.message);
        assert.equal(op.id, state.build);
        return op;
      }, role + ' host receipt');
      await page.getByText('已重载本端 Super Bot · ' + job.id.slice(0, 8), { exact: true }).waitFor();
      assert.equal(await digest(), before);
      if (role === 'web') assert.equal((await inspect()).stalled, true);
      assert.equal((await call(host, 'bot.for-session', { sessionId: bot.managerId })).id, bot.id);
      assert.equal((await call(host, 'task.detail', { id: task.id })).task.goal, task.goal);
      proof.push({ role, pid: host.pid, build: job.id, session: bot.managerId, task: task.id });
    }
    await writeFile(join(base, 'proof.json'), JSON.stringify(proof, null, 2));
    console.log('PASS Web and Desktop Host: two consecutive window receipts per profile, peer bundle and session/task continuity');
  } finally { await browser.close(); }
}
