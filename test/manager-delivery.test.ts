import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import type { DeliveryLinks } from '../src/model.ts';

const mr = 'https://gitlab.example.test/team/app/-/merge_requests/1087';
const cr = 'https://review.example.test/c/client/+/1842763';
const doc = 'https://example.feishu.cn/docx/fixture';

function fixture(store: Store, links?: DeliveryLinks, primaryLink?: string) {
  const bot = store.createBot('bot', { name: 'Delivery fixture', instructions: 'Synthetic files' });
  const manager = store.beginManager('manager', bot.id, '/synthetic/manager');
  store.confirmManager(manager.id, manager.requestedSessionId);
  const task = store.createTask('task', {
    botId: bot.id,
    goal: 'Write facts',
    scope: 'Own files',
    acceptance: 'Read facts',
    reviewPolicy: 'human',
  });
  const binding = store.beginBinding('binding', task.id, task.rowVersion, '/synthetic/work');
  store.confirmBinding(binding.id, binding.requestedSessionId);
  const run = store.reserveRun('dispatch', task.id, store.getTask(task.id).rowVersion);
  store.saveRunMessage(run.id, 'worker', '{}');
  store.claimDispatch(run.id);
  store.inputEntered(run.id, 'worker', 1);
  const result = store.workerReport(run.id, 'report', {
    kind: 'ready',
    summary: 'Facts written',
    checks: 'Read facts',
    evidence: [{ path: '/synthetic/work/result.md', sha256: 'synthetic', bytes: 20 }],
    links,
    primaryLink,
  });
  store.settleRun(run.id);
  const event = store
    .pendingManagerEvents(bot.id)
    .find((item) => item.id === `manager-event:settled:${run.id}`)!;
  return { bot, manager, task, run, result, event };
}

for (const variant of ['worker', 'manager', 'clear', 'replace'] as const)
  test(`formal primary choice follows the ${variant} registration`, () => {
    const store = new Store(':memory:');
    try {
      const links = { MR: mr, CR: cr, 方案: doc };
      const { bot, manager, task, result } = fixture(store, links, '方案');
      const sessionId = manager.requestedSessionId,
        resultId = result.resultId!,
        delivery = { taskId: task.id, resultId, text: '已核对' };
      const submit = (
        id: string,
        initial: { links?: DeliveryLinks; primaryLink?: string | null },
      ) => store.managerDeliver(id, bot.id, sessionId, id, delivery, initial);
      assert.deepEqual(store.reportedDeliveryArtifacts(store.taskDetail(task.id).run!.id), {
        links,
        primaryLink: '方案',
      });
      assert.throws(() => submit('unregistered', { primaryLink: doc }), {
        code: 'invalid-primary-link',
      });
      assert.throws(() => submit('missing', { links: { MR: mr }, primaryLink: 'CR' }), {
        code: 'invalid-primary-link',
      });
      if (variant === 'worker') submit('inherited', {});
      else if (variant === 'manager') submit('selected', { primaryLink: 'CR' });
      else if (variant === 'clear') submit('clear', { primaryLink: null });
      else submit('replace', { links: { MR: mr } });
      const primary = variant === 'worker' ? '方案' : variant === 'manager' ? 'CR' : undefined;
      const expectedLinks = variant === 'replace' ? { MR: mr } : links;
      assert.equal(store.taskDetail(task.id).deliveredResult, null);
      store.managerNotificationDelivered(`manager-event:delivery:${resultId}`, sessionId, {
        turn: 1,
        seq: 2,
        endSeq: 3,
        messageId: 'visible',
      });
      assert.deepEqual(store.chatDeliveries(sessionId, 1, 3), [
        {
          taskId: task.id,
          resultId,
          links: expectedLinks,
          ...(primary ? { primaryLink: primary } : {}),
        },
      ]);
      const patch = (id: string, links: unknown, primary?: string | null) =>
        store.managerUpdateDeliveryLinks(
          id,
          bot.id,
          sessionId,
          task.id,
          store.getTask(task.id).rowVersion,
          resultId,
          links,
          primary,
        );
      assert.throws(() => patch('unregistered-update', {}, 'absent'), {
        code: 'invalid-primary-link',
      });
      patch('owner-update', undefined, 'MR');
      assert.equal(store.chatDeliveries(sessionId, 1, 3)[0]?.primaryLink, 'MR');
      patch('owner-removal', { MR: null });
      assert.equal(store.chatDeliveries(sessionId, 1, 3)[0]?.primaryLink, undefined);
      assert.equal(
        store.chatDeliveries(sessionId, 1, 4).length,
        0,
        'corrections preserve the original receipt coordinates',
      );
    } finally {
      store.close();
    }
  });

