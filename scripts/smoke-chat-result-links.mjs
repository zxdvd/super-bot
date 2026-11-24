// Uses the isolated launchers and deterministic provider in smoke-mirror.mjs.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  artifactDeliveryText, artifactLinks, artifactPortProbeGoal, artifactReference, artifactRevision, supplementalDoc,
} from '../test/delivery-link-fixture.ts';

const workPath = (taskId, resultId) => `/#super-bot-task=${taskId}&resultId=${resultId}`;
const filePath = (resultId, sessionId) => `/api/super-bot-file?${new URLSearchParams({ resultId, index: '0', ...(sessionId && { sessionId }) })}`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const receipts = detail => detail.events.filter(event => event.kind === 'manager.delivered' && JSON.parse(event.data).resultId);
const runIds = detail => detail.events.filter(event => event.kind === 'run.queued').map(event => JSON.parse(event.data).runId).sort();

export async function smokeChatResultLinks({ base, configure, launch, stop, rpc, call, makeBot, probe, wait }) {
  const { SUPER_BOT_TEST_PLAYWRIGHT: playwright, SUPER_BOT_TEST_BROWSER: executablePath } = process.env;
  assert.ok(playwright && executablePath, 'Set absolute paths to Playwright and a Chromium browser.');
  const { chromium } = await import(pathToFileURL(playwright).href);
  const roles = ['web', 'desktop'];
  await Promise.all(roles.map(role => configure(role, { hmr: false, paired: true })));
  const web = await launch('web', 'first');
  let host = await launch('desktop', 'first');
  const oldOrigin = host.base;
  const bot = await makeBot(host, 'CHAT_RESULT_PORT_PROBE');
  const inspect = () => probe(host, 'inspect-session', bot.managerId);
  const say = text => probe(host, 'native-prompt', bot.managerId, text);
  const list = () => call(host, 'task.list', { botId: bot.id });
  await probe(host, 'select-test-model', bot.managerId);
  await say(artifactPortProbeGoal);
  const task = await wait(async () => (await list()).items.find(item => item.managerReviewed), 'reviewed native result');
  const detail = () => call(host, 'task.detail', { id: task.id, sessionId: bot.managerId });
  const awaitReceipt = resultId => wait(async () => {
    const current = await detail();
    return current.deliveredResult?.id === resultId && current.chatDelivery.state === 'delivered' && current;
  }, 'native delivery receipt');
  await wait(async () => {
    const chat = await inspect();
    return chat.status === 'idle' && chat.assistantTexts.includes('请查看上面的交付卡片。');
  }, 'persisted linkless final after the registered deliver tool');
  const first = await detail(), id = first.result.id;
  const fragment = workPath(task.id, id);
  assert.equal(first.chatDelivery.state, 'pending');
  assert.equal(first.deliveredResult, null);
  assert.deepEqual(receipts(first), []);
  await say(`DF14_SHOW_RESULT:${task.id}`);
  const delivered = await awaitReceipt(id);
  assert.deepEqual(delivered.deliveredResult.links, artifactLinks);
  const original = (await inspect()).assistantTexts.find(text => text.includes(oldOrigin + fragment));
  assert.ok(original);
  const [receipt] = receipts(delivered);
  assert.deepEqual(runIds(delivered), [first.run.id]);
  const oldFile = oldOrigin + filePath(id);
  const firstBytes = Buffer.from(await (await host.get(filePath(id))).arrayBuffer());
  assert.equal(sha256(firstBytes), first.result.evidence[0].sha256);
  await stop('desktop');
  host = await launch('desktop', 'restarted');
  assert.notEqual(host.base, oldOrigin);
  assert.ok((await inspect()).assistantTexts.includes(original));
  assert.deepEqual(receipts(await detail()), [receipt]);
  console.log(`Persisted Desktop reply: same session ${bot.managerId}, task ${task.id}, result ${id}, receipt ${receipt.id}; ${oldOrigin} → ${host.base}`);

  const browserTmp = join(base, 'browser-tmp');
  await mkdir(browserTmp);
  const browser = await chromium.launch({ executablePath, downloadsPath: browserTmp,
    env: { PATH: process.env.PATH, HOME: browserTmp, TMPDIR: browserTmp } });
  const openBrowserChat = async (carrier, name) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage(), away = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === carrier.base) return route.continue();
      away.push(url.origin);
      return route.abort();
    });
    await page.goto(carrier.launchUrl, { waitUntil: 'domcontentloaded' });
    const open = async botName => {
      await page.getByRole('button', { name: 'Super Bot', exact: true }).click({ timeout: 15000 });
      await page.locator('.bot-open').filter({ hasText: botName }).click({ timeout: 10000 });
      await page.getByRole('button', { name: '打开或收起当前 Bot 的工作' }).waitFor({ timeout: 10000 });
    };
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 1500 }).catch(() => {});
    await open(name);
    return { context, page, away, open, flow: page.locator('[data-slot="conversation.chat.flow"]') };
  };
  const rootRelative = async (carrier, flow, sessionId, marker) => {
    const href = workPath(task.id, id);
    const rawFile = filePath(id);
    await probe(carrier, 'native-prompt', sessionId, `CHAT_LINK_MARKDOWN:[${marker}_WORK](${href}) [${marker}_FILE](${rawFile})`);
    const node = flow.getByText(`${marker}_WORK`, { exact: true }).last();
    await node.waitFor({ timeout: 5000 });
    const rendered = await node.evaluate(element => {
      const asControl = control => ({ tag: control.tagName, text: control.textContent,
        href: control.getAttribute('href'), title: control.getAttribute('title') });
      const row = element.closest('[data-chat-group-part="response"]') ?? element.closest('p');
      return { work: asControl(element.closest('a, button') ?? element),
        file: [...(row?.querySelectorAll('a, button') ?? [])].map(asControl)
          .find(control => [control.title, control.text, control.href].some(text => text?.includes('super-bot-file'))) ?? null };
    });
    assert.equal(rendered.work.tag, 'BUTTON', JSON.stringify(rendered));
    assert.equal(rendered.work.href, null);
    assert.equal(rendered.file?.href ?? null, null);
    return rendered;
  };
  try {
    const { context, page, flow, away, open } = await openBrowserChat(host, bot.name);
    const link = href => flow.locator(`a[href="${href}"]`).last();
    const drawer = page.getByRole('dialog', { name: '任务详情' });
    const accept = drawer.getByRole('button', { name: '接受成果', exact: true });
    const rework = drawer.getByText('要求返工', { exact: true });
    const close = () => drawer.getByRole('button', { name: '关闭任务详情' }).click();
    const resultCard = drawer.locator('.attention-box.result');
    const artifacts = resultCard.getByRole('group', { name: '交付物', exact: true });
    const workerReport = resultCard.getByText('完整 Worker 报告', { exact: true });
    const openWorkTask = async () => {
      const row = page.locator('.sb-compact button.task').filter({ hasText: task.goal }).first();
      if (!await row.isVisible()) await page.getByRole('button', { name: '打开或收起当前 Bot 的工作' }).click();
      await row.click();
      await drawer.getByRole('heading', { name: task.goal, exact: true }).waitFor();
      assert.equal(await drawer.locator('.task-detail > [tabindex="-1"]').count(), 0, 'ordinary task drawer is not an exact link view');
    };
    const assertArtifacts = async links => {
      assert.equal(await resultCard.count(), 1);
      assert.equal(await artifacts.getByRole('link').count(), Object.keys(links).length);
      assert.equal(await artifacts.getByRole('link').getByText(/https?:\/\//).count(), 0);
      for (const [name, url] of Object.entries(links)) {
        const anchor = artifacts.getByRole('link', { name, exact: true });
        assert.equal(await anchor.getAttribute('href'), url);
        assert.equal(await anchor.getAttribute('target'), '_blank');
        assert.equal(await anchor.getAttribute('rel'), 'noopener noreferrer');
      }
      assert.equal(await artifacts.locator(`a[href="${artifactReference}"]`).count(), 0);
    };
    const openResult = async (locator, resultId) => {
      const tabs = context.pages();
      await locator.click({ timeout: 10000 });
      const opened = await drawer.getByRole('heading', { name: task.goal, exact: true })
        .waitFor({ timeout: 4500 }).then(() => true, () => false);
      assert.deepEqual({ opened, attemptedOldPort: away.includes(oldOrigin) },
        { opened: true, attemptedOldPort: false }, 'the native result click must stay on the current host');
      assert.ok(context.pages().every(tab => tabs.includes(tab)), 'opening a result does not open a new tab');
      assert.equal(new URL(page.url()).origin, host.base);
      assert.equal(new URL(page.url()).hash, workPath(task.id, resultId).slice(1));
    };
    await openWorkTask();
    await artifacts.waitFor();
    await assertArtifacts(artifactLinks);
    const resize = page.locator('[data-side="rightbar"]');
    await resize.waitFor();
    const handle = await resize.boundingBox(), initialWidth = (await drawer.boundingBox()).width;
    const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + initialWidth - 328, y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('aside.sb-drawer')?.clientWidth <= 345);
    const layout = await artifacts.evaluate(group => {
      const summary = group.previousElementSibling, drawer = group.closest('[role="dialog"]');
      return {
        compact: drawer.classList.contains('sb-compact'),
        width: drawer.clientWidth,
        overflow: drawer.scrollWidth - drawer.clientWidth,
        lines: new Set([...group.querySelectorAll('li')].map(item => Math.round(item.getBoundingClientRect().top))).size,
        order: summary.textContent.includes('等待你确认') && group.nextElementSibling.matches('p, details'),
        duplicate: summary.querySelectorAll('a[href]').length,
      };
    });
    assert.ok(layout.compact && layout.width <= 345 && layout.overflow <= 1 && layout.lines >= 2, JSON.stringify(layout));
    assert.ok(layout.order && !layout.duplicate, 'artifact links follow summary with no duplicated Markdown link');
    for (const [name, url] of Object.entries(artifactLinks)) {
      await context.route(url, route => route.fulfill({ status: 200, body: 'Synthetic artifact destination' }));
      const clicked = page.waitForEvent('popup', { timeout: 5000 });
      await artifacts.getByRole('link', { name, exact: true }).click();
      const popup = await clicked;
      await popup.waitForURL(url);
      await popup.getByText('Synthetic artifact destination').waitFor();
      await popup.close();
    }

    const card = await resultCard.elementHandle();
    await say(`请更新这项交付 ${host.base}${fragment}，新增交付物“飞书文档 · 联调纪要” ${supplementalDoc}。`);
    const patched = { ...artifactLinks, '飞书文档 · 联调纪要': supplementalDoc };
    await artifacts.getByRole('link', { name: '飞书文档 · 联调纪要' }).waitFor({ timeout: 10000 });
    await assertArtifacts(patched);
    assert.equal(await card.evaluate(element => element.isConnected), true);
    const updated = await detail();
    assert.equal(updated.deliveredResult.deliveredAt, delivered.deliveredResult.deliveredAt);
    assert.equal(updated.deliveredResult.deliveryText, delivered.deliveredResult.deliveryText);
    assert.equal(updated.result.humanAcceptedAt, null);
    assert.deepEqual(receipts(updated), [receipt]);
    await drawer.screenshot({ path: join(base, 'delivery-links-narrow.png') });
    await close();

    await openResult(link(oldOrigin + fragment), id);
    await accept.waitFor();
    const preview = page.getByRole('region', { name: '成果文件预览' });
    let downloads = 0;
    page.on('download', () => downloads++);
    await link(oldFile).click();
    await preview.getByLabel('成果文件内容').waitFor();
    assert.equal(await preview.getByLabel('成果文件内容').textContent(), firstBytes.toString('utf8'));
    assert.equal(downloads, 0);
    const download = page.waitForEvent('download', { timeout: 5000 });
    await preview.getByRole('link', { name: '下载' }).click();
    const originalDownload = await download;
    assert.equal(originalDownload.url(), host.base + filePath(id, bot.managerId));
    assert.equal(sha256(await readFile(await originalDownload.path())), first.result.evidence[0].sha256);
    console.log(`PASS file preview and explicit download used the restarted Desktop Host; no request to ${oldOrigin}`);
    await preview.getByRole('button', { name: '← 返回聊天' }).click();
    if (await drawer.isVisible()) await close();

    await say('再加一句结论。');
    const revised = await wait(async () => {
      const current = await detail();
      return current.task.managerReviewed && current.result && current.result.id !== id && current;
    }, 'second Worker Run on the same task');
    const nextId = revised.result.id;
    assert.notEqual(revised.result.summary, first.result.summary);
    assert.notEqual(revised.result.checks, first.result.checks);
    assert.notEqual(revised.result.evidence[0].sha256, first.result.evidence[0].sha256);
    assert.equal(revised.result.evidence[0].path, first.result.evidence[0].path);
    assert.equal(revised.deliveredResult.id, id);
    await openWorkTask();
    await drawer.getByRole('heading', { name: '交付 · 返工中' }).waitFor();
    await assertArtifacts(patched);
    assert.ok(await resultCard.getByText(artifactDeliveryText, { exact: false }).isVisible());
    await workerReport.click();
    await resultCard.getByText('已回读合成证据。参考资料：', { exact: false }).waitFor();
    await workerReport.click();
    assert.equal(await accept.count(), 0);
    const pending = drawer.getByText('新成果待验收', { exact: true });
    await pending.click();
    assert.ok(await accept.isVisible());
    assert.equal(await resultCard.getByRole('button', { name: '接受成果', exact: true }).count(), 0);
    assert.equal(await drawer.locator(`a[href="${filePath(nextId, bot.managerId)}"]`).count(), 1);
    await pending.click();
    await wait(async () => (await inspect()).status === 'idle', 'second candidate turn done');
    await say(`DF14_SHOW_RESULT:${task.id}`);
    await awaitReceipt(nextId);
    await artifacts.getByRole('link', { name: '飞书文档 · 修订版方案' }).waitFor();
    await assertArtifacts(artifactRevision.links);
    assert.ok(await resultCard.locator('.clamp').getByText(artifactRevision.text, { exact: true }).isVisible());
    assert.equal(await drawer.getByText('新成果待验收', { exact: true }).count(), 0);
    assert.equal(await drawer.getByText(/历史成果|查看当前交付/).count(), 0);
    assert.equal(await resultCard.getByText(artifactDeliveryText, { exact: false }).count(), 0);
    await drawer.screenshot({ path: join(base, 'delivery-links-latest.png') });
    await close();
    const freshLink = host.base + workPath(task.id, nextId);

    await openResult(link(oldOrigin + fragment), id);
    await drawer.getByRole('heading', { name: '历史成果 · 只读' }).waitFor();
    await drawer.getByText('这份成果已被新版替代。', { exact: true }).waitFor();
    await drawer.getByText('完整 Worker 报告', { exact: true }).click();
    await resultCard.getByText('已回读合成证据。参考资料：', { exact: false }).waitFor();
    assert.ok(await resultCard.getByText(artifactDeliveryText, { exact: false }).isVisible());
    await assertArtifacts(patched);
    assert.equal(await accept.count(), 0);
    assert.equal(await rework.count(), 0);
    assert.equal(await drawer.locator(`a[href="${filePath(id, bot.managerId)}"]`).count(), 1);
    assert.equal(await drawer.locator(`a[href="${filePath(nextId, bot.managerId)}"]`).count(), 0);
    const overwritten = await host.get(filePath(id, bot.managerId));
    assert.equal(overwritten.status, 200);
    assert.deepEqual(Buffer.from(await overwritten.arrayBuffer()), firstBytes);

    const path = first.result.evidence[0].path, parked = `${path}.smoke-${randomUUID()}`;
    assert.ok(path.startsWith(`${base}/`) && await realpath(path) === path);
    const nextBytes = await readFile(path);
    await rename(path, parked);
    try {
      await drawer.getByRole('button', { name: basename(path), exact: true }).click();
      await drawer.getByLabel('成果文件内容').waitFor();
      assert.equal(await drawer.getByLabel('成果文件内容').textContent(), firstBytes.toString('utf8'));
      assert.equal(downloads, 1);
      const matching = page.waitForEvent('download', { timeout: 5000 });
      await drawer.locator(`a[href="${filePath(id, bot.managerId)}"]`).click();
      assert.equal(sha256(await readFile(await (await matching).path())), first.result.evidence[0].sha256);
    } finally {
      assert.equal(await realpath(parked), parked);
      await rename(parked, path);
    }
    assert.equal(sha256(await readFile(path)), sha256(nextBytes));
    await close();
    await openResult(link(freshLink), nextId);
    await accept.waitFor(); await rework.waitFor();
    assert.ok(await resultCard.locator('.clamp').getByText(artifactRevision.text, { exact: true }).isVisible());
    await assertArtifacts(artifactRevision.links);
    const newFile = await host.get(filePath(nextId, bot.managerId));
    assert.equal(newFile.status, 200);
    assert.equal(sha256(Buffer.from(await newFile.arrayBuffer())), revised.result.evidence[0].sha256);
    assert.equal((await rpc(host, 'result.accept', { requestId: randomUUID(), id: task.id, resultId: id,
      expectedRowVersion: revised.task.rowVersion, sessionId: bot.managerId })).error.code, 'result-stale');
    await close();
    console.log(`PASS two versions: ${id} read-only with original report and checked download; ${nextId} retains review controls`);

    await say('请写一份说明，先确认读者。');
    const question = await wait(async () => {
      const waiting = (await list()).items.find(item => item.status === 'needs-input');
      if (waiting) return call(host, 'task.detail', { id: waiting.id, sessionId: bot.managerId });
    }, 'native question');
    const questionUrl = `${host.base}/#super-bot-task=${question.task.id}&attentionId=${encodeURIComponent(question.pendingQuestions[0].id)}`;
    await link(questionUrl).click();
    await drawer.getByText(question.pendingQuestions[0].question, { exact: true }).first().waitFor();
    await drawer.getByRole('textbox', { name: '回答', exact: true }).waitFor();
    await close();
    const desktopRelative = await rootRelative(host, flow, bot.managerId, 'RC5_ROOT');
    const webBot = await makeBot(web, 'WEB_ROOT_PROBE');
    await probe(web, 'select-test-model', webBot.managerId);
    const webBrowser = await openBrowserChat(web, webBot.name);
    const webRelative = await rootRelative(web, webBrowser.flow, webBot.managerId, 'RC1_ROOT');
    await webBrowser.context.close();
    await page.bringToFront();

    const forgedUrl = oldOrigin + workPath(question.task.id, id);
    const externalUrl = `https://example.invalid${fragment}`;
    await say(`CHAT_LINK_MARKDOWN:[WRONG_TASK](${forgedUrl}) [EXTERNAL_RESULT](${externalUrl})`);
    for (const href of [forgedUrl, externalUrl]) await link(href).click({ timeout: 5000 });
    await link(oldOrigin + fragment).click({ button: 'middle' });
    await link(oldOrigin + fragment).click({ modifiers: ['Control'] });
    assert.equal(await drawer.count(), 0);
    assert.ok(!away.includes(oldOrigin) && !away.includes('https://example.invalid'));
    const otherBot = await makeBot(host, 'OTHER_BOT_PROBE');
    await open(otherBot.name);
    await probe(host, 'select-test-model', otherBot.managerId);
    await probe(host, 'native-prompt', otherBot.managerId, `CHAT_LINK_MARKDOWN:[WRONG_BOT](${oldOrigin + fragment})`);
    await link(oldOrigin + fragment).click();
    assert.equal(await drawer.count(), 0);
    assert.ok(!away.includes(oldOrigin));
    assert.equal((await rpc(host, 'task.detail', { id: task.id, resultId: id, sessionId: otherBot.managerId })).error.code, 'not-found');
    assert.equal((await rpc(host, 'task.detail', { id: task.id, resultId: id, sessionId: first.binding.sessionId })).error.code, 'not-found');
    assert.equal((await call(host, 'task.detail', { id: question.task.id, resultId: id, sessionId: bot.managerId })).linkedResult, null);
    for (const sessionId of [otherBot.managerId, first.binding.sessionId, webBot.managerId]) {
      assert.equal((await host.get(filePath(id, sessionId))).status, 404);
      assert.equal((await host.get(filePath(id, sessionId) + '&preview=1')).status, 404);
    }
    const mirror = await call(web, 'mirror.detail', { owner: 'desktop', botId: bot.id, id: task.id });
    assert.ok(mirror.records.results.some(result => result.id === id && result.fileCount === 1));
    assert.equal((await call(web, 'session.origin', { sessionId: bot.managerId })).local, false);
    assert.equal(await call(web, 'bot.for-session', { sessionId: bot.managerId }), null);
    assert.equal((await rpc(web, 'task.detail', { id: task.id, resultId: id, sessionId: bot.managerId })).error.code, 'not-found');
    assert.equal((await web.get(filePath(id, bot.managerId))).status, 404);
    assert.equal((await web.get(filePath(id, bot.managerId) + '&preview=1')).status, 404);
    assert.notEqual((await fetch(host.base + filePath(id, bot.managerId), { redirect: 'manual' })).status, 200);
    assert.notEqual((await fetch(host.base + filePath(id, bot.managerId) + '&preview=1', { redirect: 'manual' })).status, 200);
    assert.notEqual((await host.post('/api/super-bot', {
      type: 'client-request', rpcId: randomUUID(), method: 'super-bot',
      payload: { action: 'task.detail', id: task.id, sessionId: bot.managerId, resultId: id },
    }, { origin: 'https://example.invalid' })).status, 200);
    const after = await detail();
    assert.deepEqual(runIds(after), [first.run.id, revised.run.id].sort());
    assert.deepEqual(receipts(after).map(event => JSON.parse(event.data).resultId).sort(), [id, nextId].sort());
    assert.ok((await inspect()).assistantTexts.includes(original));
    assert.equal(after.result.humanAcceptedAt, null);
    assert.equal((await call(host, 'task.detail', { id: task.id, resultId: id, sessionId: bot.managerId })).linkedResult.humanAcceptedAt, null);
    const runtime = { desktop: (await call(host, 'status')).runtime, web: (await call(web, 'status')).runtime };
    await writeFile(join(base, 'chat-result-proof.json'), JSON.stringify({
      runtime, oldOrigin, currentOrigin: host.base, botId: bot.id, sessionId: bot.managerId, taskId: task.id,
      versions: [first, revised].map(d => ({ id: d.result.id, sha256: d.result.evidence[0].sha256, checks: d.result.checks, runId: d.run.id })),
      deliveryReceipts: receipts(after).map(event => JSON.parse(event.data)), question: question.pendingQuestions[0].id,
      rootRelative: { desktop: desktopRelative, web: webRelative }, away, humanAcceptedAt: after.result.humanAcceptedAt,
      deliveryLinks: { layout, patched, latest: artifactRevision.links },
    }, null, 2));
    console.log(`PASS rc.1/rc.5 root-relative work links become file controls; question, scope, pairing, auth, exactly two Runs and receipts; ${JSON.stringify(runtime)}`);
  } catch (error) {
    throw new Error(String(error).replace(/([?&]token=)[^\s"']+/g, '$1<redacted>'));
  } finally { await browser.close(); }
}
