import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { Session } from '@deepseek-ai/dsh-session';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { renderContextSections, SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { DshExecution } from '../../src/dsh.ts';
import type { Binding, Run, RunInput, Task, WorkerPriorInput } from '../../src/model.ts';
import { Store } from '../../src/store.ts';
import {
  createWorkerRunMessage as buildMessage,
  registerWorkerContext,
  workerPromptPlan,
  workerStandingPrompt,
} from '../../src/worker-prompt.ts';

const sessionId = SessionId('worker-test');
const task = {
  goal: 'Prepare the operator summary',
  scope: 'Edit one draft in this checkout',
  acceptance: 'Include the verified totals',
  botConfigRevision: 4,
} as Task;
const binding = { cwd: '/tmp/super-bot-worker-prompt' } as Binding;
const standing = workerStandingPrompt(
  task,
  binding,
  {
    instructions: 'Prepare reports for the operations team',
    materials: [],
    workConvention: { source: 'default', text: 'Use Markdown tables' },
  },
  false,
);
const initial: Run = {
  id: 'initial',
  taskId: 'task-a',
  bindingId: 'binding-a',
  sessionId,
  taskRevision: 3,
  generation: 1,
  inputId: 'input-initial',
  state: 'settled',
  createdAt: 0,
  finishedAt: 1,
  note: '',
};
const next: Run = {
  ...initial,
  id: 'next',
  inputId: 'input-next',
  state: 'queued',
  finishedAt: null,
  createdAt: 2,
};
function input(run: Run, kind = 'dispatch', content = task.goal): RunInput {
  return {
    id: run.inputId,
    taskId: run.taskId,
    kind,
    content,
    state: 'accepted',
    messageId: null,
    messageJson: null,
    attentionId: null,
    createdAt: 1,
  };
}
function createWorkerRunMessage(
  run: Run,
  input: RunInput,
  standing: string,
  mode: 'full' | 'delta',
  carried: WorkerPriorInput[] = [],
  recovery?: { note: string },
  inputOrder = 1,
): UserMessage {
  return buildMessage(run, input, standing, { mode, carried, inputOrder }, recovery);
}
function textOf(message: UserMessage): string {
  const block = message.content[0];
  assert.equal(block?.type, 'text');
  return block.text;
}
function fixture(id = sessionId) {
  const session = Session.create(id);
  const prompt = new SystemPrompt(new Context(), {});
  const agent = { session, ctx: { systemPrompt: prompt } } as unknown as Agent;
  const append = (message: UserMessage) =>
    session.append('user/message', message, { surfaceOp: 'append' });
  const replace = (seq: ReturnType<typeof append>['seq']) =>
    session.append(
      'user/message',
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Incomplete summary' }],
      }),
      { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
    );
  return { session, prompt, agent, append, replace };
}

test('first dispatch is full, while proven answer, rework and bare continuation are short', () => {
  const { agent, append } = fixture();
  assert.equal(workerPromptPlan(agent, initial, standing).mode, 'full');
  const full = createWorkerRunMessage(initial, input(initial), standing, 'full');
  assert.match(textOf(full), /Goal: Prepare the operator summary/);
  assert.match(textOf(full), /Authorized scope: Edit one draft in this checkout/);
  assert.match(textOf(full), /Acceptance criteria: Include the verified totals/);
  assert.match(textOf(full), /Bot responsibility: Prepare reports for the operations team/);
  assert.match(textOf(full), /Use Markdown tables/);
  assert.match(textOf(full), /Worker 完整权限未开启/);
  assert.match(textOf(full), /register each actual external deliverable in links/);
  append(full);
  assert.equal(workerPromptPlan(agent, next, standing).mode, 'delta');
  for (const kind of ['answer', 'rework', 'dispatch']) {
    const message = createWorkerRunMessage(
      next,
      input(next, kind, 'Use the chart dated Monday'),
      'unused',
      'delta',
    );
    const body = textOf(message);
    assert.match(body, /Current run: next/);
    assert.match(body, /existing authorized scope/);
    assert.match(body, /Submit a fresh super_bot_report/);
    assert.doesNotMatch(
      body,
      /Goal:|Authorized scope:|Acceptance criteria:|Bot responsibility:|Working directory:|unused/,
    );
    if (kind === 'dispatch') assert.doesNotMatch(body, /Use the chart dated Monday/);
    else assert.ok(body.includes(`Additional user input (${kind}): Use the chart dated Monday`));
  }
});