test('formal delivery inherits the exact ready links without resubmitting the URL', () => {
  for (const useDeliver of [true, false]) {
    const store = new Store(':memory:');
    try {
      const links = { 方案: `${doc}?selection=${'12345'.repeat(2001)}#section` };
      const { bot, manager, task, result } = fixture(store, links);
      const sessionId = manager.requestedSessionId,
        resultId = result.resultId!;
      const delivery = { taskId: task.id, resultId, text: '已完成方案' };
      const version = () => store.getTask(task.id).rowVersion;
      store.managerReview(
        'review',
        bot.id,
        task.id,
        version(),
        resultId,
        'human',
        '检查了任务成果',
      );
      if (useDeliver) store.managerDeliver('deliver', bot.id, sessionId, 'deliver', delivery, {});
      assert.equal(store.taskDetail(task.id).deliveredResult, null);
      const eventId = `manager-event:delivery:${resultId}`;
      const payload = store.db
        .prepare('SELECT payload FROM outbox WHERE id=?')
        .get(eventId)?.payload;
      assert.ok(payload);
      assert.equal(
        JSON.parse(String(payload)).links,
        undefined,
        'the ready report supplies the original URL',
      );
      store.managerNotificationDelivered(eventId, sessionId, {
        turn: 1,
        seq: 2,
        endSeq: 3,
        messageId: 'visible',
      });
      assert.deepEqual(store.taskDetail(task.id).deliveredResult?.links, links);
      const updated = store.managerUpdateDeliveryLinks(
        'remove',
        bot.id,
        sessionId,
        task.id,
        version(),
        resultId,
        { 方案: null },
      );
      assert.deepEqual(updated, {});
      assert.deepEqual(
        store.taskDetail(task.id).deliveredResult?.links,
        {},
        'owner removal overrides the Worker default',
      );
    } finally {
      store.close();
    }
  }
});

test('registered delivery links require a durable receipt and KV patches preserve delivery and acceptance', () => {
  const store = new Store(':memory:');
  try {
    const { bot, manager, task, result } = fixture(store, { 草稿: doc }),
      resultId = result.resultId!,
      sessionId = manager.requestedSessionId;
    const delivery = { taskId: task.id, resultId, text: '两项内容已检查' };
    const initial = { 后端MR: mr, 前端MR: `${mr}?variant=web`, 客户端CR: cr, 方案: doc };
    const submit = (id: string, links: unknown) =>
      store.managerDeliver(id, bot.id, sessionId, id, delivery, { links });
    const patch = (id: string, version: number, links: unknown, target = resultId) =>
      store.managerUpdateDeliveryLinks(id, bot.id, sessionId, task.id, version, target, links);
    for (const links of [
      null,
      [mr],
      { ' ': mr },
      { MR: null },
      { MR: 'javascript:alert(1)' },
      { MR: '/relative' },
      { MR: 'https://name:password@example.test/a' },
      { MR: 'https://@example.test' },
      { MR: 'https:////example.test/' },
    ]) {
      assert.throws(() => submit('invalid', links), { code: 'invalid-delivery-links' });
    }
    submit('first', initial);
    const reverse = Object.fromEntries(Object.entries(initial).reverse());
    assert.deepEqual(submit('first', reverse), delivery);
    assert.deepEqual(submit('same-pending', reverse), delivery);
    assert.throws(() => submit('changed-pending', { MR: mr }), { code: 'result-stale' });
    assert.equal(store.taskDetail(task.id).deliveredResult, null);
    assert.throws(() => patch('pending', store.getTask(task.id).rowVersion, { MR: mr }), {
      code: 'result-stale',
    });
    const deliveryEvent = `manager-event:delivery:${resultId}`;
    store.managerNotificationDelivered(deliveryEvent, sessionId, {
      turn: 1,
      seq: 2,
      endSeq: 3,
      messageId: 'first-visible',
    });
    assert.equal(store.taskDetail(task.id).deliveredResult?.deliveryText, delivery.text);
    assert.deepEqual(store.taskDetail(task.id).deliveredResult?.links, initial);
    const accepted = store.acceptResult(
      'accept',
      task.id,
      store.getTask(task.id).rowVersion,
      resultId,
    );
    const before = store.taskDetail(task.id),
      proofBefore = store.db.prepare('SELECT * FROM outbox WHERE id=?').get(deliveryEvent)!;
    const version = accepted.rowVersion,
      updatedMR = `${mr}-updated`;
    assert.throws(() => patch('invalid-patch', version, { 新方案: doc, 坏链接: 'https://' }), {
      code: 'invalid-delivery-links',
    });
    assert.deepEqual(store.taskDetail(task.id).deliveredResult?.links, initial);
    const update = { 后端MR: updatedMR, 方案: null, 联调文档: doc };
    const afterFirst = { 后端MR: updatedMR, 前端MR: initial.前端MR, 客户端CR: cr, 联调文档: doc };
    assert.deepEqual(patch('changes', version, update), afterFirst);
    assert.deepEqual(
      patch('changes', version, update),
      afterFirst,
      'same request replays without writing',
    );
    assert.throws(() => patch('same-key-conflict', version, { 后端MR: cr }), {
      code: 'version-conflict',
    });
    const extra = { 其他文档: doc };
    assert.throws(() => patch('different-key', version, extra), { code: 'version-conflict' });
    assert.deepEqual(patch('different-key', version + 1, extra), { ...afterFirst, ...extra });
    assert.deepEqual(patch('no-op', version + 2, { 后端MR: updatedMR, missing: null }), {
      ...afterFirst,
      ...extra,
    });
    const after = store.taskDetail(task.id);
    assert.deepEqual(after.task, { ...before.task, rowVersion: version + 2 });
    assert.deepEqual(after.result, before.result);
    assert.deepEqual(after.run, before.run);
    assert.deepEqual(after.attentions, before.attentions);
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(after.progress, before.progress);
    assert.deepEqual(after.deliveredResult, {
      ...before.deliveredResult,
      links: { ...afterFirst, ...extra },
    });
    const proofAfter = store.db.prepare('SELECT * FROM outbox WHERE id=?').get(deliveryEvent)!;
    const { links: _, ...payloadBefore } = JSON.parse(String(proofBefore.payload));
    const { links: __, ...payloadAfter } = JSON.parse(String(proofAfter.payload));
    assert.deepEqual(
      { ...proofAfter, payload: payloadAfter },
      { ...proofBefore, payload: payloadBefore },
    );
    assert.equal(
      store.db
        .prepare("SELECT count(*) AS n FROM outbox WHERE json_extract(payload,'$.deliveryOnly')=1")
        .get()?.n,
      1,
    );
  } finally {
    store.close();
  }
});

