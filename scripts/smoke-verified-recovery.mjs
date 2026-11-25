/** Real native DSH Worker and Manager, using an isolated deterministic model. */
import assert from 'node:assert/strict';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { deploymentEffectGoal, deploymentEffectRequest, deploymentRecoveryGoal, deploymentRecoveryRequest,
  effectRecoveryGoal, effectRecoveryRequest,
  permissionRecoveryGoal, permissionRecoveryRequest, readRecoveryGoal, readRecoveryRequest,
  recoveryEffectName, recoveryEffectText, recoveryFileName } from '../test/recovery-host-fixture.ts';

const role = process.env.SUPER_BOT_TEST_CONTEXT_HOST === 'desktop' ? 'desktop' : 'web';
const matchingEvents = (state, kind) => state.events.filter(event => event.kind === kind).map(event => JSON.parse(event.data));
const outcomes = manager => manager.toolResults.flatMap(result => result.message.content).flatMap(block => {
  if (block.type !== 'text') return [];
  try { return [JSON.parse(block.text)]; } catch { return []; }
});

export async function smokeVerifiedRecovery({ base, configure, launch, call, makeBot, probe, wait }) {
  await configure(role, { hmr: false, fullAccess: true });
  const bin = join(base, 'bin'), readyFlag = join(base, 'fake-deployment-ready'), kubectlLog = join(base, 'kubectl-reads.jsonl');
  await mkdir(bin);
  const fakeKubectl = await readFile(new URL('../test/kubectl-host-fixture.mjs', import.meta.url), 'utf8');
  await writeFile(join(bin, 'kubectl'), `#!${process.execPath}\n${fakeKubectl
    .replace('__READ_LOG__', JSON.stringify(kubectlLog)).replace('__DEPLOYMENT_READY__', JSON.stringify(readyFlag))}`, { mode: 0o700 });
  const host = await launch(role, 'verified-recovery', { path: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` });
  const inspect = id => probe(host, 'inspect-session', id);

  async function createScenario(name, goal, message, initialClusterStatus) {
    const bot = await makeBot(host, name);
    await probe(host, 'select-test-model', bot.managerId);
    await probe(host, 'native-prompt', bot.managerId, message);
    const task = await wait(async () => (await call(host, 'task.list', { botId: bot.id })).items
      .find(item => item.goal === goal && item.status === 'recovery'), `original task enters recovery: ${goal}`);
    const detail = () => call(host, 'task.detail', { id: task.id, sessionId: bot.managerId });
    const before = await detail();
    const session = before.binding.sessionId;
    const worker = await inspect(session);
    const tool = initialClusterStatus ? 'super_bot_preflight' : 'read';
    assert.ok(worker.executedTools.includes(tool), JSON.stringify(worker.executedTools));
    const originalStatus = initialClusterStatus
      ? outcomes(worker).find(item => item.status === initialClusterStatus)?.status
      : worker.toolResults.find(result => result.message.isError)?.error?.code;
    assert.equal(originalStatus, initialClusterStatus ?? 'FS_NOT_FOUND', `preflight must show its actual starting state: ${goal}`);
    assert.ok(worker.events.some(event => event.type === 'turn/end' && event.seq === before.runTurn.endSeq));
    assert.equal(before.run.state, 'failed');
    assert.equal(before.result, null);
    assert.equal(before.attentions.find(attention => attention.kind === 'recovery').state, 'open');
    return { bot, detail, before, worker, originalStatus, session };
  }

  async function managerOutcome(scenario, expectedStatus) {
    return wait(async () => {
      const manager = await inspect(scenario.bot.managerId);
      if (manager.status !== 'idle') return false;
      const reports = outcomes(manager).filter(item => item.runId === scenario.before.run.id && item.status !== 'eligible');
      if (!reports.length) return false;
      const outcome = reports.find(item => item.status === expectedStatus);
      assert.ok(outcome, `Expected ${expectedStatus}, got ${JSON.stringify(reports)}`);
      return { manager, outcome };
    }, `${expectedStatus} result from native Manager tools`);
  }

  function sameAttempt(scenario, final) {
    assert.equal(final.task.id, scenario.before.task.id);
    assert.equal(final.run.id, scenario.before.run.id);
    assert.equal(final.binding.sessionId, scenario.session);
    assert.equal(final.run.state, 'failed');
    assert.equal(final.result, null);
    assert.equal(matchingEvents(final, 'run.queued').length, 1);
    assert.deepEqual(matchingEvents(final, 'run.settled'), matchingEvents(scenario.before, 'run.settled'));
  }

  const safe = await createScenario('隔离恢复 · 只读', readRecoveryGoal, readRecoveryRequest);
  await wait(async () => (await inspect(safe.bot.managerId)).stalled, 'Manager is about to inspect original failure');
  await writeFile(join(safe.before.binding.cwd, recoveryFileName), 'Fixture appeared after the original Worker failure.\n', { flag: 'wx' });
  await probe(host, 'release-stalled-model', safe.bot.managerId);
  const recovered = await managerOutcome(safe, 'readable');
  const afterSafe = await safe.detail();
  sameAttempt(safe, afterSafe);
  assert.equal(afterSafe.attentions.find(attention => attention.kind === 'recovery').state, 'resolved');
  const started = matchingEvents(afterSafe, 'run.recovery-check-started');
  const confirmed = matchingEvents(afterSafe, 'run.recovery-confirmed');
  assert.equal(started.length, 1);
  assert.equal(confirmed.length, 1, 'replaying the tool does not run the probe again');
  assert.equal(started[0].actor, 'manager');
  assert.equal(started[0].runId, safe.before.run.id);
  assert.ok(started[0].callSeq < started[0].resultSeq && started[0].resultSeq < started[0].endSeq);
  assert.equal(confirmed[0].actor, 'manager');
  assert.equal(confirmed[0].runId, safe.before.run.id);
  assert.equal(confirmed[0].result.status, 'readable');
  assert.equal(confirmed[0].performed, true);
  assert.ok(outcomes(recovered.manager).some(item => item.status === 'already-checked' && item.runId === safe.before.run.id));
  assert.equal(recovered.manager.managerAttempts.filter(attempt => attempt.action === 'recover-preflight').length, 2);
  assert.ok(recovered.manager.managerAttempts.some(attempt => attempt.action === 'list'));
  assert.ok(recovered.manager.executedTools.includes('bash'));
  const guardErrors = recovered.manager.toolResults.filter(result => result.message.isError).map(result => result.error?.reason
    ?? result.message.content.filter(block => block.type === 'text').map(block => block.text).join(''));
  assert.ok(guardErrors.some(error => error.includes('恢复通知只允许对同一任务')), JSON.stringify(guardErrors));
  assert.ok(guardErrors.some(error => /恢复通知未授权原生工具|tool .*bash.*not found|only the current task’s read-only recovery tools are authorized/i.test(error)), JSON.stringify(guardErrors));
  const dataDir = dirname(dirname(safe.before.binding.cwd));
  await assert.rejects(access(join(dataDir, 'managers', safe.bot.id, 'recovery-guard-probe.txt')), { code: 'ENOENT' });
  assert.ok(recovered.manager.assistantTexts.some(text => text.includes(recovered.outcome.message)));
  assert.equal((await call(host, 'task.list', { botId: safe.bot.id })).total, 1);
  assert.deepEqual((await inspect(safe.session)).executedTools, safe.worker.executedTools);

  const uncertain = await createScenario('隔离恢复 · 有写入', effectRecoveryGoal, effectRecoveryRequest);
  const blocked = await managerOutcome(uncertain, 'needs-human');
  const afterUncertain = await uncertain.detail();
  sameAttempt(uncertain, afterUncertain);
  assert.equal(afterUncertain.attentions.find(attention => attention.kind === 'recovery').state, 'open');
  assert.deepEqual(matchingEvents(afterUncertain, 'run.recovery-check-started'), []);
  assert.deepEqual(matchingEvents(afterUncertain, 'run.recovery-confirmed'), []);
  assert.ok(blocked.outcome.priorTools.some(item => item.tool === 'write'));
  assert.ok(blocked.manager.assistantTexts.some(text => text.includes(blocked.outcome.message)));
  assert.equal(blocked.manager.managerAttempts.filter(attempt => attempt.action === 'recover-preflight').length, 0);
  assert.equal(await readFile(join(uncertain.before.binding.cwd, recoveryEffectName), 'utf8'), recoveryEffectText);
  assert.deepEqual((await inspect(uncertain.session)).executedTools, uncertain.worker.executedTools);
  assert.equal(uncertain.worker.executedTools.filter(name => name === 'write').length, 1);
  assert.equal((await call(host, 'task.list', { botId: uncertain.bot.id })).total, 1);

  const permission = await createScenario('隔离恢复 · 权限不足', permissionRecoveryGoal, permissionRecoveryRequest, 'denied');
  await wait(async () => (await inspect(permission.bot.managerId)).stalled, 'Manager is about to inspect prior permission denial');
  const reads = async () => (await readFile(kubectlLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(await reads(), ['config', 'whoami', 'can-i']);
  await probe(host, 'release-stalled-model', permission.bot.managerId);
  const denied = await managerOutcome(permission, 'denied');
  const afterDenied = await permission.detail();
  sameAttempt(permission, afterDenied);
  const denial = matchingEvents(afterDenied, 'run.recovery-confirmed');
  assert.equal(denial.length, 1);
  assert.equal(denial[0].performed, false);
  assert.equal(denial[0].result.status, 'denied');
  assert.equal(afterDenied.task.status, 'blocked');
  assert.match(denied.outcome.message, /fixture-shared.*get persistentvolumeclaims/);
  assert.ok(denied.manager.assistantTexts.some(text => text.includes(denied.outcome.message)));
  assert.deepEqual(await reads(), ['config', 'whoami', 'can-i'], 'prior permission denial never triggers a permission request or an extra check');

  const deployment = await createScenario('隔离恢复 · Kubernetes 状态', deploymentRecoveryGoal, deploymentRecoveryRequest, 'missing');
  await wait(async () => (await inspect(deployment.bot.managerId)).stalled, 'Manager is about to inspect prior object state');
  await writeFile(readyFlag, 'The fake resource is now present and ready.\n', { flag: 'wx' });
  await probe(host, 'release-stalled-model', deployment.bot.managerId);
  const present = await managerOutcome(deployment, 'present');
  const afterDeployment = await deployment.detail();
  sameAttempt(deployment, afterDeployment);
  assert.deepEqual(present.outcome.observed, { uid: 'fixture-deployment-uid', ready: true });
  assert.equal(afterDeployment.attentions.find(attention => attention.kind === 'recovery').state, 'resolved');
  const appliedRead = matchingEvents(afterDeployment, 'run.recovery-confirmed');
  assert.equal(appliedRead.length, 1);
  assert.equal(appliedRead[0].performed, true);
  assert.deepEqual(await reads(), ['config', 'whoami', 'can-i', 'config', 'whoami', 'get', 'config', 'whoami', 'get']);

  await unlink(readyFlag);
  const uncertainDeployment = await createScenario('隔离恢复 · 有写入且可核对现状', deploymentEffectGoal, deploymentEffectRequest, 'missing');
  await wait(async () => (await inspect(uncertainDeployment.bot.managerId)).stalled, 'Manager is about to inspect prior effect and object state');
  await writeFile(readyFlag, 'The fake resource now exists, with no evidence of who caused it.\n', { flag: 'wx' });
  await probe(host, 'release-stalled-model', uncertainDeployment.bot.managerId);
  const readback = await managerOutcome(uncertainDeployment, 'present');
  const afterReadback = await uncertainDeployment.detail();
  sameAttempt(uncertainDeployment, afterReadback);
  assert.equal(readback.outcome.effectUncertain, true);
  assert.ok(readback.manager.assistantTexts.some(text => text.includes(readback.outcome.message) && text.includes('仍待核对')));
  assert.deepEqual(readback.outcome.observed, { uid: 'fixture-deployment-uid', ready: true });
  assert.deepEqual(matchingEvents(afterReadback, 'run.recovery-confirmed'), []);
  const observations = matchingEvents(afterReadback, 'run.recovery-observed');
  assert.equal(observations.length, 1);
  assert.equal(observations[0].performed, true);
  assert.equal(observations[0].effectUncertain, true);
  assert.equal(afterReadback.attentions.find(attention => attention.kind === 'recovery').state, 'open');
  assert.deepEqual((await inspect(uncertainDeployment.session)).executedTools, uncertainDeployment.worker.executedTools);
  assert.equal(uncertainDeployment.worker.executedTools.filter(name => name === 'write').length, 1);
  assert.equal(await readFile(join(afterReadback.binding.cwd, recoveryEffectName), 'utf8'), recoveryEffectText);
  assert.deepEqual((await reads()).slice(9), ['config', 'whoami', 'get', 'config', 'whoami', 'get']);

  const proof = { role, read: { taskId: safe.before.task.id, priorRun: safe.before.run.id,
    outcome: recovered.outcome.status, audit: { started, confirmed }, duplicate: 'already-checked', guardErrors },
  potentialEffect: { taskId: uncertain.before.task.id, priorRun: uncertain.before.run.id,
    outcome: blocked.outcome.status, priorTools: blocked.outcome.priorTools },
  missingPermission: { taskId: permission.before.task.id, priorRun: permission.before.run.id, outcome: denied.outcome.status, audit: denial },
  readKubernetesStatus: { taskId: deployment.before.task.id, priorRun: deployment.before.run.id,
    outcome: present.outcome.status, observed: present.outcome.observed, audit: appliedRead },
  uncertainEffectWithReadback: { taskId: uncertainDeployment.before.task.id, priorRun: uncertainDeployment.before.run.id,
    outcome: readback.outcome.status, observed: readback.outcome.observed, audit: observations },
  kubectl: { transport: 'local fixture executable, no network', invocations: await reads() } };
  await writeFile(join(base, 'verified-recovery-proof.json'), JSON.stringify(proof, null, 2));
  console.log(`PASS verified recovery using native ${role} with deterministic model: ${JSON.stringify(proof)}; ${base}`);
}