test('prior task text in the log or in a different binding never proves usable native context', () => {
  const { agent, session, append, replace } = fixture();
  const full = createWorkerRunMessage(initial, input(initial), standing, 'full');
  const event = append(full);
  for (const changed of [
    { taskId: 'other' },
    { bindingId: 'other' },
    { taskRevision: 4 },
    { generation: 2 },
    { sessionId: 'new' },
  ]) {
    assert.equal(workerPromptPlan(agent, { ...next, ...changed }, standing).mode, 'full');
  }
  assert.equal(workerPromptPlan(agent, next, standing + '\nChanged permissions').mode, 'full');
  replace(event.seq);
  assert.ok(
    session
      .snapshotEvents()
      .some((record) => record.type === 'user/message' && record.data.id === full.id),
  );
  assert.ok(!session.deriveMessages().some((message) => message.id === full.id));
  assert.equal(workerPromptPlan(agent, next, standing).mode, 'full');
  append(createUserMessage({ source: { kind: 'user' }, content: full.content }));
  assert.equal(workerPromptPlan(agent, next, standing).mode, 'full');
});

test('bare full fallback carries the prior applicable input and a requested recovery reason', () => {
  const { agent, append, replace } = fixture();
  const full = append(createWorkerRunMessage(initial, input(initial), standing, 'full'));
  const rework = input(next, 'rework', 'Keep Monday’s verified totals');
  const oldMessage = createWorkerRunMessage(next, rework, standing, 'delta');
  const previous: WorkerPriorInput = {
    id: rework.id,
    kind: 'rework',
    content: rework.content,
    messageId: oldMessage.id,
    order: 1,
  };
  const event = append(oldMessage);
  const continuation = { ...next, id: 'resumed', inputId: 'input-resumed' };
  assert.deepEqual(workerPromptPlan(agent, continuation, standing, [previous]), {
    mode: 'delta',
    carried: [],
    inputOrder: 2,
  });
  replace(event.seq);
  assert.deepEqual(workerPromptPlan(agent, continuation, standing, [previous]), {
    mode: 'delta',
    carried: [previous],
    inputOrder: 2,
  });
  replace(full.seq);
  assert.deepEqual(workerPromptPlan(agent, continuation, standing, [previous]), {
    mode: 'full',
    carried: [previous],
    inputOrder: 2,
  });
  const carried = createWorkerRunMessage(
    continuation,
    input(continuation),
    standing,
    'full',
    [previous],
    { note: 'Transient provider failure' },
  );
  const body = textOf(carried);
  assert.match(body, /Previously received task input \(rework\): Keep Monday’s verified totals/);
  assert.match(body, /Prior recovery reason: Transient provider failure/);
  assert.doesNotMatch(body, /Additional user input/);
  append(carried);
  assert.equal(
    workerPromptPlan(agent, { ...continuation, id: 'again', inputId: 'input-again' }, standing, [
      previous,
    ]).mode,
    'delta',
  );
});

