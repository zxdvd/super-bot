import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyLateJobs } from '../../src/dsh-late-job-proof.ts';
import type { Run, RunInput, RunTurn, WorkerModelPlan } from '../../src/model.ts';
import type { MirrorDetail } from '../../src/mirror.ts';
import { readLocalMirror } from '../../src/mirror-queries.ts';
import type { RunEvent } from '../../src/run-proof.ts';
import { Store } from '../../src/store.ts';
import { inboxGroups, stage, stageText, workGroup } from '../../src/ui/work/format.ts';
import { botWorkSummaries } from '../../src/work-activity.ts';

const run: Run = {
  id: 'old-run',
  taskId: 'task',
  bindingId: 'binding',
  sessionId: 'worker',
  taskRevision: 1,
  generation: 1,
  inputId: 'task-input',
  state: 'interrupted',
  createdAt: 0,
  finishedAt: 1,
  note: 'Job outstanding',
};
const input: RunInput = {
  id: run.inputId,
  taskId: run.taskId,
  kind: 'dispatch',
  content: '',
  state: 'entered',
  messageId: 'original',
  messageJson: null,
  attentionId: null,
  createdAt: 0,
};
const proof: RunTurn = {
  runId: run.id,
  turn: 1,
  startSeq: 0,
  inputSeq: 1,
  endSeq: 6,
  endKind: 'aborted',
  quiet: 0,
  reportId: null,
};
const event = (type: string, data: RunEvent['data'], surfaceOp?: string) => ({
  type,
  data,
  ...(surfaceOp ? { surfaceOp } : {}),
});
const job = (suffix: string) => ({
  jobId: 'bash-' + suffix,
  owner: run.sessionId,
  startedAt: 2,
  kind: 'bash',
  label: 'fixture',
  toolCall: { callId: suffix, rootCallId: suffix },
});
const jobs = ['bash-a', 'bash-b'];
const registration = (suffix: string) => [
  event('tool/call', { turn: 1, callId: suffix }),
  event('job/registered', job(suffix)),
];
const original = [
  event('turn/start', { turn: 1 }),
  event(
    'user/message',
    {
      id: input.messageId,
      source: {
        kind: 'super-bot',
        runId: run.id,
        inputId: input.id,
        generation: run.generation,
        taskId: run.taskId,
        taskRevision: run.taskRevision,
      },
    },
    'append',
  ),
  ...registration('a'),
  ...registration('b'),
  event('turn/end', { turn: 1, reason: { kind: 'aborted' } }),
];
const terminal = (suffix: string) =>
  event('job/settled', { ...job(suffix), status: 'completed', producerReported: true });
function consumption(suffix: string, turn: number, extras: ReturnType<typeof event>[] = []) {
  const notice = {
    id: 'notice-' + suffix,
    role: 'user',
    source: { kind: 'tool-jobs', form: 'notice' },
    content: [
      {
        type: 'text',
        text: `background job bash-${suffix} (bash: fixture) finished [status: completed]. Output:\nresult`,
      },
    ],
  };
  return [
    event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [notice] }),
    event('turn/start', { turn }),
    event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    event('user/message', notice, 'append'),
    ...extras,
    event('assistant/message', {
      turn,
      message: { content: [{ type: 'text', text: 'Read native result' }] },
    }),
    event('turn/end', { turn, reason: { kind: 'completed' } }),
  ];
}
const verify = (...later: ReturnType<typeof event>[]) =>
  verifyLateJobs(
    run,
    input,
    proof,
    jobs,
    [...original, ...later].map((e, seq) => ({ ...e, seq })),
  );

test('ownership remains held until every saved Job result is consumed in a separate normal native turn', () => {
  assert.equal(verify(terminal('a'), ...consumption('a', 2), terminal('b')), null);
  const all = verify(terminal('a'), ...consumption('a', 2), terminal('b'), ...consumption('b', 3));
  assert.ok(all);
  assert.deepEqual(
    all.jobs.map((item) => item.id),
    jobs,
  );
  assert.ok(
    all.jobs.every(
      (item) =>
        item.registeredSeq < proof.endSeq! &&
        proof.endSeq! < item.settledSeq &&
        item.settledSeq < item.noticeSeq &&
        item.noticeSeq < item.consumedEndSeq,
    ),
  );
  assert.deepEqual(
    verify(
      terminal('a'),
      ...consumption('a', 2),
      terminal('b'),
      ...consumption('b', 3),
      event('session/end-seed', {}),
    ),
    all,
    'opening the same native Session does not amend history',
  );
  assert.equal(proof.quiet, 0);
});

