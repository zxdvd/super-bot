import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  closeTask,
  ownerAcceptance,
  ownerAcceptanceConfirm,
  ownerConfirm,
  ownerDetach,
  ownerInspect,
  ownerNewGoal,
  ownerOldGoal,
  ownerPrepare,
  ownerRefuse,
  ownerRevise,
  ownerSessionTitle,
  stageArtifacts,
  stageGoal,
  stageRevoke,
  stageSupplement,
  stoppableGoal,
} from '../test/stage-host-fixture.ts';

async function verifyStageInBrowser(host, bot, task) {
  const playwright = process.env.SUPER_BOT_TEST_PLAYWRIGHT;
  if (!playwright) return;
  const { chromium } = await import(pathToFileURL(playwright));
  const browser = await chromium.launch({ executablePath: process.env.SUPER_BOT_TEST_BROWSER });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(12000);
    await page.goto(host.launchUrl, { waitUntil: 'domcontentloaded' });
    await page
      .getByRole('button', { name: 'Continue', exact: true })
      .click({ timeout: 1500 })
      .catch(() => {});
    await page.getByRole('button', { name: 'Super Bot', exact: true }).click();
    await page.locator('.bot-open').filter({ hasText: bot.name }).click();
    await page.getByRole('button', { name: /打开或收起当前 Bot 的工作/ }).click();
    await page.locator('.sb-compact button.task').filter({ hasText: task.goal }).first().click();
    const drawer = page.getByRole('dialog', { name: '任务详情' });
    await drawer.getByText('引用 · 等待外部条件', { exact: true }).waitFor();
    await drawer.getByText('下一步 · 编排附录', { exact: true }).waitFor();
    const condition = drawer.getByRole('link', { name: /fixture\/docs.*42/ });
    assert.ok((await condition.getAttribute('href')).endsWith('/fixture/docs/-/pipelines/42'));
  } finally {
    await browser.close();
  }
}

