import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';
import version from '../schema-version.json' with { type: 'json' };

function oldLedger(file: string) {
  const db = new DatabaseSync(file);
  db.exec(readFileSync(new URL('./fixtures/schema-v2.sql', import.meta.url), 'utf8'));
  db.exec(
    "INSERT INTO bots VALUES ('bot','Old Bot','Synthetic responsibility',1,NULL,1); INSERT INTO tasks VALUES ('task','bot','Existing goal','Own files','Read result','human','open','auto',1,1,NULL,1,1); INSERT INTO inputs VALUES ('input','task','goal','Existing goal','accepted',1);",
  );
  db.close();
}
function assertOld(file: string) {
  const db = new DatabaseSync(file);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.equal(
      db.prepare('SELECT goal FROM tasks WHERE id=?').get('task')?.goal,
      'Existing goal',
    );
    assert.equal(
      db
        .prepare('PRAGMA table_info(inputs)')
        .all()
        .some((column) => column.name === 'messageId'),
      false,
    );
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='bindings'")
        .get()?.n,
      0,
    );
  } finally {
    db.close();
  }
}
function assertUpgraded(file: string) {
  const store = new Store(file);
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, version);
    assert.equal(store.getTask('task').goal, 'Existing goal');
    assert.equal(store.getBot('bot').name, 'Old Bot');
    assert.equal(store.getTask('task').botConfigRevision, 1);
    assert.equal(store.taskBotContext('task').instructions, 'Synthetic responsibility');
    assert.deepEqual(store.taskBotContext('task').materials, []);
    assert.equal(
      store.db.prepare('SELECT messageId,attentionId FROM inputs WHERE id=?').get('input')
        ?.messageId,
      null,
    );
    const binding = store.beginBinding('prepare', 'task', 1, '/tmp/synthetic-upgraded-task');
    store.confirmBinding(binding.id, binding.requestedSessionId);
    assert.equal(store.reserveRun('run', 'task', store.getTask('task').rowVersion).state, 'queued');
    assert.equal(store.db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  } finally {
    store.close();
  }
}

test('a frozen version 2 ledger upgrades with old responsibility and inputs preserved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-bot-migrate-'));
  try {
    const file = join(dir, 'ledger.sqlite');
    oldLedger(file);
    assertOld(file);
    assertUpgraded(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a version 10 ledger keeps held Runs while dropping directory exclusivity', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'super-bot-migrate-'));
  const file = join(dir, 'ledger.sqlite'),
    cwd = join(dir, 'shared');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = new Store(file);
  const bot = old.createBot('bot', { name: 'Bot', instructions: 'Synthetic' });
  const task = (name: string) => {
    const created = old.createTask(`task:${name}`, {
      botId: bot.id,
      goal: name,
      scope: 'Own files',
      acceptance: 'Read back',
      reviewPolicy: 'human',
    });
    const binding = old.beginBinding(`bind:${name}`, created.id, created.rowVersion, cwd);
    old.confirmBinding(binding.id, binding.requestedSessionId);
    return old.getTask(created.id);
  };
  const first = task('first'),
    second = task('second');
  const run = old.reserveRun('first', first.id, first.rowVersion);
  old.db.exec(
    'DROP TABLE resources; CREATE TABLE resources (runId TEXT PRIMARY KEY REFERENCES runs(id),cwd TEXT NOT NULL UNIQUE); PRAGMA user_version=10;',
  );
  old.db.prepare('INSERT INTO resources VALUES (?,?)').run(run.id, cwd);
  old.close();

  const upgraded = new Store(file);
  try {
    assert.deepEqual(
      upgraded.heldRuns().map((item) => item.id),
      [run.id],
    );
    assert.deepEqual(upgraded.botCapacity(bot.id), {
      maxRunningTasks: null,
      botLimit: 5,
      botHeld: 1,
    });
    assert.equal(upgraded.activeBinding(first.id)?.cwd, cwd);
    const next = upgraded.reserveRun('second', second.id, second.rowVersion);
    assert.deepEqual(
      new Set(upgraded.heldRuns().map((item) => item.id)),
      new Set([run.id, next.id]),
    );
    assert.equal(upgraded.botCapacity(bot.id).botHeld, 2);
    assert.deepEqual(upgraded.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    upgraded.close();
  }
});

test('migration failure rolls back new tables and version, leaving old data repairable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-bot-migrate-'));
  try {
    const file = join(dir, 'ledger.sqlite');
    oldLedger(file);
    const corrupt = new DatabaseSync(file);
    corrupt.exec('CREATE VIEW managers AS SELECT 1 AS botId');
    corrupt.close();
    assert.throws(() => new Store(file), /view|index/i);
    assertOld(file);
    const repair = new DatabaseSync(file);
    repair.exec('DROP VIEW managers');
    repair.close();
    assertUpgraded(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('process loss during an uncommitted migration cannot expose half-upgraded state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-bot-migrate-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const file = join(dir, 'ledger.sqlite');
    oldLedger(file);
    child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; ALTER TABLE inputs ADD COLUMN messageId TEXT; CREATE TABLE interrupted_migration(value TEXT); PRAGMA user_version=${version};');
      process.send('migration-uncommitted');setInterval(()=>{},1000);
    `,
        file,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child?.kill('SIGKILL'), 10000);
    timer.unref();
    try {
      const signal = await Promise.race([
        once(child, 'message').then(([message]) => message),
        exited.then(() => {
          throw new Error('migration child exited before checkpoint');
        }),
      ]);
      assert.equal(signal, 'migration-uncommitted');
      child.kill('SIGKILL');
      await exited;
    } finally {
      clearTimeout(timer);
    }
    assertOld(file);
    assertUpgraded(file);
  } finally {
    child?.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
