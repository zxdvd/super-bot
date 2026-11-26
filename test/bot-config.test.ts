import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.ts';
import { botWorkSummaries } from '../src/work-activity.ts';

test('Bot updates preserve task snapshots, revoke old Manager authority, and survive reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-bot-config-')),
    file = join(dir, 'ledger.sqlite'),
    path = join(dir, 'reference.md');
  let store = new Store(file);
  const material = (text: string) => ({
    path,
    text,
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  try {
    const input = { name: 'Bot', instructions: 'Original responsibility', referencePaths: [path] };
    const bot = store.createBot('bot', input, [material('ORIGINAL_REFERENCE')]);
    const oldManager = store.beginManager('manager', bot.id, join(dir, 'manager'));
    store.confirmManager(oldManager.id, oldManager.requestedSessionId);
    const task = store.createTask('task', {
      botId: bot.id,
      goal: 'Original task',
      scope: 'Own directory',
      acceptance: 'Original criterion',
      reviewPolicy: 'human',
      startPaused: true,
    });
    const next = { ...input, name: 'Updated Bot', instructions: 'New responsibility' };
    const updated = store.updateBot('update', bot.id, 1, next, [material('NEW_REFERENCE')]);
    assert.equal(updated.configRevision, 2);
    assert.equal(updated.managerSessionId, null);
    assert.equal(store.managerForSession(oldManager.requestedSessionId), null);
    assert.equal(store.getTask(task.id).botConfigRevision, 1);
    assert.equal(store.taskBotContext(task.id).instructions, 'Original responsibility');
    assert.equal(store.taskBotContext(task.id).materials[0]?.text, 'ORIGINAL_REFERENCE');
    assert.equal(JSON.stringify(store.listBots()).includes('NEW_REFERENCE'), false);
    assert.equal(
      JSON.stringify(store.listTasks({ botId: bot.id })).includes('ORIGINAL_REFERENCE'),
      false,
    );
    const later = store.createTask('later', {
      botId: bot.id,
      goal: 'New task',
      scope: 'Own directory',
      acceptance: 'New criterion',
      reviewPolicy: 'human',
    });
    assert.equal(later.botConfigRevision, 2);
    assert.equal(store.taskBotContext(later.id).materials[0]?.text, 'NEW_REFERENCE');
    assert.throws(
      () => store.updateBot('stale', bot.id, 1, input, [material('STALE')]),
      /已经更新/,
    );
    assert.equal(
      store.updateBot('update', bot.id, 1, next, [material('DISK_CHANGED_AFTER_RECEIPT')])
        .configRevision,
      2,
    );
    const manager = store.beginManager('new-manager', bot.id, join(dir, 'manager'));
    store.confirmManager(manager.id, manager.requestedSessionId);
    const same = store.updateBot('no-change', bot.id, 2, next, [material('NEW_REFERENCE')]);
    assert.equal(same.configRevision, 2);
    assert.equal(same.managerSessionId, manager.requestedSessionId);
    store.db.exec(
      "CREATE TRIGGER fail_config BEFORE INSERT ON events WHEN NEW.kind='bot.updated' BEGIN SELECT RAISE(ABORT,'config fault'); END",
    );
    assert.throws(
      () => store.updateBot('failed-update', bot.id, 2, input, [material('ORIGINAL_REFERENCE')]),
      /config fault/,
    );
    assert.equal(store.getBot(bot.id).configRevision, 2);
    assert.equal(store.managerForSession(manager.requestedSessionId)?.id, manager.id);
    store.db.exec('DROP TRIGGER fail_config');
    store.close();
    store = new Store(file);
    assert.equal(store.getBot(bot.id).configRevision, 2);
    assert.equal(store.taskBotContext(task.id).materials[0]?.text, 'ORIGINAL_REFERENCE');
    assert.equal(store.taskBotContext(later.id).materials[0]?.text, 'NEW_REFERENCE');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Bot deletion is versioned and atomic, retaining history while revoking current work and group routing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-bot-delete-'));
  const file = join(dir, 'ledger.sqlite'),
    workspace = join(dir, 'workspace.txt');
  let store = new Store(file);
  try {
    const bot = store.createBot('alpha', { name: 'Alpha', instructions: 'Synthetic' });
    const other = store.createBot('beta', { name: 'Beta', instructions: 'Synthetic' });
    const manager = store.beginManager('prepare', bot.id, dir);
    store.confirmManager(manager.id, manager.requestedSessionId);
    const task = store.createTask('task', {
      botId: bot.id,
      goal: 'Work',
      scope: '',
      acceptance: '',
      reviewPolicy: 'human',
    });
    const binding = store.db.prepare('INSERT INTO feishu_group_bindings VALUES (?,?,?,?,?,?,?)');
    binding.run('alpha-binding', bot.id, 'app', 'owner', 'oc_alpha', 'Alpha group', Date.now());
    binding.run('beta-binding', other.id, 'app', 'owner', 'oc_beta', 'Beta group', Date.now());
    writeFileSync(workspace, 'Preserve this workspace');
    assert.throws(() => store.deleteBot('delete', bot.id, 2, false), { code: 'version-conflict' });
    assert.throws(() => store.deleteBot('delete', bot.id, 1, false), { code: 'bot-unfinished' });
    store.cancelTask('cancel', task.id, task.rowVersion);
    store.enqueueManager(bot.id, 'remaining', 'Do not wake after deletion', null);
    store.enqueueManager(other.id, 'other', 'Remain active', null);
    store.db.exec(
      "CREATE TRIGGER fail_delete BEFORE INSERT ON events WHEN NEW.kind='bot.deleted' BEGIN SELECT RAISE(ABORT,'audit fault'); END",
    );
    assert.throws(() => store.deleteBot('delete', bot.id, 1, false), /audit fault/);
    assert.equal(store.botForSession(manager.requestedSessionId)?.id, bot.id);
    assert.equal(store.pendingManagerEvents(bot.id).length, 1);
    assert.equal(
      store.db.prepare('SELECT id FROM feishu_group_bindings WHERE botId=?').get(bot.id)?.id,
      'alpha-binding',
    );
    store.db.exec('DROP TRIGGER fail_delete');
    const receipt = store.deleteBot('delete', bot.id, 1, false);
    assert.deepEqual(receipt, {
      botId: bot.id,
      managerSessionId: manager.requestedSessionId,
      feishuBindingId: 'alpha-binding',
    });
    store.close();
    store = new Store(file);
    assert.deepEqual(store.deleteBot('delete', bot.id, 1, false), receipt);
    assert.throws(() => store.deleteBot('delete', bot.id, 1, true), {
      code: 'idempotency-conflict',
    });
    assert.throws(() => store.deleteBot('delete', other.id, 1, false), {
      code: 'idempotency-conflict',
    });
    assert.throws(() => store.beginManager('new-prepare', bot.id, dir), { code: 'not-found' });
    assert.throws(
      () =>
        store.createTask('late-task', {
          botId: bot.id,
          goal: 'Too late',
          scope: '',
          acceptance: '',
          reviewPolicy: 'human',
        }),
      { code: 'not-found' },
    );
    assert.equal(store.botForSession(manager.requestedSessionId), null);
    assert.equal(store.getManager(manager.id).state, 'released');
    assert.equal(store.getTask(task.id).lifecycle, 'cancelled');
    assert.equal(readFileSync(workspace, 'utf8'), 'Preserve this workspace');
    assert.deepEqual(
      store.listBots().map((item) => item.id),
      [other.id],
    );
    assert.deepEqual(
      botWorkSummaries(store.db).map((item) => item.id),
      [other.id],
    );
    assert.deepEqual(
      store.db
        .prepare('SELECT id FROM feishu_group_bindings')
        .all()
        .map((row) => row.id),
      ['beta-binding'],
    );
    store.enqueueManager(bot.id, 'late', 'Do not wake a deleted Bot', null);
    assert.equal(store.pendingManagerEvents(bot.id).length, 0);
    assert.equal(store.pendingManagerEvents(other.id).length, 1);
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='bot.deleted'").get()?.n,
      1,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
