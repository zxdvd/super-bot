import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { hostClient } from './host-client.mjs';

const root = resolve('.');
await mkdir(join(root, '.runtime'), { recursive: true });
const base = await mkdtemp(join(root, '.runtime/late-jobs-'));
const home = join(base, 'super-bot/.runtime/dsh'), osHome = join(base, 'os-home');
const lib = join(base, 'lib'), fixture = join(base, 'fixture.js'), patch = join(base, 'host.patch.json');
const cli = process.env.SUPER_BOT_TEST_WEB_ENTRY ?? join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const env = { PATH: process.env.PATH, HOME: osHome, DSH_HOME: home, TMPDIR: osHome, DSH_TELEMETRY_DISABLED: '1' };
await mkdir(home, { recursive: true });
await mkdir(osHome, { recursive: true });
const command = (args, opts = {}) => new Promise((success, failure) => {
  const child = spawn(process.execPath, args, { cwd: root, env, ...opts });
  child.once('error', failure);
  child.once('close', code => code === 0 ? success() : failure(Error(`isolated command failed: ${args[0]}`)));
});
await command(['scripts/build.mjs'], { env: { ...env, SUPER_BOT_BUILD_OUTDIR: lib }, stdio: 'inherit' });
await build({ entryPoints: ['test/host-probe.ts'], outfile: fixture, bundle: true, format: 'esm', platform: 'node', packages: 'external' });
await command([cli, '--profile', 'late-jobs', '--from-default-profile', 'web', '--dump-config'], { stdio: 'ignore' });
await writeFile(patch, JSON.stringify([{ id: 'hmr', disabled: true }, { insert: [
  { id: 'super-bot', name: join(lib, 'index.js') },
  { id: 'super-bot-contract-probe', name: fixture },
] }]));

