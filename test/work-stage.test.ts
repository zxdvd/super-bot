import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run } from '../src/model.ts';
import { Store } from '../src/store.ts';
import { observeGitLabStage, startStageObservation } from '../src/gitlab-observer.ts';
import { botWorkSummaries } from '../src/work-activity.ts';
import { stageText } from '../src/ui/work/format.ts';
import {
  gitLabObservationOrigin,
  readStageCondition,
  STAGE_WAIT_MS,
  type StageCondition,
} from '../src/work-stage.ts';

const origin = 'https://gitlab.example.invalid';
const pipeline = {
  kind: 'gitlab-pipeline',
  sourceOrigin: origin,
  project: 'group/subgroup/repo',
  number: 42,
} satisfies StageCondition;
const finalReport = {
  kind: 'ready' as const,
  summary: 'Deployment and business check are complete',
  checks: 'Smoke check succeeded',
  evidence: [{ path: '/tmp/result.md', sha256: 'fixture', bytes: 12 }],
};

function createBound(store: Store, key: string, botId?: string) {
  const bot = botId
    ? store.getBot(botId)
    : store.createBot(key + '-bot', { name: 'Release Bot', instructions: 'Release existing work' });
  const task = store.createTask(key + '-task', {
    botId: bot.id,
    goal: 'Release and verify the change',
    scope: 'Only the test environment',
    acceptance: 'Deployment and smoke check both pass',
    reviewPolicy: 'human',
  });
  const binding = store.beginBinding(
    key + '-prepare',
    task.id,
    task.rowVersion,
    '/tmp/release-fixture',
  );
  store.claimBindingCreation(binding.id);
  store.confirmBinding(binding.id, binding.requestedSessionId);
  return { bot, task: store.getTask(task.id), binding };
}

function enter(store: Store, taskId: string, key: string): Run {
  const run = store.reserveRun(key, taskId, store.getTask(taskId).rowVersion);
  store.saveRunMessage(run.id, `message-${key}`, '{}');
  assert.equal(store.claimDispatch(run.id), true);
  store.inputEnqueued(run.id);
  store.inputEntered(run.id, `message-${key}`, 12);
  return run;
}

function checkpoint(
  store: Store,
  run: Run,
  evidenceRef: string,
  checks = 'Exact receipt was inspected',
) {
  const report = {
    kind: 'stage' as const,
    stage: 'Verification checkpoint',
    evidenceRef,
    summary: 'Stage recorded',
    checks,
  };
  assert.deepEqual(store.workerReport(run.id, 'stage', report), { accepted: true });
  assert.deepEqual(store.workerReport(run.id, 'stage', report), { accepted: true });
  store.settleRun(run.id);
  store.settleRun(run.id);
}

