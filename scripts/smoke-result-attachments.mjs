// Run via smoke-mirror.mjs with SUPER_BOT_TEST_RESULT_ATTACHMENTS=1 and a prebuilt bundle.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import schemaVersion from '../schema-version.json' with { type: 'json' };
import { Store } from '../src/store.ts';
import { receiptReviewGoal } from '../test/delivery-link-fixture.ts';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const attachmentPath = (id, index = 0, sessionId) =>
  `/api/super-bot-file?${new URLSearchParams({
    resultId: id,
    index: String(index),
    ...(sessionId && { sessionId }),
  })}`;

async function seedLegacy(ledger, base) {
  const cwd = join(base, 'legacy-fixture');
  await mkdir(cwd);
  const path = join(cwd, 'legacy.txt'),
    bytes = Buffer.from('Original legacy content\n');
  await writeFile(path, bytes, { flag: 'wx' });
  const store = new Store(ledger);
  try {
    const bot = store.createBot('legacy-bot', {
      name: 'Schema 9 fixture',
      instructions: 'Synthetic only',
    });
    const task = store.createTask('legacy-task', {
      botId: bot.id,
      goal: 'Old file',
      scope: 'Fixture',
      acceptance: 'Read the file',
      reviewPolicy: 'human',
    });
    const binding = store.beginBinding('legacy-binding', task.id, task.rowVersion, cwd);
    store.confirmBinding(binding.id, binding.requestedSessionId);
    const run = store.reserveRun('legacy-run', task.id, store.getTask(task.id).rowVersion);
    store.saveRunMessage(run.id, 'legacy-message', '{}');
    store.claimDispatch(run.id);
    store.inputEntered(run.id, 'legacy-message', 1);
    const { resultId } = store.workerReport(run.id, 'legacy-report', {
      kind: 'ready',
      summary: 'Old result',
      checks: 'Read it',
      evidence: [{ path, bytes: bytes.length, sha256: sha256(bytes) }],
    });
    store.settleRun(run.id, false);
    store.db.exec('DROP TABLE result_attachments; PRAGMA user_version=9');
    return { resultId, path, bytes };
  } finally {
    store.close();
  }
}