test('fallback restores only lost prior inputs and preserves their original order', () => {
  const { agent, append, replace } = fixture();
  const full = append(createWorkerRunMessage(initial, input(initial), standing, 'full'));
  const reworkRun = { ...next, id: 'rework', inputId: 'input-rework' };
  const followup = { ...next, id: 'followup', inputId: 'input-followup' };
  const answer = input(next, 'answer', 'Use Chinese only');
  const rework = input(reworkRun, 'rework', 'Add a summary');
  const answerMessage = createWorkerRunMessage(next, answer, standing, 'delta');
  const reworkMessage = buildMessage(reworkRun, rework, standing, {
    mode: 'delta',
    carried: [],
    inputOrder: 2,
  });
  const previous: WorkerPriorInput[] = [
    {
      id: answer.id,
      kind: 'answer',
      content: answer.content,
      messageId: answerMessage.id,
      order: 1,
    },
    {
      id: rework.id,
      kind: 'rework',
      content: rework.content,
      messageId: reworkMessage.id,
      order: 2,
    },
  ];
  const answerEvent = append(answerMessage),
    reworkEvent = append(reworkMessage);
  assert.deepEqual(workerPromptPlan(agent, followup, standing, previous), {
    mode: 'delta',
    carried: [],
    inputOrder: 3,
  });
  replace(answerEvent.seq);
  const partial = workerPromptPlan(agent, followup, standing, previous);
  assert.deepEqual(partial, { mode: 'delta', carried: [previous[0]], inputOrder: 3 });
  const partialText = textOf(buildMessage(followup, input(followup), standing, partial));
  assert.match(partialText, /Restored task input order: 1/);
  assert.match(textOf(reworkMessage), /Task input order: 2/);
  assert.match(partialText, /Use Chinese only/);
  assert.doesNotMatch(partialText, /Add a summary/);
  replace(reworkEvent.seq);
  replace(full.seq);
  const lost = workerPromptPlan(agent, followup, standing, previous);
  assert.deepEqual(lost, { mode: 'full', carried: previous, inputOrder: 3 });
  const restored = textOf(buildMessage(followup, input(followup), standing, lost));
  assert.ok(restored.indexOf(answer.content) < restored.indexOf(rework.content));
});

test('a continuation preserves earlier direction and partial effects even if native context was compacted', () => {
  const { agent } = fixture();
  const earlier: WorkerPriorInput = {
    id: 'scope',
    kind: 'continuation',
    content: '镜像升级先只查线上版本。',
    messageId: 'older-native-input',
    order: 1,
  };
  const latest = input(next, 'continuation', '继续。');
  const body = textOf(
    buildMessage(
      next,
      latest,
      standing,
      workerPromptPlan(agent, next, standing, [earlier]),
      undefined,
      {
        priorRunId: initial.id,
        mode: 'read-only',
        effectUncertain: true,
        probes: [],
        priorReport: {
          kind: 'blocked',
          summary: '首启超时；线上 Deployment 已创建但未就绪。',
          checks: '缺少配置权限。',
        },
        priorCheck: {
          status: 'present',
          message: 'Deployment 仍只有 0/1 Ready',
          observed: { uid: 'synthetic', ready: false },
        },
      },
    ),
  );
  assert.match(body, /Previously received task input \(continuation\): 镜像升级先只查线上版本。/);
  assert.match(body, /Task input order: 2.\n\nAdditional user input \(continuation\): 继续。/);
  assert.match(body, /Deployment 已创建但未就绪/);
  assert.match(body, /0\/1 Ready/);
  assert.match(body, /Use only the read-only tools available for this continuation/);
  assert.match(body, /Use waiting for a specific decision or permission/);
});

test('native context refresh restores standing instructions after admission-time loss without rewriting the Run Input', async () => {
  const { agent, prompt, session, append, replace } = fixture();
  const full = append(createWorkerRunMessage(initial, input(initial), standing, 'full'));
  assert.equal(workerPromptPlan(agent, next, standing).mode, 'delta');
  const delta = createWorkerRunMessage(
    next,
    input(next, 'answer', 'Tuesday is the approved date'),
    standing,
    'delta',
  );
  const persisted = JSON.stringify(delta);
  let entered = false,
    authorized = true;
  const release = registerWorkerContext(
    agent,
    next,
    standing,
    delta,
    [],
    () => entered,
    () => authorized,
  );
  const assembly = await prompt.assemble({ agent });
  assert.deepEqual(renderContextSections(assembly), []);
  replace(full.seq);
  const refresh = () => renderContextSections(prompt.refreshContext(assembly, { agent }));
  assert.deepEqual(refresh(), [{ name: 'super-bot-worker-task', text: standing }]);
  const current = append(delta);
  entered = true;
  assert.deepEqual(refresh(), [{ name: 'super-bot-worker-task', text: standing }]);
  replace(current.seq);
  assert.deepEqual(refresh(), [
    { name: 'super-bot-worker-task', text: `${standing}\n\n${textOf(delta)}` },
  ]);
  assert.equal(JSON.stringify(delta), persisted);
  assert.equal(
    session
      .snapshotEvents()
      .filter((record) => record.type === 'user/message' && record.data.id === delta.id).length,
    1,
  );
  authorized = false;
  assert.deepEqual(refresh(), []);
  release();
});