test('distinct evidence advances the same Worker without final review or corrective rework', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { bot, task, binding } = createBound(store, 'release');
  let run = enter(store, task.id, 'stage-1');
  store.workerReport(run.id, 'progress', { kind: 'progress', summary: 'Preparing' });
  assert.throws(() => store.settleRun(run.id), { code: 'no-result' });
  assert.throws(() =>
    store.workerReport(run.id, 'no-proof', {
      kind: 'stage',
      stage: 'Checkpoint',
      summary: 'Completed',
    }),
  );
  for (let i = 1; i <= 4; i++) {
    checkpoint(store, run, `fixture-receipt-${i}`);
    const detail = store.taskDetail(task.id);
    assert.equal(detail.stage?.state, 'awaiting-decision');
    assert.equal(detail.task.lifecycle, 'open');
    assert.equal(detail.result, null);
    assert.equal(detail.attentions.length, 0);
    assert.equal(detail.runHeld, false);
    assert.throws(() => store.reserveRun(`too-early-${i}`, task.id, detail.task.rowVersion), {
      code: 'work-blocked',
    });
    assert.throws(
      () =>
        store.advanceStage(
          `wrong-version-${i}`,
          bot.id,
          task.id,
          detail.task.rowVersion - 1,
          run.id,
          'Verify next target',
          undefined,
          origin,
        ),
      { code: 'stage-stale' },
    );
    const decision = () =>
      store.advanceStage(
        `advance-${i}`,
        bot.id,
        task.id,
        detail.task.rowVersion,
        run.id,
        'Verify next target',
        undefined,
        origin,
      );
    assert.equal(decision().stage.state, 'ready');
    assert.equal(decision().stage.state, 'ready');
    const prior = run;
    run = enter(store, task.id, `stage-${i + 1}`);
    assert.equal(run.bindingId, binding.id);
    assert.equal(run.sessionId, prior.sessionId);
    assert.equal(run.taskRevision, task.taskRevision);
    const input = store.getRunInput(run.id);
    assert.equal(input.kind, 'stage');
    assert.match(input.content, /Only the test environment/);
    assert.ok(input.content.includes(`fixture-receipt-${i}`));
    assert.equal(store.taskDetail(task.id).stages[0]?.dispatchedRunId, run.id);
  }
  for (let i = 1; i <= 2; i++) {
    const { resultId } = store.workerReport(run.id, `final-${i}`, finalReport);
    store.settleRun(run.id);
    const detail = store.taskDetail(task.id);
    assert.equal(detail.task.lifecycle, 'review');
    const revised = store.managerReview(
      `rework-${i}`,
      bot.id,
      task.id,
      detail.task.rowVersion,
      resultId!,
      'rework',
      'Correct this issue',
    );
    assert.equal(revised.lifecycle, 'open');
    run = enter(store, task.id, `corrected-${i}`);
    assert.equal(store.getRunInput(run.id).kind, 'rework');
  }
  store.workerReport(run.id, 'business-failure', {
    kind: 'blocked',
    summary: 'Smoke check failed after deployment',
  });
  store.settleRun(run.id);
  const failure = store.taskDetail(task.id);
  assert.equal(failure.task.status, 'blocked');
  assert.equal(failure.result, null);
  assert.equal(
    failure.attentions.some((item) => item.kind === 'review' && item.state === 'open'),
    false,
  );
  assert.equal(failure.stages.length, 4);
});

test('the same evidence and check do not advance another run solely because its report is rephrased', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { bot, task } = createBound(store, 'loop');
  const first = enter(store, task.id, 'first');
  checkpoint(store, first, 'same-immutable-receipt');
  store.advanceStage(
    'advance',
    bot.id,
    task.id,
    store.getTask(task.id).rowVersion,
    first.id,
    'Verify release',
    undefined,
    origin,
  );
  const second = enter(store, task.id, 'second');
  checkpoint(store, second, 'same-immutable-receipt', 'Exact   receipt was  inspected');
  const detail = store.taskDetail(task.id);
  assert.equal(detail.stage?.state, 'blocked');
  assert.match(detail.stage!.reason!, /已经|已登记/);
  assert.equal(detail.runHeld, false);
  assert.equal(detail.result, null);
  assert.throws(
    () =>
      store.advanceStage(
        'unexpected',
        bot.id,
        task.id,
        detail.task.rowVersion,
        second.id,
        'Same update',
        undefined,
        origin,
      ),
    { code: 'stage-decided' },
  );
});