export async function smokeTaskStages({
  base,
  configure,
  launch,
  stop,
  call,
  makeBot,
  probe,
  wait,
}) {
  const cert = join(base, 'test-ca.pem'),
    key = join(base, 'test-ca.key'),
    config = join(base, 'openssl.cnf');
  await writeFile(
    config,
    '[req]\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n',
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=Local Stage Test',
      '-config',
      config,
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  let pipelineStatus = 'running';
  let heldRead;
  const observations = [];
  const server = createServer(
    { cert: await readFile(cert), key: await readFile(key) },
    (req, res) => {
      if (req.url !== '/api/v4/projects/fixture%2Fdocs/pipelines/42' || req.method !== 'GET') {
        res.writeHead(404).end();
        return;
      }
      const respond = (status) => {
        observations.push(status);
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ id: 42, status }));
      };
      if (heldRead && !heldRead.respond) heldRead.respond = respond;
      else respond(pipelineStatus);
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await exercise();
  } finally {
    server.close();
    server.closeAllConnections();
  }
  async function exercise() {
    await configure('web', {
      hmr: false,
      fullAccess: true,
      gitLabObserverOrigin: 'https://127.0.0.1:' + server.address().port,
    });
    let host = await launch('web', 'task-stages', { testCa: cert });
    const bot = await makeBot(host, '分阶段编写说明');
    await probe(host, 'select-test-model', bot.managerId);
    await probe(host, 'native-prompt', bot.managerId, stageGoal);
    const tasks = () => call(host, 'task.list', { botId: bot.id });
    const task = await wait(
      async () => (await tasks()).items.find((item) => item.goal === stageGoal),
      'one writing task',
    );
    const waiting = await wait(async () => {
      const detail = await call(host, 'task.detail', { id: task.id, sessionId: bot.managerId });
      return (
        detail.stage?.state === 'waiting' &&
        detail.stage.observation?.stateLabel === 'running' &&
        detail
      );
    }, 'pipeline observed running without occupying a Worker');
    assert.equal(waiting.runHeld, false);
    assert.equal(waiting.result, null);
    await verifyStageInBrowser(host, bot, task);
    await probe(host, 'native-prompt', bot.managerId, stageSupplement);
    const supplemented = await wait(async () => {
      const detail = await call(host, 'task.detail', { id: task.id, sessionId: bot.managerId });
      return (
        detail.directionStatus === 'next-run' &&
        detail.recoveryInstruction?.source.text === stageSupplement &&
        detail
      );
    }, 'the original chat saves one additive directive');
    assert.equal(supplemented.stage.state, 'waiting');
    assert.equal(supplemented.stage.deadlineAt, waiting.stage.deadlineAt);
    assert.equal(supplemented.stage.nextStep, waiting.stage.nextStep);
    const firstManager = await probe(host, 'inspect-session', bot.managerId);
    assert.ok(
      firstManager.managerAttempts.some(
        (attempt) =>
          attempt.action === 'continue' &&
          attempt.userInstruction === stageSupplement &&
          attempt.stageFollowUp === undefined,
      ),
    );
    const ownerInput = firstManager.events.find(
      (event) =>
        event.type === 'user/message' &&
        event.data.id === supplemented.recoveryInstruction.source.messageId,
    );
    assert.equal(ownerInput?.seq, supplemented.recoveryInstruction.source.seq);
    await stop('web');
    const ledger = new DatabaseSync(
      join(base, 'web/super-bot/.runtime/dsh/super-bot/ledger.sqlite'),
    );
    try {
      const now = Date.now();
      assert.equal(
        ledger
          .prepare(
            "UPDATE work_stages SET nextCheckAt=?,details=json_set(details,'$.deadlineAt',?) WHERE runId=?",
          )
          .run(now - 1, now - 2, waiting.stage.runId).changes,
        1,
      );
    } finally {
      ledger.close();
    }
    pipelineStatus = 'success';
    host = await launch('web', 'task-stages-restarted', { testCa: cert });
    const done = await wait(
      async () => {
        const detail = await call(host, 'task.detail', { id: task.id, sessionId: bot.managerId });
        return detail.task.managerReviewed && detail.chatDelivery?.state === 'delivered' && detail;
      },
      'three intermediate stages followed by final delivery',
      800,
    );
    assert.ok(observations.includes('running'));
    assert.deepEqual(
      observations.filter((state) => state === 'success'),
      ['success'],
    );
    assert.equal(done.binding.sessionId, waiting.binding.sessionId);
    const worker = await probe(host, 'inspect-session', done.binding.sessionId);
    const manager = await probe(host, 'inspect-session', bot.managerId);
    const inputs = worker.events.filter(
      (event) => event.type === 'user/message' && event.data.source.kind === 'super-bot',
    );
    assert.equal(inputs.length, stageArtifacts.length + 1);
    assert.equal(new Set(inputs.map((event) => event.data.source.runId)).size, inputs.length);
    assert.ok(inputs.every((event) => event.data.source.taskId === task.id));
    const augmentedInputs = inputs.filter((event) =>
      event.data.content.some((block) => block.text?.includes(stageSupplement)),
    );
    assert.equal(augmentedInputs.length, 1);
    assert.equal(augmentedInputs[0].data.source.runId, inputs[2].data.source.runId);
    const augmentedText = augmentedInputs[0].data.content.map((block) => block.text).join('');
    assert.ok(augmentedText.includes(stageArtifacts[1].nextStep));
    assert.equal(augmentedText.split(stageSupplement).length - 1, 1);
    const attempts = [...firstManager.managerAttempts, ...manager.managerAttempts];
    const nextSteps = attempts.filter((attempt) => attempt.action === 'advance_stage');
    assert.deepEqual(
      nextSteps.map((attempt) => attempt.nextStep),
      stageArtifacts.map((item) => item.nextStep),
    );
    assert.deepEqual(
      nextSteps.map((attempt) => attempt.runId),
      inputs.slice(0, -1).map((event) => event.data.source.runId),
    );
    assert.equal(attempts.filter((attempt) => attempt.action === 'review').length, 1);
    assert.equal(attempts.filter((attempt) => attempt.action === 'rework').length, 0);
    assert.equal(done.deliveredResult.id, done.result.id);
    assert.equal((await tasks()).total, 1);
    await probe(host, 'native-prompt', bot.managerId, ownerAcceptance);
    const pendingAcceptance = await call(host, 'task.detail', {
      id: task.id,
      sessionId: bot.managerId,
    });
    assert.equal(pendingAcceptance.task.lifecycle, 'review');
    const question = (await probe(host, 'inspect-session', bot.managerId)).assistantTexts.at(-1);
    assert.ok(question.includes('是否接受') && question.includes(done.result.id));
    await probe(host, 'native-prompt', bot.managerId, ownerAcceptanceConfirm);
    const accepted = await call(host, 'task.detail', { id: task.id, sessionId: bot.managerId });
    assert.equal(accepted.task.lifecycle, 'completed');
    const ownerReceipt = accepted.events
      .filter((event) => event.kind === 'result.accepted')
      .map((event) => JSON.parse(event.data));
    assert.equal(ownerReceipt.length, 1);
    assert.equal(ownerReceipt[0].resultId, done.result.id);
    assert.deepEqual(
      ownerReceipt[0].source.messages.map((message) => message.text),
      [ownerAcceptance, ownerAcceptanceConfirm],
    );
    pipelineStatus = 'running';
    heldRead = {};
    await probe(host, 'native-prompt', bot.managerId, stageGoal);
    const withdrawn = await wait(async () => {
      const item = (await tasks()).items.find(
        (item) => item.goal === stageGoal && item.id !== task.id,
      );
      if (!item || !heldRead.respond) return;
      const detail = await call(host, 'task.detail', { id: item.id });
      return detail.stage?.state === 'waiting' && detail;
    }, 'a fresh stage is waiting with its GitLab read in flight');
    await probe(host, 'native-prompt', bot.managerId, stageRevoke);
    await wait(async () => {
      const detail = await call(host, 'task.detail', { id: withdrawn.task.id });
      return detail.stage?.state === 'superseded' && detail.directionStatus === 'revoked' && detail;
    }, 'the original chat withdraws the stage');
    heldRead.respond('success');
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const afterWithdrawal = await call(host, 'task.detail', { id: withdrawn.task.id });
    assert.equal(afterWithdrawal.stage.state, 'superseded');
    assert.equal(afterWithdrawal.stage.observation, undefined);
    assert.equal(afterWithdrawal.run.id, withdrawn.run.id);
    assert.equal(afterWithdrawal.runHeld, false);
    await probe(host, 'native-prompt', bot.managerId, stoppableGoal);
    const stoppable = await wait(async () => {
      const item = (await tasks()).items.find((item) => item.goal === stoppableGoal);
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
    assert.equal((await tasks()).total, 3);
    await exerciseOwnerSessionActions(host, bot);
    console.log('PASS running task closed from its owner chat with one request');
    console.log(
      'PASS an in-flight HTTPS success after owner chat withdrawal did not reach a Worker',
    );
    console.log(
      'PASS the default stage addition survived restart and the observation deadline, entered exactly one of four runs on the original Worker, and produced one final chat delivery',
    );
  }

  async function exerciseOwnerSessionActions(host, bot) {
    const draft = await call(host, 'task.create', {
      requestId: 'chat-owner-fixture',
      botId: bot.id,
      goal: ownerOldGoal,
      scope: '只修改合成资料文件',
      acceptance: '会话已关联或已准备',
      reviewPolicy: 'human',
      startPaused: true,
    });
    const session = await probe(host, 'create-attach-session', undefined, ownerSessionTitle);
    const original = await probe(host, 'inspect-session', session.sessionId);
    const prompt = (text) => probe(host, 'native-prompt', bot.managerId, text);
    const detail = () => call(host, 'task.detail', { id: draft.id, sessionId: bot.managerId });
    await prompt(ownerRevise);
    assert.equal((await detail()).task.goal, ownerNewGoal);
    await prompt(ownerInspect);
    const preview = (await probe(host, 'inspect-session', bot.managerId)).assistantTexts.at(-1);
    assert.ok(preview.includes(ownerSessionTitle) && preview.includes(session.cwd), preview);
    assert.match(preview, /完整会话历史.*读取、写入和编辑.*保持暂停/);
    assert.equal((await detail()).binding, null);
    await prompt(ownerRefuse);
    await prompt(ownerConfirm);
    assert.equal(
      (await detail()).binding,
      null,
      'confirmation after rejecting the preview cannot attach',
    );
    await prompt(ownerInspect);
    const beforeRace = await detail();
    await call(host, 'task.control', {
      requestId: 'owner-session-stale',
      id: draft.id,
      sessionId: bot.managerId,
      expectedRowVersion: beforeRace.task.rowVersion,
      mode: 'paused',
    });
    await prompt(ownerConfirm);
    assert.equal(
      (await detail()).binding,
      null,
      'confirmation naming the previous task version cannot attach',
    );
    await prompt(ownerInspect);
    await prompt(ownerConfirm);
    const attached = await detail();
    assert.equal(attached.binding.sessionId, session.sessionId);
    assert.equal(attached.task.controlMode, 'paused');
    assert.equal(attached.run, null);
    const approval = JSON.parse(
      attached.events.find((event) => event.kind === 'session.attached').data,
    );
    assert.deepEqual(
      approval.source.messages.map((message) => message.text),
      [ownerInspect, ownerConfirm],
    );
    const history = await probe(host, 'inspect-session', session.sessionId);
    assert.equal(
      history.historyMessageIds.filter((id) => id === session.historyMessageId).length,
      1,
    );
    assert.equal(history.modelSteps, original.modelSteps);
    assert.equal(
      history.events.some(
        (event) => event.type === 'user/message' && event.data.source.kind === 'super-bot',
      ),
      false,
    );
    await prompt(ownerDetach);
    assert.equal((await detail()).binding, null);
    await prompt(ownerPrepare);
    const prepared = await detail();
    assert.equal(prepared.binding.state, 'ready');
    assert.notEqual(prepared.binding.sessionId, session.sessionId);
    assert.equal(prepared.run, null);
    assert.equal(prepared.task.controlMode, 'paused');
    console.log(
      'PASS original owner chat accepted the delivered result, revised a goal, inspected an existing session, rejected stale/declined consent, attached on a short reply, detached and prepared a new Worker',
    );
  }
}
