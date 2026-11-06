import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError, requiredText, optionalText, taskStatus, type Bot, type Task, type NewBot, type NewTask, type TaskPage, type ControlMode, type Attention } from './model.ts';

/** One local database. Business transactions will live here, not in the UI/adapter. */
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=100; PRAGMA foreign_keys=ON; PRAGMA locking_mode=EXCLUSIVE;');
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version.user_version > 2) throw new AppError('schema-newer', '数据库来自更新版本，请升级插件。');
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.db.exec(`BEGIN IMMEDIATE;
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
        CREATE TABLE IF NOT EXISTS inputs (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, content TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'accepted', createdAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS attentions (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, question TEXT NOT NULL, taskRevision INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'open', createdAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, taskId TEXT REFERENCES tasks(id), payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
        PRAGMA user_version=2;
        COMMIT;`);
    } catch (error) {
      this.db.close();
      if ((error as { errcode?: number }).errcode === 5) throw new AppError('host-active', '另一宿主正在使用此工作台，请先关闭该宿主。');
      throw error;
    }
  }
  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  set(key: string, value: string): void {
    this.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  private command<T>(requestId: string, action: string, payload: unknown, operation: () => T): T {
    const id = requiredText(requestId, '请求标识', 200);
    // Payloads are explicit normalized records constructed by the command, never raw wire objects.
    const hash = createHash('sha256').update(JSON.stringify({ action, payload })).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT hash,result FROM requests WHERE id=?').get(id) as { hash: string; result: string } | undefined;
      if (prior) {
        if (prior.hash !== hash) throw new AppError('idempotency-conflict', '同一请求标识不能用于不同的内容。');
        this.db.exec('COMMIT'); return JSON.parse(prior.result) as T;
      }
      const result = operation();
      this.db.prepare('INSERT INTO requests VALUES (?,?,?)').run(id, hash, JSON.stringify(result));
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private event(kind: string, taskId: string | null, data: unknown): void {
    this.db.prepare('INSERT INTO events(taskId,kind,data,createdAt) VALUES (?,?,?,?)').run(taskId, kind, JSON.stringify(data), Date.now());
  }
  createBot(requestId: string, input: NewBot): Bot {
    const payload = { name: requiredText(input.name, 'Bot 名称', 80), instructions: requiredText(input.instructions, 'Bot 职责') };
    return this.command(requestId, 'bot.create', payload, () => {
      const bot: Bot = { id: randomUUID(), ...payload, configRevision: 1, managerSessionId: null, createdAt: Date.now() };
      this.db.prepare('INSERT INTO bots(id,name,instructions,createdAt) VALUES (?,?,?,?)').run(bot.id, bot.name, bot.instructions, bot.createdAt);
      this.event('bot.created', null, { botId: bot.id }); return bot;
    });
  }
  listBots(): Bot[] { return this.db.prepare('SELECT * FROM bots ORDER BY createdAt,id').all() as unknown as Bot[]; }
  getBot(id: string): Bot {
    const bot = this.db.prepare('SELECT * FROM bots WHERE id=?').get(id) as unknown as Bot | undefined;
    if (!bot) throw new AppError('not-found', 'Bot 不存在。');
    return bot;
  }
  createTask(requestId: string, input: NewTask): Task {
    const payload: NewTask = { botId: requiredText(input.botId, 'Bot 标识', 200), goal: requiredText(input.goal, '任务目标'),
      scope: optionalText(input.scope, '任务范围'), acceptance: optionalText(input.acceptance, '验收条件'), reviewPolicy: input.reviewPolicy };
    if (!['human', 'bot'].includes(payload.reviewPolicy)) throw new AppError('invalid-input', '请选择有效的验收方式。');
    return this.command(requestId, 'task.create', payload, () => {
      this.getBot(payload.botId);
      const id = randomUUID(), now = Date.now();
      this.db.prepare('INSERT INTO tasks(id,botId,goal,scope,acceptance,reviewPolicy,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, payload.botId, payload.goal, payload.scope, payload.acceptance, payload.reviewPolicy, now, now);
      this.db.prepare('INSERT INTO inputs(id,taskId,kind,content,createdAt) VALUES (?,?,?,?,?)')
        .run(randomUUID(), id, 'goal', payload.goal, now);
      this.event('task.created', id, { taskRevision: 1 });
      if (!payload.scope || !payload.acceptance) this.db.prepare('INSERT INTO attentions(id,taskId,kind,question,taskRevision,createdAt) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(),id,'input','请补充任务范围和验收条件，然后再安排执行。',1,now);
      return this.getTask(id);
    });
  }
  getTask(id: string): Task {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as unknown as Task | undefined;
    if (!task) throw new AppError('not-found', '任务不存在。');
    return { ...task, status: taskStatus(task) };
  }
  taskDetail(id: string): { task: Task; attentions: Attention[]; events: { id: number; kind: string; data: string; createdAt: number }[] } {
    return { task: this.getTask(id),
      attentions: this.db.prepare('SELECT * FROM attentions WHERE taskId=? ORDER BY createdAt,id').all(id) as unknown as Attention[],
      events: this.db.prepare('SELECT id,kind,data,createdAt FROM events WHERE taskId=? ORDER BY id DESC LIMIT 50').all(id) as unknown as { id: number; kind: string; data: string; createdAt: number }[],
    };
  }
  reviseTask(requestId: string, id: string, expectedRowVersion: number, input: Pick<NewTask,'goal'|'scope'|'acceptance'>): Task {
    const payload = { id, expectedRowVersion, goal: requiredText(input.goal,'任务目标'), scope: optionalText(input.scope,'任务范围'), acceptance: optionalText(input.acceptance,'验收条件') };
    return this.command(requestId,'task.revise',payload,() => {
      const task = this.getTask(id);
      if (task.rowVersion !== expectedRowVersion) throw new AppError('version-conflict','任务已经更新，请刷新后再修改。');
      if (task.sessionId) throw new AppError('execution-attached','执行会话已关联，需要先核对执行状态才能修改目标。');
      if (task.lifecycle !== 'open') throw new AppError('task-ended','当前任务不接受目标修改。');
      if (task.goal === payload.goal && task.scope === payload.scope && task.acceptance === payload.acceptance) return task;
      this.db.prepare('UPDATE tasks SET goal=?,scope=?,acceptance=?,taskRevision=taskRevision+1,rowVersion=rowVersion+1,updatedAt=? WHERE id=?')
        .run(payload.goal,payload.scope,payload.acceptance,Date.now(),id);
      this.db.prepare("UPDATE attentions SET state='stale' WHERE taskId=? AND state='open'").run(id);
      if (!payload.scope || !payload.acceptance) this.db.prepare('INSERT INTO attentions(id,taskId,kind,question,taskRevision,createdAt) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(),id,'input','请补充任务范围和验收条件，然后再安排执行。',task.taskRevision+1,Date.now());
      this.event('task.revised',id,{ taskRevision: task.taskRevision+1 }); return this.getTask(id);
    });
  }
  listTasks(query: { botId: string; q?: string; lifecycle?: string; limit?: number; offset?: number }): TaskPage {
    this.getBot(query.botId);
    const limit = query.limit ?? 25, offset = query.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new AppError('invalid-input', '分页参数无效。');
    const q = (query.q ?? '').trim().toLowerCase();
    const lifecycle = query.lifecycle ?? '';
    if (!['', 'open', 'review', 'completed', 'cancelled'].includes(lifecycle)) throw new AppError('invalid-input', '状态筛选无效。');
    const where = 'botId=? AND instr(lower(goal),?)>0 AND (?=\'\' OR lifecycle=?)';
    const args = [query.botId, q, lifecycle, lifecycle];
    const rows = this.db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY updatedAt DESC,id LIMIT ? OFFSET ?`).all(...args, limit, offset) as unknown as Task[];
    const total = Number(this.db.prepare(`SELECT count(*) AS n FROM tasks WHERE ${where}`).get(...args)?.n);
    const counts = { all: 0, open: 0, review: 0, completed: 0, cancelled: 0 };
    for (const row of this.db.prepare('SELECT lifecycle,count(*) AS n FROM tasks WHERE botId=? AND instr(lower(goal),?)>0 GROUP BY lifecycle').all(query.botId,q)) {
      const key = row.lifecycle as Task['lifecycle']; counts[key] = Number(row.n); counts.all += Number(row.n);
    }
    const snapshotVersion = Number(this.db.prepare('SELECT coalesce(max(id),0) AS n FROM events').get()?.n);
    return { items: rows.map(task => ({ ...task, status: taskStatus(task) })), total, limit, offset, counts, snapshotVersion };
  }
  controlTask(requestId: string, id: string, expectedRowVersion: number, mode: ControlMode): Task {
    if (!['auto','paused','manual'].includes(mode)) throw new AppError('invalid-input', '控制模式无效。');
    return this.command(requestId, 'task.control', { id, expectedRowVersion, mode }, () => {
      const task = this.getTask(id);
      if (task.rowVersion !== expectedRowVersion) throw new AppError('version-conflict', '任务已经更新，请刷新后再操作。');
      if (task.lifecycle === 'completed' || task.lifecycle === 'cancelled') throw new AppError('task-ended', '任务已结束。');
      this.db.prepare('UPDATE tasks SET controlMode=?,rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(mode,Date.now(),id);
      this.event('task.control',id,{ mode }); return this.getTask(id);
    });
  }
  sqliteInfo(): { sqliteVersion: string; journalMode: string } {
    const sqlite = this.db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    const journal = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    return { sqliteVersion: sqlite.version, journalMode: journal.journal_mode };
  }
  close(): void { this.db.close(); }
}