export async function smokeResultAttachments({
  root,
  base,
  bundle,
  ledger,
  configure,
  patch,
  launch,
  stop,
  rpc,
  call,
  makeBot,
  probe,
  wait,
  verifyClient,
}) {
  await Promise.all(
    ['web', 'desktop'].map((role) => configure(role, { hmr: false, paired: true })),
  );
  const legacy = await seedLegacy(ledger('web'), base);
  let origin = await launch('web', 'attachments');
  const peer = await launch('desktop', 'attachments');
  const hostFacts = async (role, host) => ({
    pid: host.pid,
    origin: host.base,
    runtime: (await call(host, 'status')).runtime,
    clientRevision: await verifyClient(role, host),
  });
  const hosts = { web: await hostFacts('web', origin), desktop: await hostFacts('desktop', peer) };
  const getBytes = async (path) => {
    const response = await origin.get(path);
    assert.equal(response.status, 200, path);
    return Buffer.from(await response.arrayBuffer());
  };
  const oldRoute = attachmentPath(legacy.resultId);
  assert.deepEqual(await getBytes(oldRoute), legacy.bytes);
  const mismatch = Buffer.from(legacy.bytes);
  mismatch[0] ^= 1;
  await writeFile(legacy.path, mismatch);
  const changed = await origin.get(oldRoute);
  assert.equal(changed.status, 409);
  const changedMessage = await changed.text();
  assert.match(changedMessage, /未保存附件副本.*记录不符.*恢复到原路径.*重新提交/);
  assert.equal(await realpath(legacy.path), join(base, 'legacy-fixture', 'legacy.txt'));
  await rm(legacy.path);
  const missing = await origin.get(oldRoute);
  assert.equal(missing.status, 409);
  const missingMessage = await missing.text();
  assert.match(missingMessage, /未保存附件副本.*无法读取.*恢复到原路径.*重新提交/);
  await writeFile(legacy.path, legacy.bytes, { flag: 'wx' });
  assert.deepEqual(await getBytes(oldRoute), legacy.bytes);
  console.log(
    'PASS schema 9 legacy record: matching file 200, same-size SHA mismatch and missing file 409 with recovery instructions',
  );

  const bot = await makeBot(origin, 'Result attachment retention probe');
  const say = (text) => probe(origin, 'native-prompt', bot.managerId, text);
  const inspect = () => probe(origin, 'inspect-session', bot.managerId);
  await probe(origin, 'select-test-model', bot.managerId);
  await say(receiptReviewGoal);
  const task = await wait(
    async () =>
      (await call(origin, 'task.list', { botId: bot.id })).items.find(
        (item) => item.managerReviewed,
      ),
    'first Worker ready',
  );
  const taskScope = { id: task.id, sessionId: bot.managerId };
  const detail = (resultId) =>
    call(origin, 'task.detail', { ...taskScope, ...(resultId && { resultId }) });
  async function version(previous) {
    const resultDetail = await wait(async () => {
      const current = await detail();
      return (
        current.task.lifecycle === 'review' &&
        current.task.managerReviewed &&
        current.result &&
        current.result.id !== previous &&
        current
      );
    }, 'reviewable Worker result');
    await wait(async () => (await inspect()).status === 'idle', 'manager reply to review');
    await say(`DF14_SHOW_RESULT:${task.id}`);
    const current = await wait(async () => {
      const value = await detail();
      return value.chatDelivery.state === 'delivered' && value;
    }, 'native delivery receipt');
    const { result, run } = current;
    assert.equal(result.id, resultDetail.result.id);
    assert.equal(result.humanAcceptedAt, null);
    assert.equal(result.evidence.length, 1);
    const path = result.evidence[0].path;
    const bytes = await readFile(path);
    assert.equal(bytes.length, result.evidence[0].bytes);
    assert.equal(sha256(bytes), result.evidence[0].sha256);
    const receipt = current.events
      .filter((event) => event.kind === 'manager.delivered')
      .map((event) => JSON.parse(event.data))
      .find((event) => event.resultId === result.id);
    assert.equal(receipt.sessionId, bot.managerId);
    const chat = await inspect();
    assert.equal(
      chat.events.find((event) => event.seq === receipt.endSeq)?.data.reason.kind,
      'completed',
    );
    assert.ok(
      chat.assistantTexts.some((text) =>
        text.includes(`${origin.base}/#super-bot-task=${task.id}&resultId=${result.id}`),
      ),
    );
    return {
      id: result.id,
      runId: run.id,
      path,
      bytes,
      sha256: sha256(bytes),
      receiptEndSeq: receipt.endSeq,
    };
  }

  const first = await version();
  const initial = await detail();
  const cwd = join(base, 'web', 'super-bot', '.runtime', 'dsh', 'super-bot', 'workspaces', task.id);
  assert.equal(initial.binding.cwd, cwd);
  await writeFile(join(cwd, 'unsubmitted.txt'), 'Outside the ready list', { flag: 'wx' });
  await say('再加一句结论。');
  const second = await version(first.id);
  assert.equal(first.path, second.path);
  assert.notEqual(first.sha256, second.sha256);
  const versions = [first, second];
  async function verifyDownloads() {
    for (const item of versions) {
      const linked = await detail(item.id);
      assert.equal(linked.linkedResult.id, item.id);
      assert.equal(linked.linkedResult.humanAcceptedAt, null);
      const route = attachmentPath(item.id, 0, bot.managerId);
      const downloaded = await getBytes(route);
      assert.deepEqual(downloaded, item.bytes);
      assert.equal(sha256(downloaded), linked.linkedResult.evidence[0].sha256);
      assert.equal((await origin.get(attachmentPath(item.id, 1, bot.managerId))).status, 404);
    }
  }
  await verifyDownloads();
  assert.notEqual(
    (await fetch(origin.base + attachmentPath(first.id), { redirect: 'manual' })).status,
    200,
  );
  const view = await call(peer, 'mirror.detail', { owner: 'web', botId: bot.id, id: task.id });
  for (const { id } of versions) {
    assert.equal(view.records.results.find((result) => result.id === id)?.fileCount, 1);
    assert.equal((await peer.get(attachmentPath(id))).status, 404);
  }
  assert.equal(JSON.stringify(view).includes(first.path), false);
  assert.equal(JSON.stringify(view).includes('"evidence"'), false);
  const stale = await rpc(origin, 'result.accept', {
    ...taskScope,
    resultId: first.id,
    requestId: randomUUID(),
    expectedRowVersion: (await detail()).task.rowVersion,
  });
  assert.equal(stale.error?.code, 'result-stale');
  assert.equal(await realpath(cwd), cwd);
  await rm(cwd, { recursive: true });
  await assert.rejects(stat(cwd), { code: 'ENOENT' });
  await verifyDownloads();
  assert.equal((await detail()).task.lifecycle, 'review');
  console.log(
    `PASS two same-name versions ${first.id}/${second.id}; original bytes after overwrite and workdir deletion; peer metadata only, historical accept rejected`,
  );

  const backup = await call(origin, 'backup.create', { requestId: randomUUID() });
  assert.equal(backup.schema, schemaVersion);
  assert.equal(backup.counts.results, 3);
  assert.match(backup.scope, /已保存的成果附件/);
  assert.equal((await stat(backup.path)).mode & 0o777, 0o600);
  const snapshot = new DatabaseSync(backup.path, { readOnly: true });
  try {
    const rows = snapshot
      .prepare('SELECT resultId,fileIndex,data FROM result_attachments ORDER BY resultId')
      .all();
    assert.deepEqual(
      rows.map((row) => [row.resultId, row.fileIndex, sha256(row.data)]),
      versions.map((item) => [item.id, 0, item.sha256]).sort(([a], [b]) => a.localeCompare(b)),
    );
  } finally {
    snapshot.close();
  }
  await stop('web');
  const restored = join(base, 'restored-ledger');
  const backupHash = sha256(await readFile(backup.path));
  const restore = JSON.parse(
    execFileSync(
      process.execPath,
      [join(root, 'scripts/restore-ledger.mjs'), backup.path, restored],
      { encoding: 'utf8', timeout: 10000 },
    ),
  );
  assert.equal(restore.ok, true);
  assert.equal(sha256(await readFile(backup.path)), backupHash);
  await patch('web', { hmr: false, data: restored });
  origin = await launch('web', 'restored');
  hosts.restored = await hostFacts('web', origin);
  await verifyDownloads();
  assert.deepEqual(await getBytes(oldRoute), legacy.bytes);
  const after = await detail();
  assert.equal(after.task.controlMode, 'paused');
  assert.equal(after.result.humanAcceptedAt, null);
  assert.deepEqual(
    after.events
      .filter((event) => event.kind === 'run.queued')
      .map((event) => JSON.parse(event.data).runId)
      .sort(),
    versions.map((item) => item.runId).sort(),
  );
  const resultReceipts = after.events
    .filter((event) => event.kind === 'manager.delivered')
    .map((event) => JSON.parse(event.data))
    .filter((receipt) => receipt.resultId);
  assert.deepEqual(
    resultReceipts.map((receipt) => [receipt.resultId, receipt.endSeq]).sort(),
    versions.map((item) => [item.id, item.receiptEndSeq]).sort(),
  );
  const proof = {
    hosts,
    taskId: task.id,
    managerSession: bot.managerId,
    workdirRemoved: cwd,
    versions: versions.map(({ id, runId, sha256, bytes, path, receiptEndSeq }) => ({
      id,
      runId,
      sha256,
      bytes: bytes.length,
      filename: basename(path),
      receiptEndSeq,
      downloadedAfterRestore: true,
    })),
    legacy: {
      id: legacy.resultId,
      sha256: sha256(legacy.bytes),
      sourceSchema: 9,
      available: 200,
      changed: changedMessage,
      missing: missingMessage,
    },
    build: {
      host: sha256(await readFile(join(bundle, 'lib/index.js'))),
      client: sha256(await readFile(join(bundle, 'lib/client.js'))),
    },
    backup: { schema: backup.schema, sha256: backupHash, restored },
    humanAcceptedAt: after.result.humanAcceptedAt,
  };
  await writeFile(join(base, 'attachment-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(
    `PASS existing SQLite backup and restore, both SHA unchanged; proof ${join(base, 'attachment-proof.json')}`,
  );
}