test('a GitLab wait frees the slot and survives restart, pause, old observations, duplicate updates and capacity', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'super-bot-wait-'));
  const db = join(directory, 'ledger.sqlite');
  let store = new Store(db);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { bot, task, binding } = createBound(store, 'pipeline');
  const manager = store.beginManager('pipeline-owner', bot.id, '/tmp/manager-fixture');
  store.confirmManager(manager.id, manager.requestedSessionId);
  store.setBotCapacity('capacity', bot.id, null, 1);
  const run = enter(store, task.id, 'release-start');
  checkpoint(store, run, 'release-mr-42');
  const decision = store.advanceStage(
    'register-wait',
    bot.id,
    task.id,
    store.getTask(task.id).rowVersion,
    run.id,
    'Verify the exact deployment',
    pipeline,
    origin,
  );
  assert.equal(decision.stage.state, 'waiting');
  assert.equal(store.botCapacity(bot.id).botHeld, 0);
  for (const event of store.managerNotifications(bot.id)) store.settleManagerEvent(event.id);
  assert.equal(stageText(store.taskDetail(task.id).task), '等待外部条件');
  assert.equal(
    store.taskInbox(bot.id).items.find((item) => item.id === task.id)?.activity,
    'working',
  );
  assert.equal(botWorkSummaries(store.db).find((summary) => summary.id === bot.id)?.working, 1);
  const other = createBound(store, 'other', bot.id);
  const otherRun = enter(store, other.task.id, 'other-work');
  const staleAddition = store.dueStages(1)[0]!;
  const appendix = {
    sessionId: manager.requestedSessionId,
    messageId: 'add-note',
    seq: 15,
    text: 'Only read the relevant logs as an extra appendix; keep the original step.',
  };
  const add = () =>
    store.saveRecoveryInstruction(
      task.id,
      store.getTask(task.id).rowVersion,
      appendix,
      'read-only',
      false,
      false,
      undefined,
      { stageFollowUp: 'append' },
    );
  assert.equal(add().instruction.stageRunId, run.id);
  assert.equal(add().instruction.directions?.length, 1);
  assert.equal(store.taskDetail(task.id).directionStatus, 'next-run');
  assert.equal(store.taskDetail(task.id).stage?.deadlineAt, decision.stage.deadlineAt);
  store.recordStageObservation(
    staleAddition,
    { state: 'satisfied', detail: 'arrived after the note' },
    staleAddition.checkAt,
  );
  assert.equal(store.taskDetail(task.id).stage?.state, 'waiting');
  const due = store.dueStages(1)[0]!;
  store.recordStageObservation(
    due,
    { state: 'pending', detail: 'running', stateLabel: 'running' },
    due.checkAt,
  );
  store.recordStageObservation(
    due,
    { state: 'satisfied', detail: 'stale second response', stateLabel: 'success' },
    due.checkAt,
  );
  assert.equal(store.taskDetail(task.id).stage?.observation?.stateLabel, 'running');
  assert.equal(store.dueStages(1, due.checkAt + 29_999).length, 0);

  store.close();
  store = new Store(db);
  const afterRestart = store.dueStages(1, due.checkAt + 30_000)[0]!;
  assert.equal(afterRestart.runId, run.id);
  assert.deepEqual(afterRestart.condition, pipeline);
  const paused = store.controlTask('pause', task.id, store.getTask(task.id).rowVersion, 'paused');
  store.recordStageObservation(
    afterRestart,
    { state: 'satisfied', detail: 'arrived after pause', stateLabel: 'success' },
    afterRestart.checkAt,
  );
  assert.equal(store.taskDetail(task.id).stage?.state, 'waiting');
  assert.equal(store.dueStages(1, afterRestart.checkAt).length, 0);
  store.controlTask('resume', task.id, paused.rowVersion, 'auto');
  const current = store.dueStages(1, afterRestart.checkAt)[0]!;
  store.recordStageObservation(
    current,
    { state: 'satisfied', detail: 'exact pipeline succeeded', stateLabel: 'success' },
    current.checkAt,
  );
  store.recordStageObservation(
    current,
    { state: 'unavailable', detail: 'late duplicate' },
    current.checkAt,
  );
  assert.equal(store.taskDetail(task.id).stage?.state, 'ready');
  assert.equal(store.taskDetail(task.id).stage?.observation?.stateLabel, 'success');
  assert.equal(store.taskDetail(task.id).wait?.code, 'capacity');
  const readyId = `manager-event:stage-ready:${run.id}`;
  assert.notEqual(store.nextManagerEvent(bot.id)?.id, readyId);
  assert.throws(() => store.reserveRun('no-capacity', task.id, store.getTask(task.id).rowVersion), {
    code: 'capacity',
  });
  store.workerReport(otherRun.id, 'finished', finalReport);
  store.settleRun(otherRun.id);
  assert.equal(store.nextManagerEvent(bot.id)?.id, readyId);
  const next = enter(store, task.id, 'authorized-next');
  assert.equal(next.sessionId, binding.requestedSessionId);
  const content = store.getRunInput(next.id).content;
  assert.match(content, /exact pipeline succeeded/);
  assert.match(content, /Verify the exact deployment/);
  assert.equal(content.split(appendix.text).length - 1, 1);
  assert.equal(store.taskDetail(task.id).directionStatus, 'entered');
  assert.equal(store.recoveryWorkPlan(next.id), null);
  assert.notEqual(store.nextManagerEvent(bot.id)?.id, readyId);
});