test('duplicate, foreign and unclaimed results preserve the original reservation', () => {
  assert.throws(() => verify(terminal('a'), terminal('a')), { code: 'late-job-unproven' });
  assert.throws(() => verify(event('job/settled', { ...terminal('a').data, owner: 'other' })), {
    code: 'late-job-unproven',
  });
  const [queued] = consumption('a', 2);
  assert.equal(verify(terminal('a'), queued!), null);
});

test('owner input or an extra tool in a notice turn never authorizes automatic continuation', () => {
  for (const extra of [
    event('user/message', { id: 'human-message', source: { kind: 'user' } }, 'append'),
    event('tool/call', { callId: 'extra', turn: 2, name: 'bash' }),
    event('approval/asked', { turn: 2 }),
  ]) {
    assert.throws(() => verify(terminal('a'), ...consumption('a', 2, [extra])), {
      code: 'late-job-unproven',
    });
  }
});

function suspendedJob(store: Store) {
  const bot = store.createBot('bot', { name: 'Bot', instructions: 'Synthetic recovery' });
  const manager = store.beginManager('manager', bot.id, '/synthetic');
  store.confirmManager(manager.id, manager.requestedSessionId);
  const task = store.createTask('task', {
    botId: bot.id,
    goal: 'Write report',
    scope: 'Files',
    acceptance: 'Checked facts',
    reviewPolicy: 'human',
  });
  const binding = store.beginBinding('binding', task.id, task.rowVersion, '/synthetic');
  store.confirmBinding(binding.id, binding.requestedSessionId);
  const old = store.reserveRun('dispatch', task.id, store.getTask(task.id).rowVersion);
  store.saveRunMessage(old.id, 'worker-input', '{}');
  store.claimDispatch(old.id);
  store.inputEnqueued(old.id);
  store.inputEntered(old.id, 'worker-input', 1);
  store.associateRunTurn(old.id, 1, 0, 1);
  store.observeRunEnd(old.id, 6, 'aborted', false, jobs);
  store.runRecovery(old.id, 'Background work active');
  const getTask = () => store.getTask(task.id);
  const control = (mode: 'paused' | 'auto') =>
    store.controlTask(mode, task.id, getTask().rowVersion, mode);
  return { old, binding, bot, manager, getTask, control };
}

const plannedModel: WorkerModelPlan = {
  source: 'native-selection',
  provider: 'fixture',
  model: 'fixture',
  reasoningEffort: null,
};
const laterProof = verify(
  terminal('a'),
  ...consumption('a', 2),
  terminal('b'),
  ...consumption('b', 3),
)!;

test('late Job waiting, pause and a claimable receipt agree across work views without a Manager', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { old, bot, manager, control } = suspendedJob(store);
  const assertWorkView = (lateState: 'waiting' | 'ready', activity: 'working' | null) => {
    const detail = store.taskDetail(old.taskId);
    assert.equal(detail.lateJobRecovery?.state, lateState);
    assert.equal(detail.task.status, 'recovery');
    const inbox = store.taskInbox(bot.id);
    const item = inbox.items.find((task) => task.id === old.taskId)!;
    const groups = inboxGroups(inbox.items, {}, Date.now());
    const listed = store.listTasks({ botId: bot.id }).items.find((task) => task.id === old.taskId)!;
    const mirrored = readLocalMirror(store, {
      op: 'detail',
      id: old.taskId,
      botId: bot.id,
    }) as MirrorDetail;
    for (const task of [detail.task, item, listed, mirrored.task]) {
      assert.equal(task.activity, activity);
      assert.equal(stage(task), 'waiting');
      assert.equal(stageText(task), activity === 'working' ? '等待自动跟进' : '已暂停');
      assert.equal(workGroup(task), 'doing');
    }
    assert.equal(groups.attentionCount, 0);
    assert.deepEqual(
      groups.active.map((task) => task.id),
      activity === 'working' ? [old.taskId] : [],
    );
    const { working, attention } = botWorkSummaries(store.db)[0]!;
    assert.deepEqual(
      { working, attention },
      { working: Number(activity === 'working'), attention: 0 },
    );
  };
  for (const event of store.managerNotifications(bot.id)) store.settleManagerEvent(event.id);
  assertWorkView('waiting', 'working');
  store.releaseManager('remove-manager', bot.id, manager.generation);
  assertWorkView('waiting', 'working');
  control('paused');
  t.mock.timers.tick(store.lateJobRecovery(old.id)!.deadline - Date.now());
  assertWorkView('waiting', null);
  store.updateLateJob(old.id, { proof: laterProof });
  assertWorkView('ready', null);
  control('auto');
  assert.equal(store.lateJobCanDispatch(old.id), true);
  assertWorkView('ready', 'working');
});

