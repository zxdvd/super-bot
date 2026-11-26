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
      await page
        .getByRole('button', { name: 'Continue', exact: true })
        .click({ timeout: 1800 })
        .catch(() => {});
      const nav = page.getByRole('navigation', { name: 'Bot', exact: true });
      const row = (label) =>
        nav.getByRole('button', {
          name: [bot.name, label].filter(Boolean).join(' · '),
          exact: true,
        });
      const header = (label) =>
        page.getByRole('button', {
          name: ['打开或收起当前 Bot 的工作', label].filter(Boolean).join(' · '),
          exact: true,
        });
      const home = page.getByRole('button', { name: 'Super Bot', exact: true });
      const homeRow = (label) =>
        page.getByRole('button', {
          name: [bot.name, label, '继续聊天'].filter(Boolean).join(' · '),
          exact: true,
        });
      const rail = page.locator('.sb-sidebar-rail');
      const collapse = page.getByRole('button', { name: /^(Collapse sidebar|收起侧边栏)$/ });
      const expand = page.getByRole('button', { name: /^(Open sidebar|打开侧边栏|展开侧边栏)$/ });
      await row('').click();
      await header('').waitFor();
      async function dispatch(goal) {
        const task = await call(host, 'task.create', {
          requestId: randomUUID(),
          botId: bot.id,
          goal,
          scope: 'Own files',
          acceptance: 'Read result.md',
          reviewPolicy: 'human',
        });
        const binding = await call(host, 'session.prepare', {
          requestId: randomUUID(),
          id: task.id,
          expectedRowVersion: task.rowVersion,
        });
        await probe(host, 'select-test-model', binding.sessionId);
        const { task: current } = await call(host, 'task.detail', { id: task.id });
        await call(host, 'task.dispatch', {
          requestId: randomUUID(),
          id: task.id,
          expectedRowVersion: current.rowVersion,
        });
        return { id: task.id, worker: binding.sessionId };
      }
      const held = await dispatch('RELIABILITY_HOLD');
      await wait(
        async () => (await probe(host, 'inspect-session', held.worker)).stalled,
        'held Worker',
      );
      await header('进行中 1').waitFor();
      await nav.getByRole('button', { name: other.name, exact: true }).click();
      await header('').waitFor();
      const ask = await dispatch('ASK_PROBE');
      const activeQuestion = '进行中 1 · 需处理 1';
      await row(activeQuestion).waitFor();
      await header('').waitFor();
      await row(activeQuestion).click();
      await header(activeQuestion).click();
      const sections = page.locator('.inbox-group');
      await sections.filter({ hasText: '请说明文档面向谁？' }).waitFor();
      assert.deepEqual((await sections.locator('h3').allTextContents()).slice(0, 2), [
        '进行中',
        '需处理',
      ]);
      await sections.getByRole('button', { name: /ASK_PROBE/ }).click();
      await page.getByRole('textbox', { name: '回答', exact: true }).fill('面向新同事。');
      await page.getByRole('button', { name: '保存回答' }).click();
      await probe(host, 'select-test-model', bot.managerId);
      const delivered = (id) =>
        wait(
          async () => {
            const detail = await call(host, 'task.detail', { id });
            return detail.chatDelivery?.state === 'delivered' && detail;
          },
          'reviewed result delivered',
          600,
        );
      await delivered(ask.id);
      const detailDrawer = page.getByRole('dialog', { name: '任务详情' });
      await detailDrawer.getByRole('button', { name: '关闭任务详情', exact: true }).click();
      await header('进行中 1').waitFor();
      const clarify = await call(host, 'task.create', {
        requestId: randomUUID(),
        botId: bot.id,
        goal: 'Clarify scope',
        scope: '',
        acceptance: 'Confirm scope',
        reviewPolicy: 'human',
      });
      const mixed = '进行中 1 · 需处理 1 · 待验收 1';
      await header(activeQuestion).waitFor();
      await row(activeQuestion).waitFor();
      const counts = row(activeQuestion).locator('.sb-work-count:visible');
      assert.deepEqual(
        await counts.evaluateAll((nodes) =>
          nodes.map((node) => [node.dataset.status, node.textContent]),
        ),
        [
          ['working', '1'],
          ['attention', '1'],
        ],
      );
      await sections
        .filter({ has: page.getByRole('heading', { name: '待验收', exact: true }) })
        .waitFor();
      assert.deepEqual((await sections.locator('h3').allTextContents()).slice(0, 3), [
        '进行中',
        '需处理',
        '待验收',
      ]);
      const summary = page.locator('.sb-title').getByRole('img', { name: mixed, exact: true });
      await summary.waitFor();
      assert.deepEqual(await summary.locator('.sb-work-count:visible').allTextContents(), [
        '进行中 1',
        '需处理 1',
        '待验收 1',
      ]);
      await collapse.click();
      const railRow = rail.getByRole('button', {
        name: bot.name + ' · ' + activeQuestion,
        exact: true,
      });
      await railRow.waitFor();
      assert.equal(await railRow.getAttribute('title'), bot.name + ' · ' + activeQuestion);
      assert.deepEqual(
        await railRow
          .locator('.sb-work-count:visible')
          .evaluateAll((nodes) => nodes.map((node) => node.dataset.status)),
        ['working'],
      );
      assert.equal(
        await railRow.evaluate(
          (node) => node.scrollWidth <= node.clientWidth && node.innerText.includes('1'),
        ),
        true,
      );
      await expand.click();
      await header(activeQuestion).click();
      await summary.waitFor({ state: 'hidden' });
      await home.click();
      await homeRow(activeQuestion).click();
      await header(activeQuestion).waitFor();
      await header(activeQuestion).click();
      await sections.getByRole('button', { name: /Clarify scope/ }).click();
      await detailDrawer.getByText('更多操作', { exact: true }).click();
      await detailDrawer.getByRole('button', { name: '关闭任务', exact: true }).click();
      await detailDrawer.getByRole('button', { name: '确认关闭任务', exact: true }).click();
      await wait(
        async () =>
          (await call(host, 'task.detail', { id: clarify.id })).task.lifecycle === 'cancelled',
        'panel close settled',
      );
      await detailDrawer.getByRole('button', { name: '关闭任务详情', exact: true }).click();
      await header('进行中 1').click();
      await probe(host, 'release-stalled-model', held.worker);
      await delivered(held.id);
      for (const [button, title] of [
        [row(''), bot.name],
        [header(''), bot.name + ' · 打开或收起工作视图'],
      ]) {
        await button.waitFor();
        assert.equal(await button.getAttribute('title'), title);
        assert.equal(await button.locator('.sb-work-counts').count(), 0);
      }
      await header('').click();
      await page.locator('.sb-title').getByRole('img', { name: '待验收 2', exact: true }).waitFor();
      const reviewGroup = sections.filter({
        has: page.getByRole('heading', { name: '待验收', exact: true }),
      });
      await reviewGroup.getByRole('button', { name: /ASK_PROBE/ }).click();
      await detailDrawer.getByRole('heading', { name: '成果 · 待你验收', exact: true }).waitFor();
      await detailDrawer.getByRole('button', { name: '接受成果', exact: true }).waitFor();
      await detailDrawer.getByRole('button', { name: '关闭任务详情', exact: true }).click();
      await collapse.click();
      const reviewOnlyRailRow = rail.getByRole('button', { name: bot.name, exact: true });
      await reviewOnlyRailRow.waitFor();
      assert.equal(await reviewOnlyRailRow.getAttribute('title'), bot.name);
      assert.equal(await reviewOnlyRailRow.locator('.sb-work-counts').count(), 0);
      await expand.click();
      await home.click();
      await homeRow('').waitFor();
      assert.equal(await homeRow('').getAttribute('title'), bot.name + ' · 继续聊天');
      assert.equal(await homeRow('').locator('.sb-work-counts').count(), 0);
      await homeRow('').click();
      await header('').waitFor();
      await call(host, 'sidebar.pin', { botId: bot.id, sessionId: bot.managerId });
      await page.getByRole('button', { name: '切换到 Workspace', exact: true }).click();
      const native = page.locator('[data-slot="sidebar.session.row.trailing"]');
      const nativeRow = page.locator(`[data-row-key="session:${bot.managerId}"]`);
      await nativeRow.first().waitFor();
      assert.equal(await nativeRow.locator('.sb-work-counts').count(), 0);
      for (const { id } of [ask, held]) {
        const detail = await call(host, 'task.detail', { id });
        await call(host, 'result.accept', {
          requestId: randomUUID(),
          id,
          resultId: detail.result.id,
          expectedRowVersion: detail.task.rowVersion,
        });
      }
      await nativeRow.first().waitFor();
      assert.equal(await nativeRow.locator('.sb-work-counts').count(), 0);
      await call(host, 'task.create', {
        requestId: randomUUID(),
        botId: bot.id,
        goal: 'Clarify scope',
        scope: '',
        acceptance: 'Confirm scope',
        reviewPolicy: 'human',
      });
      await native.locator('.sb-work-counts[title="需处理 1"]').first().waitFor();
      const markedRows = await native
        .locator('.sb-work-counts[title="需处理 1"]')
        .evaluateAll((badges) =>
          badges.map((badge) => badge.closest('[data-row-key]')?.getAttribute('data-row-key')),
        );
      assert.deepEqual([...new Set(markedRows)], ['session:' + bot.managerId]);
      await page.close();
      console.log(
        role +
          ': verified ordered counts, collapsed rail, home, work button, inbox, review-only, idle and session isolation.',
      );
    }
  } finally {
    await browser.close();
  }
}
