import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import schemaVersion from '../../schema-version.json' with { type: 'json' };
import { AppError } from '../model.ts';
import { writeTransaction } from './transactions.ts';

export function openLedger(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=100; PRAGMA foreign_keys=ON; PRAGMA locking_mode=EXCLUSIVE;');
    const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (user_version > schemaVersion) throw new AppError('schema-newer', '数据库来自更新版本，请升级插件。');
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    migrateLedger(db, user_version);
    return db;
  } catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === 5) throw new AppError('host-active', '另一宿主正在使用此工作台，请先关闭该宿主。');
    throw error;
  }
}

function migrateLedger(db: DatabaseSync, fromVersion: number): void {
  writeTransaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL,
        configRevision INTEGER NOT NULL DEFAULT 1, managerSessionId TEXT, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, botId TEXT NOT NULL REFERENCES bots(id), goal TEXT NOT NULL,
        scope TEXT NOT NULL, acceptance TEXT NOT NULL,
        reviewPolicy TEXT NOT NULL CHECK(reviewPolicy IN ('human','bot')),
        lifecycle TEXT NOT NULL DEFAULT 'open' CHECK(lifecycle IN ('open','review','completed','cancelled')),
        controlMode TEXT NOT NULL DEFAULT 'auto' CHECK(controlMode IN ('auto','paused','manual')),
        taskRevision INTEGER NOT NULL DEFAULT 1, rowVersion INTEGER NOT NULL DEFAULT 1,
        sessionId TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_bot ON tasks(botId, updatedAt DESC, id);
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_session ON tasks(sessionId) WHERE sessionId IS NOT NULL AND lifecycle IN ('open','review');
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, hash TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_child_wait_task ON events(taskId,id) WHERE kind GLOB 'child-wait.*';
      CREATE INDEX IF NOT EXISTS events_delivery_task ON events(taskId,id) WHERE kind='manager.delivered';
      CREATE INDEX IF NOT EXISTS events_delivery_turn ON events(
        json_extract(data,'$.sessionId'),json_extract(data,'$.turn'),json_extract(data,'$.endSeq')
      ) WHERE kind='manager.delivered' AND json_type(data,'$.resultId')='text';
      CREATE INDEX IF NOT EXISTS events_settled_task ON events(taskId) WHERE kind='run.settled';
      CREATE TABLE IF NOT EXISTS inputs (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, content TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'accepted', createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attentions (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, question TEXT NOT NULL, taskRevision INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'open', createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS attentions_task_state ON attentions(taskId,state);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, taskId TEXT REFERENCES tasks(id), payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings (
        id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), generation INTEGER NOT NULL,
        taskRevision INTEGER NOT NULL, requestedSessionId TEXT NOT NULL UNIQUE, sessionId TEXT,
        cwd TEXT NOT NULL, state TEXT NOT NULL, createdAt INTEGER NOT NULL,
        UNIQUE(taskId,generation)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS bindings_active_task ON bindings(taskId) WHERE state!='released';
      CREATE UNIQUE INDEX IF NOT EXISTS bindings_active_session ON bindings(sessionId) WHERE state!='released';
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), bindingId TEXT NOT NULL REFERENCES bindings(id),
        sessionId TEXT NOT NULL, taskRevision INTEGER NOT NULL, generation INTEGER NOT NULL,
        inputId TEXT NOT NULL REFERENCES inputs(id), state TEXT NOT NULL,
        createdAt INTEGER NOT NULL, finishedAt INTEGER, note TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS run_turns (runId TEXT PRIMARY KEY REFERENCES runs(id),turn INTEGER,startSeq INTEGER,inputSeq INTEGER,endSeq INTEGER,endKind TEXT,quiet INTEGER NOT NULL DEFAULT 0,reportId TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS runs_active_task ON runs(taskId) WHERE finishedAt IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS runs_active_session ON runs(sessionId) WHERE finishedAt IS NULL;
      CREATE TABLE IF NOT EXISTS resources (runId TEXT PRIMARY KEY REFERENCES runs(id));
      CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY,runId TEXT NOT NULL REFERENCES runs(id),kind TEXT NOT NULL,data TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS reports_run ON reports(runId);
      CREATE TABLE IF NOT EXISTS work_stages (
        runId TEXT PRIMARY KEY REFERENCES runs(id), taskId TEXT NOT NULL REFERENCES tasks(id),
        taskRevision INTEGER NOT NULL, state TEXT NOT NULL, details TEXT NOT NULL,
        nextCheckAt INTEGER, failures INTEGER NOT NULL DEFAULT 0, observerOrigin TEXT
      );
      CREATE INDEX IF NOT EXISTS stages_task_revision ON work_stages(taskId,taskRevision);
      CREATE INDEX IF NOT EXISTS stages_due ON work_stages(nextCheckAt) WHERE state='waiting';
      CREATE TABLE IF NOT EXISTS gitlab_release_plans (
        stageRunId TEXT PRIMARY KEY REFERENCES work_stages(runId),
        authorization TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gitlab_release_receipts (
        stageRunId TEXT PRIMARY KEY REFERENCES work_stages(runId),
        runId TEXT NOT NULL REFERENCES runs(id),
        taskId TEXT NOT NULL REFERENCES tasks(id),
        snapshot TEXT NOT NULL,
        nextCheckAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS gitlab_release_due ON gitlab_release_receipts(nextCheckAt) WHERE nextCheckAt IS NOT NULL;
      CREATE TABLE IF NOT EXISTS gitlab_release_claims (
        target TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES runs(id), at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS results (id TEXT PRIMARY KEY,runId TEXT NOT NULL UNIQUE REFERENCES runs(id),taskId TEXT NOT NULL REFERENCES tasks(id),taskRevision INTEGER NOT NULL,summary TEXT NOT NULL,checks TEXT NOT NULL,evidence TEXT NOT NULL,createdAt INTEGER NOT NULL,humanAcceptedAt INTEGER);
      CREATE TABLE IF NOT EXISTS result_attachments (
        resultId TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
        fileIndex INTEGER NOT NULL CHECK(fileIndex BETWEEN 0 AND 9),
        data BLOB NOT NULL,
        PRIMARY KEY(resultId,fileIndex)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY,resultId TEXT NOT NULL REFERENCES results(id),actor TEXT NOT NULL,verdict TEXT NOT NULL,note TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS managers (id TEXT PRIMARY KEY,botId TEXT NOT NULL REFERENCES bots(id),generation INTEGER NOT NULL,configRevision INTEGER NOT NULL,requestedSessionId TEXT NOT NULL UNIQUE,sessionId TEXT UNIQUE,cwd TEXT NOT NULL,state TEXT NOT NULL,createdAt INTEGER NOT NULL,UNIQUE(botId,generation));
      CREATE UNIQUE INDEX IF NOT EXISTS managers_active ON managers(botId) WHERE state!='released';
      CREATE TABLE IF NOT EXISTS waits (taskId TEXT PRIMARY KEY REFERENCES tasks(id),createdAt INTEGER NOT NULL,seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS feishu_group_bindings (
        id TEXT NOT NULL UNIQUE, botId TEXT PRIMARY KEY REFERENCES bots(id),
        appId TEXT NOT NULL, ownerOpenId TEXT NOT NULL,
        chatId TEXT NOT NULL UNIQUE, name TEXT NOT NULL, boundAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feishu_group_creations (
        id TEXT PRIMARY KEY, botId TEXT NOT NULL REFERENCES bots(id), appId TEXT NOT NULL,
        ownerOpenId TEXT NOT NULL, name TEXT NOT NULL, startedAt INTEGER NOT NULL,
        chatId TEXT, resolvedAt INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS feishu_group_creation_pending
        ON feishu_group_creations(botId,appId,ownerOpenId) WHERE resolvedAt IS NULL;
      CREATE TABLE IF NOT EXISTS feishu_group_creation_requests (
        requestId TEXT PRIMARY KEY, creationId TEXT NOT NULL REFERENCES feishu_group_creations(id)
      );
      CREATE TABLE IF NOT EXISTS feishu_inbound_receipts (
        messageId TEXT PRIMARY KEY, nativeMessageId TEXT NOT NULL UNIQUE, bindingId TEXT NOT NULL,
        botId TEXT NOT NULL, sessionId TEXT NOT NULL, senderOpenId TEXT NOT NULL, appId TEXT NOT NULL,
        textDigest TEXT NOT NULL, acceptedAt INTEGER NOT NULL, nativeSeq INTEGER
      );
      `);

    const inputColumns = db.prepare('PRAGMA table_info(inputs)').all().map(row => row.name);
    if (!inputColumns.includes('messageId')) {
      db.exec('ALTER TABLE inputs ADD COLUMN messageId TEXT; ALTER TABLE inputs ADD COLUMN messageJson TEXT;');
    }
    if (!inputColumns.includes('attentionId')) {
      db.exec('ALTER TABLE inputs ADD COLUMN attentionId TEXT REFERENCES attentions(id);');
    }
    const botColumns = db.prepare('PRAGMA table_info(bots)').all().map(row => row.name);
    if (!botColumns.includes('materials')) db.exec("ALTER TABLE bots ADD COLUMN materials TEXT NOT NULL DEFAULT '[]';");
    if (!botColumns.includes('deletedAt')) db.exec('ALTER TABLE bots ADD COLUMN deletedAt INTEGER;');

    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name);
    if (!taskColumns.includes('botConfigRevision')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN botConfigRevision INTEGER NOT NULL DEFAULT 1;
        UPDATE tasks SET botConfigRevision=(SELECT configRevision FROM bots WHERE bots.id=tasks.botId);`);
    }
    if (!taskColumns.includes('botContext')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN botContext TEXT NOT NULL DEFAULT '{}';
        UPDATE tasks SET botContext=json_object(
          'instructions',(SELECT instructions FROM bots WHERE bots.id=tasks.botId),
          'materials',json((SELECT materials FROM bots WHERE bots.id=tasks.botId))
        );`);
    }
    if (!taskColumns.includes('workdirRequest')) db.exec('ALTER TABLE tasks ADD COLUMN workdirRequest TEXT;');

    const bindingColumns = db.prepare('PRAGMA table_info(bindings)').all().map(row => row.name);
    if (!bindingColumns.includes('workdir')) db.exec('ALTER TABLE bindings ADD COLUMN workdir TEXT;');
    if (fromVersion > 0 && fromVersion < 11) {
      db.exec(`CREATE TABLE resources_next (runId TEXT PRIMARY KEY REFERENCES runs(id));
        INSERT INTO resources_next SELECT runId FROM resources;
        DROP TABLE resources;
        ALTER TABLE resources_next RENAME TO resources;`);
    }
    db.exec(`PRAGMA user_version=${schemaVersion}`);
  });
}