test('late Job expiry, missing proof and separate owner blockers remain visible', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  for (const cause of ['expiry', 'missing-proof', 'input', 'approval'] as const) {
    const store = new Store(':memory:');
    try {
      const { old, bot, getTask } = suspendedJob(store);
      if (cause === 'expiry')
        t.mock.timers.tick(store.lateJobRecovery(old.id)!.deadline - Date.now());
      else if (cause === 'missing-proof')
        store.updateLateJob(old.id, { reason: 'No matching native receipt' });
      else {
        store.db
          .prepare(
            'INSERT INTO attentions(id,taskId,kind,question,taskRevision,createdAt) VALUES (?,?,?,?,?,?)',
          )
          .run(
            `separate:${cause}`,
            old.taskId,
            cause,
            'Owner decision needed',
            getTask().taskRevision,
            Date.now(),
          );
        assert.equal(store.lateJobTarget(old.id), undefined);
      }
      const detail = store.taskDetail(old.taskId);
      assert.equal(detail.lateJobRecovery?.state, 'blocked');
      assert.equal(stage(detail.task), 'needs-you');
      if (cause === 'input' || cause === 'approval') {
        assert.ok(detail.attentions.some((item) => item.kind === cause && item.state === 'open'));
      }
      const groups = inboxGroups(store.taskInbox(bot.id).items, {}, Date.now());
      assert.deepEqual(
        groups.attention.map((task) => task.id),
        [old.taskId],
      );
      const { working, attention } = botWorkSummaries(store.db)[0]!;
      assert.deepEqual({ working, attention }, { working: 0, attention: 1 });
    } finally {
      store.close();
    }
  }
});

test('pause admits late settlement evidence and explicit resume transfers the original reservation once', () => {
  const store = new Store(':memory:');
  try {
    const { old, binding, getTask, control } = suspendedJob(store);
    assert.equal(control('paused').controlMode, 'paused');
    store.updateLateJob(old.id, { proof: laterProof });
    assert.equal(store.lateJobRecovery(old.id)?.state, 'ready');
    assert.equal(store.lateJobRecovery(old.id)?.rowVersion, getTask().rowVersion);
    assert.equal(store.lateJobCanDispatch(old.id), false);
    assert.throws(() => store.reserveLateJobContinuation(old.id, laterProof, plannedModel), {
      code: 'recovery-stale',
    });
    assert.equal(control('auto').controlMode, 'auto');
    const resumed = store.reserveLateJobContinuation(old.id, laterProof, plannedModel);
    assert.equal(resumed.taskId, old.taskId);
    assert.equal(resumed.bindingId, binding.id);
    assert.equal(store.reserveLateJobContinuation(old.id, laterProof, plannedModel).id, resumed.id);
    assert.deepEqual(
      store.heldRuns().map((run) => run.id),
      [resumed.id],
    );
    assert.equal(store.runTurn(old.id)?.quiet, 0);
  } finally {
    store.close();
  }
});

test('owner takeover, closure and a new plan rule out carrying the old Job continuation through resume', () => {
  for (const interrupt of ['takeover', 'closure', 'new-plan']) {
    const store = new Store(':memory:');
    try {
      const { old, bot, manager, getTask, control } = suspendedJob(store);
      assert.equal(control('paused').controlMode, 'paused');
      store.updateLateJob(old.id, { proof: laterProof });
      if (interrupt === 'takeover') store.nativeIntervention(old.sessionId, 'human-input');
      else if (interrupt === 'closure')
        store.requestTaskClose('close', old.taskId, getTask().rowVersion);
      else
        store.saveRecoveryInstruction(
          old.taskId,
          getTask().rowVersion,
          {
            sessionId: manager.requestedSessionId,
            messageId: 'new-scope',
            seq: 45,
            text: '改为只读核对版本。',
          },
          'read-only',
        );
      if (interrupt === 'closure') assert.throws(() => control('auto'), { code: 'task-closing' });
      else control('auto');
      assert.equal(store.lateJobCanDispatch(old.id), false);
      assert.equal(store.latestRun(old.taskId)?.id, old.id);
      assert.equal(store.taskDetail(old.taskId).lateJobRecovery?.state, 'blocked');
      assert.equal(
        store.taskInbox(bot.id).items.find((task) => task.id === old.taskId)?.activity,
        'attention',
      );
      assert.equal(botWorkSummaries(store.db)[0]?.attention, 1);
    } finally {
      store.close();
    }
  }
});