test('latest formal delivery stays visible throughout rework, with no links inherited by the new version', () => {
  const store = new Store(':memory:');
  try {
    const { bot, manager, task, result } = fixture(store, { MR: mr }),
      firstId = result.resultId!,
      sessionId = manager.requestedSessionId;
    const prove = (resultId: string, turn: number) => {
      store.managerNotificationDelivered(`manager-event:delivery:${resultId}`, sessionId, {
        turn,
        seq: turn * 10,
        endSeq: turn * 10 + 1,
        messageId: `visible-${turn}`,
      });
    };
    store.managerDeliver(
      'first',
      bot.id,
      sessionId,
      'first',
      { taskId: task.id, resultId: firstId, text: '第一版' },
      {},
    );
    prove(firstId, 1);
    store.rejectResult('rework', task.id, store.getTask(task.id).rowVersion, firstId, '补充事实');
    assert.equal(store.taskDetail(task.id).deliveredResult?.id, firstId);
    const patch = (resultId: string) =>
      store.managerUpdateDeliveryLinks(
        'late',
        bot.id,
        sessionId,
        task.id,
        store.getTask(task.id).rowVersion,
        resultId,
        { MR: cr },
      );
    assert.throws(() => patch(firstId), { code: 'result-stale' });
    const run = store.reserveRun('dispatch-2', task.id, store.getTask(task.id).rowVersion);
    store.saveRunMessage(run.id, 'worker-2', '{}');
    store.claimDispatch(run.id);
    store.inputEntered(run.id, 'worker-2', 1);
    const second = store.workerReport(run.id, 'report-2', {
      kind: 'ready',
      summary: `See [reference](${doc})`,
      checks: 'Read the new facts',
      evidence: [{ path: '/synthetic/work/result.md', sha256: 'synthetic', bytes: 21 }],
    });
    store.settleRun(run.id);
    const secondId = second.resultId!;
    const pending = store.taskDetail(task.id);
    assert.equal(pending.result?.id, secondId);
    assert.equal(pending.deliveredResult?.id, firstId);
    assert.deepEqual(pending.deliveredResult?.links, { MR: mr });
    assert.throws(() => patch(firstId), { code: 'result-stale' });
    store.managerReview(
      'legacy-review',
      bot.id,
      task.id,
      pending.task.rowVersion,
      secondId,
      'human',
      '新版本已检查',
    );
    prove(secondId, 2);
    assert.equal(store.taskDetail(task.id).deliveredResult?.id, secondId);
    assert.equal(store.taskDetail(task.id).deliveredResult?.deliveryText, undefined);
    assert.deepEqual(store.taskDetail(task.id).deliveredResult?.links, {});
    assert.deepEqual(
      patch(secondId),
      { MR: cr },
      'a legacy delivery without a link field can be patched explicitly',
    );
    assert.deepEqual(
      store.deliveredResult(store.getTask(task.id), store.resultById(firstId)!)?.links,
      { MR: mr },
    );
  } finally {
    store.close();
  }
});

