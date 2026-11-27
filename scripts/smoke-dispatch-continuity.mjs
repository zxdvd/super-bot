import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  rosterGoal,
  rosterDirection,
  rosterDraft,
  rosterFinal,
} from '../test/stage-host-fixture.ts';

export async function smokeDispatchContinuity({
  base,
  bundle,
  configure,
  launch,
  stop,
  call,
  makeBot,
  probe,
  wait,
}) {
  const role = process.env.SUPER_BOT_TEST_DISPATCH_HOST;
  assert.ok(['web', 'desktop'].includes(role));
  const prior = process.env.SUPER_BOT_TEST_PRIOR_LIB;
  const plugin = join(bundle, 'lib', 'index.js');
  const candidate = prior ? await readFile(plugin) : null;
  if (prior) await copyFile(join(prior, 'index.js'), plugin);
  await configure(role, { hmr: false, fullAccess: true });
  let host = await launch(role, 'initial');
  const bot = await makeBot(host, '名单整理');
  const say = (text) => probe(host, 'native-prompt', bot.managerId, text);
  const tasks = () => call(host, 'task.list', { botId: bot.id });
  const inspect = (session) => probe(host, 'inspect-session', session);
  await probe(host, 'select-test-model', bot.managerId);
  await say(rosterGoal);
  const task = await wait(
    async () => (await tasks()).items.find((item) => item.goal === rosterGoal),
    'original task',
  );
  const detail = () => call(host, 'task.detail', { id: task.id, sessionId: bot.managerId });
  const first = await wait(async () => {
    const state = await detail();
    return state.binding?.sessionId && (await inspect(state.binding.sessionId)).stalled && state;
  }, 'Worker holding the old draft');
  const session = first.binding.sessionId;
  const file = join(first.binding.cwd, 'roster.txt');
  assert.equal(await readFile(file, 'utf8'), rosterDraft);
  await say(rosterDirection);
  const pending = await detail();
  assert.equal(pending.directionStatus, 'next-run');
  assert.equal(pending.recoveryInstruction.source.text, rosterDirection);
  const sourceId = pending.recoveryInstruction.source.messageId;
  await probe(host, 'release-stalled-model', session);
  if (prior) {
    // Upgrade a real pending instruction after the old Manager has received a wake.
    await wait(async () => {
      const state = await detail();
      const events = (await inspect(bot.managerId)).events;
      const seen = events.filter(
        (event) =>
          event.type === 'user/message' &&
          event.data.source?.kind === 'super-bot-manager' &&
          event.data.source.eventId?.includes(pending.recoveryInstruction.id),
      );
      return (
        state.directionStatus === 'recorded' &&
        !state.runHeld &&
        seen.length >= 1 &&
        events.some((event) => event.type === 'turn/end' && event.seq > seen.at(-1).seq)
      );
    }, 'baseline kept the direction but never handed it to the Worker');
    assert.equal(await readFile(file, 'utf8'), rosterDraft);
    await stop(role);
    await writeFile(plugin, candidate);
    host = await launch(role, 'upgraded');
  }
  const done = await wait(
    async () => {
      const state = await detail();
      return (
        state.directionStatus === 'entered' &&
        state.chatDelivery?.state === 'delivered' &&
        state.deliveredResult?.id === state.result?.id &&
        state
      );
    },
    'saved owner instruction delivered as a real edit and final chat result',
    300,
  );
  const verify = async () => {
    const worker = await inspect(session);
    const inputs = worker.events.filter(
      (event) => event.type === 'user/message' && event.data.source.kind === 'super-bot',
    );
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0].data.source.runId, first.run.id);
    assert.equal(inputs[1].data.source.runId, done.run.id);
    assert.equal(inputs[1].data.source.taskId, task.id);
    assert.ok(inputs[1].data.content.some((item) => item.text?.includes(rosterDirection)));
    assert.equal(done.recoveryInstruction.source.messageId, sourceId);
    assert.equal((await tasks()).total, 1);
    assert.equal(await readFile(file, 'utf8'), rosterFinal);
    assert.equal(worker.executedTools.filter((name) => name === 'bash').length, 1);
    assert.equal(worker.executedTools.filter((name) => name === 'write').length, 2);
    assert.ok(!worker.executedTools.includes('super_bot_gitlab_play'));
    const manager = await inspect(bot.managerId);
    assert.equal(
      manager.managerAttempts.filter((a) => a.action === 'continue' && !a.userInstruction).length,
      0,
      'the host handles saved directions without another model decision',
    );
    const state = await detail();
    assert.equal(state.deliveredResult.id, done.result.id);
    assert.equal(state.run.id, done.run.id);
  };
  await verify();
  await stop(role);
  host = await launch(role, 'reopened');
  await verify();
  await writeFile(
    join(base, 'dispatch-proof.json'),
    JSON.stringify(
      {
        role,
        upgraded: !!prior,
        taskId: task.id,
        ownerMessageId: sourceId,
        firstRun: first.run.id,
        successor: done.run.id,
        result: done.result.id,
        workerReceived: 1,
        confirmedAfterRestart: true,
        changedLine: '26 已补',
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS',
    role,
    prior ? 'upgrade' : 'same version',
    'original chat follow-up, exactly one successor, correct file and final delivery across restart',
  );
}