test('an unavailable observer can recover the original plan; terminal failed checks and cancellation do not dispatch', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { bot, task } = createBound(store, 'blocked');
  const run = enter(store, task.id, 'release');
  checkpoint(store, run, 'release-fixture');
  const registered = store.advanceStage(
    'no-reader',
    bot.id,
    task.id,
    store.getTask(task.id).rowVersion,
    run.id,
    'Verify the deployment',
    pipeline,
    null,
  );
  assert.equal(registered.stage.observation?.state, 'unavailable');
  assert.equal(registered.stage.state, 'waiting');
  const due = store.dueStages(1)[0]!;
  store.recordStageObservation(due, { state: 'unavailable', detail: 'HTTP 403' }, due.checkAt);
  assert.equal(store.dueStages(1, due.checkAt + 299_999).length, 0);
  const recovered = store.dueStages(1, due.checkAt + 300_000)[0]!;
  assert.equal(recovered.runId, run.id);
  assert.equal(recovered.origin, origin);
  assert.equal(store.taskDetail(task.id).stage?.deadlineAt, registered.stage.deadlineAt);
  store.recordStageObservation(
    recovered,
    { state: 'unsatisfied', detail: 'pipeline failed', stateLabel: 'failed' },
    recovered.checkAt,
  );
  const blocked = store.taskDetail(task.id);
  assert.equal(blocked.stage?.reason, 'pipeline failed');
  assert.equal(blocked.task.status, 'blocked');
  assert.equal(blocked.result, null);
  assert.equal(blocked.runHeld, false);
  assert.equal(store.cancelTask('cancel', task.id, blocked.task.rowVersion).lifecycle, 'cancelled');
  store.recordStageObservation(due, { state: 'satisfied', detail: 'late success' });
  assert.equal(store.taskDetail(task.id).stages[0]?.state, 'superseded');
  assert.equal(store.dueStages(1).length, 0);
  assert.throws(() =>
    store.reserveRun('cancelled-dispatch', task.id, store.getTask(task.id).rowVersion),
  );
});