test('notification entry and managerReview are not delivery; review-to-final crash recovers only notification', () => {
  const root = realpathSync(process.cwd());
  mkdirSync(join(root, '.runtime'), { recursive: true });
  const dir = mkdtempSync(join(root, '.runtime', 'delivery-regression-')),
    file = join(dir, 'ledger.sqlite');
  let store = new Store(file);
  try {
    const f = fixture(store);
    store.claimManagerEvent(f.event.id, 'notice', '{}');
    store.managerEventEntered(f.event.id, 'notice');
    assert.equal(
      store.db.prepare('SELECT state FROM outbox WHERE id=?').get(f.event.id)?.state,
      'entered',
      'native user/message only proves entry, not final chat delivery',
    );
    store.managerReview(
      'review',
      f.bot.id,
      f.task.id,
      store.getTask(f.task.id).rowVersion,
      f.result.resultId!,
      'human',
      'Read actual evidence',
    );
    assert.equal(store.getTask(f.task.id).managerReviewed, true);
    const taskBefore = store.getTask(f.task.id),
      runBefore = store.getRun(f.run.id);
    // Real failure window: the committed review exists, no final assistant message exists, process reopens.
    store.close();
    store = new Store(file);
    store.resetUnconfirmedManagerEvents();
    const retry = store
      .pendingManagerEvents(f.bot.id)
      .find((item) => item.id === `manager-event:delivery:${f.result.resultId}`);
    assert.ok(retry, 'reviewed results must retain a separate delivery obligation');
    assert.equal(JSON.parse(retry.payload).deliveryOnly, true);
    assert.equal(JSON.parse(retry.payload).resultId, f.result.resultId);
    assert.equal(
      store.db.prepare('SELECT state FROM outbox WHERE id=?').get(f.event.id)?.state,
      'unknown',
      'unfinished original management is not replayed',
    );
    assert.deepEqual(store.getTask(f.task.id), taskBefore);
    assert.deepEqual(store.getRun(f.run.id), runBefore);
    assert.equal(store.heldRuns().length, 0);
    assert.equal(store.runResult(f.run.id)?.humanAcceptedAt, null);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get()?.n, 1);
  } finally {
    store.close();
    assert.ok(dir.startsWith(join(root, '.runtime', 'delivery-regression-')));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Review and its delivery obligation commit or roll back together and retry never duplicates responsibility', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store),
      version = store.getTask(f.task.id).rowVersion;
    const review = () =>
      store.managerReview(
        'review',
        f.bot.id,
        f.task.id,
        version,
        f.result.resultId!,
        'human',
        'Read evidence',
      );
    store.db.exec(
      "CREATE TEMP TRIGGER fail_review BEFORE INSERT ON requests WHEN NEW.id='review' BEGIN SELECT RAISE(ABORT,'review receipt fault'); END",
    );
    assert.throws(review, /review receipt fault/);
    assert.equal(store.getTask(f.task.id).managerReviewed, false);
    assert.equal(
      store.managerNotifications(f.bot.id).filter((event) => JSON.parse(event.payload).deliveryOnly)
        .length,
      0,
    );
    store.db.exec('DROP TRIGGER fail_review');
    const first = review();
    assert.deepEqual(review(), first);
    assert.equal(
      store.managerNotifications(f.bot.id).filter((event) => JSON.parse(event.payload).deliveryOnly)
        .length,
      1,
    );
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM reviews').get()?.n, 1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get()?.n, 1);
  } finally {
    store.close();
  }
});

