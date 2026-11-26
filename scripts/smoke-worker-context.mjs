/** Real native DSH inbox, model history, compaction and tool execution with a deterministic provider. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const answer = '读者是新同事，保持简短。';
const rework = '再加一句结论。';
const fullOnly = process.env.SUPER_BOT_TEST_EXPECT_FULL_CONTEXT === '1';
const role = process.env.SUPER_BOT_TEST_CONTEXT_HOST === 'desktop' ? 'desktop' : 'web';

export async function smokeWorkerContext({ base, configure, launch, call, makeBot, probe, wait }) {
  await configure(role, { hmr: false, fullAccess: true });
  const host = await launch(role, 'context');
  const bot = await makeBot(host, '隔离 Worker 上下文');
  const say = (text) => probe(host, 'native-prompt', bot.managerId, text);
  const inspect = (id) => probe(host, 'inspect-session', id);
  const list = () => call(host, 'task.list', { botId: bot.id });
  await probe(host, 'select-test-model', bot.managerId);
  await say('请写一份说明，先确认读者。');
  const task = await wait(
    async () => (await list()).items.find((item) => item.status === 'needs-input'),
    'initial Worker question',
  );
  const detail = () => call(host, 'task.detail', { id: task.id, sessionId: bot.managerId });
  const waiting = await detail();
  const session = waiting.binding.sessionId;
  assert.equal(waiting.pendingQuestions.length, 1);
  await wait(async () => {
    const manager = await inspect(bot.managerId);
    return (
      manager.status === 'idle' &&
      manager.assistantTexts.some((text) =>
        text.includes(encodeURIComponent(waiting.pendingQuestions[0].id)),
      )
    );
  }, 'question linked in original Bot chat');

  async function reviewedAfter(runId, label) {
    return wait(async () => {
      const state = await detail();
      return (
        state.run?.id !== runId &&
        state.run.state === 'settled' &&
        state.task.managerReviewed &&
        state.chatDelivery.state === 'delivered' &&
        state.deliveredResult?.id === state.result.id &&
        state
      );
    }, label);
  }
  await say(answer);
  const answered = await reviewedAfter(waiting.run.id, 'answer reaches same Worker');
  assert.equal(answered.input.attentionId, waiting.pendingQuestions[0].id);
  await say(rework);
  const revised = await reviewedAfter(answered.run.id, 'rework reaches same Worker');
  assert.notEqual(revised.result.id, answered.result.id);
  const compaction = await probe(host, 'compact-worker-context', session, waiting.run.id);
  assert.ok(compaction.shadowed > 0);
  await say(rework);
  const fallback = await reviewedAfter(
    revised.run.id,
    'rework after native compaction receives full context',
  );

  const states = [waiting, answered, revised, fallback];
  const worker = await inspect(session);
  const captures = states.map((state, index) => {
    assert.equal(state.task.id, task.id);
    assert.equal(state.binding.sessionId, session);
    assert.equal(state.binding.generation, waiting.binding.generation);
    assert.equal(state.task.taskRevision, waiting.task.taskRevision);
    const event = worker.events.find(
      (e) =>
        e.type === 'user/message' &&
        e.data.source.kind === 'super-bot' &&
        e.data.source.runId === state.run.id,
    );
    const seen = worker.workerContexts.find((entry) => entry.runId === state.run.id);
    assert.ok(event && seen, `expected persisted and model-visible input for attempt ${index + 1}`);
    assert.equal(event.data.source.inputId, state.input.id);
    assert.equal(seen.inputId, state.input.id);
    assert.equal(state.runTurn.inputSeq, event.seq);
    assert.ok(worker.events.some((e) => e.type === 'turn/end' && e.seq === state.runTurn.endSeq));
    const body = event.data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    assert.equal(seen.bytes, Buffer.byteLength(body));
    assert.equal(seen.characters, [...body].length);
    assert.ok(body.includes(state.run.id), 'current Run remains explicit');
    assert.match(body, /fresh super_bot_report/, 'each Run requests its own report');
    const hasFull = /^Goal: ASK_PROBE$/m.test(body);
    assert.equal(
      hasFull,
      fullOnly || index === 0 || index === 3,
      `context form of attempt ${index + 1}`,
    );
    for (const section of [
      'Bot configuration revision:',
      'Bot responsibility:',
      'Authorized scope:',
      'Acceptance criteria:',
      'Working directory:',
    ]) {
      assert.equal(body.includes(section), hasFull, `${section} in attempt ${index + 1}`);
    }
    if (index > 0)
      assert.ok(
        body.includes(index === 1 ? answer : rework),
        'continuation contains latest user text',
      );
    const carriedInputs = event.data.source.carriedInputIds ?? [];
    if (!fullOnly && index === 3) {
      assert.deepEqual(carriedInputs, [answered.input.id, revised.input.id]);
      assert.ok(body.includes(`Previously received task input (answer): ${answer}`));
      assert.ok(body.includes(`Previously received task input (rework): ${rework}`));
    } else assert.deepEqual(carriedInputs, []);
    return {
      attempt: ['first', 'answer', 'rework', 'afterCompaction'][index],
      form: hasFull ? 'full' : 'delta',
      carriedInputs,
      ...seen,
    };
  });
  assert.deepEqual(captures[1].previousFullRunIds, [waiting.run.id]);
  assert.ok(captures[2].previousFullRunIds.includes(waiting.run.id));
  assert.deepEqual(
    captures[3].previousRunIds,
    [],
    'compaction removes exact prompts from the model-visible history',
  );
  assert.equal((await list()).total, 1);
  assert.equal(fallback.result.humanAcceptedAt, null);
  const result = { role, taskId: task.id, session, compaction, captures };
  await writeFile(join(base, 'worker-context-proof.json'), JSON.stringify(result, null, 2));
  console.log(
    `PASS Worker context using native ${role} with deterministic model: ${JSON.stringify(result)}; ${base}`,
  );
}