test('dispatch reuses the exact persisted input on retry and carries an entered answer only when it is missing', async (t) => {
  const cwd = realpathSync(process.cwd()),
    store = new Store(':memory:');
  const bot = store.createBot('bot', {
    name: 'Worker prompt test',
    instructions: 'Own one synthetic task',
  });
  const current = store.createTask('task', {
    botId: bot.id,
    goal: task.goal,
    scope: task.scope,
    acceptance: task.acceptance,
    reviewPolicy: 'human',
  });
  const bound = store.beginBinding('bind', current.id, current.rowVersion, cwd);
  store.confirmBinding(bound.id, bound.requestedSessionId);
  const { agent, session, prompt, append, replace } = fixture(SessionId(bound.requestedSessionId));
  const delivered: UserMessage[] = [];
  let finish = () => {};
  const waitForFinish = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  let idle = waitForFinish();
  const driver = {
    id: session.id,
    session,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [], remove: () => false },
    ctx: {
      systemPrompt: prompt,
      tools: { restrict: () => () => {}, guard: () => () => {} },
      on: () => () => {},
    },
    followup(message: UserMessage) {
      delivered.push(message);
      Object.assign(agent, { status: 'running' });
      idle = waitForFinish();
    },
    whenIdle: () => idle,
    cancel() {
      Object.assign(agent, { status: 'idle' });
      finish();
    },
  };
  Object.assign(agent, driver);
  const ctx = {
    sessionController: { resolveAgent: async () => ({ agent }) },
    sessionProjections: {
      snapshot: () => ({
        values: { modelSelection: { next: { provider: 'fixture', model: 'fixture' } } },
      }),
    },
    workingDirectory: { get: () => cwd },
    jobs: { list: () => [] },
    agents: { list: () => [], isOwnedBy: () => false },
  } as unknown as Context;
  const execution = new DshExecution(ctx, store, cwd, { fullAccess: false });
  t.after(async () => {
    driver.cancel();
    await execution.dispose();
    store.close();
  });
  const rowVersion = () => store.getTask(current.id).rowVersion;
  const enter = (run: Run) => {
    const message = delivered.at(-1)!;
    const event = append(message);
    store.inputEntered(run.id, message.id, event.seq);
    return event;
  };
  const settle = async () => {
    driver.cancel();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const first = await execution.dispatch('first', current.id, rowVersion());
  const firstMessage = enter(first);
  assert.match(textOf(delivered[0]), /Goal: Prepare the operator summary/);
  store.workerReport(first.id, 'waiting', { kind: 'waiting', summary: 'Which date?' });
  store.settleRun(first.id);
  await settle();
  const answer = store.respondAttention(
    'answer',
    `run:${first.id}`,
    rowVersion(),
    'Tuesday is the approved date',
  );
  const answerVersion = rowVersion();
  const second = await execution.dispatch('second', current.id, answerVersion);
  assert.doesNotMatch(textOf(delivered[1]), /Goal:/);
  const saved = store.getRunInput(second.id);
  assert.equal(saved.messageJson, JSON.stringify(delivered[1]));
  const admitted = enter(second);
  replace(admitted.seq);
  replace(firstMessage.seq);
  assert.equal((await execution.dispatch('second', current.id, answerVersion)).id, second.id);
  assert.equal(delivered.length, 2);
  assert.equal(store.getRunInput(second.id).messageJson, saved.messageJson);
  store.runRecovery(second.id, 'Synthetic failure');
  await settle();
  store.resolveRunRecovery('resolve', current.id, rowVersion());
  store.controlTask('resume', current.id, rowVersion(), 'auto');
  const third = await execution.dispatch('third', current.id, rowVersion());
  assert.deepEqual(store.previousWorkerInputs(third), [
    {
      id: answer.id,
      kind: 'answer',
      content: answer.content,
      messageId: saved.messageId,
      order: 1,
    },
  ]);
  assert.match(textOf(delivered[2]), /Goal: Prepare the operator summary/);
  assert.match(
    textOf(delivered[2]),
    /Previously received task input \(answer\): Tuesday is the approved date/,
  );
  assert.notEqual(third.inputId, second.inputId);
});
