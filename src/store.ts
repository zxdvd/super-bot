import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname,relative,isAbsolute,sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import schemaVersion from '../schema-version.json' with {type:'json'};
import { AppError, requiredText, optionalText, taskStatus, type Bot, type Task, type NewBot, type NewTask, type TaskPage, type ControlMode, type Attention, type Binding, type Run, type RunInput, type WorkReport, type Result,type ManagerBinding,type ManagerEvent,type ExistingSessionGrant,type ReferenceMaterial,type TaskBotContext,botDraft } from './model.ts';

/** One local database. Business transactions will live here, not in the UI/adapter. */
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=100; PRAGMA foreign_keys=ON; PRAGMA locking_mode=EXCLUSIVE;');
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version.user_version > schemaVersion) throw new AppError('schema-newer', '数据库来自更新版本，请升级插件。');
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
        CREATE UNIQUE INDEX IF NOT EXISTS runs_active_task ON runs(taskId) WHERE finishedAt IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS runs_active_session ON runs(sessionId) WHERE finishedAt IS NULL;
        CREATE TABLE IF NOT EXISTS resources (runId TEXT PRIMARY KEY REFERENCES runs(id),cwd TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY,runId TEXT NOT NULL REFERENCES runs(id),kind TEXT NOT NULL,data TEXT NOT NULL,createdAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS results (id TEXT PRIMARY KEY,runId TEXT NOT NULL UNIQUE REFERENCES runs(id),taskId TEXT NOT NULL REFERENCES tasks(id),taskRevision INTEGER NOT NULL,summary TEXT NOT NULL,checks TEXT NOT NULL,evidence TEXT NOT NULL,createdAt INTEGER NOT NULL,humanAcceptedAt INTEGER);
        CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY,resultId TEXT NOT NULL REFERENCES results(id),actor TEXT NOT NULL,verdict TEXT NOT NULL,note TEXT NOT NULL,createdAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS managers (id TEXT PRIMARY KEY,botId TEXT NOT NULL REFERENCES bots(id),generation INTEGER NOT NULL,configRevision INTEGER NOT NULL,requestedSessionId TEXT NOT NULL UNIQUE,sessionId TEXT UNIQUE,cwd TEXT NOT NULL,state TEXT NOT NULL,createdAt INTEGER NOT NULL,UNIQUE(botId,generation));
        CREATE UNIQUE INDEX IF NOT EXISTS managers_active ON managers(botId) WHERE state!='released';
        `);
      const inputColumns=this.db.prepare('PRAGMA table_info(inputs)').all().map(row=>row.name);
      if(!inputColumns.includes('messageId'))this.db.exec('ALTER TABLE inputs ADD COLUMN messageId TEXT; ALTER TABLE inputs ADD COLUMN messageJson TEXT;');
      if(!inputColumns.includes('attentionId'))this.db.exec('ALTER TABLE inputs ADD COLUMN attentionId TEXT REFERENCES attentions(id);');
      const botColumns=this.db.prepare('PRAGMA table_info(bots)').all().map(row=>row.name);
      if(!botColumns.includes('materials'))this.db.exec("ALTER TABLE bots ADD COLUMN materials TEXT NOT NULL DEFAULT '[]';");
      const taskColumns=this.db.prepare('PRAGMA table_info(tasks)').all().map(row=>row.name);
      if(!taskColumns.includes('botConfigRevision'))this.db.exec('ALTER TABLE tasks ADD COLUMN botConfigRevision INTEGER NOT NULL DEFAULT 1; UPDATE tasks SET botConfigRevision=(SELECT configRevision FROM bots WHERE bots.id=tasks.botId);');
      if(!taskColumns.includes('botContext'))this.db.exec("ALTER TABLE tasks ADD COLUMN botContext TEXT NOT NULL DEFAULT '{}'; UPDATE tasks SET botContext=json_object('instructions',(SELECT instructions FROM bots WHERE bots.id=tasks.botId),'materials',json((SELECT materials FROM bots WHERE bots.id=tasks.botId)));");
      this.db.exec(`PRAGMA user_version=${schemaVersion}; COMMIT;`);
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
  commandReceipt<T>(requestId:string,action:string,payload:unknown):T|undefined {
    const id=requiredText(requestId,'请求标识',200);
    const prior=this.db.prepare('SELECT hash,result FROM requests WHERE id=?').get(id) as {hash:string;result:string}|undefined;
    if(!prior)return;
    const hash=createHash('sha256').update(JSON.stringify({action,payload})).digest('hex');
    if(prior.hash!==hash)throw new AppError('idempotency-conflict','同一请求标识不能用于不同的内容。');
    return JSON.parse(prior.result) as T;
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
  createBot(requestId: string, input: NewBot,materials:ReferenceMaterial[]=[]): Bot {
    const payload=botDraft(input);
    return this.command(requestId,'bot.create',payload,()=>{
      this.assertMaterials(payload,materials);
      const id=randomUUID();
      this.db.prepare('INSERT INTO bots(id,name,instructions,materials,createdAt) VALUES (?,?,?,?,?)').run(id,payload.name,payload.instructions,JSON.stringify(materials),Date.now());
      this.event('bot.created',null,{botId:id});return this.getBot(id);
    });
  }
  private assertMaterials(input:NewBot,materials:ReferenceMaterial[]):void {
    if(JSON.stringify(input.referencePaths??[])!==JSON.stringify(materials.map(material=>material.path)))throw new AppError('material-snapshot','参考文本尚未完整读取，未保存配置。');
  }
  private botFromRow(row:Record<string,unknown>):Bot {
    const materials=JSON.parse(String(row.materials)) as ReferenceMaterial[];
    return {...row,materials:materials.map(({text: _text,...info})=>info)} as unknown as Bot;
  }
  listBots(): Bot[] {return this.db.prepare('SELECT * FROM bots ORDER BY createdAt,id').all().map(row=>this.botFromRow(row));}
  getBot(id:string):Bot {
    const row=this.db.prepare('SELECT * FROM bots WHERE id=?').get(id);
    if(!row)throw new AppError('not-found','Bot 不存在。');return this.botFromRow(row);
  }
  currentBotContext(botId:string):TaskBotContext {
    const bot=this.getBot(botId),row=this.db.prepare('SELECT materials FROM bots WHERE id=?').get(botId)!;
    return {instructions:bot.instructions,materials:JSON.parse(String(row.materials)) as ReferenceMaterial[]};
  }
  taskBotContext(taskId:string):TaskBotContext {
    const row=this.db.prepare('SELECT botContext FROM tasks WHERE id=?').get(taskId);
    if(!row)throw new AppError('not-found','任务不存在。');return JSON.parse(String(row.botContext)) as TaskBotContext;
  }
  updateBot(requestId:string,botId:string,expectedRevision:number,input:NewBot,materials:ReferenceMaterial[]):Bot {
    const payload={botId,expectedRevision,...botDraft(input)};
    return this.command(requestId,'bot.update',payload,()=>{
      this.assertMaterials(payload,materials);const bot=this.getBot(botId),before=this.currentBotContext(botId);
      if(bot.configRevision!==expectedRevision)throw new AppError('version-conflict','Bot 配置已经更新，请刷新后再保存。');
      if(bot.name===payload.name&&bot.instructions===payload.instructions&&before.materials.length===materials.length&&before.materials.every((old,i)=>{const next=materials[i]!;return old.path===next.path&&old.sha256===next.sha256&&old.bytes===next.bytes&&old.text===next.text;}))return bot;
      this.db.prepare("UPDATE managers SET state='released' WHERE botId=? AND state!='released'").run(botId);
      this.db.prepare('UPDATE bots SET name=?,instructions=?,materials=?,configRevision=configRevision+1,managerSessionId=NULL WHERE id=?').run(payload.name,payload.instructions,JSON.stringify(materials),botId);
      this.db.prepare("UPDATE outbox SET state='superseded' WHERE kind='manager.notify' AND state='unknown' AND json_extract(payload,'$.botId')=?").run(botId);
      this.event('bot.updated',null,{botId,configRevision:bot.configRevision+1,referencePaths:payload.referencePaths??[]});return this.getBot(botId);
    });
  }
  activeManager(botId:string):ManagerBinding|null {
    const row=this.db.prepare("SELECT * FROM managers WHERE botId=? AND state!='released'").get(botId) as unknown as ManagerBinding|undefined;return row?{...row}:null;
  }
  getManager(id:string):ManagerBinding {
    const row=this.db.prepare('SELECT * FROM managers WHERE id=?').get(id) as unknown as ManagerBinding|undefined;
    if(!row)throw new AppError('not-found','管理会话记录不存在。');return {...row};
  }
  managerPreparationReceipt(requestId:string,botId:string):ManagerBinding|undefined {
    const row=this.db.prepare('SELECT result FROM requests WHERE id=?').get(requestId) as {result:string}|undefined;if(!row)return;
    const previous=JSON.parse(row.result) as ManagerBinding;
    const receipt=this.commandReceipt<ManagerBinding>(requestId,'manager.prepare',{botId,cwd:previous.cwd});
    return receipt?this.getManager(receipt.id):undefined;
  }
  managerForSession(sessionId:string):ManagerBinding|null {
    const row=this.db.prepare("SELECT * FROM managers WHERE requestedSessionId=? AND state!='released'").get(sessionId) as unknown as ManagerBinding|undefined;return row?{...row}:null;
  }
  beginManager(requestId:string,botId:string,cwd:string):ManagerBinding {
    return this.command(requestId,'manager.prepare',{botId,cwd},()=>{
      const bot=this.getBot(botId),existing=this.activeManager(botId);if(existing)return existing;
      const generation=Number(this.db.prepare('SELECT coalesce(max(generation),0)+1 AS n FROM managers WHERE botId=?').get(botId)?.n);
      const manager:ManagerBinding={id:randomUUID(),botId,generation,configRevision:bot.configRevision,requestedSessionId:`session-${randomUUID()}`,sessionId:null,cwd,state:'creating',createdAt:Date.now()};
      this.db.prepare('INSERT INTO managers VALUES (?,?,?,?,?,?,?,?,?)').run(manager.id,botId,generation,bot.configRevision,manager.requestedSessionId,null,cwd,'creating',manager.createdAt);
      this.db.prepare('INSERT INTO outbox(id,kind,payload,createdAt) VALUES (?,?,?,?)').run(`manager-create:${manager.id}`,'manager.create',JSON.stringify({managerId:manager.id}),Date.now());
      this.event('manager.preparing',null,{botId,managerId:manager.id});return manager;
    });
  }
  claimManagerCreation(id:string):boolean{return this.db.prepare("UPDATE outbox SET state='sending',attempts=attempts+1 WHERE id=? AND state='pending'").run(`manager-create:${id}`).changes===1;}
  confirmManager(id:string,sessionId:string):ManagerBinding {
    return this.command(`manager-confirm:${id}`,'manager.confirm',{id,sessionId},()=>{
      const manager=this.db.prepare('SELECT * FROM managers WHERE id=?').get(id) as unknown as ManagerBinding|undefined;
      if(!manager||manager.state==='released'||manager.requestedSessionId!==sessionId)throw new AppError('manager-stale','管理会话不一致或已经失效。');
      this.db.prepare("UPDATE managers SET state='ready',sessionId=? WHERE id=?").run(sessionId,id);
      this.db.prepare('UPDATE bots SET managerSessionId=? WHERE id=?').run(sessionId,manager.botId);
      this.db.prepare("UPDATE outbox SET state='done' WHERE id=?").run(`manager-create:${id}`);
      let actionable=0;
      for(const row of this.db.prepare("SELECT id FROM tasks WHERE botId=? AND controlMode='auto' AND lifecycle IN ('open','review') ORDER BY createdAt,id").all(manager.botId)) {
        const task=this.getTask(String(row.id));
        if(task.status!=='unscheduled'&&!(task.status==='review'&&!task.managerReviewed))continue;
        actionable++;
        if(!this.db.prepare("SELECT 1 FROM outbox WHERE kind='manager.notify' AND state='pending' AND taskId=? AND json_extract(payload,'$.botId')=?").get(task.id,manager.botId))this.enqueueManager(manager.botId,`backlog:${id}:${task.id}`,'管理会话已准备好，请从账本恢复这项现有工作。',task.id);
      }
      if(!actionable)this.enqueueManager(manager.botId,`init:${id}`,'管理会话已准备好，请从账本恢复当前工作。',null);
      this.event('manager.ready',null,{botId:manager.botId,sessionId});return this.activeManager(manager.botId)!;
    });
  }
  enqueueManager(botId:string,key:string,reason:string,taskId:string|null,priority=0):void {
    if(!this.getBot(botId).managerSessionId)return;
    this.db.prepare('INSERT OR IGNORE INTO outbox(id,kind,taskId,payload,createdAt) VALUES (?,?,?,?,?)').run(`manager-event:${key}`,'manager.notify',taskId,JSON.stringify({botId,reason,taskId,priority}),Date.now());
  }
  pendingManagerEvents(botId:string):ManagerEvent[] {
    return this.db.prepare("SELECT id,taskId,payload,state,createdAt FROM outbox WHERE kind='manager.notify' AND state='pending' AND json_extract(payload,'$.botId')=? ORDER BY coalesce(json_extract(payload,'$.priority'),0) DESC,createdAt,id LIMIT 10").all(botId) as unknown as ManagerEvent[];
  }
  claimManagerEvent(id:string,messageId:string,messageJson:string):boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const claimed=this.db.prepare("UPDATE outbox SET state='sending',attempts=attempts+1,payload=json_set(payload,'$.messageId',?,'$.messageJson',?,'$.deliveredAt',?) WHERE id=? AND state='pending'").run(messageId,messageJson,Date.now(),id).changes===1;
      if(claimed)this.set('managerCursor',String(this.db.prepare("SELECT json_extract(payload,'$.botId') AS botId FROM outbox WHERE id=?").get(id)?.botId));
      this.db.exec('COMMIT');return claimed;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  managerEventEntered(id:string,messageId:string):void {
    this.db.prepare("UPDATE outbox SET state='done' WHERE id=? AND state='sending' AND json_extract(payload,'$.messageId')=?").run(id,messageId);
  }
  managerEventUnknown(id:string):void {this.db.prepare("UPDATE outbox SET state='unknown' WHERE id=? AND state='sending'").run(id);}
  managerWakeCount(botId:string,since:number):number {
    return Number(this.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='manager.notify' AND state!='pending' AND json_extract(payload,'$.deliveredAt')>=? AND json_extract(payload,'$.botId')=?").get(since,botId)?.n);
  }
  resetUnconfirmedManagerEvents():void {this.db.prepare("UPDATE outbox SET state='unknown' WHERE kind='manager.notify' AND state='sending'").run();}
  managerOrder():Bot[] {const bots=this.listBots(),id=this.get('managerCursor'),cursor=bots.findIndex(bot=>bot.id===id);return [...bots.slice(cursor+1),...bots.slice(0,cursor+1)];}
  managerProblem(botId:string,message:string):void {
    const key=`managerProblem:${botId}`;const prior=this.get(key);
    if(!message){this.db.prepare('DELETE FROM metadata WHERE key=?').run(key);return;}
    if(prior&&JSON.parse(prior).message===message)return;
    this.set(key,JSON.stringify({message,at:Date.now()}));
  }
  managerInfo(botId:string) {return {binding:this.activeManager(botId),pending:Number(this.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='manager.notify' AND state='pending' AND json_extract(payload,'$.botId')=?").get(botId)?.n),uncertain:Number(this.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='manager.notify' AND state='unknown' AND json_extract(payload,'$.botId')=?").get(botId)?.n),hourlyWakes:this.managerWakeCount(botId,Date.now()-3600000),problem:JSON.parse(this.get(`managerProblem:${botId}`)??'null') as {message:string;at:number}|null};}
  releaseManager(requestId:string,botId:string,expectedGeneration:number):ManagerBinding {
    return this.command(requestId,'manager.replace',{botId,expectedGeneration},()=>{
      const manager=this.activeManager(botId);if(!manager||manager.generation!==expectedGeneration)throw new AppError('manager-stale','管理会话已经改变，请刷新。');
      this.db.prepare("UPDATE managers SET state='released' WHERE id=?").run(manager.id);
      this.db.prepare('UPDATE bots SET managerSessionId=NULL WHERE id=?').run(botId);
      this.db.prepare("UPDATE outbox SET state='superseded' WHERE kind='manager.notify' AND state='unknown' AND json_extract(payload,'$.botId')=?").run(botId);
      this.event('manager.replaced',null,{botId,oldSessionId:manager.sessionId});return manager;
    });
  }
  createTask(requestId: string, input: NewTask): Task {
    if(input.startPaused!==undefined&&typeof input.startPaused!=='boolean')throw new AppError('invalid-input','初始暂停状态必须是布尔值。');
    const payload: NewTask = { botId: requiredText(input.botId, 'Bot 标识', 200), goal: requiredText(input.goal, '任务目标'),
      scope: optionalText(input.scope, '任务范围'), acceptance: optionalText(input.acceptance, '验收条件'), reviewPolicy: input.reviewPolicy,...(input.startPaused?{startPaused:true}:{}) };
    if (!['human', 'bot'].includes(payload.reviewPolicy)) throw new AppError('invalid-input', '请选择有效的验收方式。');
    return this.command(requestId, 'task.create', payload, () => {
      const bot=this.getBot(payload.botId),context=this.currentBotContext(payload.botId);
      const id = randomUUID(), now = Date.now();
      this.db.prepare('INSERT INTO tasks(id,botId,goal,scope,acceptance,reviewPolicy,controlMode,createdAt,updatedAt,botConfigRevision,botContext) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, payload.botId, payload.goal, payload.scope, payload.acceptance, payload.reviewPolicy,payload.startPaused?'paused':'auto',now,now,bot.configRevision,JSON.stringify(context));
      this.db.prepare('INSERT INTO inputs(id,taskId,kind,content,createdAt) VALUES (?,?,?,?,?)')
        .run(randomUUID(), id, 'goal', payload.goal, now);
      this.event('task.created', id, { taskRevision: 1 });
      this.enqueueManager(payload.botId,`created:${id}`,'有新任务，请检查授权范围与验收条件后安排。',id);
      if (!payload.scope || !payload.acceptance) this.db.prepare('INSERT INTO attentions(id,taskId,kind,question,taskRevision,createdAt) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(),id,'input','请补充任务范围和验收条件，然后再安排执行。',1,now);
      return this.getTask(id);
    });
  }
  getTask(id: string): Task {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as unknown as Task | undefined;
    if (!task) throw new AppError('not-found', '任务不存在。');
    return this.decorateTask(task);
  }
  private decorateTask(row:Task):Task {
    const {botContext:_context,...task}=row as Task&{botContext?:string};
    let status=taskStatus(task);const run=this.latestRun(task.id);
    if(task.lifecycle==='open'||task.lifecycle==='review') {
      if(this.db.prepare("SELECT 1 FROM attentions WHERE taskId=? AND kind='recovery' AND state='open'").get(task.id))status='recovery';
      else if(run?.state==='cancelling')status='stopping';
      else if(this.db.prepare("SELECT 1 FROM attentions WHERE taskId=? AND kind='approval' AND state='open'").get(task.id))status='approval';
      else if(run?.state==='running')status='running';
      else if(run?.state==='queued')status='queued';
      else if(this.db.prepare("SELECT 1 FROM attentions WHERE taskId=? AND kind='input' AND state='open'").get(task.id))status='needs-input';
    }
    const managerReviewed=!!(run&&this.db.prepare("SELECT 1 FROM reviews JOIN results ON results.id=reviews.resultId WHERE results.runId=? AND reviews.actor LIKE 'manager:%' LIMIT 1").get(run.id));
    return {...task,status,managerReviewed};
  }
  taskDetail(id: string): { task: Task; binding: Binding | null; bindingHistory:Binding[]; run:Run|null; input:RunInput|null; result:Result|null; attentions: Attention[]; events: { id: number; kind: string; data: string; createdAt: number }[] } {
    const task=this.getTask(id),binding=this.activeBinding(id),run=this.latestRun(id);
    return { task,binding,bindingHistory:this.db.prepare("SELECT * FROM bindings WHERE taskId=? AND state='released' ORDER BY generation DESC").all(id) as unknown as Binding[],run,input:this.pendingInput(id)??(run?this.getRunInput(run.id):null),result:run&&run.taskRevision===task.taskRevision&&run.bindingId===binding?.id?this.runResult(run.id):null,
      attentions: this.db.prepare('SELECT * FROM attentions WHERE taskId=? ORDER BY createdAt,id').all(id) as unknown as Attention[],
      events: this.db.prepare('SELECT id,kind,data,createdAt FROM events WHERE taskId=? ORDER BY id DESC LIMIT 50').all(id) as unknown as { id: number; kind: string; data: string; createdAt: number }[],
    };
  }
  reviseTask(requestId: string, id: string, expectedRowVersion: number, input: Pick<NewTask,'goal'|'scope'|'acceptance'>): Task {
    const payload = { id, expectedRowVersion, goal: requiredText(input.goal,'任务目标'), scope: optionalText(input.scope,'任务范围'), acceptance: optionalText(input.acceptance,'验收条件') };
    return this.command(requestId,'task.revise',payload,() => {
      const task = this.getTask(id);
      if (task.rowVersion !== expectedRowVersion) throw new AppError('version-conflict','任务已经更新，请刷新后再修改。');
      if (this.activeBinding(id)) throw new AppError('execution-attached','执行会话已关联，需要先核对执行状态才能修改目标。');
      if (task.lifecycle !== 'open') throw new AppError('task-ended','当前任务不接受目标修改。');
      if (task.goal === payload.goal && task.scope === payload.scope && task.acceptance === payload.acceptance) return task;
      this.db.prepare('UPDATE tasks SET goal=?,scope=?,acceptance=?,taskRevision=taskRevision+1,rowVersion=rowVersion+1,updatedAt=? WHERE id=?')
        .run(payload.goal,payload.scope,payload.acceptance,Date.now(),id);
      this.db.prepare("UPDATE attentions SET state='stale' WHERE taskId=? AND state='open'").run(id);
      if (!payload.scope || !payload.acceptance) this.db.prepare('INSERT INTO attentions(id,taskId,kind,question,taskRevision,createdAt) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(),id,'input','请补充任务范围和验收条件，然后再安排执行。',task.taskRevision+1,Date.now());
      this.enqueueManager(task.botId,`revision:${id}:${task.taskRevision+1}`,'用户已更新任务目标、范围或验收条件，请读取新版本后安排。',id,10);
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
    const rows = this.db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY CASE WHEN EXISTS (SELECT 1 FROM attentions WHERE attentions.taskId=tasks.id AND attentions.state='open') THEN 0 ELSE 1 END,updatedAt DESC,id LIMIT ? OFFSET ?`).all(...args, limit, offset) as unknown as Task[];
    const total = Number(this.db.prepare(`SELECT count(*) AS n FROM tasks WHERE ${where}`).get(...args)?.n);
    const counts = { all: 0, open: 0, review: 0, completed: 0, cancelled: 0 };
    for (const row of this.db.prepare('SELECT lifecycle,count(*) AS n FROM tasks WHERE botId=? AND instr(lower(goal),?)>0 GROUP BY lifecycle').all(query.botId,q)) {
      const key = row.lifecycle as Task['lifecycle']; counts[key] = Number(row.n); counts.all += Number(row.n);
    }
    const snapshotVersion = Number(this.db.prepare('SELECT coalesce(max(id),0) AS n FROM events').get()?.n);
    return { items: rows.map(task => this.decorateTask(task)), total, limit, offset, counts, snapshotVersion };
  }
  activeBinding(taskId: string): Binding | null {
    const binding=this.db.prepare("SELECT * FROM bindings WHERE taskId=? AND state!='released'").get(taskId) as unknown as Binding | undefined;
    return binding?{...binding}:null;
  }
  getBinding(id: string): Binding {
    const binding=this.db.prepare('SELECT * FROM bindings WHERE id=?').get(id) as unknown as Binding | undefined;
    if(!binding)throw new AppError('not-found','会话关联不存在。');return {...binding};
  }
  nextBindingGeneration(taskId:string):number {return Number(this.db.prepare('SELECT coalesce(max(generation),0)+1 AS n FROM bindings WHERE taskId=?').get(taskId)?.n);}
  assertSessionAttachable(taskId:string,sessionId:string):void {
    const task=this.getTask(taskId);
    if(task.lifecycle!=='open'||!task.scope||!task.acceptance)throw new AppError('not-ready','请先补全未完成任务的范围和验收条件。');
    if(this.activeBinding(taskId))throw new AppError('session-attached','任务已有执行会话，请先核对并解除关联。');
    if(this.db.prepare("SELECT 1 FROM attentions WHERE taskId=? AND kind='recovery' AND state='open'").get(taskId)||this.heldRuns().some(run=>run.taskId===taskId))throw new AppError('needs-recovery','请先完成旧执行的恢复核对。');
    if(this.db.prepare('SELECT 1 FROM bindings WHERE sessionId=? OR requestedSessionId=?').get(sessionId,sessionId)||this.db.prepare('SELECT 1 FROM managers WHERE sessionId=? OR requestedSessionId=?').get(sessionId,sessionId))throw new AppError('session-owned','该会话已用于 Super Bot 的任务或管理身份。请保留原关联，或准备全新会话。');
  }
  attachExistingSession(requestId:string,grant:ExistingSessionGrant):Binding {
    return this.command(requestId,'session.attach',grant,()=>{
      if(grant.fullHistoryApproved!==true||grant.directoryApproved!==true)throw new AppError('confirmation-required','请明确授权读取整个会话历史，以及在所示目录内执行文件任务。');
      this.assertSessionAttachable(grant.taskId,grant.sessionId);const task=this.getTask(grant.taskId);
      if(task.rowVersion!==grant.expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请重新检查关联信息。');
      const binding:Binding={id:randomUUID(),taskId:task.id,generation:this.nextBindingGeneration(task.id),taskRevision:task.taskRevision,requestedSessionId:grant.sessionId,sessionId:grant.sessionId,cwd:grant.cwd,state:'ready',createdAt:Date.now()};
      this.db.prepare('INSERT INTO bindings(id,taskId,generation,taskRevision,requestedSessionId,sessionId,cwd,state,createdAt) VALUES (?,?,?,?,?,?,?,?,?)').run(binding.id,task.id,binding.generation,task.taskRevision,grant.sessionId,grant.sessionId,grant.cwd,'ready',binding.createdAt);
      this.db.prepare("UPDATE tasks SET sessionId=?,controlMode='paused',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(grant.sessionId,Date.now(),task.id);
      this.event('session.attached',task.id,{bindingId:binding.id,sessionId:grant.sessionId,cwd:grant.cwd,history:'entire-session',directoryApproved:true,actor:'user',taskRevision:task.taskRevision});return binding;
    });
  }
  bindingReceipt(requestId:string,taskId:string,expectedRowVersion:number):Binding|undefined {
    const row=this.db.prepare('SELECT result FROM requests WHERE id=?').get(requestId) as {result:string}|undefined;if(!row)return;
    const previous=JSON.parse(row.result) as Binding;
    const receipt=this.commandReceipt<Binding>(requestId,'session.prepare',{taskId,expectedRowVersion,cwd:previous.cwd});
    return receipt?this.getBinding(receipt.id):undefined;
  }
  managerDispatchReceipt(requestId:string,taskId:string,expectedRowVersion:number):{run:Run}|{prepared:Binding}|undefined {
    const row=this.db.prepare('SELECT result FROM requests WHERE id=?').get(requestId) as {result:string}|undefined;if(!row)return;
    const saved=JSON.parse(row.result) as Record<string,unknown>;
    // One management action first prepares a binding, or dispatches an existing one.
    // Recover its original kind, then validate the exact underlying command hash.
    if(typeof saved.inputId==='string') {
      const run=this.commandReceipt<Run>(requestId,'task.dispatch',{taskId,expectedRowVersion})!;
      return {run};
    }
    return {prepared:this.bindingReceipt(requestId,taskId,expectedRowVersion)!};
  }
  beginBinding(requestId: string, taskId: string, expectedRowVersion: number, cwd: string): Binding {
    return this.command(requestId,'session.prepare',{taskId,expectedRowVersion,cwd},()=>{
      const task=this.getTask(taskId);
      if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后再准备会话。');
      if(task.lifecycle!=='open'||!task.scope||!task.acceptance)throw new AppError('not-ready','请先补全任务范围和验收条件。');
      const existing=this.activeBinding(taskId);if(existing)return existing;
      const generation=this.nextBindingGeneration(taskId);
      const binding:Binding={id:randomUUID(),taskId,generation,taskRevision:task.taskRevision,requestedSessionId:`session-${randomUUID()}`,sessionId:null,cwd,state:'creating',createdAt:Date.now()};
      this.db.prepare('INSERT INTO bindings(id,taskId,generation,taskRevision,requestedSessionId,sessionId,cwd,state,createdAt) VALUES (?,?,?,?,?,?,?,?,?)').run(binding.id,taskId,generation,task.taskRevision,binding.requestedSessionId,null,cwd,'creating',binding.createdAt);
      this.db.prepare('INSERT INTO outbox(id,kind,taskId,payload,createdAt) VALUES (?,?,?,?,?)').run(`binding:${binding.id}`,'session.create',taskId,JSON.stringify({bindingId:binding.id}),Date.now());
      this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(Date.now(),taskId);
      this.event('session.preparing',taskId,{bindingId:binding.id,generation});return binding;
    });
  }
  claimBindingCreation(id: string): boolean {
    return this.db.prepare("UPDATE outbox SET state='sending',attempts=attempts+1 WHERE id=? AND state='pending'").run(`binding:${id}`).changes===1;
  }
  confirmBinding(id: string, sessionId: string): Binding {
    return this.command(`binding-confirm:${id}`,'session.confirm',{id,sessionId},()=>{
      const b=this.getBinding(id);const task=this.getTask(b.taskId);
      if(b.state==='released'||task.taskRevision!==b.taskRevision)throw new AppError('binding-stale','会话关联已经失效。');
      if(sessionId!==b.requestedSessionId)throw new AppError('session-mismatch','宿主返回了不同会话，需核对后再使用。');
      this.db.prepare("UPDATE bindings SET sessionId=?,state='ready' WHERE id=?").run(sessionId,id);
      this.db.prepare('UPDATE tasks SET sessionId=?,rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(sessionId,Date.now(),b.taskId);
      this.db.prepare("UPDATE outbox SET state='done' WHERE id=?").run(`binding:${id}`);
      this.db.prepare("UPDATE attentions SET state='resolved' WHERE id=?").run(`binding:${id}`);
      this.event('session.ready',b.taskId,{bindingId:id,sessionId});return this.getBinding(id);
    });
  }
  bindingRecovery(id: string): void {
    this.command(`binding-recovery:${id}`,'session.recovery',{id},()=>{
      const b=this.getBinding(id);if(b.state==='ready'||b.state==='released')return {};
      this.db.prepare("UPDATE bindings SET state='recovery' WHERE id=?").run(id);
      this.db.prepare('INSERT OR IGNORE INTO attentions(id,taskId,kind,question,taskRevision,createdAt) VALUES (?,?,?,?,?,?)')
        .run(`binding:${id}`,b.taskId,'recovery','会话创建结果待核对。核对会查找已申请的会话，不会重复创建。',b.taskRevision,Date.now());
      this.event('session.recovery',b.taskId,{bindingId:id});return {};
    });
  }
  latestRun(taskId:string):Run|null {
    const run=this.db.prepare('SELECT * FROM runs WHERE taskId=? ORDER BY createdAt DESC,rowid DESC LIMIT 1').get(taskId) as unknown as Run|undefined;
    return run?{...run}:null;
  }
  getRun(id:string):Run {
    const run=this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as unknown as Run|undefined;
    if(!run)throw new AppError('not-found','执行记录不存在。');return {...run};
  }
  getRunInput(id:string):RunInput {
    const run=this.getRun(id);return {...this.db.prepare('SELECT * FROM inputs WHERE id=?').get(run.inputId)} as unknown as RunInput;
  }
  pendingInput(taskId:string):RunInput|null {
    const input=this.db.prepare("SELECT * FROM inputs WHERE taskId=? AND kind IN ('answer','rework') AND state='accepted' ORDER BY createdAt,id LIMIT 1").get(taskId) as unknown as RunInput|undefined;
    return input?{...input}:null;
  }
  heldRuns():Run[] {return this.db.prepare('SELECT runs.* FROM runs JOIN resources ON resources.runId=runs.id').all() as unknown as Run[];}
  nativeIntervention(sessionId:string,messageId:string):boolean {
    const binding=this.db.prepare("SELECT * FROM bindings WHERE sessionId=? AND state='ready'").get(sessionId) as unknown as Binding|undefined;
    if(!binding)return false;const task=this.getTask(binding.taskId);if(!['open','review'].includes(task.lifecycle))return false;
    if(this.commandReceipt(`native:${sessionId}:${messageId}`,'task.native',{sessionId,messageId}))return false;
    this.command(`native:${sessionId}:${messageId}`,'task.native',{sessionId,messageId},()=>{
      this.db.prepare("UPDATE tasks SET controlMode='manual',lifecycle='open',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(Date.now(),task.id);
      this.db.prepare("UPDATE attentions SET state='stale' WHERE taskId=? AND kind='review' AND state='open'").run(task.id);
      this.db.prepare("UPDATE attentions SET state='stale' WHERE taskId=? AND kind='approval' AND state='open'").run(task.id);
      const run=this.latestRun(task.id);
      if(run&&run.finishedAt===null) {
        const note='原生会话已人工介入，旧执行授权终止。请核对原生会话后结束本次尝试。';
        this.db.prepare("UPDATE runs SET state='interrupted',finishedAt=?,note=? WHERE id=?").run(Date.now(),note,run.id);
        this.db.prepare("UPDATE inputs SET state='unknown' WHERE id=? AND state!='entered'").run(run.inputId);
        this.db.prepare('INSERT OR IGNORE INTO attentions(id,taskId,kind,question,taskRevision,createdAt) VALUES (?,?,?,?,?,?)').run(`run:${run.id}`,task.id,'recovery',note,task.taskRevision,Date.now());
      }
      this.event('native.intervention',task.id,{sessionId,messageId});return {};
    });
    return true;
  }
  reserveRun(requestId:string,taskId:string,expectedRowVersion:number):Run {
    return this.command(requestId,'task.dispatch',{taskId,expectedRowVersion},()=>{
      const task=this.getTask(taskId);const b=this.activeBinding(taskId);
      if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后再执行。');
      if(task.lifecycle!=='open'||task.controlMode!=='auto'||!task.scope||!task.acceptance)throw new AppError('not-ready','任务当前不能自动执行，请核对目标和管理方式。');
      if(!b||b.state!=='ready'||!b.sessionId)throw new AppError('not-ready','请先准备执行会话。');
      if(this.db.prepare("SELECT 1 FROM attentions WHERE taskId=? AND state='open'").get(taskId))throw new AppError('needs-attention','请先处理当前待办。');
      const held=this.db.prepare('SELECT resources.*,runs.taskId,tasks.botId FROM resources JOIN runs ON runs.id=resources.runId JOIN tasks ON tasks.id=runs.taskId').all();
      if(held.some(r=>r.taskId===taskId))throw new AppError('run-active','这个任务的上次执行尚未收敛。');
      if(held.length>=2)throw new AppError('capacity','两个执行名额已占用，请等待或核对已有执行。');
      const contains=(parent:string,child:string)=>{const path=relative(parent,child);return path===''||(!isAbsolute(path)&&path!=='..'&&!path.startsWith(`..${sep}`));};
      if(held.some(r=>contains(String(r.cwd),b.cwd)||contains(b.cwd,String(r.cwd))))throw new AppError('resource-conflict','这个工作目录与另一执行重叠。');
      const pending=this.pendingInput(taskId);const id=randomUUID(),inputId=pending?.id??randomUUID(),now=Date.now();
      if(!pending)this.db.prepare('INSERT INTO inputs(id,taskId,kind,content,createdAt) VALUES (?,?,?,?,?)').run(inputId,taskId,'dispatch',task.goal,now);
      this.db.prepare('INSERT INTO runs(id,taskId,bindingId,sessionId,taskRevision,generation,inputId,state,createdAt) VALUES (?,?,?,?,?,?,?,?,?)').run(id,taskId,b.id,b.sessionId,task.taskRevision,b.generation,inputId,'queued',now);
      this.db.prepare('INSERT INTO resources VALUES (?,?)').run(id,b.cwd);
      this.db.prepare('INSERT INTO outbox(id,kind,taskId,payload,createdAt) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(`input:${inputId}`,'input.deliver',taskId,JSON.stringify({runId:id,inputId}),now);
      this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(now,taskId);
      this.event('run.queued',taskId,{runId:id,inputId});return this.getRun(id);
    });
  }
  saveRunMessage(id:string,messageId:string,messageJson:string):RunInput {
    return this.command(`message:${id}`,'input.identify',{id,messageId,messageJson},()=>{
      const run=this.getRun(id);this.db.prepare('UPDATE inputs SET messageId=?,messageJson=? WHERE id=?').run(messageId,messageJson,run.inputId);return this.getRunInput(id);
    });
  }
  claimDispatch(id:string):boolean {
    const run=this.getRun(id);const task=this.getTask(run.taskId);const b=this.activeBinding(run.taskId);
    if(task.controlMode!=='auto'||task.lifecycle!=='open'||task.taskRevision!==run.taskRevision||b?.id!==run.bindingId||b.state!=='ready'||run.state!=='queued')throw new AppError('dispatch-stale','派发条件已经改变，没有投递。');
    if(!this.getRunInput(id).messageId)throw new AppError('input-missing','输入尚未生成。');
    return this.db.prepare("UPDATE outbox SET state='sending',attempts=attempts+1 WHERE id IN (?,?) AND state='pending'").run(`input:${run.inputId}`,`run:${id}`).changes===1;
  }
  inputEnqueued(id:string):void {
    const run=this.getRun(id);this.db.prepare("UPDATE inputs SET state='enqueued' WHERE id=? AND state='accepted'").run(run.inputId);
    this.db.prepare("UPDATE outbox SET state='done' WHERE id IN (?,?)").run(`input:${run.inputId}`,`run:${id}`);
  }
  inputEntered(id:string,messageId:string,seq:number):void {
    this.command(`entered:${id}:${messageId}`,'input.entered',{id,messageId,seq},()=>{
      const run=this.getRun(id);const input=this.getRunInput(id);
      if(input.messageId!==messageId||run.finishedAt!==null)return {};
      this.db.prepare("UPDATE inputs SET state='entered' WHERE id=?").run(run.inputId);
      if(input.attentionId)this.db.prepare("UPDATE attentions SET state='resolved' WHERE id=? AND state='responding'").run(input.attentionId);
      this.db.prepare("UPDATE runs SET state='running' WHERE id=? AND state='queued'").run(id);
      this.event('input.entered',run.taskId,{runId:id,messageId,seq});return {};
    });
  }
  runRecovery(id:string,note:string):void {
    if(this.getRun(id).finishedAt!==null)return;
    this.command(`recovery:${id}`,'run.recovery',{id,note},()=>{
      const run=this.getRun(id);if(run.finishedAt!==null)return {};
      this.db.prepare("UPDATE runs SET state='interrupted',finishedAt=?,note=? WHERE id=?").run(Date.now(),note,id);
      this.db.prepare("UPDATE inputs SET state='unknown' WHERE id=? AND state!='entered'").run(run.inputId);
      this.db.prepare("UPDATE attentions SET state='stale' WHERE taskId=? AND kind='approval' AND state='open'").run(run.taskId);
      this.db.prepare('INSERT OR IGNORE INTO attentions(id,taskId,kind,question,taskRevision,createdAt) VALUES (?,?,?,?,?,?)').run(`run:${id}`,run.taskId,'recovery',note,run.taskRevision,Date.now());
      this.event('run.recovery',run.taskId,{runId:id,note});return {};
    });
  }
  nativeApprovalAsked(runId:string,requestId:string,toolName:string,reason:string):void {
    this.command(`approval-asked:${requestId}`,'approval.asked',{runId,requestId,toolName,reason},()=>{
      const run=this.getRun(runId);if(run.finishedAt!==null)return {};
      this.db.prepare('INSERT OR IGNORE INTO attentions(id,taskId,kind,question,taskRevision,state,createdAt) VALUES (?,?,?,?,?,?,?)').run(`approval:${requestId}`,run.taskId,'approval',`原生工具 ${toolName} 等待审批。${reason?`\n${reason}`:''}\n请打开任务会话处理；工作台不代替原生批准或拒绝。`,run.taskRevision,'open',Date.now());
      this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(Date.now(),run.taskId);
      this.event('approval.asked',run.taskId,{runId,requestId,toolName});return {};
    });
  }
  nativeApprovalDecided(sessionId:string,requestId:string,outcome:string):void {
    const attention=this.db.prepare('SELECT * FROM attentions WHERE id=?').get(`approval:${requestId}`) as unknown as Attention|undefined;
    if(!attention||this.activeBinding(attention.taskId)?.sessionId!==sessionId)return;
    this.command(`approval-decided:${requestId}`,'approval.decided',{sessionId,requestId,outcome},()=>{
      // A decision does not settle the Run or prove the requested effect has finished.
      this.db.prepare("UPDATE attentions SET state='resolved' WHERE id=? AND state='open'").run(attention.id);
      this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(Date.now(),attention.taskId);
      this.event('approval.decided',attention.taskId,{requestId,outcome});return {};
    });
  }
  runResult(runId:string):Result|null {
    const row=this.db.prepare('SELECT * FROM results WHERE runId=?').get(runId) as unknown as (Omit<Result,'evidence'>&{evidence:string})|undefined;
    return row?{...row,evidence:JSON.parse(row.evidence)}:null;
  }
  resultById(id:string):Result|null {
    const row=this.db.prepare('SELECT * FROM results WHERE id=?').get(id) as unknown as (Omit<Result,'evidence'>&{evidence:string})|undefined;
    return row?{...row,evidence:JSON.parse(row.evidence)}:null;
  }
  workerReportReceipt(runId:string,callId:string,report:WorkReport):{accepted:true;resultId?:string}|undefined {
    const row=this.db.prepare('SELECT data FROM reports WHERE id=?').get(`${runId}:${callId}`) as {data:string}|undefined;if(!row)return;
    const saved=JSON.parse(row.data) as {evidence:WorkReport['evidence']};
    return this.commandReceipt(`report:${runId}:${callId}`,'worker.report',{runId,callId,kind:report.kind,summary:requiredText(report.summary,'报告内容'),checks:optionalText(report.checks,'验收说明'),evidence:saved.evidence??[],...(report.requestedFiles?{requestedFiles:report.requestedFiles}:{})});
  }
  workerReport(runId:string,callId:string,report:WorkReport):{accepted:true;resultId?:string} {
    const summary=requiredText(report.summary,'报告内容');
    if(!['progress','waiting','ready','blocked','failed'].includes(report.kind))throw new AppError('invalid-report','报告类型无效。');
    const payload={runId,callId,kind:report.kind,summary,checks:optionalText(report.checks,'验收说明'),evidence:report.evidence??[],...(report.requestedFiles?{requestedFiles:report.requestedFiles}:{})};
    if(report.kind==='ready'&&(!payload.checks||payload.evidence.length===0))throw new AppError('evidence-required','提交成果必须有验收说明和文件证据。');
    const outcome=this.command(`report:${runId}:${callId}`,'worker.report',payload,()=>{
      const run=this.getRun(runId);const task=this.getTask(run.taskId);const b=this.activeBinding(task.id);
      if(run.finishedAt!==null||run.state==='cancelling'||task.taskRevision!==run.taskRevision||b?.id!==run.bindingId||task.controlMode==='manual') {
        this.event('work.report-stale',task.id,{runId,callId,kind:report.kind,summary,taskRevision:run.taskRevision});
        return {accepted:false as const};
      }
      if(this.getRunInput(runId).state!=='entered')throw new AppError('input-unconfirmed','尚无输入进入上下文的证据。');
      if(this.db.prepare("SELECT 1 FROM reports WHERE runId=? AND kind!='progress'").get(runId))throw new AppError('report-ended','本次执行已经提交最终报告。');
      this.db.prepare('INSERT INTO reports VALUES (?,?,?,?,?)').run(`${runId}:${callId}`,runId,report.kind,JSON.stringify(payload),Date.now());
      this.event('work.report',task.id,{runId,kind:report.kind,summary});
      if(report.kind!=='ready')return {accepted:true as const};
      const resultId=randomUUID();
      this.db.prepare('INSERT INTO results VALUES (?,?,?,?,?,?,?,?,NULL)').run(resultId,runId,task.id,run.taskRevision,summary,payload.checks,JSON.stringify(payload.evidence),Date.now());
      return {accepted:true as const,resultId};
    });
    if(!outcome.accepted)throw new AppError('report-stale','当前执行或目标已改变，报告未成为当前成果。');
    return outcome;
  }
  settleRun(id:string):void {
    if(this.getRun(id).finishedAt!==null)return;
    this.command(`settle:${id}`,'run.settle',{id},()=>{
      const run=this.getRun(id);const task=this.getTask(run.taskId);
      if(this.db.prepare("SELECT 1 FROM attentions WHERE taskId=? AND kind='approval' AND state='open'").get(task.id))throw new AppError('approval-pending','原生审批尚未得到结果，不能确认执行结束。');
      const last=this.db.prepare("SELECT kind,data FROM reports WHERE runId=? AND kind!='progress' ORDER BY createdAt DESC LIMIT 1").get(id) as {kind:WorkReport['kind'];data:string}|undefined;
      if(!last||this.getRunInput(id).state!=='entered'||task.controlMode==='manual')throw new AppError('no-result','执行已空闲，但没有可确认的最终报告。');
      const report=JSON.parse(last.data) as WorkReport;const failed=last.kind==='blocked'||last.kind==='failed';
      this.db.prepare('UPDATE runs SET state=?,finishedAt=?,note=? WHERE id=?').run(failed?'failed':'settled',Date.now(),report.summary,id);
      this.db.prepare('DELETE FROM resources WHERE runId=?').run(id);
      const kind=last.kind==='ready'?'review':last.kind==='waiting'?'input':'recovery';
      this.db.prepare('INSERT OR IGNORE INTO attentions(id,taskId,kind,question,taskRevision,createdAt) VALUES (?,?,?,?,?,?)').run(`run:${id}`,run.taskId,kind,last.kind==='ready'?'成果与执行已核对，请检查证据并验收。':report.summary,run.taskRevision,Date.now());
      this.db.prepare('UPDATE tasks SET lifecycle=?,rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(last.kind==='ready'?'review':'open',Date.now(),run.taskId);
      this.enqueueManager(task.botId,`settled:${id}`,`执行已结束，报告类型 ${last.kind}。请读当前账本和成果，不要重放旧输入。`,task.id);
      this.event('run.settled',run.taskId,{runId:id,kind:last.kind});return {};
    });
  }
  acceptResult(requestId:string,taskId:string,expectedRowVersion:number,resultId:string):Task {
    return this.command(requestId,'result.accept',{taskId,expectedRowVersion,resultId},()=>{
      const task=this.getTask(taskId);const run=this.latestRun(taskId);const result=run?this.runResult(run.id):null;
      if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后再验收。');
      if(task.lifecycle!=='review'||!result||result.id!==resultId||result.taskRevision!==task.taskRevision||run?.state!=='settled')throw new AppError('result-stale','当前成果不能验收，请重新核对。');
      if(this.db.prepare('SELECT 1 FROM resources WHERE runId=?').get(run.id)||this.db.prepare("SELECT 1 FROM attentions WHERE taskId=? AND state='open' AND kind!='review'").get(taskId))throw new AppError('needs-attention','还有执行或待办未处理。');
      const now=Date.now();this.db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?,?)').run(randomUUID(),resultId,'user','accepted','用户检查当前证据后接受',now);
      this.db.prepare('UPDATE results SET humanAcceptedAt=? WHERE id=?').run(now,resultId);
      this.db.prepare("UPDATE tasks SET lifecycle='completed',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(now,taskId);
      this.db.prepare("UPDATE attentions SET state='resolved' WHERE taskId=? AND state='open' AND kind='review'").run(taskId);
      this.event('result.accepted',taskId,{resultId});return this.getTask(taskId);
    });
  }
  recordRunBudget(id:string,kind:'steps'|'time'):boolean {
    const run=this.getRun(id);if(run.finishedAt!==null||run.state==='cancelling')return false;
    return this.command(`budget:${id}`,'run.budget-reached',{id,kind},()=>{
      const note=kind==='steps'?'执行已达到 40 步上限，请检查进展并拆分任务后再继续。':'执行已达到 10 分钟上限，请检查进展后再继续。';
      this.db.prepare('UPDATE runs SET note=? WHERE id=?').run(note,id);
      this.event('run.budget-reached',run.taskId,{runId:id,kind,limit:kind==='steps'?40:600,note});return true;
    });
  }
  requestStop(requestId:string,taskId:string,expectedRowVersion:number):{runId:string;requested:true} {
    return this.command(requestId,'task.stop',{taskId,expectedRowVersion},()=>{
      const task=this.getTask(taskId);const run=this.latestRun(taskId);
      if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后再停止。');
      if(!run||run.finishedAt!==null)throw new AppError('no-active-run','没有正在执行的尝试；未知状态请使用核对。');
      this.db.prepare("UPDATE tasks SET controlMode='paused',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(Date.now(),taskId);
      this.db.prepare("UPDATE runs SET state='cancelling' WHERE id=?").run(run.id);
      this.db.prepare("UPDATE outbox SET state='cancelled' WHERE id IN (?,?) AND state='pending'").run(`input:${run.inputId}`,`run:${run.id}`);
      this.event('run.stop-requested',taskId,{runId:run.id});return {runId:run.id,requested:true as const};
    });
  }
  settleCancelled(id:string):void {
    if(this.getRun(id).finishedAt!==null)return;
    this.command(`cancelled:${id}`,'run.cancelled',{id},()=>{
      const run=this.getRun(id);if(run.state!=='cancelling')throw new AppError('stop-not-requested','没有停止请求。');
      const budget=this.db.prepare("SELECT 1 FROM events WHERE kind='run.budget-reached' AND taskId=? AND json_extract(data,'$.runId')=?").get(run.taskId,id);
      this.db.prepare("UPDATE runs SET state='cancelled',finishedAt=?,note=? WHERE id=?").run(Date.now(),budget?run.note:'已核对停止',id);
      if(budget)this.db.prepare('INSERT OR IGNORE INTO attentions(id,taskId,kind,question,taskRevision,createdAt) VALUES (?,?,?,?,?,?)').run(`run:${id}`,run.taskId,'recovery',`${run.note} 已确认停止；不会自动重试。`,run.taskRevision,Date.now());
      this.db.prepare("UPDATE inputs SET state='discarded' WHERE id=? AND state!='entered'").run(run.inputId);
      this.db.prepare("UPDATE attentions SET state='stale' WHERE taskId=? AND kind='approval' AND state='open'").run(run.taskId);
      const input=this.getRunInput(id);if(input.attentionId&&input.state==='discarded')this.db.prepare("UPDATE attentions SET state='open' WHERE id=? AND state='responding'").run(input.attentionId);
      this.db.prepare('DELETE FROM resources WHERE runId=?').run(id);
      this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(Date.now(),run.taskId);
      this.event('run.cancelled',run.taskId,{runId:id});return {};
    });
  }
  respondAttention(requestId:string,attentionId:string,expectedRowVersion:number,text:string):RunInput {
    const content=requiredText(text,'回答');
    return this.command(requestId,'attention.respond',{attentionId,expectedRowVersion,content},()=>{
      const attention=this.db.prepare('SELECT * FROM attentions WHERE id=?').get(attentionId) as unknown as Attention|undefined;
      if(!attention)throw new AppError('not-found','待办不存在。');const task=this.getTask(attention.taskId);
      if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后回答。');
      if(attention.kind!=='input'||attention.state!=='open'||attention.taskRevision!==task.taskRevision)throw new AppError('attention-stale','问题已失效或已有回答。');
      if(!this.activeBinding(task.id))throw new AppError('not-execution-question','请使用修改任务补全范围和验收条件。');
      if(this.heldRuns().some(r=>r.taskId===task.id))throw new AppError('run-active','执行尚未收敛，暂未提交回答。');
      const id=randomUUID();this.db.prepare('INSERT INTO inputs(id,taskId,kind,content,attentionId,createdAt) VALUES (?,?,?,?,?,?)').run(id,task.id,'answer',content,attentionId,Date.now());
      this.db.prepare('INSERT INTO outbox(id,kind,taskId,payload,createdAt) VALUES (?,?,?,?,?)').run(`input:${id}`,'input.deliver',task.id,JSON.stringify({inputId:id}),Date.now());
      this.db.prepare("UPDATE attentions SET state='responding' WHERE id=?").run(attentionId);
      this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(Date.now(),task.id);
      this.enqueueManager(task.botId,`answer:${id}`,'用户回答已保存，请核对管理方式后继续。',task.id,10);
      this.event('attention.answered',task.id,{attentionId,inputId:id});return this.pendingInput(task.id)!;
    });
  }
  rejectResult(requestId:string,taskId:string,expectedRowVersion:number,resultId:string,text:string):Task {
    const content=requiredText(text,'返工要求');
    return this.command(requestId,'result.reject',{taskId,expectedRowVersion,resultId,content},()=>{
      const task=this.getTask(taskId),run=this.latestRun(taskId),result=run?this.runResult(run.id):null;
      if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后再返工。');
      if(task.lifecycle!=='review'||!result||result.id!==resultId||result.taskRevision!==task.taskRevision)throw new AppError('result-stale','这份成果已失效。');
      if(this.heldRuns().some(r=>r.taskId===taskId))throw new AppError('run-active','执行尚未收敛，暂未安排返工。');
      this.db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?,?)').run(randomUUID(),resultId,'user','rejected',content,Date.now());
      const inputId=randomUUID();this.db.prepare('INSERT INTO inputs(id,taskId,kind,content,createdAt) VALUES (?,?,?,?,?)').run(inputId,taskId,'rework',content,Date.now());
      this.db.prepare('INSERT INTO outbox(id,kind,taskId,payload,createdAt) VALUES (?,?,?,?,?)').run(`input:${inputId}`,'input.deliver',taskId,JSON.stringify({inputId}),Date.now());
      this.db.prepare("UPDATE attentions SET state='resolved' WHERE taskId=? AND kind='review' AND state='open'").run(taskId);
      this.db.prepare("UPDATE tasks SET lifecycle='open',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(Date.now(),taskId);
      this.enqueueManager(task.botId,`user-rework:${inputId}`,'用户返工要求已保存，请核对管理方式后继续。',taskId,10);
      this.event('result.rejected',taskId,{resultId,inputId});return this.getTask(taskId);
    });
  }
  resolveRunRecovery(requestId:string,taskId:string,expectedRowVersion:number):Task {
    return this.command(requestId,'run.resolve-recovery',{taskId,expectedRowVersion},()=>{
      const task=this.getTask(taskId),run=this.latestRun(taskId);
      if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后核对。');
      if(run?.finishedAt===null)throw new AppError('run-active','请先停止当前执行。');
      if(!run&&!this.db.prepare("SELECT 1 FROM attentions WHERE id=? AND state='open'").get(`restore:${taskId}`))throw new AppError('not-found','没有待核对的执行。');
      if(run) {
        this.db.prepare('DELETE FROM resources WHERE runId=?').run(run.id);
        this.db.prepare("UPDATE attentions SET state='resolved' WHERE id=? AND kind='recovery'").run(`run:${run.id}`);
        this.db.prepare("UPDATE inputs SET state='discarded' WHERE id=? AND state IN ('accepted','unknown','enqueued')").run(run.inputId);
        const input=this.getRunInput(run.id);if(input.attentionId&&input.state==='discarded')this.db.prepare("UPDATE attentions SET state='open' WHERE id=? AND state='responding'").run(input.attentionId);
      }
      this.db.prepare("UPDATE attentions SET state='resolved' WHERE id=? AND kind='recovery'").run(`restore:${taskId}`);
      this.db.prepare("UPDATE attentions SET state='stale' WHERE taskId=? AND kind='approval' AND state='open'").run(taskId);
      this.db.prepare("UPDATE tasks SET controlMode='paused',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(Date.now(),taskId);
      this.event('run.recovery-confirmed',taskId,{runId:run?.id??null,actor:'user'});return this.getTask(taskId);
    });
  }
  managerReview(requestId:string,botId:string,taskId:string,expectedRowVersion:number,resultId:string,verdict:'accept'|'rework'|'human',text:string,requested?:{verdict:'accept';note:string}):Task {
    const note=requiredText(text,'验收判断');
    return this.command(requestId,'manager.review',{botId,taskId,expectedRowVersion,resultId,verdict,note,...(requested?{requested}:{})},()=>{
      const task=this.getTask(taskId),run=this.latestRun(taskId),result=run?this.runResult(run.id):null;
      if(task.botId!==botId)throw new AppError('scope','只能处理自己负责的任务。');
      if(task.rowVersion!==expectedRowVersion||task.controlMode!=='auto'||task.lifecycle!=='review'||!result||result.id!==resultId||result.taskRevision!==task.taskRevision||run?.state!=='settled')throw new AppError('review-stale','任务状态、授权或成果已经改变，管理判断未应用。');
      if(this.heldRuns().some(r=>r.taskId===taskId))throw new AppError('run-active','执行尚未收敛。');
      if(this.db.prepare("SELECT 1 FROM attentions WHERE taskId=? AND state='open' AND kind!='review'").get(taskId))throw new AppError('needs-attention','还有其他待办需要处理。');
      let decision:string=verdict;
      const reworks=Number(this.db.prepare("SELECT count(*) AS n FROM reviews JOIN results ON results.id=reviews.resultId WHERE results.taskId=? AND results.taskRevision=? AND reviews.actor=? AND reviews.verdict='rework'").get(taskId,task.taskRevision,`manager:${botId}`)?.n);
      if(verdict==='rework'&&reworks>=2)decision='human';
      if(verdict==='accept'&&task.reviewPolicy==='human')decision='human';
      this.db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?,?)').run(randomUUID(),resultId,`manager:${botId}`,decision,note,Date.now());
      if(decision==='accept') {
        this.db.prepare("UPDATE tasks SET lifecycle='completed',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(Date.now(),taskId);
        this.db.prepare("UPDATE attentions SET state='resolved' WHERE taskId=? AND kind='review' AND state='open'").run(taskId);
      }else if(decision==='rework') {
        const inputId=randomUUID();this.db.prepare('INSERT INTO inputs(id,taskId,kind,content,createdAt) VALUES (?,?,?,?,?)').run(inputId,taskId,'rework',note,Date.now());
        this.db.prepare('INSERT INTO outbox(id,kind,taskId,payload,createdAt) VALUES (?,?,?,?,?)').run(`input:${inputId}`,'input.deliver',taskId,JSON.stringify({inputId}),Date.now());
        this.db.prepare("UPDATE attentions SET state='resolved' WHERE taskId=? AND kind='review' AND state='open'").run(taskId);
        this.db.prepare("UPDATE tasks SET lifecycle='open',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(Date.now(),taskId);
        this.enqueueManager(botId,`rework:${inputId}`,'返工要求已保存，可以在容量允许时继续。',taskId);
      }else {
        this.db.prepare("UPDATE attentions SET question=? WHERE taskId=? AND kind='review' AND state='open'").run((verdict==='rework'&&reworks>=2?'自动返工已达 2 次，请你判断。\n':'Bot 已检查，请你最终判断。\n')+note,taskId);
        this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(Date.now(),taskId);
        if(verdict==='rework'&&reworks>=2)this.db.prepare("UPDATE tasks SET controlMode='paused' WHERE id=?").run(taskId);
      }
      this.event('manager.reviewed',taskId,{resultId,decision,note});return this.getTask(taskId);
    });
  }
  controlTask(requestId: string, id: string, expectedRowVersion: number, mode: ControlMode): Task {
    if (!['auto','paused','manual'].includes(mode)) throw new AppError('invalid-input', '控制模式无效。');
    return this.command(requestId, 'task.control', { id, expectedRowVersion, mode }, () => {
      const task = this.getTask(id);
      if (task.rowVersion !== expectedRowVersion) throw new AppError('version-conflict', '任务已经更新，请刷新后再操作。');
      if (task.lifecycle === 'completed' || task.lifecycle === 'cancelled') throw new AppError('task-ended', '任务已结束。');
      this.db.prepare('UPDATE tasks SET controlMode=?,rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(mode,Date.now(),id);
      if(mode==='auto')this.enqueueManager(task.botId,`resume:${id}:${task.rowVersion+1}`,'任务恢复自动管理，请读取最新状态。',id,10);
      this.event('task.control',id,{ mode }); return this.getTask(id);
    });
  }
  private assertTaskSettled(taskId:string):void {
    if(this.db.prepare('SELECT 1 FROM runs LEFT JOIN resources ON resources.runId=runs.id WHERE runs.taskId=? AND (runs.finishedAt IS NULL OR resources.runId IS NOT NULL)').get(taskId))throw new AppError('run-active','请先停止执行并完成恢复核对，当前占用尚未释放。');
    if(this.db.prepare("SELECT 1 FROM attentions WHERE taskId=? AND kind='recovery' AND state='open'").get(taskId))throw new AppError('needs-attention','请先完成待核对事项。');
    const binding=this.activeBinding(taskId);if(binding&&binding.state!=='ready')throw new AppError('session-recovery','请先核对会话创建结果。');
  }
  private discardPendingWork(taskId:string):void {
    this.db.prepare("UPDATE inputs SET state='discarded' WHERE taskId=? AND state IN ('accepted','enqueued','unknown')").run(taskId);
    this.db.prepare("UPDATE outbox SET state='superseded' WHERE taskId=? AND state='pending'").run(taskId);
    this.db.prepare("UPDATE attentions SET state='stale' WHERE taskId=? AND state IN ('open','responding')").run(taskId);
  }
  detachSession(requestId:string,taskId:string,expectedRowVersion:number):Task {
    return this.command(requestId,'session.detach',{taskId,expectedRowVersion},()=>{
      const task=this.getTask(taskId);if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后解除关联。');
      if(task.lifecycle!=='open')throw new AppError('task-ended','仅未完成任务可以解除关联；待验收成果请先返工或取消任务。');
      this.assertTaskSettled(taskId);const binding=this.activeBinding(taskId);if(!binding)throw new AppError('not-found','没有当前执行会话。');
      this.db.prepare("UPDATE bindings SET state='released' WHERE id=?").run(binding.id);
      this.discardPendingWork(taskId);
      this.db.prepare("UPDATE tasks SET sessionId=NULL,controlMode='paused',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(Date.now(),taskId);
      this.event('session.detached',taskId,{bindingId:binding.id,sessionId:binding.sessionId});return this.getTask(taskId);
    });
  }
  cancelTask(requestId:string,taskId:string,expectedRowVersion:number):Task {
    return this.command(requestId,'task.cancel',{taskId,expectedRowVersion},()=>{
      const task=this.getTask(taskId);if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后取消。');
      if(!['open','review'].includes(task.lifecycle))throw new AppError('task-ended','任务已经结束。');
      this.assertTaskSettled(taskId);this.discardPendingWork(taskId);
      this.db.prepare("UPDATE tasks SET lifecycle='cancelled',controlMode='paused',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(Date.now(),taskId);
      this.event('task.cancelled',taskId,{});return this.getTask(taskId);
    });
  }
  sqliteInfo(): { sqliteVersion: string; journalMode: string } {
    const sqlite = this.db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    const journal = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    return { sqliteVersion: sqlite.version, journalMode: journal.journal_mode };
  }
  backupLedger(path:string):void {
    // VACUUM INTO is a consistent SQLite snapshot; copying a live WAL file is not.
    this.db.prepare('VACUUM INTO ?').run(path);
  }
  recordBackup(key:string,path:string):void {this.command(`backup:${key}`,'ledger.backup',{path},()=>{this.event('ledger.backup',null,{path});return {};});}
  close(): void { this.db.close(); }
}