test('transient reads back off and wait only until the original deadline', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { bot, task } = createBound(store, 'retry');
  const run = enter(store, task.id, 'prepare');
  checkpoint(store, run, 'fixture');
  const { stage: plan } = store.advanceStage(
    'wait',
    bot.id,
    task.id,
    store.getTask(task.id).rowVersion,
    run.id,
    'Continue',
    pipeline,
    origin,
  );
  let now = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const due = store.dueStages(1, now)[0]!;
    assert.equal(due.runId, run.id);
    store.recordStageObservation(due, { state: 'transient', detail: 'HTTP 503' }, now);
    const next = now + 30_000 * 2 ** attempt;
    assert.equal(store.dueStages(1, next - 1).length, 0);
    now = next;
  }
  assert.equal(store.dueStages(1, now).length, 0);
  assert.equal(store.taskDetail(task.id).stage?.state, 'waiting');
  assert.equal(store.taskDetail(task.id).stage?.observation?.state, 'unavailable');
  assert.equal(
    store
      .managerNotifications(bot.id)
      .filter((event) => event.id.startsWith('manager-event:stage-unavailable:')).length,
    1,
  );
  const last = store.dueStages(1, plan.deadlineAt! - 1)[0]!;
  store.superviseStages(plan.deadlineAt!);
  store.superviseStages(plan.deadlineAt! + 1);
  store.recordStageObservation(
    last,
    { state: 'satisfied', detail: 'late success' },
    plan.deadlineAt! + 2,
  );
  assert.equal(store.dueStages(1, plan.deadlineAt! + STAGE_WAIT_MS).length, 0);
  const stage = store.taskDetail(task.id).stage;
  assert.equal(stage?.state, 'blocked');
  assert.equal(stage?.expired, true);
  assert.match(stage!.reason!, /HTTP 503/);
  assert.equal(
    store
      .managerNotifications(bot.id)
      .filter((event) => event.id.startsWith('manager-event:stage-blocked:')).length,
    1,
  );
});

test('a newer pending owner instruction takes priority over a ready stage', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { bot, task } = createBound(store, 'owner');
  const manager = store.beginManager('owner-manager', bot.id, '/tmp/manager-fixture');
  store.confirmManager(manager.id, manager.requestedSessionId);
  const run = enter(store, task.id, 'prepare');
  checkpoint(store, run, 'fixture');
  store.advanceStage(
    'advance',
    bot.id,
    task.id,
    store.getTask(task.id).rowVersion,
    run.id,
    'Verify automatic next step',
    undefined,
    null,
  );
  store.saveRecoveryInstruction(
    task.id,
    store.getTask(task.id).rowVersion,
    {
      sessionId: manager.requestedSessionId,
      messageId: 'owner-message',
      seq: 15,
      text: 'Pause the automatic next step and only read the test logs',
    },
    'read-only',
  );
  assert.equal(store.taskDetail(task.id).task.status, 'blocked');
  assert.equal(store.taskDetail(task.id).stage?.state, 'superseded');
  assert.throws(() => store.reserveRun('unexpected', task.id, store.getTask(task.id).rowVersion), {
    code: 'work-blocked',
  });
  assert.match(store.nextManagerEvent(bot.id)?.id ?? '', /^manager-event:continuation:/);
});

test('an exact replacement invalidates the old observation and owner revocation prevents either plan from running', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { bot, task } = createBound(store, 'replace');
  const manager = store.beginManager('replacement-manager', bot.id, '/tmp/stage-manager');
  store.confirmManager(manager.id, manager.requestedSessionId);
  const run = enter(store, task.id, 'replacement-start');
  checkpoint(store, run, 'replacement-evidence');
  const advance = (
    request: string,
    condition: StageCondition,
    source?: { sessionId: string; messageId: string; seq: number; text: string },
  ) =>
    store.advanceStage(
      request,
      bot.id,
      task.id,
      store.getTask(task.id).rowVersion,
      run.id,
      'Verify the release',
      condition,
      origin,
      false,
      { source },
    );
  advance('original', pipeline);
  const old = store.dueStages(1)[0]!;
  const next = { ...pipeline, number: 43 };
  assert.throws(() => advance('unproven', next), { code: 'stage-decided' });
  const source = {
    sessionId: manager.requestedSessionId,
    messageId: 'replace-forty-two',
    seq: 1,
    text: 'Wait for pipeline 43 instead.',
  };
  assert.throws(() => advance('foreign', next, { ...source, sessionId: 'another-session' }), {
    code: 'manager-scope',
  });
  const replacement = advance('replace-plan', next, source);
  assert.deepEqual(replacement.stage.planSource, source);
  store.recordStageObservation(
    old,
    { state: 'satisfied', detail: 'old pipeline success' },
    old.checkAt,
  );
  assert.equal(store.taskDetail(task.id).stage?.state, 'waiting');
  const due = store.dueStages(1)[0]!;
  assert.deepEqual(due.condition, next);
  const revoke = {
    ...source,
    messageId: 'revoke-step',
    seq: 2,
    text: 'Withdraw the release step and keep the checkpoint.',
  };
  const saved = store.saveRecoveryInstruction(
    task.id,
    store.getTask(task.id).rowVersion,
    revoke,
    undefined,
    false,
    false,
    undefined,
    { stageFollowUp: 'revoke' },
  );
  assert.equal(store.recoveryDirectionStatus(saved.instruction), 'revoked');
  store.recordStageObservation(
    due,
    { state: 'satisfied', detail: 'new pipeline success' },
    due.checkAt,
  );
  assert.equal(store.taskDetail(task.id).stage?.state, 'superseded');
  assert.equal(store.dueStages(1, due.checkAt).length, 0);
  assert.equal(
    store
      .managerNotifications(bot.id)
      .some((event) => event.id.startsWith('manager-event:stage-ready:')),
    false,
  );
  assert.throws(() => store.reserveRun('withdrawn', task.id, store.getTask(task.id).rowVersion), {
    code: 'work-blocked',
  });
});

