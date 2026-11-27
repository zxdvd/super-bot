// Exercise the sidebar against real, isolated DSH hosts and two paused task bindings.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function smokeBotLocation({ configure, launch, call, makeBot }) {
  const { SUPER_BOT_TEST_PLAYWRIGHT: playwright, SUPER_BOT_TEST_BROWSER: executablePath } =
    process.env;
  assert.ok(playwright && executablePath, 'Set the Playwright and Chromium executable paths');
  const { chromium } = await import(pathToFileURL(playwright));
  const browser = await chromium.launch({
    executablePath,
    args: ['--disable-background-networking'],
  });
  try {
    for (const role of ['web', 'desktop']) {
      await configure(role, { hmr: false });
      const host = await launch(role, 'bot-location');
      async function fixture(name, goal) {
        const bot = await makeBot(host, name);
        const task = await call(host, 'task.create', {
          requestId: randomUUID(),
          botId: bot.id,
          goal,
          scope: 'Synthetic task scope',
          acceptance: 'Synthetic acceptance',
          reviewPolicy: 'human',
          startPaused: true,
        });
        const worker = await call(host, 'session.prepare', {
          id: task.id,
          requestId: randomUUID(),
          expectedRowVersion: task.rowVersion,
        });
        assert.equal(worker.state, 'ready');
        return { ...bot, goal, worker };
      }
      const alpha = await fixture('Synthetic Alpha', 'Alpha document');
      const beta = await fixture('Synthetic Beta', 'Beta document');
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      // Web assets can share the host. Desktop's launcher may generate same-machine asset URLs.
      await page.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
      );
      page.setDefaultTimeout(10000);
      await page.goto(host.launchUrl, { waitUntil: 'domcontentloaded' });
      const button = (name) => page.getByRole('button', { name, exact: true });
      await button('Continue')
        .click({ timeout: 1800 })
        .catch(() => {});
      const nav = page.getByRole('navigation', { name: 'Bot', exact: true });
      async function selectBot(bot) {
        const row = nav.getByRole('button', { name: bot.name, exact: true });
        await row.click();
        // Let navigation settle before switching sidebar modes to inspect the native selection.
        await row.and(page.locator('button:enabled')).waitFor();
      }
      const work = page.getByRole('button', { name: '打开或收起当前 Bot 的工作', exact: true });
      const drawer = page.getByRole('dialog', { name: '任务详情', exact: true });
      const expectTask = (bot) =>
        drawer.getByRole('heading', { name: bot.goal, exact: true }).waitFor();
      const chatWork = (bot) =>
        work.and(page.getByTitle(`${bot.name} · 打开或收起工作视图`, { exact: true }));
      async function chooseTask(bot) {
        if (await drawer.isVisible())
          await drawer.getByRole('button', { name: '关闭任务详情', exact: true }).click();
        await page.getByRole('tab', { name: '全部', exact: true }).click();
        await page
          .getByRole('region', { name: '任务列表' })
          .getByRole('button', { name: new RegExp(bot.goal) })
          .click();
        await expectTask(bot);
      }
      async function expectWorker({ worker }) {
        await button('切换到 Workspace').click();
        const project = page
          .locator('[data-row-key^="workspace:"][aria-expanded]')
          .filter({ hasText: basename(worker.cwd) });
        await project.waitFor();
        if ((await project.getAttribute('aria-expanded')) === 'false') await project.click();
        await page
          .locator(`[data-row-key="session:${worker.sessionId}"][aria-selected="true"]`)
          .waitFor();
        await button('切换到 Bot').click();
      }
      async function openWorker(bot) {
        await drawer.getByRole('button', { name: '打开 Worker 会话', exact: true }).click();
        await expectWorker(bot);
      }
      const returnToChat = button('返回这个 Bot 聊天 →');
      async function openMainWork(bot) {
        await button('Super Bot').click();
        await page
          .locator('.bot-row')
          .filter({ hasText: bot.name })
          .getByRole('button', { name: '工作', exact: true })
          .click();
        await returnToChat.waitFor();
      }
      async function expectExplicitChat(bot) {
        await chatWork(bot).waitFor();
        await page.getByRole('tablist', { name: '视图', exact: true }).waitFor({ state: 'hidden' });
      }

      await selectBot(alpha);
      await chatWork(alpha).waitFor();
      await work.click();
      await chooseTask(alpha);
      await openWorker(alpha);
      await selectBot(beta);
      await chatWork(beta).waitFor();
      await selectBot(alpha);
      await expectWorker(alpha).catch(async (cause) => {
        const openedManager = await chatWork(alpha).isVisible();
        const message = openedManager ? 'Alpha’s Manager reopened' : 'Alpha’s Worker did not open';
        throw new Error(`${message} when returning from Beta chat`, { cause });
      });

      await selectBot(beta);
      await chatWork(beta).waitFor();
      await work.click();
      await chooseTask(beta);
      await openWorker(beta);
      await selectBot(alpha);
      await expectWorker(alpha);
      await selectBot(beta);
      await expectWorker(beta);

      await openMainWork(alpha);
      await returnToChat.click();
      await expectExplicitChat(alpha);
      await work.click();
      await expectTask(alpha);
      await button('Super Bot').click();
      await button(`${beta.name} · 继续聊天`).click();
      await expectExplicitChat(beta);
      await work.click();
      await expectTask(beta);
      await selectBot(alpha);
      await expectTask(alpha);
      await selectBot(beta);
      await expectTask(beta);

      await openMainWork(alpha);
      await chooseTask(alpha);
      await selectBot(beta);
      await expectTask(beta);
      await openMainWork(beta);
      await chooseTask(beta);
      for (const bot of [alpha, beta]) {
        await selectBot(bot);
        await returnToChat.waitFor();
        await expectTask(bot);
      }

      await page.close();
      console.log(
        `${role}: verified independent Worker and task-detail locations and explicit chat.`,
      );
    }
  } finally {
    await browser.close();
  }
}
