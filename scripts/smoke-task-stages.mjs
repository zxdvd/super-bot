import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { closeTask, stageArtifacts, stageGoal, stoppableGoal } from '../test/stage-host-fixture.ts';

async function verifyStageInBrowser(host, bot, task) {
  const playwright = process.env.SUPER_BOT_TEST_PLAYWRIGHT;
  if (!playwright) return;
  const { chromium } = await import(pathToFileURL(playwright));
  const browser = await chromium.launch({ executablePath: process.env.SUPER_BOT_TEST_BROWSER });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(12000);
    await page.goto(host.launchUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 1500 }).catch(() => {});
    await page.getByRole('button', { name: 'Super Bot', exact: true }).click();
    await page.locator('.bot-open').filter({ hasText: bot.name }).click();
    await page.getByRole('button', { name: /打开或收起当前 Bot 的工作/ }).click();
    await page.locator('.sb-compact button.task').filter({ hasText: task.goal }).first().click();
    const drawer = page.getByRole('dialog', { name: '任务详情' });
    await drawer.getByText('引用 · 等待外部条件', { exact: true }).waitFor();
    await drawer.getByText('下一步 · 编排附录', { exact: true }).waitFor();
    const condition = drawer.getByRole('link', { name: /fixture\/docs.*42/ });
    assert.ok((await condition.getAttribute('href')).endsWith('/fixture/docs/-/pipelines/42'));
  } finally { await browser.close(); }
}

export async function smokeTaskStages({ base, configure, launch, stop, call, makeBot, probe, wait }) {
  const cert = join(base, 'test-ca.pem'), key = join(base, 'test-ca.key'), config = join(base, 'openssl.cnf');
  await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Local Stage Test',
    '-config', config, '-keyout', key, '-out', cert], { stdio: 'ignore' });
  let pipelineStatus = 'running';
  const observations = [];
  const server = createServer({ cert: await readFile(cert), key: await readFile(key) }, (req, res) => {
    if (req.url !== '/api/v4/projects/fixture%2Fdocs/pipelines/42' || req.method !== 'GET') {
      res.writeHead(404).end();
      return;
    }
    observations.push(pipelineStatus);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 42, status: pipelineStatus }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await exercise();
  } finally {
    server.close();
    server.closeAllConnections();
  }
  async function exercise() {
    await configure('web', { hmr: false, fullAccess: true, gitLabObserverOrigin: 'https://127.0.0.1:' + server.address().port });
    let host = await launch('web', 'task-stages', { testCa: cert });
    const bot = await makeBot(host, '分阶段编写说明');
    await probe(host, 'select-test-model', bot.managerId);
    await probe(host, 'native-prompt', bot.managerId, stageGoal);
    const tasks = () => call(host, 'task.list', { botId: bot.id });
    const task = await wait(async () => (await tasks()).items.find(item => item.goal === stageGoal), 'one writing task');
    const waiting = await wait(async () => {
      const detail = await call(host, 'task.detail', { id: task.id, sessionId: bot.managerId });
      return detail.stage?.state === 'waiting' && detail.stage.observation?.stateLabel === 'running' && detail;
    }, 'pipeline observed running without occupying a Worker');
    assert.equal(waiting.runHeld, false);
    assert.equal(waiting.result, null);
    await verifyStageInBrowser(host, bot, task);
    const firstManager = await probe(host, 'inspect-session', bot.managerId);
    await stop('web');
    pipelineStatus = 'success';
    host = await launch('web', 'task-stages-restarted', { testCa: cert });
    const done = await wait(async () => {
      const detail = await call(host, 'task.detail', { id: task.id, sessionId: bot.managerId });
      return detail.task.managerReviewed && detail.chatDelivery?.state === 'delivered' && detail;
    }, 'three intermediate stages followed by final delivery', 800);
    assert.ok(observations.includes('running'));
    assert.deepEqual(observations.filter(state => state === 'success'), ['success']);
    assert.equal(done.binding.sessionId, waiting.binding.sessionId);
    const worker = await probe(host, 'inspect-session', done.binding.sessionId);
    const manager = await probe(host, 'inspect-session', bot.managerId);
    const inputs = worker.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'super-bot');
    assert.equal(inputs.length, stageArtifacts.length + 1);
    assert.equal(new Set(inputs.map(event => event.data.source.runId)).size, inputs.length);
    assert.ok(inputs.every(event => event.data.source.taskId === task.id));
    const attempts = [...firstManager.managerAttempts, ...manager.managerAttempts];
    const nextSteps = attempts.filter(attempt => attempt.action === 'advance_stage');
    assert.deepEqual(nextSteps.map(attempt => attempt.nextStep), stageArtifacts.map(item => item.nextStep));
    assert.deepEqual(nextSteps.map(attempt => attempt.runId), inputs.slice(0,-1).map(event => event.data.source.runId));
    assert.equal(attempts.filter(attempt => attempt.action === 'review').length, 1);
    assert.equal(attempts.filter(attempt => attempt.action === 'rework').length, 0);
    assert.equal(done.deliveredResult.id, done.result.id);
    assert.equal((await tasks()).total, 1);
    await probe(host, 'native-prompt', bot.managerId, stoppableGoal);
    const stoppable = await wait(async () => {
      const item = (await tasks()).items.find(item => item.goal === stoppableGoal);
      if (!item) return;
      const detail = await call(host, 'task.detail', { id: item.id });
      if (!detail.binding || !detail.runHeld) return;
      const live = await probe(host, 'inspect-session', detail.binding.sessionId);
      return live.status !== 'idle' && live.workerContexts.length === 1 && detail;
    }, 'native Worker active with no unaccounted operations');
    await probe(host, 'native-prompt', bot.managerId, closeTask);
    const closed = await wait(async () => {
      const detail = await call(host, 'task.detail', { id: stoppable.task.id });
      return detail.task.lifecycle === 'cancelled' && !detail.runHeld && detail;
    }, 'one owner chat message stops and closes a working task');
    assert.equal(closed.run.id, stoppable.run.id);
    assert.equal(closed.pendingQuestions.length, 0);
    assert.equal((await tasks()).total, 2);
    console.log('PASS running task closed from its owner chat with one request');
    console.log('PASS one native owner message, three checkpoints, restart during external HTTPS wait, four runs on one Worker, one final delivery');
  }
}