test('delivery attempts enforce persistent 30/60 second backoff and a three-wake cap at claim time', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const store = new Store(':memory:');
  try {
    const f = fixture(store);
    store.managerReview(
      'review',
      f.bot.id,
      f.task.id,
      store.getTask(f.task.id).rowVersion,
      f.result.resultId!,
      'human',
      'Read evidence',
    );
    const id = `manager-event:delivery:${f.result.resultId}`;
    for (let n = 0; n < 3; n++) {
      assert.equal(store.claimManagerEvent(id, `delivery-${n}`, '{}'), true);
      store.managerEventEntered(id, `delivery-${n}`);
      const proof = { sessionId: f.manager.requestedSessionId, turn: n + 1, endSeq: 10 + n };
      store.managerDeliveryAttemptEnded(id, `delivery-${n}`, proof);
      const before = store.db.prepare('SELECT state,payload FROM outbox WHERE id=?').get(id);
      store.managerDeliveryAttemptEnded(id, `delivery-${n}`, proof);
      store.managerEventUnknown(id);
      store.resetUnconfirmedManagerEvents();
      assert.deepEqual(
        store.db.prepare('SELECT state,payload FROM outbox WHERE id=?').get(id),
        before,
        'duplicate end/reset cannot reset the retry deadline',
      );
      assert.equal(store.claimManagerEvent(id, 'too-soon', '{}'), false);
      if (n < 2) {
        assert.ok(!store.pendingManagerEvents(f.bot.id).some((item) => item.id === id));
        t.mock.timers.tick(30000 * 2 ** n - 1);
        assert.equal(store.claimManagerEvent(id, 'still-too-soon', '{}'), false);
        t.mock.timers.tick(1);
        assert.ok(store.pendingManagerEvents(f.bot.id).some((item) => item.id === id));
      }
    }
    assert.equal(store.managerWakeCount(f.bot.id, 0), 3);
    assert.equal(store.db.prepare('SELECT attempts FROM outbox WHERE id=?').get(id)?.attempts, 3);
    assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=?').get(id)?.state, 'unknown');
    const problem = store.managerInfo(f.bot.id).problem;
    assert.match(problem?.message ?? '', /3 次/);
    t.mock.timers.tick(3600000);
    store.resetUnconfirmedManagerEvents();
    assert.equal(store.claimManagerEvent(id, 'never-replay', '{}'), false);
    assert.deepEqual(store.managerInfo(f.bot.id).problem, problem);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get()?.n, 1);
  } finally {
    store.close();
    t.mock.timers.reset();
  }
});

test('unknown sends and entered attempts without durable end proof never become pending on restart', () => {
  for (const entered of [false, true]) {
    const store = new Store(':memory:');
    try {
      const f = fixture(store);
      store.managerReview(
        'review',
        f.bot.id,
        f.task.id,
        store.getTask(f.task.id).rowVersion,
        f.result.resultId!,
        'human',
        'Read evidence',
      );
      const id = `manager-event:delivery:${f.result.resultId}`;
      assert.equal(store.claimManagerEvent(id, 'unconfirmed', '{}'), true);
      if (entered) store.managerEventEntered(id, 'unconfirmed');
      store.resetUnconfirmedManagerEvents();
      assert.equal(
        store.db.prepare('SELECT state FROM outbox WHERE id=?').get(id)?.state,
        entered ? 'entered' : 'unknown',
      );
      assert.equal(store.claimManagerEvent(id, 'never-replay', '{}'), false);
      store.managerEventUnknown(id);
      store.resetUnconfirmedManagerEvents();
      assert.equal(
        store.db.prepare('SELECT state FROM outbox WHERE id=?').get(id)?.state,
        'unknown',
      );
    } finally {
      store.close();
    }
  }
});

test('claim rejects an already exhausted legacy pending delivery and records its problem only once', () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store);
    store.managerReview(
      'review',
      f.bot.id,
      f.task.id,
      store.getTask(f.task.id).rowVersion,
      f.result.resultId!,
      'human',
      'Read evidence',
    );
    const id = `manager-event:delivery:${f.result.resultId}`;
    store.db.prepare('UPDATE outbox SET attempts=14 WHERE id=?').run(id);
    assert.equal(store.claimManagerEvent(id, 'never', '{}'), false);
    const problem = store.managerInfo(f.bot.id).problem;
    assert.match(problem?.message ?? '', /3 次/);
    assert.equal(store.claimManagerEvent(id, 'never-again', '{}'), false);
    assert.deepEqual(store.managerInfo(f.bot.id).problem, problem);
    assert.equal(store.managerWakeCount(f.bot.id, 0), 0);
  } finally {
    store.close();
  }
});