test('a capacity wait expires once across restart and frees its FIFO place', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'super-bot-stage-capacity-'));
  const path = join(directory, 'ledger.sqlite');
  let store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { bot, task } = createBound(store, 'capacity-stage');
  store.setBotCapacity('stage-capacity', bot.id, null, 1);
  const run = enter(store, task.id, 'capacity-stage-start');
  checkpoint(store, run, 'capacity-evidence');
  const other = createBound(store, 'capacity-incumbent', bot.id);
  const otherRun = enter(store, other.task.id, 'capacity-incumbent-start');
  const { stage } = store.advanceStage(
    'needs-slot',
    bot.id,
    task.id,
    store.getTask(task.id).rowVersion,
    run.id,
    'Complete the release',
    undefined,
    origin,
  );
  assert.equal(store.taskDetail(task.id).wait?.code, 'capacity');
  assert.equal(store.botCapacity(bot.id).botHeld, 1);
  store.close();
  store = new Store(path);
  store.superviseStages(stage.deadlineAt! - 1);
  assert.equal(store.taskDetail(task.id).stage?.state, 'ready');
  store.superviseStages(stage.deadlineAt!);
  store.superviseStages(stage.deadlineAt! + 1);
  const detail = store.taskDetail(task.id);
  assert.equal(detail.stage?.expired, true);
  assert.match(detail.stage!.reason!, /执行名额等待期限/);
  assert.equal(detail.wait, null);
  assert.equal(
    store
      .managerNotifications(bot.id)
      .filter((event) => event.id.startsWith('manager-event:stage-blocked:')).length,
    1,
  );
  store.workerReport(otherRun.id, 'capacity-finish', finalReport);
  store.settleRun(otherRun.id);
  const later = createBound(store, 'waiter-after-expiry', bot.id);
  assert.equal(enter(store, later.task.id, 'later-dispatch').state, 'queued');
  assert.equal(store.latestRun(task.id)?.id, run.id);
});

