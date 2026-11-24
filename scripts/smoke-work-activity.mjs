// Both actual Host launchers, synthetic Workers and browser-rendered plugin slots.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function smokeWorkActivity({ configure, launch, call, makeBot, probe, wait }) {
  const { chromium } = await import(pathToFileURL(process.env.SUPER_BOT_TEST_PLAYWRIGHT));
  const browser = await chromium.launch({ executablePath: process.env.SUPER_BOT_TEST_BROWSER });
  try {
    for (const role of ['web', 'desktop']) {
      await configure(role, { hmr: false });
      const host = await launch(role, 'work-activity');
      const bot = await makeBot(host, '工作状态验收');
      const other = await makeBot(host, '另一个 Bot');
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      page.setDefaultTimeout(15000);
      await page.goto(host.launchUrl, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 1800 }).catch(() => {});
      const nav = page.getByRole('navigation', { name: 'Bot', exact: true });
      const row = label => nav.getByRole('button', { name: [bot.name, label].filter(Boolean).join(' · '), exact: true });
      const header = label => page.getByRole('button', { name: ['打开或收起当前 Bot 的工作', label].filter(Boolean).join(' · '), exact: true });
      await row('').click();
      await header('').waitFor();
      async function dispatch(goal) {
        const task = await call(host, 'task.create', { requestId: randomUUID(), botId: bot.id, goal, scope: 'Own files',
          acceptance: 'Read result.md', reviewPolicy: 'human' });
        const binding = await call(host, 'session.prepare', { requestId: randomUUID(), id: task.id, expectedRowVersion: task.rowVersion });
        await probe(host, 'select-test-model', binding.sessionId);
        const { task: current } = await call(host, 'task.detail', { id: task.id });
        await call(host, 'task.dispatch', { requestId: randomUUID(), id: task.id, expectedRowVersion: current.rowVersion });
        return { id: task.id, worker: binding.sessionId };
      }
      const held = await dispatch('RELIABILITY_HOLD');
      await wait(async () => (await probe(host, 'inspect-session', held.worker)).stalled, 'held Worker');
      await header('进行中').waitFor();
      await nav.getByRole('button', { name: other.name, exact: true }).click();
      await header('').waitFor();
      const ask = await dispatch('ASK_PROBE');
      await row('等你处理').waitFor();
      await header('').waitFor();
      await row('等你处理').click();
      await header('等你处理').click();
      const sections = page.locator('.inbox-group');
      await sections.filter({ hasText: '请说明文档面向谁？' }).waitFor();
      assert.deepEqual((await sections.locator('h3').allTextContents()).slice(0, 2), ['进行中', '等你处理']);
      await sections.getByRole('button', { name: /ASK_PROBE/ }).click();
      await page.getByRole('textbox', { name: '回答', exact: true }).fill('面向新同事。');
      await page.getByRole('button', { name: '保存回答' }).click();
      await header('进行中').waitFor();
      await row('进行中').waitFor();
      await probe(host, 'select-test-model', bot.managerId);
      await probe(host, 'release-stalled-model', held.worker);
      for (const { id } of [ask, held]) {
        const detail = await wait(async () => {
          const d = await call(host, 'task.detail', { id });
          return d.chatDelivery?.state === 'delivered' && d;
        }, 'reviewed result delivered', 600);
        await header('等你处理').waitFor();
        await call(host, 'result.accept', { requestId: randomUUID(), id, resultId: detail.result.id,
          expectedRowVersion: detail.task.rowVersion });
      }
      await row('').waitFor();
      await header('').waitFor();
      await call(host, 'sidebar.pin', { botId: bot.id, sessionId: bot.managerId });
      await call(host, 'task.create', { requestId: randomUUID(), botId: bot.id, goal: 'Clarify scope',
        scope: '', acceptance: 'Confirm scope', reviewPolicy: 'human' });
      await row('等你处理').waitFor();
      await page.getByRole('button', { name: '切换到 Workspace', exact: true }).click();
      const native = page.locator('[data-slot="sidebar.session.row.trailing"]');
      await native.locator('[title="等你处理"]').first().waitFor();
      const markedRows = await native.locator('[title="等你处理"]').evaluateAll(badges =>
        badges.map(badge => badge.closest('[data-row-key]')?.getAttribute('data-row-key')));
      assert.deepEqual([...new Set(markedRows)], ['session:' + bot.managerId]);
      await page.close();
      console.log(role + ': switched chats, running → question → answer → delivered → accepted; panel order and badges verified.');
    }
  } finally { await browser.close(); }
}