let active, client;
async function launch(label) {
  const log = join(base, label + '.log'), out = await open(log, 'wx', 0o600);
  const child = spawn(process.execPath, [cli, '--profile', 'late-jobs', '--patch', patch, '--no-open', '--port', '0'],
    { cwd: root, env, stdio: ['ignore', out.fd, out.fd] });
  const closed = new Promise(resolve => child.once('close', resolve));
  active = { child, closed, out };
  client = await hostClient(log);
}
async function stop() {
  if (!active) return;
  const { child, closed, out } = active;
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 4000);
  await closed;
  clearTimeout(timeout);
  await out.close();
  active = undefined;
}
async function call(action, data = {}) {
  const response = await client.post('/api/super-bot', {
    type: 'client-request', rpcId: randomUUID(), method: 'super-bot', payload: { action, ...data },
  });
  const { result } = await response.json();
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
async function probe(action, sessionId, extra = {}) {
  const value = await (await client.post('/api/super-bot-probe', { action, sessionId, ...extra })).json();
  assert.equal(value.ok, true, JSON.stringify(value));
  return value;
}
async function wait(fn, label) {
  for (let n = 0; n < 450; n++) {
    const value = await fn();
    if (value) return value;
    await delay(100);
  }
  assert.fail(`timeout: ${label} (isolated evidence: ${base})`);
}
const message = event => event.data.content.map(block => block.type === 'text' ? block.text : '').join('');
const events = (state, kind) => state.events.filter(event => event.kind === kind).map(event => JSON.parse(event.data));

try {
  await launch('first');
  const bot = await call('bot.create', { requestId: randomUUID(), name: 'Late native Jobs', instructions: 'Scoped research fixture' });
  const { sessionId: chat } = await call('manager.prepare', { requestId: randomUUID(), botId: bot.id });
  await probe('select-test-model', chat);
  const detail = id => call('task.detail', { id, sessionId: chat });
  const start = async label => {
    const goal = 'LATE_JOB_RESEARCH_' + label;
    await probe('native-prompt', chat, { text: goal });
    const task = (await call('task.list', { botId: bot.id })).items.find(item => item.goal === goal);
    assert.ok(task);
    const entered = await wait(async () => {
      const work = await detail(task.id);
      if (!work.runHeld || !work.binding?.sessionId) return;
      const native = await probe('late-job-events', work.binding.sessionId);
      return native.stalled && native.events.some(event => event.type === 'job/registered') && work;
    }, 'original Worker launched the native job');
    await probe('late-job-abort', entered.binding.sessionId);
    const pending = await wait(async () => {
      const work = await detail(task.id);
      return work.run?.state === 'interrupted' && work.lateJobRecovery?.state === 'waiting' && work;
    }, 'interrupted attempt holds its exact Job identity');
    assert.equal(pending.runTurn.endKind, 'aborted');
    assert.equal(pending.runTurn.quiet, 0);
    assert.equal(pending.runHeld, true);
    assert.equal(pending.result, null);
    assert.equal(pending.lateJobRecovery.ids.length, 1);
    return pending;
  };
  const releaseJob = async work => {
    await writeFile(join(work.binding.cwd, 'release-late-job'), 'release\n', { flag: 'wx' });
    return wait(async () => {
      const native = await probe('late-job-events', work.binding.sessionId);
      return native.stalled && native.events.some(event => event.type === 'user/message' && event.data.source.kind === 'tool-jobs') && native;
    }, 'separate native notice turn received inline job result');
  };
  const finishNotice = work => probe('release-stalled-model', work.binding.sessionId);
  const control = (verb, work) => probe('native-prompt', chat, { text: `请${verb}「${work.task.goal}」的原计划。` });
  const old = await start('RESTART');
  await wait(async () => (await probe('inspect-session', chat)).assistantTexts
    .find(text => text.includes('仍在等待后台 Job 终态和原生结果消费')), 'original chat receives waiting status');
  const supplement = `LATE_JOB_APPEND ${old.task.id} 请在报告附上部署限制，其他照旧。`;
  await probe('native-prompt', chat, { text: supplement });
  const appended = await detail(old.task.id);
  assert.equal(appended.lateJobRecovery.state, 'waiting');
  assert.equal(appended.run.id, old.run.id);
  assert.equal(appended.recoveryInstruction?.source.text, supplement);
  assert.deepEqual(appended.lateJobRecovery.ids, old.lateJobRecovery.ids);
  await releaseJob(old);
  const whileNoticeRuns = await detail(old.task.id);
  assert.equal(whileNoticeRuns.run.id, old.run.id);
  assert.equal(whileNoticeRuns.runHeld, true);
  assert.equal(whileNoticeRuns.result, null);
  const hold = probe('native-prompt', chat, { text: 'LATE_JOB_MANAGER_HOLD' }).catch(() => {});
  await wait(async () => (await probe('inspect-session', chat)).stalled, 'current owner conversation keeps new dispatch waiting');
  await finishNotice(old);
  const ready = await wait(async () => {
    const work = await detail(old.task.id);
    return work.lateJobRecovery?.state === 'ready' && work;
  }, 'durable convergence proof before the host restart');
  assert.equal(ready.run.id, old.run.id);
  assert.equal(ready.runHeld, true);
  await stop();
  await hold;
  await launch('restart');
  const final = await wait(async () => {
    const work = await detail(old.task.id);
    return work.chatDelivery?.state === 'delivered' && work;
  }, 'original task continued and original Manager chat delivered');
  assert.equal(final.task.id, old.task.id);
  assert.equal(final.binding.sessionId, old.binding.sessionId);
  assert.equal(final.binding.generation, old.binding.generation);
  assert.equal(final.task.reviewPolicy, old.task.reviewPolicy);
  assert.match(final.lateJobPriorEffects, /旧轮外部效果仍待核实/);
  assert.equal(events(final, 'run.late-job-continued').length, 1);
  assert.equal(events(final, 'run.queued').length, 2);
  assert.equal(events(final, 'run.settled').length, 1);
  assert.equal(final.result.humanAcceptedAt, null);
  assert.equal(await readFile(join(old.binding.cwd, 'job-marker.txt'), 'utf8'), 'JOB_EFFECT_ONCE\n');
  const worker = await probe('late-job-events', final.binding.sessionId);
  const inputs = worker.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'super-bot');
  assert.equal(inputs.length, 2);
  assert.equal(worker.events.filter(event => event.type === 'job/registered').length, 1);
  assert.ok(ready.lateJobRecovery.proof.lastSeq < inputs[1].seq);
  assert.match(message(inputs[1]), /已记录现状调研的基线/);
  assert.ok(message(inputs[1]).includes(supplement));
  assert.equal(final.recoveryInstruction.runId, final.run.id);
  assert.equal((await probe('inspect-session', chat)).assistantTexts.filter(text => text.includes(final.result.id)).length, 1);

  const duplicate = await start('DUPLICATE');
  await releaseJob(duplicate);
  await probe('late-job-duplicate-terminal', duplicate.binding.sessionId);
  await finishNotice(duplicate);
  const ambiguous = await wait(async () => {
    const work = await detail(duplicate.task.id);
    return work.lateJobRecovery?.state === 'blocked' && work;
  }, 'ambiguous terminal fails closed');
  assert.equal(ambiguous.run.id, duplicate.run.id);
  assert.equal(ambiguous.runHeld, true);
  assert.equal(ambiguous.result, null);

  const takeover = await start('TAKEOVER');
  await releaseJob(takeover);
  await probe('queue-native', takeover.binding.sessionId, { text: '用户直接接管原 Worker。' });
  assert.equal((await detail(takeover.task.id)).run.id, takeover.run.id);
  await finishNotice(takeover);
  await wait(async () => (await detail(takeover.task.id)).task.controlMode === 'manual', 'new native owner input takes over');
  await control('恢复', takeover);
  const afterTakeover = await detail(takeover.task.id);
  assert.equal(afterTakeover.run.id, takeover.run.id);
  assert.equal(afterTakeover.lateJobRecovery.state, 'blocked', 'restoring management cannot revive an owner takeover');

  const closing = await start('CLOSE');
  await control('关闭', closing);
  await releaseJob(closing);
  await finishNotice(closing);
  await wait(async () => (await probe('late-job-events', closing.binding.sessionId)).status === 'idle', 'closed native notice ended');
  const afterClose = await detail(closing.task.id);
  assert.ok(afterClose.closeRequest || afterClose.task.lifecycle === 'cancelled');
  assert.equal(afterClose.run.id, closing.run.id);
  assert.equal(afterClose.result, null);

  const paused = await start('PAUSE');
  await control('暂停', paused);
  await releaseJob(paused);
  await finishNotice(paused);
  await wait(async () => (await probe('late-job-events', paused.binding.sessionId)).status === 'idle', 'paused native notice ended');
  const afterPause = await detail(paused.task.id);
  assert.equal(afterPause.task.controlMode, 'paused');
  assert.equal(afterPause.run.id, paused.run.id);
  assert.equal(afterPause.runHeld, true);
  assert.equal(afterPause.result, null);
  const proofWhilePaused = await wait(async () => {
    const work = await detail(paused.task.id);
    return work.lateJobRecovery?.state === 'ready' && work;
  }, 'read-only proof was safely recorded while the task was paused');
  assert.equal(proofWhilePaused.task.controlMode, 'paused');
  assert.equal(proofWhilePaused.run.id, paused.run.id);
  await control('恢复', paused);
  const resumed = await wait(async () => {
    const work = await detail(paused.task.id);
    return work.chatDelivery?.state === 'delivered' && work;
  }, 'explicit resume in original chat delivers the same paused task');
  assert.equal(resumed.task.id, paused.task.id);
  assert.equal(resumed.binding.sessionId, paused.binding.sessionId);
  assert.equal(resumed.task.controlMode, 'auto');
  assert.equal(events(resumed, 'run.queued').length, 2);
  assert.equal(events(resumed, 'run.late-job-continued').length, 1);
  assert.equal(events(resumed, 'run.settled').length, 1);
  await control('恢复', paused);
  assert.equal(events(await detail(paused.task.id), 'run.queued').length, 2, 'repeated resume does not replay the task');
  assert.equal((await probe('inspect-session', chat)).assistantTexts.filter(text => text.includes(resumed.result.id)).length, 1);
  await writeFile(join(base, 'proof.json'), JSON.stringify({
    taskId: old.task.id, worker: old.binding.sessionId, manager: chat, firstRun: old.run.id, nextRun: final.run.id,
    oldTurn: old.runTurn, late: ready.lateJobRecovery.proof, resultId: final.result.id,
    additiveOwnerDirection: true, duplicateTerminal: ambiguous.lateJobRecovery.reason,
    takeoverPreventsSuccessor: true, closePreventsSuccessor: true, pausePreventsSuccessor: true,
    resume: { taskId: resumed.task.id, worker: resumed.binding.sessionId, priorRun: paused.run.id, nextRun: resumed.run.id,
      resultId: resumed.result.id, noticeConsumedDuringPause: proofWhilePaused.lateJobRecovery.proof.lastSeq },
  }, null, 2));
  console.log(`PASS late Job held and consumed separately, restart and chat resume deliver once, duplicate/close/takeover blocked (${base})`);
} finally { await stop(); }