test('the reader uses exact GitLab IDs with a fixed HTTPS origin and fails closed on unknown states', async () => {
  for (const invalid of [
    'http://gitlab.invalid',
    'https://id:pw@gitlab.invalid',
    'https://gitlab.invalid/other',
    'https://gitlab.invalid?host=other',
    'https://gitlab.invalid#other',
  ]) {
    assert.equal(gitLabObservationOrigin(invalid), null);
  }
  assert.equal(gitLabObservationOrigin(origin + '/'), origin);
  assert.throws(() => readStageCondition({ ...pipeline, url: 'https://elsewhere.invalid' }), {
    code: 'stage-condition',
  });
  assert.throws(() => readStageCondition({ ...pipeline, project: 'group/../repo' }), {
    code: 'stage-condition',
  });
  assert.throws(() => readStageCondition({ ...pipeline, number: 9007199254740992 }), {
    code: 'stage-condition',
  });
  const signal = new AbortController().signal;
  const observed = await observeGitLabStage(
    origin,
    pipeline,
    signal,
    'fixture-read-only-token',
    async (url, options) => {
      assert.equal(String(url), origin + '/api/v4/projects/group%2Fsubgroup%2Frepo/pipelines/42');
      assert.equal(options?.method, 'GET');
      assert.equal(options?.redirect, 'error');
      assert.equal(new Headers(options?.headers).get('PRIVATE-TOKEN'), 'fixture-read-only-token');
      return Response.json({
        id: 42,
        status: 'success',
        web_url: 'https://somewhere-else.invalid/',
      });
    },
  );
  assert.equal(observed.state, 'satisfied');
  assert.equal(observed.url, origin + '/group/subgroup/repo/-/pipelines/42');
  const mr = {
    kind: 'gitlab-merge',
    sourceOrigin: origin,
    project: '123',
    number: 7,
  } satisfies StageCondition;
  const read = (body: unknown, status = 200) =>
    observeGitLabStage(origin, mr, signal, undefined, async (url) => {
      assert.equal(String(url), origin + '/api/v4/projects/123/merge_requests/7');
      return Response.json(body, { status });
    });
  assert.equal((await read({ iid: 7, state: 'opened' })).state, 'pending');
  assert.equal((await read({ iid: 7, state: 'merged' })).state, 'satisfied');
  assert.equal((await read({ iid: 7, state: 'closed' })).state, 'unsatisfied');
  assert.equal((await read({ iid: 8, state: 'merged' })).state, 'unavailable');
  assert.equal((await read({ iid: 7, state: 'unknown' })).state, 'unavailable');
  assert.equal((await read(null, 403)).state, 'unavailable');
  assert.equal((await read(null, 429)).state, 'transient');
  const wrongOrigin = await observeGitLabStage(
    'https://another.invalid',
    pipeline,
    signal,
    undefined,
    async () => {
      assert.fail('A supplied source cannot redirect the read request');
    },
  );
  assert.equal(wrongOrigin.state, 'unavailable');
});

test('condition on a different GitLab instance keeps its exact origin even with a matching project and ID', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { bot, task } = createBound(store, 'different-origin');
  const run = enter(store, task.id, 'prepare');
  checkpoint(store, run, 'fixture');
  const condition = { ...pipeline, sourceOrigin: 'https://elsewhere.invalid' };
  const receipt = store.advanceStage(
    'wait',
    bot.id,
    task.id,
    store.getTask(task.id).rowVersion,
    run.id,
    'Continue',
    condition,
    origin,
  );
  assert.equal(receipt.stage.state, 'waiting');
  assert.match(receipt.stage.reason!, /https:\/\/elsewhere\.invalid/);
  assert.equal(store.dueStages(1)[0]?.origin, condition.sourceOrigin);
});

test('observer configuration changes never redirect an outstanding wait to another host', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { bot, task } = createBound(store, 'origin');
  const run = enter(store, task.id, 'prepare');
  checkpoint(store, run, 'fixture');
  store.advanceStage(
    'wait',
    bot.id,
    task.id,
    store.getTask(task.id).rowVersion,
    run.id,
    'Continue',
    pipeline,
    origin,
  );
  const stop = startStageObservation(store, 'https://other.invalid', async () => {
    assert.fail('An old wait must not send a request to a replacement host');
  });
  t.after(stop);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.taskDetail(task.id).stage?.observation?.state, 'unavailable');
  assert.equal(store.taskDetail(task.id).stage?.state, 'waiting');
  assert.equal(store.dueStages(1).length, 0);
});
