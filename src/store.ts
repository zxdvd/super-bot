import { inboxActivity } from './work-activity.ts';
import { settledBlockerSql } from './settled-blocker.ts';
import { readStageCondition, stageConditionText, stageReadyKey, STAGE_OBSERVE_MS, STAGE_WAIT_MS,
  type DueStage, type StageFollowUp, type StageObservation, type WorkStage } from './work-stage.ts';
import { exactMergeReference, mergeReferences, releaseKey, releaseUrl, RELEASE_CHECK_MS, RELEASE_WAIT_MS,
  type ReleaseAuthorization, type ReleasePlan, type ReleaseReceipt, type ReleaseTarget } from './gitlab-release.ts';
import type { StageCondition } from './work-stage.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import schemaVersion from '../schema-version.json' with {type:'json'};
import { AppError, requiredText, optionalText, taskStatus, type ChatSource, type Bot, type Task, type NewBot, type NewTask, type TaskPage, type TaskInboxPage, type ControlMode, type Attention, type Binding, type Run, type RunInput, type WorkReport, type Result,type ManagerBinding,type ManagerEvent,type ExistingSessionGrant,type ReferenceMaterial,type TaskBotContext,type DispatchWait,type WorkdirInfo,type RunTurn,botDraft } from './model.ts';
import { RESULT_FRESH_MS, type ChatDeliveryStatus, type DeliveredResult, type DeliveryArtifacts, type DeliveryLinks, type RecoveryContinuation, type ReloadReceipt, type RunChildWait, type TaskCloseRequest,
  DEFAULT_BOT_RUNNING_TASKS, type BotCapacity, type TaskProgress, type UncertainDelivery,
  type WorkerModelPlan, type WorkerPriorInput, type RecoveryDirection, type RecoveryDirectionChange, type RecoveryDirectionStatus,
  type RecoveryInstruction, type RecoveryWorkContext, type LateJobRecovery, type LateJobProof } from './model.ts';
import type { ClusterProbe, ProbeEvidence, ProbeResult, ReadQueryReceipt, RecoveryCheck } from './read-only-recovery.ts';
import { readDeliveryLinks, readPrimaryDeliveryLink } from './delivery-artifacts.ts';
import {parseWorkdirRequest} from './workdir.ts';
import type { CapturedEvidence } from './evidence.ts';
import type { BotMemory } from './bot-memory.ts';
import type { MirrorRecords, ResultRecord, ReviewRecord } from './mirror.ts';

const BLOCKING_ATTENTIONS="state='open' AND kind IN ('input','approval','recovery')";
const DELIVERY_ATTEMPT_LIMIT=3;
const DELIVERY_RETRY_DELAY_MS=30000;
const RESULT_DELIVERY_REASON='成果仍待在原对话交付。请在最终可见回复中附上当前版本的成果链接。';
const DELIVERY_RETRIES_EXHAUSTED='成果补交付已达到 3 次上限，已停止自动唤醒。请在 Bot 对话或工作面板核对成果；未重新执行 Worker。';
const BOT_CAPACITY_KEY = 'bot-capacity:';
const JOB_RECOVERY_WAIT = '旧轮已结束，仍在等待后台 Job 终态和原生结果消费。Bot 会继续核对，原任务未交付。';
type ManagerProblem = { message: string; at: number; eventId?: string };
type RecoveryWorkPlan = { context: RecoveryWorkContext; authorizedProbes: {probe:ClusterProbe;auth:string}[] };
type StoredRecoveryInstruction = RecoveryInstruction&{directionRefs?:Omit<RecoveryDirection,'source'>[]};
export type BotDeletionReceipt = { botId: string; managerSessionId: string | null; feishuBindingId: string | null };

function directionId(source:ChatSource):string {
  return createHash('sha256').update(JSON.stringify([source.sessionId,source.messageId])).digest('hex');
}

function capacityOverride(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  throw new AppError('invalid-input', 'Bot 执行上限必须为正整数，留空可恢复默认。');
}

function deliveryUncertainReason(payload:{deliveryUncertainReason?:string;deliveryRetryExhausted?:boolean;
  legacyDelivery?:{explicit?:boolean};reconcileNote?:string}, diagnostic?:string):string {
  return payload.deliveryUncertainReason??diagnostic
    ??(payload.deliveryRetryExhausted?DELIVERY_RETRIES_EXHAUSTED:undefined)
    ??(payload.legacyDelivery?.explicit?'历史交付工具有回包，尚缺原聊天中的可核对回复。':undefined)
    ??payload.reconcileNote??'账本未能确认这份成果已在原聊天交付。';
}

function workerReportPayload(runId:string,callId:string,report:WorkReport,evidence:NonNullable<WorkReport['evidence']>) {
  const {kind,requestedFiles}=report;
  if(!['progress','stage','waiting','ready','blocked','failed'].includes(kind))throw new AppError('invalid-report','报告类型无效。');
  if((report.links!==undefined||report.primaryLink!==undefined)&&kind!=='ready')throw new AppError('invalid-delivery-links','只有成果报告可以提供交付物链接。');
  if(kind!=='stage'&&(report.stage!==undefined||report.evidenceRef!==undefined))throw new AppError('invalid-report','阶段字段仅用于阶段报告。');
  const checkpoint=kind==='stage'?{
    stage:requiredText(report.stage,'阶段名称',160),
    evidenceRef:requiredText(report.evidenceRef,'稳定的阶段证据编号',500),
  }:undefined;
  const links=report.links===undefined?undefined:readDeliveryLinks(report.links,false);
  const primaryLink=report.primaryLink===undefined?undefined:readPrimaryDeliveryLink(links??{},report.primaryLink);
  const checks=kind==='stage'?requiredText(report.checks,'阶段依据'):optionalText(report.checks,'验收说明');
  return {runId,callId,kind,summary:requiredText(report.summary,'报告内容'),checks,
    evidence,...checkpoint,...(requestedFiles?{requestedFiles}:{}),...(links?{links}:{}),...(primaryLink?{primaryLink}:{})};
}

/** One local database. Business transactions will live here, not in the UI/adapter. */
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string, readonly memory?: BotMemory) {
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
      const inputColumns=this.db.prepare('PRAGMA table_info(inputs)').all().map(row=>row.name);
      if(!inputColumns.includes('messageId'))this.db.exec('ALTER TABLE inputs ADD COLUMN messageId TEXT; ALTER TABLE inputs ADD COLUMN messageJson TEXT;');
      if(!inputColumns.includes('attentionId'))this.db.exec('ALTER TABLE inputs ADD COLUMN attentionId TEXT REFERENCES attentions(id);');
      const botColumns=this.db.prepare('PRAGMA table_info(bots)').all().map(row=>row.name);
      if(!botColumns.includes('materials'))this.db.exec("ALTER TABLE bots ADD COLUMN materials TEXT NOT NULL DEFAULT '[]';");
      if(!botColumns.includes('deletedAt'))this.db.exec('ALTER TABLE bots ADD COLUMN deletedAt INTEGER;');
      const taskColumns=this.db.prepare('PRAGMA table_info(tasks)').all().map(row=>row.name);
      if(!taskColumns.includes('botConfigRevision'))this.db.exec('ALTER TABLE tasks ADD COLUMN botConfigRevision INTEGER NOT NULL DEFAULT 1; UPDATE tasks SET botConfigRevision=(SELECT configRevision FROM bots WHERE bots.id=tasks.botId);');
      if(!taskColumns.includes('botContext'))this.db.exec("ALTER TABLE tasks ADD COLUMN botContext TEXT NOT NULL DEFAULT '{}'; UPDATE tasks SET botContext=json_object('instructions',(SELECT instructions FROM bots WHERE bots.id=tasks.botId),'materials',json((SELECT materials FROM bots WHERE bots.id=tasks.botId)));");
      if(!taskColumns.includes('workdirRequest'))this.db.exec('ALTER TABLE tasks ADD COLUMN workdirRequest TEXT;');
      const bindingColumns=this.db.prepare('PRAGMA table_info(bindings)').all().map(row=>row.name);
      if(!bindingColumns.includes('workdir'))this.db.exec('ALTER TABLE bindings ADD COLUMN workdir TEXT;');
      if(version.user_version>0&&version.user_version<11)this.db.exec(`
        CREATE TABLE resources_next (runId TEXT PRIMARY KEY REFERENCES runs(id));
        INSERT INTO resources_next SELECT runId FROM resources;
        DROP TABLE resources;
        ALTER TABLE resources_next RENAME TO resources;
      `);
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
  recordChildWait(taskId:string,edge:'started'|'updated'|'ended',wait:RunChildWait):void {
    this.event(`child-wait.${edge}`,taskId,wait);
  }
  taskChildWaits(taskId:string):RunChildWait[] {
    const waits=new Map<string,RunChildWait>();
    const rows=this.db.prepare("SELECT data FROM events WHERE taskId=? AND kind GLOB 'child-wait.*' ORDER BY id").iterate(taskId);
    for(const {data} of rows) {
      const wait=JSON.parse(String(data)) as RunChildWait;
      waits.set(wait.id,wait);
    }
    return [...waits.values()].reverse();
  }
  /** Audit-only fact recorded by an adapter (no state change). */
  note(kind:string,taskId:string|null,data:unknown):void {this.event(kind,taskId,data);}
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
    const {deletedAt: _deletedAt,...fields}=row;
    return {...fields,materials:materials.map(({text: _text,...info})=>info)} as unknown as Bot;
  }
  listBots(): Bot[] {return this.db.prepare('SELECT * FROM bots WHERE deletedAt IS NULL ORDER BY createdAt,id').all().map(row=>this.botFromRow(row));}
  getBot(id:string):Bot {
    const row=this.db.prepare('SELECT * FROM bots WHERE id=? AND deletedAt IS NULL').get(id);
    if(!row)throw new AppError('not-found','Bot 不存在。');return this.botFromRow(row);
  }
  isBotDeleted(botId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM bots WHERE id=? AND deletedAt IS NOT NULL').get(botId);
  }
  botCapacity(botId: string): BotCapacity {
    this.getBot(botId);
    const override = this.botCapacityOverride(botId);
    return {
      maxRunningTasks: override, botLimit: override ?? DEFAULT_BOT_RUNNING_TASKS,
      botHeld: this.heldCapacity(botId),
    };
  }
  setBotCapacity(requestId: string, botId: string, expected: unknown, limit: unknown): BotCapacity {
    const expectedMaxRunningTasks = capacityOverride(expected);
    const maxRunningTasks = capacityOverride(limit);
    this.command(requestId, 'bot.capacity.set', { botId, expectedMaxRunningTasks, maxRunningTasks }, () => {
      this.getBot(botId);
      if (this.botCapacityOverride(botId) !== expectedMaxRunningTasks) {
        throw new AppError('version-conflict', 'Bot 执行上限已更新，请刷新后再保存。');
      }
      if (maxRunningTasks === expectedMaxRunningTasks) return {};
      const key = BOT_CAPACITY_KEY + botId;
      if (maxRunningTasks === null) this.db.prepare('DELETE FROM metadata WHERE key=?').run(key);
      else this.set(key, String(maxRunningTasks));
      if ((maxRunningTasks ?? DEFAULT_BOT_RUNNING_TASKS) < (expectedMaxRunningTasks ?? DEFAULT_BOT_RUNNING_TASKS)) {
        this.keepBlockedCapacityWaits(botId);
      }
      this.event('bot.capacity.changed', null, { botId, maxRunningTasks });
      return {};
    });
    return this.botCapacity(botId);
  }
  private botCapacityOverride(botId: string): number | null {
    const value = Number(this.get(BOT_CAPACITY_KEY + botId));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  private heldCapacity(botId: string): number {
    return Number(this.db.prepare(`SELECT count(*) AS count FROM resources q
      JOIN runs r ON r.id=q.runId JOIN tasks t ON t.id=r.taskId WHERE t.botId=?`).get(botId)?.count);
  }
  private keepBlockedCapacityWaits(botId: string): void {
    // A Manager may see that the slot is gone and finish its turn without trying dispatch again.
    const inFlight = this.db.prepare(`SELECT t.id,t.rowVersion FROM waits w JOIN tasks t ON t.id=w.taskId
      JOIN bindings b ON b.taskId=t.id AND b.state='ready' AND b.sessionId IS NOT NULL
      WHERE t.botId=? AND EXISTS (SELECT 1 FROM outbox o WHERE o.kind='manager.notify' AND o.taskId=t.id
        AND o.id GLOB 'manager-event:capacity:' || t.id || ':*' AND json_extract(o.payload,'$.botId')=t.botId
        AND o.state IN ('sending','entered'))`).all(botId);
    for (const row of inFlight) {
      const taskId = String(row.id);
      if (this.getTask(taskId).status === 'unscheduled' && this.dispatchWaitForBot(taskId, botId)) {
        this.ensureCapacityNotification(botId, taskId, Number(row.rowVersion));
      }
    }
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
  assertBotDeletable(botId: string, expectedRevision: number, force: boolean): void {
    if (this.getBot(botId).configRevision !== expectedRevision) {
      throw new AppError('version-conflict', 'Bot 配置已经更新，请刷新后再删除。');
    }
    if (!force && this.db.prepare(`SELECT 1 FROM tasks t WHERE t.botId=? AND (t.lifecycle IN ('open','review')
      OR EXISTS (SELECT 1 FROM runs r LEFT JOIN resources s ON s.runId=r.id
        WHERE r.taskId=t.id AND (r.finishedAt IS NULL OR s.runId IS NOT NULL)))`).get(botId)) {
      throw new AppError('bot-unfinished', '此 Bot 还有未结束或待核对的任务，请先处理这些任务，或使用强制删除。');
    }
  }
  deleteBot(requestId: string, botId: string, expectedRevision: number, force: boolean): BotDeletionReceipt {
    return this.command(requestId, 'bot.delete', { botId, expectedRevision, force }, () => {
      this.assertBotDeletable(botId, expectedRevision, force);
      const manager = this.activeManager(botId);
      const binding = this.db.prepare('SELECT id FROM feishu_group_bindings WHERE botId=?').get(botId);
      const receipt = { botId, managerSessionId: manager?.requestedSessionId ?? null,
        feishuBindingId: binding ? String(binding.id) : null };
      const deletedAt = Date.now();
      this.db.prepare('UPDATE bots SET deletedAt=?,managerSessionId=NULL WHERE id=?').run(deletedAt, botId);
      this.db.prepare("UPDATE managers SET state='released' WHERE botId=? AND state!='released'").run(botId);
      this.db.prepare(`UPDATE outbox SET state='superseded' WHERE state IN ('pending','sending','entered','unknown','blocked')
        AND ((kind='manager.notify' AND json_extract(payload,'$.botId')=?)
          OR (kind='manager.create' AND json_extract(payload,'$.managerId') IN (SELECT id FROM managers WHERE botId=?)))`)
        .run(botId, botId);
      this.db.prepare('DELETE FROM feishu_group_bindings WHERE botId=?').run(botId);
      if (force) this.retireBotTasks(botId);
      this.event('bot.deleted', null, { ...receipt, expectedRevision, force, actor: 'user' });
      return receipt;
    });
  }
  isDeletedManagerSession(sessionId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM managers m JOIN bots b ON b.id=m.botId
      WHERE m.requestedSessionId=? AND b.deletedAt IS NOT NULL`).get(sessionId);
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
  /** Only the current, ready native Bot conversation owns a chat-adjacent work view. */
  botForSession(sessionId:string):Bot|null {
    const manager=this.managerForSession(sessionId);
    if(!manager||manager.state!=='ready'||manager.sessionId!==sessionId)return null;
    const bot=this.getBot(manager.botId);
    return bot.managerSessionId===sessionId&&bot.configRevision===manager.configRevision&&this.activeManager(bot.id)?.id===manager.id?bot:null;
  }
  ownsManagedSession(sessionId: string): boolean {
    if (this.botForSession(sessionId)) return true;
    return !!this.db.prepare(`SELECT 1 FROM bindings b JOIN tasks t ON t.id=b.taskId JOIN bots ON bots.id=t.botId
      WHERE bots.deletedAt IS NULL AND b.requestedSessionId=? AND b.sessionId=b.requestedSessionId AND b.state='ready'
        AND t.sessionId=b.sessionId AND b.taskRevision=t.taskRevision AND EXISTS (
          SELECT 1 FROM outbox WHERE id='binding:' || b.id AND kind='session.create' AND state='done')`).get(sessionId);
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
      for(const row of this.db.prepare("SELECT id FROM tasks WHERE botId=? AND controlMode='auto' AND lifecycle IN ('open','review') ORDER BY createdAt,id").all(manager.botId)) {
        const task=this.getTask(String(row.id));
        if(task.status!=='unscheduled'&&!(task.status==='review'&&!task.managerReviewed))continue;
        if(!this.db.prepare("SELECT 1 FROM outbox WHERE kind='manager.notify' AND state IN ('pending','sending','entered','unknown','blocked') AND taskId=? AND json_extract(payload,'$.botId')=?").get(task.id,manager.botId))this.enqueueManager(manager.botId,`backlog:${id}:${task.id}`,'管理会话已准备好，请从账本恢复这项现有工作。',task.id);
      }
      this.event('manager.ready',null,{botId:manager.botId,sessionId});return this.activeManager(manager.botId)!;
    });
  }
  enqueueManager(botId:string,key:string,reason:string,taskId:string|null,priority=0,delivery?:{
    resultId:string;taskRevision:number;reviewSessionId?:string;reviewCallId?:string;deliverSessionId?:string;deliverCallId?:string;
  }):void {
    if (this.isBotDeleted(botId)) return;
    this.getBot(botId); // Readiness is a delivery gate, never permission to lose a durable notification.
    this.db.prepare('INSERT OR IGNORE INTO outbox(id,kind,taskId,payload,createdAt) VALUES (?,?,?,?,?)').run(`manager-event:${key}`,'manager.notify',taskId,JSON.stringify({botId,reason,taskId,priority,notifyWhilePaused:/^(budget-stopped:|recovery:|approval:|settled:|delivery:|task-closed:|close-blocked:)/.test(key),...(delivery?{deliveryOnly:true,exactResultLink:true,...delivery}:{})}),Date.now());
  }
  private dueManagerEvents(botId:string,limit:number):Iterable<ManagerEvent> {
    return this.db.prepare(`SELECT id,taskId,payload,state,createdAt FROM outbox
      WHERE kind='manager.notify' AND state='pending' AND json_extract(payload,'$.botId')=?
        AND (taskId IS NULL OR EXISTS (SELECT 1 FROM tasks WHERE tasks.id=outbox.taskId AND tasks.botId=?
          AND (tasks.controlMode='auto' OR json_extract(outbox.payload,'$.notifyWhilePaused')=1)))
        AND coalesce(json_extract(payload,'$.nextAttemptAt'),0)<=?
      ORDER BY coalesce(json_extract(payload,'$.priority'),0) DESC,createdAt,id LIMIT ?`)
      .iterate(botId,botId,Date.now(),limit) as unknown as Iterable<ManagerEvent>;
  }
  pendingManagerEvents(botId:string):ManagerEvent[] {return [...this.dueManagerEvents(botId,10)];}
  nextManagerEvent(botId:string,canWake:(event:ManagerEvent)=>boolean=()=>true):ManagerEvent|undefined {
    const blocked=new Set<string>();
    for(const event of this.dueManagerEvents(botId,-1)) {
      if(event.id.startsWith('manager-event:continuation:')) {
        const task=event.taskId&&this.getTask(event.taskId);
        const instruction=task&&this.recoveryInstruction(task.id);
        if(!task||task.lifecycle!=='open'||!instruction||instruction.runId||instruction.taskRevision!==task.taskRevision||
          !event.id.startsWith(`manager-event:continuation:${instruction.id}`))continue;
      }
      if(!canWake(event))continue;
      if(event.taskId&&event.id.startsWith('manager-event:gitlab-release:')) {
        const current=this.gitLabReleaseDetail(this.getTask(event.taskId));
        const latest=current&&`manager-event:gitlab-release:${current.stageRunId}:${current.state}:${current.status??'unconfirmed'}`;
        if(event.id!==latest) {this.settleManagerEvent(event.id);continue;}
      }
      const stageEvent=/^manager-event:stage-(settled|ready|blocked|unavailable):([a-f0-9-]{36})(?::\d+)?$/.exec(event.id);
      if(stageEvent&&event.taskId) {
        const task=this.getTask(event.taskId),run=this.latestRun(task.id);
        const stage=run?.id===stageEvent[2]&&run?this.currentStage(task,run):null;
        const valid=task.lifecycle==='open'&&stage&&(
          (stageEvent[1]==='settled'&&['awaiting-decision','blocked'].includes(stage.state))||
          (stageEvent[1]==='unavailable'&&stage.state==='waiting'&&stage.observation?.state==='unavailable'&&
            event.id===`manager-event:stage-unavailable:${stage.runId}:${stage.planVersion??0}`)||
          stageEvent[1]===stage.state&&(stage.state!=='ready'||event.id===`manager-event:${stageReadyKey(stage)}`));
        if(!valid) {this.settleManagerEvent(event.id);continue;}
        if(this.stageOwnerFollowUp(task,run!)||stage.state==='ready'&&(task.status!=='unscheduled'||
          stage.deadlineAt!==undefined&&stage.deadlineAt<=Date.now()||this.dispatchBlocker(task.id)))continue;
      }
      if(!event.id.startsWith('manager-event:capacity:'))return event;
      const id=event.taskId;
      if(!id||blocked.has(id))continue;
      const {status}=this.getTask(id);
      const continuation=status==='blocked'?this.recoveryInstruction(id):null;
      if((status==='unscheduled'||continuation?.mode&&!continuation.runId)&&this.activeBinding(id)?.state==='ready'&&!this.dispatchBlocker(id))return event;
      blocked.add(id);
    }
  }
  /** No enqueue has been attempted: persist bounded backoff without consuming a wake attempt. */
  deferManagerEvent(id:string,reason:string,until:number,error=false):void {
    const row=this.db.prepare("SELECT payload FROM outbox WHERE id=? AND kind='manager.notify' AND state='pending'").get(id);if(!row)return;
    const payload=JSON.parse(String(row.payload)),failures=Number(payload.preflightFailures??0)+Number(error);
    const blocked=error&&failures>=5;
    this.db.prepare("UPDATE outbox SET state=?,payload=json_set(payload,'$.preflightFailures',?,'$.deferReason',?,'$.nextAttemptAt',?) WHERE id=? AND state='pending'").run(blocked?'blocked':'pending',failures,reason,error?Date.now()+30000*2**Math.min(failures-1,4):until,id);
    if(blocked)this.managerProblem(payload.botId,'通知在入队前连续失败 5 次，已停止自动重试；请核对后显式 retry-unsent。通知没有被丢弃。',id);
  }
  managerWakeAvailableAt(botId:string):number {
    const row=this.db.prepare("SELECT min(at) at FROM (SELECT createdAt at FROM events WHERE kind='manager.wake' AND json_extract(data,'$.botId')=? UNION ALL SELECT json_extract(payload,'$.deliveredAt') at FROM outbox WHERE kind='manager.notify' AND json_extract(payload,'$.botId')=? AND NOT EXISTS (SELECT 1 FROM events WHERE kind='manager.wake' AND json_extract(data,'$.eventId')=outbox.id)) WHERE at>=?").get(botId,botId,Date.now()-3600000);
    return Math.max(Date.now()+1000,Number(row?.at??Date.now())+3600001);
  }
  claimManagerReconciliation(botId:string):ManagerEvent[] {
    const rows=this.db.prepare("SELECT id,payload,taskId,state,createdAt FROM outbox WHERE kind='manager.notify' AND state IN ('unknown','entered') AND json_extract(payload,'$.botId')=? AND coalesce(json_extract(payload,'$.reconcileAttempts'),0)<3 AND coalesce(json_extract(payload,'$.nextReconcileAt'),0)<=? ORDER BY createdAt,id LIMIT 10").all(botId,Date.now());
    for(const row of rows) {
      const attempts=Number(JSON.parse(String(row.payload)).reconcileAttempts??0)+1;
      this.db.prepare("UPDATE outbox SET state=CASE WHEN ?=3 THEN 'unknown' ELSE state END,payload=json_set(payload,'$.reconcileAttempts',?,'$.nextReconcileAt',?,'$.reconcileNote',?) WHERE id=?").run(attempts,attempts,Date.now()+30000*2**(attempts-1),attempts===3?'持久证据自动核对已达 3 次；缺证据时请检查原会话，明确处理后 handled；不会重发。':'等待可归属的持久输入、最终回复与正常结束；不会重发。',row.id);
    }
    return rows as unknown as ManagerEvent[];
  }
  quarantinedManagerInput(sessionId:string,eventId:string,messageId:string,botId:string,managerId:string):boolean {
    return !!this.db.prepare("SELECT 1 FROM outbox JOIN managers ON managers.id=? AND managers.requestedSessionId=? AND managers.botId=? WHERE outbox.id=? AND kind='manager.notify' AND outbox.state IN ('unknown','handled','superseded','blocked') AND json_extract(payload,'$.botId')=? AND json_extract(payload,'$.messageId')=?").get(managerId,sessionId,botId,eventId,botId,messageId);
  }
  resolveManagerNotification(requestId:string,botId:string,id:string,action:'handled'|'retry-unsent',acknowledged:unknown,source?:ChatSource):void {
    if(acknowledged!==true||!['handled','retry-unsent'].includes(action))throw new AppError('confirmation-required','请明确确认核对结果；未知入队结果不能自动重发。');
    this.command(requestId,'manager.notification.resolve',{botId,id,action,acknowledged:true,...(source?{source}:{})},()=>{
      this.getBot(botId);
      const row=this.db.prepare("SELECT state,payload,taskId,attempts FROM outbox WHERE id=? AND kind='manager.notify' AND json_extract(payload,'$.botId')=?").get(id,botId);
      if(!row)throw new AppError('not-found','通知不存在。');
      const payload=JSON.parse(String(row.payload));
      const problem=JSON.parse(this.get(`managerProblem:${botId}`)??'null') as ManagerProblem|null;
      const diagnostic=problem?.eventId===id?problem.message:undefined;
      if(action==='retry-unsent') {
        if(row.state!=='blocked'||Number(row.attempts)!==0||payload.messageId!=null)throw new AppError('notification-uncertain','只有未入队且已停止重试的通知可以重试；未知投递须人工核对，不能重发。');
        this.db.prepare("UPDATE outbox SET state='pending',payload=json_set(payload,'$.preflightFailures',0,'$.nextAttemptAt',0,'$.deferReason','用户确认重试未入队通知') WHERE id=?").run(id);
      }else {
        if(!['unknown','blocked'].includes(String(row.state)))throw new AppError('notification-active','通知仍在处理或已经结束。');
        if(row.state==='unknown'&&payload.deliveryOnly===true) {
          this.db.prepare("UPDATE outbox SET state='handled',payload=json_set(payload,'$.deliveryUncertainReason',?) WHERE id=?")
            .run(deliveryUncertainReason(payload,diagnostic),id);
        }else this.db.prepare("UPDATE outbox SET state='handled' WHERE id=?").run(id);
      }
      if(problem?.eventId===id)this.managerProblem(botId,'');
      this.event('manager.notification-resolved',(row.taskId??null) as string|null,{botId,eventId:id,action,actor:'user',source});return {};
    });
  }
  claimManagerEvent(id:string,messageId:string,messageJson:string):boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row=this.db.prepare("SELECT payload,attempts FROM outbox WHERE id=? AND kind='manager.notify' AND state='pending'").get(id);
      if(!row){this.db.exec('COMMIT');return false;}
      const payload=JSON.parse(String(row.payload));
      if(payload.deliveryOnly&&Number(row.attempts)>=DELIVERY_ATTEMPT_LIMIT) {
        this.stopManagerDeliveryRetries(id,payload.botId);this.db.exec('COMMIT');return false;
      }
      if((Number(row.attempts)>0||payload.messageId!=null)&&!(payload.deliveryOnly&&typeof payload.messageId==='string'&&payload.messageId.length>0&&payload.deliveryAttemptEnd?.messageId===payload.messageId)) {
        this.db.prepare("UPDATE outbox SET state='unknown' WHERE id=?").run(id);this.db.exec('COMMIT');return false;
      }
      if((payload.nextAttemptAt??0)>Date.now()){this.db.exec('COMMIT');return false;}
      const claimed=this.db.prepare("UPDATE outbox SET state='sending',attempts=attempts+1,payload=json_set(payload,'$.messageId',?,'$.messageJson',?,'$.deliveredAt',?,'$.reconcileAttempts',0,'$.nextReconcileAt',0,'$.preflightFailures',0) WHERE id=? AND state='pending'").run(messageId,messageJson,Date.now(),id).changes===1;
      if(claimed) {
        const row=this.db.prepare('SELECT taskId,payload FROM outbox WHERE id=?').get(id)!;const botId=JSON.parse(String(row.payload)).botId as string;
        this.set('managerCursor',botId);
        this.event('manager.wake',row.taskId as string|null,{botId,eventId:id,messageId});
      }
      this.db.exec('COMMIT');return claimed;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  managerEventEntered(id:string,messageId:string,durable=false):void {
    this.db.prepare("UPDATE outbox SET state='entered' WHERE id=? AND (state='sending' OR (?=1 AND state='unknown')) AND json_extract(payload,'$.messageId')=?").run(id,Number(durable),messageId);
  }
  managerEvent(id:string):ManagerEvent|undefined {
    return this.db.prepare("SELECT id,taskId,payload,state,createdAt FROM outbox WHERE id=? AND kind='manager.notify'").get(id) as unknown as ManagerEvent|undefined;
  }
  managerEventTargets(id:string,messageId:string,botId:string,taskId:string,scopeOnly=false):boolean {
    return !!this.db.prepare(`SELECT 1 FROM outbox WHERE id=? AND kind='manager.notify' AND taskId=?
      AND (state='entered' OR (?=1 AND state IN ('sending','unknown','done','handled')))
      AND coalesce(json_extract(payload,'$.deliveryOnly'),0)=0
      AND json_extract(payload,'$.messageId')=? AND json_extract(payload,'$.botId')=?`).get(id,taskId,Number(scopeOnly),messageId,botId);
  }
  managerEventUnknown(id:string):void {
    // Idle/entry alone is not permission to repeat a notification.
    this.db.prepare("UPDATE outbox SET state='unknown' WHERE id=? AND state IN ('sending','entered')").run(id);
  }
  private stopManagerDeliveryRetries(id:string,botId:string):void {
    const changed=this.db.prepare("UPDATE outbox SET state='unknown',payload=json_set(payload,'$.deliveryRetryExhausted',json('true')) WHERE id=? AND coalesce(json_extract(payload,'$.deliveryRetryExhausted'),0)=0").run(id).changes;
    if(changed)this.managerProblem(botId,DELIVERY_RETRIES_EXHAUSTED,id);
  }
  managerDeliveryAttemptEnded(id:string,messageId:string,proof:{sessionId:string;turn:number;endSeq:number}):void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row=this.db.prepare("SELECT payload,attempts FROM outbox WHERE id=? AND kind='manager.notify' AND state='entered' AND json_extract(payload,'$.deliveryOnly')=1 AND json_extract(payload,'$.messageId')=?").get(id,messageId);
      if(row) {
        const payload=JSON.parse(String(row.payload));
        if(this.activeManager(payload.botId)?.sessionId!==proof.sessionId)throw new AppError('manager-stale','补交付会话已经改变。');
        // Persist the exact ended input and deadline. Duplicate end callbacks/reloads cannot extend or reset them.
        this.db.prepare("UPDATE outbox SET payload=json_set(payload,'$.deliveryAttemptEnd',json(?)) WHERE id=?").run(JSON.stringify({messageId,...proof}),id);
        if(Number(row.attempts)>=DELIVERY_ATTEMPT_LIMIT)this.stopManagerDeliveryRetries(id,payload.botId);
        else this.db.prepare("UPDATE outbox SET state='pending',payload=json_set(payload,'$.nextAttemptAt',?) WHERE id=?").run(Date.now()+DELIVERY_RETRY_DELAY_MS*2**Math.max(0,Number(row.attempts)-1),id);
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  managerWakeCount(botId:string,since:number):number {
    const current=Number(this.db.prepare("SELECT count(*) AS n FROM events WHERE kind='manager.wake' AND createdAt>=? AND json_extract(data,'$.botId')=?").get(since,botId)?.n);
    const legacy=Number(this.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='manager.notify' AND json_extract(payload,'$.deliveredAt')>=? AND json_extract(payload,'$.botId')=? AND NOT EXISTS (SELECT 1 FROM events WHERE kind='manager.wake' AND json_extract(data,'$.eventId')=outbox.id)").get(since,botId)?.n);
    return current+legacy;
  }
  resetUnconfirmedManagerEvents():void {
    // A historical tool response can be recovered as content; only the native log can prove delivery.
    this.db.prepare(`UPDATE outbox SET state='unknown',
        payload=json_remove(json_set(payload,'$.legacyDelivery',json_extract(payload,'$.chatDelivery')),'$.chatDelivery')
        WHERE kind='manager.notify' AND state='done' AND json_extract(payload,'$.deliveryOnly')=1
          AND json_extract(payload,'$.chatDelivery.explicit')=1
          AND NOT EXISTS (SELECT 1 FROM bots WHERE id=json_extract(outbox.payload,'$.botId') AND deletedAt IS NOT NULL)`).run();
    // Older versions requeued entered attempts without an end proof. Reconcile those before any fresh wake.
    this.db.prepare("UPDATE outbox SET state='entered' WHERE kind='manager.notify' AND state='pending' AND attempts>0 AND json_extract(payload,'$.deliveryOnly')=1 AND json_extract(payload,'$.deliveryAttemptEnd') IS NULL AND json_extract(payload,'$.messageId') IS NOT NULL").run();
    // A legacy pending row with any prior enqueue hint is NOT proof that delivery never happened.
    this.db.prepare("UPDATE outbox SET state='unknown' WHERE kind='manager.notify' AND state='pending' AND (attempts>0 OR json_extract(payload,'$.messageId') IS NOT NULL) AND NOT (coalesce(json_extract(payload,'$.deliveryOnly'),0)=1 AND json_extract(payload,'$.messageId') IS NOT NULL AND coalesce(json_extract(payload,'$.deliveryAttemptEnd.messageId')=json_extract(payload,'$.messageId'),0)=1)").run();
    // Keep entered delivery attempts until the adapter verifies their durable turn/end; never requeue on restart alone.
    this.db.prepare("UPDATE outbox SET state='unknown' WHERE kind='manager.notify' AND (state='sending' OR (state='entered' AND coalesce(json_extract(payload,'$.deliveryOnly'),0)!=1))").run();
    // An authenticated instruction survives a lost Manager notification receipt. A later wake
    // only reads the current ledger and may reserve the source once, even if the old wake ran.
    const interrupted=this.db.prepare(`SELECT t.id,t.botId,json_extract(m.value,'$.id') AS instructionId
      FROM tasks t JOIN metadata m ON m.key='recovery-instruction:' || t.id
      JOIN outbox o ON o.id='manager-event:continuation:' || json_extract(m.value,'$.id')
      JOIN bots b ON b.id=t.botId AND b.deletedAt IS NULL
      WHERE t.lifecycle='open' AND json_extract(m.value,'$.taskRevision')=t.taskRevision
        AND json_extract(m.value,'$.runId') IS NULL AND o.state='unknown'`).all();
    for(const row of interrupted)this.enqueueManager(String(row.botId),`continuation:${row.instructionId}:restart`,
      '重启前保存的用户指示仍待处理，请按原任务当前证据继续。',String(row.id),10);
    // Repair legacy unsent intents only when a strictly newer run has a matching Worker enqueue receipt.
    this.db.prepare(`WITH fulfilled AS MATERIALIZED (
        SELECT notice.id, (SELECT r.id FROM runs r JOIN inputs i ON i.id=r.inputId
          JOIN outbox receipt ON receipt.taskId=r.taskId AND json_extract(receipt.payload,'$.runId')=r.id
          WHERE r.taskId=notice.taskId AND i.state IN ('enqueued','entered') AND receipt.state='done'
            AND coalesce(json_extract(receipt.payload,'$.dispatchRowVersion') >=
              CAST(substr(notice.id,length('manager-event:capacity:' || notice.taskId || ':')+1) AS INTEGER),r.createdAt>notice.createdAt)
            AND receipt.id IN ('input:' || r.inputId,'run:' || r.id)
          ORDER BY r.createdAt,r.id LIMIT 1) AS runId
        FROM outbox notice JOIN tasks t ON t.id=notice.taskId
        WHERE notice.kind='manager.notify' AND notice.state IN ('pending','blocked') AND notice.attempts=0
          AND notice.id GLOB 'manager-event:capacity:' || t.id || ':*'
          AND json_extract(notice.payload,'$.botId')=t.botId AND json_extract(notice.payload,'$.messageId') IS NULL
      ) UPDATE outbox SET state='done',payload=json_set(payload,'$.fulfilledByRunId',fulfilled.runId)
        FROM fulfilled WHERE outbox.id=fulfilled.id AND fulfilled.runId IS NOT NULL`).run();
  }
  managerNotifications(botId:string,limit=-1):ManagerEvent[] {
    return this.db.prepare("SELECT id,taskId,payload,state,createdAt FROM outbox WHERE kind='manager.notify' AND state NOT IN ('done','superseded','handled') AND json_extract(payload,'$.botId')=? ORDER BY createdAt DESC,id LIMIT ?").all(botId,limit) as unknown as ManagerEvent[];
  }
  supersedeManagerDelivery(id:string):void {
    this.db.prepare("UPDATE outbox SET state='superseded' WHERE id=? AND kind='manager.notify' AND json_extract(payload,'$.deliveryOnly')=1 AND state NOT IN ('done','handled')").run(id);
  }
  managerDeliveryUncertain(id:string):boolean {
    return this.db.prepare("UPDATE outbox SET state='unknown' WHERE id=? AND kind='manager.notify' AND json_extract(payload,'$.deliveryOnly')=1 AND state IN ('pending','sending','entered')").run(id).changes===1;
  }
  managerNotificationDelivered(id:string,sessionId:string,proof:{turn:number;messageId:string;seq:number;endSeq:number}):void {
    const row=this.db.prepare("SELECT taskId,payload,state FROM outbox WHERE id=? AND kind='manager.notify'").get(id);
    if(!row||['done','superseded','handled'].includes(String(row.state)))return;
    const payload=JSON.parse(String(row.payload));
    if(this.activeManager(payload.botId)?.sessionId!==sessionId)throw new AppError('manager-stale','交付会话已经改变。');
    if(payload.deliveryOnly) {
      const task=this.getTask(String(row.taskId)),result=this.taskDetail(task.id).result;
      if(task.botId!==payload.botId||task.taskRevision!==payload.taskRevision||!result||result.id!==payload.resultId||
        result.taskRevision!==task.taskRevision||!['review','completed'].includes(task.lifecycle))throw new AppError('result-stale','交付成果已经改变。');
    }else if(row.state!=='entered'&&row.state!=='unknown')return;
    this.command(`manager-delivered:${id}`,'manager.delivered',{id,sessionId,...proof},()=>{
      this.db.prepare("UPDATE outbox SET state='done',payload=json_set(payload,'$.chatDelivery',json(?)) WHERE id=?").run(JSON.stringify({sessionId,...proof}),id);
      if(JSON.parse(this.get(`managerProblem:${payload.botId}`)??'null')?.eventId===id)this.managerProblem(payload.botId,'');
      this.event('manager.delivered',row.taskId as string|null,{eventId:id,sessionId,...proof,...(payload.resultId?{resultId:payload.resultId}:{})});return {};
    });
  }
  /** A tool result is prepared content. Only the native chat receipt settles its notification. */
  managerDeliver<T extends {taskId:string;resultId:string;text:string}>(requestId:string,botId:string,
    sessionId:string,callId:string,delivery:T,initial?:{links?:unknown;primaryLink?:unknown}):T {
    if(this.activeManager(botId)?.sessionId!==sessionId)throw new AppError('manager-stale','交付会话已经改变。');
    const task=this.getTask(delivery.taskId),result=this.taskDetail(task.id).result;
    if(task.botId!==botId||result?.id!==delivery.resultId||result.taskRevision!==task.taskRevision||!['review','completed'].includes(task.lifecycle))throw new AppError('result-stale','交付成果已经改变。');
    this.assertNoTaskClose(task.id);
    const links=initial?.links===undefined?undefined:readDeliveryLinks(initial.links,false);
    const primary=initial?.primaryLink;
    const primaryLink=primary===undefined||primary===null?primary:readPrimaryDeliveryLink(links??this.reportedDeliveryArtifacts(result.runId).links,primary);
    const artifacts={...(links?{links}:{}),...(primaryLink!==undefined?{primaryLink}:{})};
    return this.command(requestId,'manager.deliver',{botId,taskId:task.id,resultId:result.id,text:delivery.text,...artifacts},()=>{
      this.enqueueManager(botId,`delivery:${result.id}`,RESULT_DELIVERY_REASON,task.id,5,
        {resultId:result.id,taskRevision:task.taskRevision,deliverSessionId:sessionId,deliverCallId:callId});
      if(initial) {
        const eventId=`manager-event:delivery:${result.id}`;
        const saved=this.db.prepare(`UPDATE outbox SET payload=json_patch(payload,json(?))
          WHERE id=? AND state NOT IN ('done','handled','superseded') AND json_extract(payload,'$.deliveryText') IS NULL`)
          .run(JSON.stringify({deliveryText:delivery.text,...artifacts}),eventId).changes;
        if(saved&&primaryLink===null) {
          this.db.prepare("UPDATE outbox SET payload=json_set(payload,'$.primaryLink',NULL) WHERE id=?").run(eventId);
        }
        if(!saved&&(links!==undefined||primaryLink!==undefined)) {
          const previous=this.db.prepare("SELECT state,json_extract(payload,'$.links') AS links,json_extract(payload,'$.primaryLink') AS primaryLink FROM outbox WHERE id=?").get(eventId);
          if(previous?.state!=='done'&&(previous?.links??undefined)===JSON.stringify(links)&&previous?.primaryLink===(primaryLink??null))return delivery;
          throw new AppError('result-stale','此版本的初始交付物已登记；交付确认后请用链接更新操作。');
        }
      }
      return delivery;
    });
  }
  managerUpdateDeliveryLinks(requestId:string,botId:string,sessionId:string,taskId:string,expectedRowVersion:number,
    resultId:string,changes:unknown,primary:unknown=undefined):DeliveryLinks {
    if(this.activeManager(botId)?.sessionId!==sessionId)throw new AppError('manager-stale','交付会话已经改变。');
    if(changes===undefined&&primary===undefined)throw new AppError('invalid-delivery-links','请提供变更的交付物或首要入口。');
    const patch=changes===undefined?{}:readDeliveryLinks(changes,true);
    return this.command(requestId,'manager.update-delivery-links',{botId,taskId,expectedRowVersion,resultId,patch,
      ...(primary!==undefined?{primaryLink:primary}:{})},()=>{
      const task=this.getTask(taskId),run=this.latestRun(taskId);
      if(task.botId!==botId)throw new AppError('manager-scope','只能管理自己负责的任务。');
      if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请重新读取交付版本。');
      const receipt=this.deliveryReceipt(task,resultId);
      if(!receipt||!['review','completed'].includes(task.lifecycle)||run?.id!==receipt.runId||
        run.taskRevision!==task.taskRevision||run.bindingId!==this.activeBinding(task.id)?.id) {
        throw new AppError('result-stale','只能更新当前已经在原聊天确认交付的成果。');
      }
      const links=new Map<string,string>(Object.entries(JSON.parse(receipt.linksJson)));
      let modified=false;
      for(const [name,url] of Object.entries(patch)) {
        if(url===null)modified=links.delete(name)||modified;
        else if(links.get(name)!==url){links.set(name,url);modified=true;}
      }
      const updated=Object.fromEntries(links);
      const previous=receipt.primaryLink;
      const primaryLink=primary===undefined?(previous&&links.has(previous)?previous:undefined)
        :primary===null?undefined:readPrimaryDeliveryLink(updated,primary);
      if(modified||primaryLink!==previous) {
        const savedLinks=JSON.stringify(updated);
        if(primaryLink||previous) {
          this.db.prepare("UPDATE outbox SET payload=json_set(payload,'$.links',json(?),'$.primaryLink',?) WHERE id=?")
            .run(savedLinks,primaryLink??null,receipt.eventId);
        } else {
          this.db.prepare("UPDATE outbox SET payload=json_set(payload,'$.links',json(?)) WHERE id=?").run(savedLinks,receipt.eventId);
        }
        this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1 WHERE id=?').run(taskId);
      }
      return updated;
    });
  }
  managerOrder():Bot[] {const bots=this.listBots(),id=this.get('managerCursor'),cursor=bots.findIndex(bot=>bot.id===id);return [...bots.slice(cursor+1),...bots.slice(0,cursor+1)];}
  managerProblem(botId:string,message:string,eventId?:string):void {
    if (this.isBotDeleted(botId)) return;
    const key=`managerProblem:${botId}`;const prior=this.get(key);
    if(!message){this.db.prepare('DELETE FROM metadata WHERE key=?').run(key);return;}
    if(eventId?.startsWith('manager-event:delivery:')) {
      const delivery=this.db.prepare(`SELECT state FROM outbox WHERE id=? AND kind='manager.notify'
        AND json_extract(payload,'$.deliveryOnly')=1 AND json_extract(payload,'$.botId')=?`).get(eventId,botId);
      if(delivery?.state==='handled')return; // A late native check must not reopen the owner's issue.
      // Keep an exact delivery's diagnostic when subsequent wakes clear or replace the Bot-wide problem.
      if(delivery?.state==='unknown')this.db.prepare(`UPDATE outbox SET payload=json_set(payload,'$.deliveryUncertainReason',?)
        WHERE id=? AND json_extract(payload,'$.deliveryUncertainReason') IS NOT ?`).run(message,eventId,message);
    }
    if(prior&&JSON.parse(prior).message===message&&JSON.parse(prior).eventId===eventId)return;
    this.set(key,JSON.stringify({message,at:Date.now(),...(eventId?{eventId}:{})}));
  }
  private uncertainDeliveries(botId:string,problem:ManagerProblem|null):UncertainDelivery[] {
    const rows=this.db.prepare(`SELECT o.id,t.id AS taskId,t.goal AS taskGoal,r.id AS resultId,o.createdAt,o.payload
      FROM outbox o JOIN tasks t ON t.id=o.taskId
      JOIN results r ON r.taskId=t.id AND r.id=json_extract(o.payload,'$.resultId')
        AND r.taskRevision=json_extract(o.payload,'$.taskRevision') AND o.id='manager-event:delivery:' || r.id
      WHERE o.kind='manager.notify' AND o.state='unknown' AND json_extract(o.payload,'$.deliveryOnly')=1
        AND t.botId=? AND json_extract(o.payload,'$.botId')=t.botId ORDER BY o.createdAt,o.id`).all(botId);
    if(!rows.length)return [];
    const chats=this.db.prepare('SELECT id,sessionId FROM managers WHERE botId=? AND sessionId IS NOT NULL').all(botId);
    return rows.map(row=>{
      const id=String(row.id),payload=JSON.parse(String(row.payload));
      const ended=payload.deliveryAttemptEnd;
      const input=typeof payload.messageJson==='string'?this.decodeManagerMessage(payload.messageJson):null;
      const source=input?.source;
      const claimed=source?.kind==='super-bot-manager'&&source.botId===botId&&source.eventId===id
        &&typeof payload.messageId==='string'&&input?.id===payload.messageId;
      const attemptChat=claimed?chats.find(chat=>chat.id===source.managerId)?.sessionId:undefined;
      const hasEnd=ended?.messageId&&ended.messageId===payload.messageId;
      const session=attemptChat??[hasEnd&&ended.sessionId,payload.reviewSessionId,payload.deliverSessionId,payload.legacyDelivery?.sessionId]
        .find(candidate=>candidate&&chats.some(chat=>chat.sessionId===candidate));
      const reason=deliveryUncertainReason(payload,problem?.eventId===id?problem.message:undefined);
      return {id,taskId:String(row.taskId),taskGoal:String(row.taskGoal),resultId:String(row.resultId),reason,
        sessionId:typeof session==='string'?session:null,at:Number(payload.deliveredAt??row.createdAt),
        ...(hasEnd&&ended.sessionId===session&&Number.isSafeInteger(ended.turn)?{turn:Number(ended.turn)}:{})};
    });
  }
  private decodeManagerMessage(json:string) {
    try {return JSON.parse(json) as {id?:string;source?:{kind?:string;botId?:string;eventId?:string;managerId?:string}}|null;}
    catch {return null;}
  }
  managerInfo(botId:string) {
    this.getBot(botId);
    const problem=JSON.parse(this.get(`managerProblem:${botId}`)??'null') as ManagerProblem|null;
    return {binding:this.activeManager(botId),notifications:this.db.prepare(`SELECT id,state,attempts,json_extract(payload,'$.deferReason') deferReason,
        json_extract(payload,'$.nextAttemptAt') nextAttemptAt,json_extract(payload,'$.reconcileAttempts') reconcileAttempts,
        json_extract(payload,'$.reconcileNote') reconcileNote FROM outbox WHERE kind='manager.notify'
        AND state NOT IN ('done','superseded','handled') AND json_extract(payload,'$.botId')=? ORDER BY createdAt,id LIMIT 20`).all(botId),
      pending:Number(this.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='manager.notify' AND state='pending' AND json_extract(payload,'$.botId')=?").get(botId)?.n),
      uncertain:Number(this.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='manager.notify' AND state='unknown' AND json_extract(payload,'$.botId')=?").get(botId)?.n),
      uncertainDeliveries:this.uncertainDeliveries(botId,problem),hourlyWakes:this.managerWakeCount(botId,Date.now()-3600000),problem};
  }
  releaseManager(requestId:string,botId:string,expectedGeneration:number):ManagerBinding {
    return this.command(requestId,'manager.replace',{botId,expectedGeneration},()=>{
      const manager=this.activeManager(botId);if(!manager||manager.generation!==expectedGeneration)throw new AppError('manager-stale','管理会话已经改变，请刷新。');
      this.db.prepare("UPDATE managers SET state='released' WHERE id=?").run(manager.id);
      this.db.prepare('UPDATE bots SET managerSessionId=NULL WHERE id=?').run(botId);
      this.db.prepare("UPDATE outbox SET state='superseded' WHERE kind='manager.notify' AND state='unknown' AND json_extract(payload,'$.botId')=?").run(botId);
      this.event('manager.replaced',null,{botId,oldSessionId:manager.sessionId});return manager;
    });
  }
  createTask(requestId: string, input: NewTask, source?: ChatSource, conventionOverride?: string, release?:{reference:string; jobName?:string; requiresJobName?:boolean}): Task {
    if(input.startPaused!==undefined&&typeof input.startPaused!=='boolean')throw new AppError('invalid-input','初始暂停状态必须是布尔值。');
    const payload: NewTask = { botId: requiredText(input.botId, 'Bot 标识', 200), goal: requiredText(input.goal, '任务目标'),
      scope: optionalText(input.scope, '任务范围'), acceptance: optionalText(input.acceptance, '验收条件'), reviewPolicy: input.reviewPolicy,...(input.startPaused?{startPaused:true}:{}) };
    const workdir=parseWorkdirRequest(input.workdir);if(workdir)payload.workdir=workdir;
    if (!['human', 'bot'].includes(payload.reviewPolicy)) throw new AppError('invalid-input', '请选择有效的验收方式。');
    // Native provenance, not a model-provided call ID, identifies one human request.
    // Keep the normal call receipt too: reusing a call ID with changed content must still fail.
    const reference=release&&exactMergeReference(release.reference);
    if(release&&(!source||this.botForSession(source.sessionId)?.id!==input.botId||
      !reference||!mergeReferences(source.text).some(item=>JSON.stringify(item)===JSON.stringify(reference)))) {
      throw new AppError('gitlab-release-scope','创建任务时需要原聊天中的确切 GitLab MR 链接。');
    }
    const intent = { ...payload, ...(conventionOverride===undefined?{}:{conventionOverride}), ...(release?{release}:{}) };
    const intentHash=source?createHash('sha256').update(JSON.stringify({action:'task.create-intent',payload:intent,source:{sessionId:source.sessionId,messages:(source.messages??[source]).map(({messageId,seq})=>({messageId,seq})).sort((a,b)=>a.seq-b.seq)}})).digest('hex'):undefined;
    const intentId=intentHash?`task-intent:${intentHash}`:undefined;
    return this.command(requestId, 'task.create', {...intent,...(source?{source}:{})}, () => {
      const prior=intentId?this.db.prepare('SELECT result FROM requests WHERE id=?').get(intentId):undefined;
      if(prior)return JSON.parse(String(prior.result)) as Task;
      const bot=this.getBot(payload.botId),context=this.currentBotContext(payload.botId);
      const convention = conventionOverride ?? this.memory?.defaultConvention(bot.id);
      if (convention !== undefined) context.workConvention = {
        text: convention, source: conventionOverride === undefined ? 'default' : 'override',
      };
      const id = randomUUID(), now = Date.now();
      this.db.prepare('INSERT INTO tasks(id,botId,goal,scope,acceptance,reviewPolicy,controlMode,createdAt,updatedAt,botConfigRevision,botContext,workdirRequest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, payload.botId, payload.goal, payload.scope, payload.acceptance, payload.reviewPolicy,payload.startPaused?'paused':'auto',now,now,bot.configRevision,JSON.stringify(context),payload.workdir?JSON.stringify(payload.workdir):null);
      this.db.prepare('INSERT INTO inputs(id,taskId,kind,content,createdAt) VALUES (?,?,?,?,?)')
        .run(randomUUID(), id, 'goal', payload.goal, now);
      this.event('task.created', id, { taskRevision: 1,...(source?{source}:{}),...(release?{release}:{}) });
      this.enqueueManager(payload.botId,`created:${id}`,'有新任务，请检查授权范围与验收条件后安排。',id);
      if (!payload.scope || !payload.acceptance) this.db.prepare('INSERT INTO attentions(id,taskId,kind,question,taskRevision,createdAt) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(),id,'input','请补充任务范围和验收条件，然后再安排执行。',1,now);
      const task=this.getTask(id);
      // Same transaction as Task/Input/Event/Outbox: a crash cannot leave an unclaimed intent.
      if(intentId)this.db.prepare('INSERT INTO requests VALUES (?,?,?)').run(intentId,intentHash!,JSON.stringify(task));
      return task;
    });
  }
  getTask(id: string): Task {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as unknown as Task | undefined;
    if (!task) throw new AppError('not-found', '任务不存在。');
    return this.decorateTask(task);
  }
  private decorateTask(row:Task):Task {
    const {botContext:_context,workdirRequest:rawWorkdir,...rest}=row as Omit<Task,'workdirRequest'>&{botContext?:string;workdirRequest?:string|null};
    const task:Task={...rest,workdirRequest:rawWorkdir?JSON.parse(rawWorkdir):null};
    let status=taskStatus(task);const run=this.latestRun(task.id);
    const stage=run&&task.lifecycle==='open'?this.currentStage(task,run):null;
    let blockingAttention: Task['blockingAttention'] = null;
    if(task.lifecycle==='open'||task.lifecycle==='review') {
      const open=this.db.prepare(`SELECT id,kind,taskRevision FROM attentions WHERE taskId=? AND ${BLOCKING_ATTENTIONS}
        ORDER BY CASE kind WHEN 'recovery' THEN 0 WHEN 'approval' THEN 1 ELSE 2 END`).all(task.id);
      const settled=run?.taskRevision===task.taskRevision&&run.sessionId===task.sessionId&&this.verifiedBlocker(run);
      const actionable=open.filter(row=>!settled||row.id!==`run:${run!.id}`);
      blockingAttention=(actionable.find(row=>row.taskRevision===task.taskRevision)?.kind as Task['blockingAttention']) ?? null;
      // Keep the conservative recovery status for command guards, including a stale open recovery record.
      const has=(kind: string)=>actionable.some(row=>row.kind===kind);
      if(has('recovery'))status='recovery';
      else if(run?.state==='cancelling')status='stopping';
      else if(has('approval'))status='approval';
      else if(run?.state==='running')status='running';
      else if(run?.state==='queued')status='queued';
      else if(has('input'))status='needs-input';
      else if(status==='unscheduled'&&run&&run.taskRevision===task.taskRevision) {
        const result=this.recoveryCheck(run.id)?.resolution;
        if(stage) {
          if(stage.state!=='ready'||this.stageOwnerFollowUp(task,run))status='blocked';
        }else if(settled||result&&(['denied','missing'].includes(result.status)||result.observed?.ready===false))status='blocked';
      }
    }
    const managerReviewed=!!(run&&this.db.prepare("SELECT 1 FROM reviews JOIN results ON results.id=reviews.resultId WHERE results.runId=? AND reviews.actor LIKE 'manager:%' LIMIT 1").get(run.id));
    const check=status==='blocked'&&run?this.recoveryCheck(run.id):null;
    const resolution=check?.resolution;
    const needsDecision=stage?.state==='blocked'||check?.effectUncertain===true||(status==='blocked'&&!!run&&this.recoveryWorkPlan(run.id)?.context.effectUncertain===true)||!!resolution&&
      (['denied','missing'].includes(resolution.status)||resolution.observed?.ready===false);
    return {...task,status,managerReviewed,blockingAttention,
      ...(stage?{stageState:stage.state}:{}),
      ...(status==='blocked'&&!needsDecision?{waitingForPrerequisite:true as const}:{})};
  }
  private withDelivery(task: Task): Task {
    if(task.lifecycle!=='review'&&task.lifecycle!=='completed') return task;
    const run=this.latestRun(task.id);
    if(!run || run.taskRevision!==task.taskRevision || run.bindingId!==this.activeBinding(task.id)?.id) return task;
    const receipt=this.deliveryReceipt(task);
    return receipt?.runId===run.id?{...task,deliveredAt:receipt.deliveredAt}:task;
  }
  reportedDeliveryArtifacts(runId:string):DeliveryArtifacts {
    const row=this.db.prepare("SELECT data FROM reports WHERE runId=? AND kind='ready'").get(runId);
    const {links,primaryLink}=row?JSON.parse(String(row.data)) as WorkReport:{};
    return {links:links??{},...(primaryLink?{primaryLink}:{})};
  }
  private deliveryReceipt(task:Task,resultId?:string) {
    const receipt=this.db.prepare(`SELECT r.id AS resultId,r.runId,o.id AS eventId,e.createdAt AS deliveredAt,
      json_extract(o.payload,'$.deliveryText') AS deliveryText,
      coalesce(json_extract(o.payload,'$.links'),json_extract(p.data,'$.links')) AS links,
      CASE WHEN json_type(o.payload,'$.links') IS NOT NULL OR json_type(o.payload,'$.primaryLink') IS NOT NULL
        THEN json_extract(o.payload,'$.primaryLink') ELSE json_extract(p.data,'$.primaryLink') END AS primaryLink
      FROM events e JOIN outbox o ON o.id=json_extract(e.data,'$.eventId') AND o.taskId=e.taskId
      JOIN results r ON r.taskId=e.taskId AND r.id=json_extract(e.data,'$.resultId')
      LEFT JOIN reports p ON p.runId=r.runId AND p.kind='ready'
      WHERE e.taskId=? AND e.kind='manager.delivered' AND coalesce(json_extract(e.data,'$.explicit'),0)=0
        AND o.id='manager-event:delivery:' || r.id AND o.kind='manager.notify' AND o.state='done'
        AND json_extract(o.payload,'$.botId')=? AND json_extract(o.payload,'$.resultId')=r.id
        AND json_extract(o.payload,'$.taskRevision')=r.taskRevision
        AND json_extract(o.payload,'$.chatDelivery.messageId') IS NOT NULL AND (? IS NULL OR r.id=?)
      ORDER BY e.id DESC LIMIT 1`).get(task.id,task.botId,resultId??null,resultId??null);
    return receipt?{resultId:String(receipt.resultId),runId:String(receipt.runId),eventId:String(receipt.eventId),
      deliveredAt:Number(receipt.deliveredAt),deliveryText:typeof receipt.deliveryText==='string'?receipt.deliveryText:undefined,
      linksJson:typeof receipt.links==='string'?receipt.links:'{}',
      primaryLink:typeof receipt.primaryLink==='string'?receipt.primaryLink:undefined}:null;
  }
  deliveredResult(task:Task,exact?:Result):DeliveredResult|null {
    const receipt=this.deliveryReceipt(task,exact?.id);
    if(!receipt)return null;
    const result=exact??this.resultById(receipt.resultId);
    return result&&{...result,deliveredAt:receipt.deliveredAt,
      ...(receipt.deliveryText!==undefined?{deliveryText:receipt.deliveryText}:{}),links:JSON.parse(receipt.linksJson),
      ...(receipt.primaryLink?{primaryLink:receipt.primaryLink}:{})};
  }
  /** Return only artifacts for results proven delivered in this completed native turn. */
  chatDeliveries(sessionId:string,turn:number,endSeq:number,messageId?:string):({taskId:string;resultId:string}&DeliveryArtifacts)[] {
    const bot=this.botForSession(sessionId);
    if(!bot)return [];
    const rows=this.db.prepare(`SELECT e.taskId,json_extract(e.data,'$.resultId') AS resultId
      FROM events e JOIN tasks t ON t.id=e.taskId
      WHERE e.kind='manager.delivered' AND json_type(e.data,'$.resultId')='text'
        AND json_extract(e.data,'$.sessionId')=? AND json_extract(e.data,'$.turn')=? AND json_extract(e.data,'$.endSeq')=?
        AND coalesce(json_extract(e.data,'$.explicit'),0)=0 AND t.botId=?
        AND (? IS NULL OR json_extract(e.data,'$.messageId')=?) ORDER BY e.id`)
      .all(sessionId,turn,endSeq,bot.id,messageId??null,messageId??null);
    return rows.flatMap(row=>{
      const taskId=String(row.taskId), resultId=String(row.resultId), result=this.resultById(resultId);
      const delivery=result?.taskId===taskId?this.deliveredResult(this.getTask(taskId),result):null;
      return delivery?[{taskId,resultId,links:delivery.links,...(delivery.primaryLink?{primaryLink:delivery.primaryLink}:{})}]:[];
    });
  }
  chatDeliveryStatus(task:Task,result:Result|null,historical=false):ChatDeliveryStatus|null {
    if(!result||result.taskId!==task.id||(!historical&&!['review','completed'].includes(task.lifecycle)))return null;
    const eventId=`manager-event:delivery:${result.id}`;
    const row=this.db.prepare(`SELECT state,payload FROM outbox WHERE id=? AND kind='manager.notify' AND taskId=?
      AND json_extract(payload,'$.botId')=? AND json_extract(payload,'$.taskRevision')=?`)
      .get(eventId,task.id,task.botId,historical?result.taskRevision:task.taskRevision);
    if(!row)return historical?null:{state:task.lifecycle==='review'&&!task.managerReviewed?'awaiting-review':'uncertain'};
    const payload=JSON.parse(String(row.payload));
    if(row.state==='done'&&payload.chatDelivery?.messageId)return {state:'delivered'};
    const problem=JSON.parse(this.get(`managerProblem:${task.botId}`)??'null') as ManagerProblem|null;
    const pending=['pending','sending','entered'].includes(String(row.state));
    const diagnostic=problem?.eventId===eventId?problem.message:undefined;
    const reason=row.state==='unknown'||row.state==='handled'?deliveryUncertainReason(payload,diagnostic)
      :pending?(payload.deferReason??diagnostic):(diagnostic??payload.reconcileNote??payload.deferReason);
    return {state:row.state==='handled'?'handled':pending?'pending':'uncertain',...(reason?{reason}:{})};
  }
  taskDetail(id: string) {
    const current=this.getTask(id),binding=this.activeBinding(id),run=this.latestRun(id);
    const deliveredResult=this.deliveredResult(current);
    const result=run&&run.taskRevision===current.taskRevision&&run.bindingId===binding?.id?this.runResult(run.id):null;
    const task=result&&result.id===deliveredResult?.id&&['review','completed'].includes(current.lifecycle)
      ?{...current,deliveredAt:deliveredResult.deliveredAt}:current;
    const recoveryInstruction=this.recoveryInstruction(id);
    const canWait=binding?.state==='ready'&&(task.status==='unscheduled'||task.status==='blocked'&&recoveryInstruction?.mode&&!recoveryInstruction.runId);
    const resourceNotice=canWait&&this.db.prepare(`SELECT 1 FROM outbox WHERE kind='manager.notify' AND taskId=?
      AND (id GLOB 'manager-event:capacity:' || taskId || ':*' OR id GLOB 'manager-event:stage-ready:*')
      AND json_extract(payload,'$.botId')=?
      AND state IN ('pending','sending','entered') LIMIT 1`).get(id,task.botId);
    const manager=resourceNotice?this.activeManager(task.botId):null;
    const autoDispatchPending=!!manager?.sessionId&&this.botForSession(manager.sessionId)?.id===task.botId;
    const wait=canWait&&(resourceNotice||this.db.prepare('SELECT 1 FROM waits WHERE taskId=?').get(id))?this.dispatchWait(id):null;
    const attentions=this.db.prepare('SELECT * FROM attentions WHERE taskId=? ORDER BY createdAt,id').all(id) as unknown as Attention[];
    const currentRun=run?.taskRevision===task.taskRevision&&run.bindingId===binding?.id?run:null;
    const late=run?this.lateJobRecovery(run.id):null;
    const currentLate=run&&this.lateJobTarget(run.id,true);
    const invalidated=late&&['waiting','ready'].includes(late.state)&&!currentLate;
    const lateState:LateJobRecovery|null=late&&invalidated?{...late,state:'blocked',reason:
      '任务的指示、控制或 Worker 关联已更新。Bot 将按当前授权核对，旧的后台回执不再触发续跑。'}:late;
    const lateNote=currentLate&&task.controlMode==='paused'
      ?'任务已按你的要求暂停。Bot 仍可核对后台结果，恢复管理后才会接续。'
      :invalidated&&lateState?.state==='blocked'?lateState.reason:undefined;
    if(lateNote) {
      const recovery=attentions.find(item=>item.id===`run:${run!.id}`&&item.state==='open');
      if(recovery)recovery.question=lateNote;
    }
    return { task,wait,autoDispatchPending,stage:currentRun?this.currentStage(task,currentRun):null,stages:this.stageHistory(task),
      gitLabRelease:this.gitLabReleaseDetail(task),
      closeRequest:this.taskClose(id),
      runHeld:!!(run&&this.db.prepare('SELECT 1 FROM resources WHERE runId=?').get(run.id)),runTurn:run?this.runTurn(run.id):null,recoveryCheck:run?this.recoveryCheck(run.id):null,recoveryInstruction,
      ...(lateState?{lateJobRecovery:lateState}:{}),
      ...(run&&this.recoveryWorkPlan(run.id)?.context.lateJobs?{lateJobPriorEffects:'原生 Job 已收敛并签收，旧轮外部效果仍待核实。'}:{}),
      directionStatus:recoveryInstruction?this.recoveryDirectionStatus(recoveryInstruction):null,
      settledBlocker:currentRun?this.verifiedBlocker(currentRun):null,
      binding,bindingHistory:this.db.prepare("SELECT * FROM bindings WHERE taskId=? AND state='released' ORDER BY generation DESC").all(id).map(row=>this.toBinding(row)),run,input:this.pendingInput(id)??(run?this.getRunInput(run.id):null),result,
      deliveredResult,chatDelivery:this.chatDeliveryStatus(task,result),progress:this.taskProgress(task,currentRun,result),
      attentions,pendingQuestions:this.pendingWorkerQuestions(task,binding,attentions),
      events: this.db.prepare("SELECT id,kind,data,createdAt FROM events WHERE taskId=? AND kind NOT GLOB 'child-wait.*' ORDER BY id DESC LIMIT 50").all(id) as unknown as { id: number; kind: string; data: string; createdAt: number }[],
    };
  }
  private taskProgress(task: Task, run: Run | null, result: Result | null): TaskProgress {
    const worker=this.db.prepare(`SELECT p.runId,json_extract(p.data,'$.summary') AS summary,p.createdAt AS at
      FROM runs r JOIN reports p ON p.runId=r.id WHERE r.taskId=? AND r.taskRevision=? AND p.kind='progress'
      ORDER BY p.createdAt DESC,p.rowid DESC LIMIT 1`).get(task.id,task.taskRevision);
    const entered=run&&this.db.prepare(`SELECT createdAt FROM events WHERE taskId=? AND kind='input.entered'
      AND json_extract(data,'$.runId')=? ORDER BY id LIMIT 1`).get(task.id,run.id);
    const accepted=task.lifecycle==='completed'&&result&&this.db.prepare(`SELECT createdAt AS at,CASE WHEN actor='user' THEN 'user' ELSE 'bot' END AS actor
      FROM reviews WHERE resultId=? AND ((actor='user' AND verdict='accepted') OR (actor=? AND verdict='accept'))
      ORDER BY createdAt DESC LIMIT 1`).get(result.id,`manager:${task.botId}`);
    const applied=result&&this.db.prepare(`SELECT data,createdAt FROM events WHERE taskId=? AND kind='dev.reload-applied'
      AND json_extract(data,'$.resultId')=? ORDER BY id DESC LIMIT 1`).get(task.id,result.id);
    const reload=applied?{...JSON.parse(String(applied.data)),at:Number(applied.createdAt)} as ReloadReceipt:null;
    return { worker:worker ? { runId: String(worker.runId), summary: String(worker.summary), at: Number(worker.at) } : null,
      runId:run?.id??null, inputEnteredAt:typeof entered?.createdAt==='number'?entered.createdAt:null,
      acceptance:accepted ? { actor: accepted.actor==='user'?'user':'bot', at: Number(accepted.at) } : null, reload };
  }
  devReloadResult(resultId: string, root: string): { taskId: string; result: Result } {
    const result=this.resultById(resultId);
    const detail=result&&this.taskDetail(result.taskId);
    if(!result||!detail||detail.result?.id!==result.id||detail.run?.state!=='settled'||detail.binding?.cwd!==root
      ||!['review','completed'].includes(detail.task.lifecycle)||detail.task.blockingAttention) {
      throw new AppError('result-stale','请选择当前仓库中已收敛、仍可核对的 Super Bot 成果。');
    }
    return { taskId:result.taskId,result };
  }
  recordDevReload(root: string, receipt: Omit<ReloadReceipt,'at'>): void {
    this.command(`dev-reload:${receipt.build}`,'dev.reload-applied',receipt,()=>{
      const { taskId }=this.devReloadResult(receipt.resultId,root);
      this.event('dev.reload-applied',taskId,receipt);return {};
    });
  }
  taskResultRecords(id: string): MirrorRecords {
    const results = this.db.prepare(`SELECT id,runId,taskRevision,summary,checks,createdAt,humanAcceptedAt,
      json_array_length(evidence) AS fileCount FROM results WHERE taskId=? ORDER BY createdAt DESC,id LIMIT 11`)
      .all(id) as unknown as ResultRecord[];
    const reviews = this.db.prepare(`SELECT reviews.id,resultId,CASE WHEN actor='user' THEN 'user' ELSE 'bot' END AS actor,
      verdict,reviews.createdAt FROM reviews JOIN results ON results.id=reviews.resultId
      WHERE results.taskId=? ORDER BY reviews.createdAt DESC,reviews.id LIMIT 31`).all(id) as unknown as ReviewRecord[];
    return { results: results.slice(0, 10), reviews: reviews.slice(0, 30), moreResults: results.length > 10, moreReviews: reviews.length > 30 };
  }
  reviseTask(requestId: string, id: string, expectedRowVersion: number, input: Pick<NewTask,'goal'|'scope'|'acceptance'>, source?:ChatSource): Task {
    const payload = { id, expectedRowVersion, goal: requiredText(input.goal,'任务目标'), scope: optionalText(input.scope,'任务范围'),
      acceptance: optionalText(input.acceptance,'验收条件'), ...(source?{source}:{}) };
    return this.command(requestId,'task.revise',payload,() => {
      const task = this.getTask(id);
      if (task.rowVersion !== expectedRowVersion) throw new AppError('version-conflict','任务已经更新，请刷新后再修改。');
      this.assertNoTaskClose(id);
      if (this.activeBinding(id)) throw new AppError('execution-attached','执行会话已关联，需要先核对执行状态才能修改目标。');
      if (task.lifecycle !== 'open') throw new AppError('task-ended','当前任务不接受目标修改。');
      if (task.goal === payload.goal && task.scope === payload.scope && task.acceptance === payload.acceptance) return task;
      this.db.prepare('UPDATE tasks SET goal=?,scope=?,acceptance=?,taskRevision=taskRevision+1,rowVersion=rowVersion+1,updatedAt=? WHERE id=?')
        .run(payload.goal,payload.scope,payload.acceptance,Date.now(),id);
      this.db.prepare("UPDATE attentions SET state='stale' WHERE taskId=? AND state='open'").run(id);
      if (!payload.scope || !payload.acceptance) this.db.prepare('INSERT INTO attentions(id,taskId,kind,question,taskRevision,createdAt) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(),id,'input','请补充任务范围和验收条件，然后再安排执行。',task.taskRevision+1,Date.now());
      this.enqueueManager(task.botId,`revision:${id}:${task.taskRevision+1}`,'用户已更新任务目标、范围或验收条件，请读取新版本后安排。',id,10);
      this.event('task.revised',id,{ taskRevision: task.taskRevision+1,source }); return this.getTask(id);
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
    return { items: rows.map(row=>this.withDelivery(this.decorateTask(row))), total, limit, offset, counts, snapshotVersion };
  }
  taskInbox(botId: string): TaskInboxPage {
    const open=this.listTasks({botId,lifecycle:'open',limit:100});
    const review=this.listTasks({botId,lifecycle:'review',limit:100});
    const completed=this.listTasks({botId,lifecycle:'completed',limit:30});
    const cancelled=this.listTasks({botId,lifecycle:'cancelled',limit:8});
    const visible=new Map([...open.items,...review.items,...completed.items,...cancelled.items].map(task=>[task.id,task]));
    // Keep an active blocker or late delivery visible even when its task is outside the usual window.
    const freshSince=Date.now()-RESULT_FRESH_MS;
    const additional=this.db.prepare(`SELECT t.id FROM tasks t WHERE t.botId=? AND t.lifecycle IN ('open','review')
      AND EXISTS(SELECT 1 FROM attentions WHERE taskId=t.id AND taskRevision=t.taskRevision AND ${BLOCKING_ATTENTIONS})
      UNION SELECT t.id FROM events e JOIN tasks t ON t.id=e.taskId WHERE t.botId=? AND t.lifecycle IN ('review','completed')
      AND e.kind='manager.delivered' AND e.createdAt>? AND json_extract(e.data,'$.resultId') IS NOT NULL`)
      .all(botId,botId,freshSince);
    for(const { id } of additional) {
      if(visible.has(String(id))) continue;
      const task=this.withDelivery(this.getTask(String(id)));
      if(task.blockingAttention || (task.deliveredAt ?? 0)>freshSince) visible.set(task.id,task);
    }
    const { byTask: activity, reviewTotal } = inboxActivity(this.db, botId);
    for (const [id, state] of activity) {
      if ((state === 'working' || state === 'attention') && !visible.has(id)) visible.set(id, this.withDelivery(this.getTask(id)));
    }
    const question = this.db.prepare(`SELECT question FROM attentions WHERE taskId=? AND taskRevision=?
      AND kind='input' AND state='open' ORDER BY createdAt,id LIMIT 1`);
    const items=[...visible.values()].map(task => ({
      ...task, activity: activity.get(task.id) ?? null,
      ...(task.blockingAttention === 'input' ? { activityQuestion: question.get(task.id, task.taskRevision)?.question as string } : {}),
    }));
    return {...open,items,limit:items.length,reviewTotal,truncated:open.total>open.items.length||review.total>review.items.length};
  }
  private toBinding(row:unknown):Binding {
    const {workdir,...binding}=row as Omit<Binding,'workdir'>&{workdir?:string|null};
    return {...binding,workdir:workdir?JSON.parse(workdir) as WorkdirInfo:null};
  }
  activeBinding(taskId: string): Binding | null {
    const binding=this.db.prepare("SELECT * FROM bindings WHERE taskId=? AND state!='released'").get(taskId);
    return binding?this.toBinding(binding):null;
  }
  /** Active binding, or the most recent released one: where the task's files live. */
  latestBinding(taskId:string):Binding|null {
    const row=this.db.prepare("SELECT * FROM bindings WHERE taskId=? ORDER BY state='released',generation DESC LIMIT 1").get(taskId);
    return row?this.toBinding(row):null;
  }
  setBindingWorkdir(bindingId:string,info:WorkdirInfo):Binding {
    const binding=this.getBinding(bindingId);
    this.db.prepare('UPDATE bindings SET workdir=? WHERE id=?').run(JSON.stringify(info),bindingId);
    this.event('workdir.cleanup',binding.taskId,{bindingId,state:info.state});return this.getBinding(bindingId);
  }
  /** Only sessions actually created by this plugin, not user-authorized attachments.
   * Stale goal generations lack their original title input: leave those native/manual.
   */
  sidebarWorkers(botId:string):{binding:Binding;task:Task}[] {
    this.getBot(botId);
    const rows=this.db.prepare(`SELECT b.* FROM bindings b JOIN tasks t ON t.id=b.taskId
      WHERE t.botId=? AND b.sessionId=b.requestedSessionId AND b.taskRevision=t.taskRevision
      AND EXISTS (SELECT 1 FROM events e WHERE e.kind='session.preparing' AND e.taskId=t.id AND json_extract(e.data,'$.bindingId')=b.id)
      ORDER BY b.createdAt,b.id`).all(botId) as unknown as Binding[];
    return rows.map(binding=>({binding,task:this.getTask(binding.taskId)}));
  }
  getBinding(id: string): Binding {
    const binding=this.db.prepare('SELECT * FROM bindings WHERE id=?').get(id);
    if(!binding)throw new AppError('not-found','会话关联不存在。');return this.toBinding(binding);
  }
  nextBindingGeneration(taskId:string):number {return Number(this.db.prepare('SELECT coalesce(max(generation),0)+1 AS n FROM bindings WHERE taskId=?').get(taskId)?.n);}
  assertSessionAttachable(taskId:string,sessionId:string):void {
    const task=this.getTask(taskId);
    this.assertNoTaskClose(taskId);
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
      this.event('session.attached',task.id,{bindingId:binding.id,sessionId:grant.sessionId,cwd:grant.cwd,history:'entire-session',
        directoryApproved:true,actor:'user',taskRevision:task.taskRevision,source:grant.source});return binding;
    });
  }
  bindingReceipt(requestId:string,taskId:string,expectedRowVersion:number):Binding|undefined {
    const row=this.db.prepare('SELECT result FROM requests WHERE id=?').get(requestId) as {result:string}|undefined;if(!row)return;
    const previous=JSON.parse(row.result) as Binding;
    const receipt=this.commandReceipt<Binding>(requestId,'session.prepare',{taskId,expectedRowVersion,cwd:previous.cwd});
    return receipt?this.getBinding(receipt.id):undefined;
  }
  /** Raw run receipt for an internal dispatch request ID; undefined when that dispatch never committed. */
  runForRequest(requestId:string):Run|undefined {
    const row=this.db.prepare('SELECT result FROM requests WHERE id=?').get(requestId) as {result:string}|undefined;if(!row)return;
    const saved=JSON.parse(row.result) as {id?:unknown;inputId?:unknown};
    return typeof saved.inputId==='string'&&typeof saved.id==='string'?this.getRun(saved.id):undefined;
  }
  settleManagerEvent(id:string):void {
    this.db.prepare("UPDATE outbox SET state='done' WHERE id=? AND kind='manager.notify' AND state='pending'").run(id);
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
  beginBinding(requestId: string, taskId: string, expectedRowVersion: number, cwd: string,workdir?:WorkdirInfo): Binding {
    return this.command(requestId,'session.prepare',{taskId,expectedRowVersion,cwd},()=>{
      const task=this.getTask(taskId);
      if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后再准备会话。');
      this.assertNoTaskClose(taskId);
      if(task.lifecycle!=='open'||!task.scope||!task.acceptance)throw new AppError('not-ready','请先补全任务范围和验收条件。');
      const existing=this.activeBinding(taskId);if(existing)return existing;
      const generation=this.nextBindingGeneration(taskId);
      const binding:Binding={id:randomUUID(),taskId,generation,taskRevision:task.taskRevision,requestedSessionId:`session-${randomUUID()}`,sessionId:null,cwd,state:'creating',createdAt:Date.now(),workdir:workdir??null};
      this.db.prepare('INSERT INTO bindings(id,taskId,generation,taskRevision,requestedSessionId,sessionId,cwd,state,createdAt,workdir) VALUES (?,?,?,?,?,?,?,?,?,?)').run(binding.id,taskId,generation,task.taskRevision,binding.requestedSessionId,null,cwd,'creating',binding.createdAt,workdir?JSON.stringify(workdir):null);
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
      this.enqueueManager(this.getTask(b.taskId).botId,`binding-recovery:${id}`,`会话创建结果待核对。请在任务详情核对已申请的会话 ${b.requestedSessionId}；不会重复创建或自动派发。`,b.taskId,10);
      this.event('session.recovery',b.taskId,{bindingId:id});return {};
    });
  }
  latestRun(taskId:string):Run|null {
    const run=this.db.prepare('SELECT * FROM runs WHERE taskId=? ORDER BY createdAt DESC,rowid DESC LIMIT 1').get(taskId) as unknown as Run|undefined;
    return run?{...run}:null;
  }
  taskRuns(taskId:string):Run[] {
    return this.db.prepare('SELECT * FROM runs WHERE taskId=? ORDER BY createdAt DESC,rowid DESC').all(taskId) as unknown as Run[];
  }
  runModelPlan(runId:string):WorkerModelPlan|null {
    const plan=this.get(`run-model-plan:${runId}`);
    return plan?JSON.parse(plan) as WorkerModelPlan:null;
  }
  getRun(id:string):Run {
    const run=this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as unknown as Run|undefined;
    if(!run)throw new AppError('not-found','执行记录不存在。');return {...run};
  }
  getRunInput(id:string):RunInput {
    const run=this.getRun(id);return {...this.db.prepare('SELECT * FROM inputs WHERE id=?').get(run.inputId)} as unknown as RunInput;
  }
  /** Past entered inputs can inform a new run without changing their delivery state. */
  previousWorkerInputs(run:Run):WorkerPriorInput[] {
    const inputs=this.db.prepare(`SELECT i.id,i.kind,i.content,i.messageId,r.id AS previousRunId FROM runs r JOIN inputs i ON i.id=r.inputId
      WHERE r.taskId=? AND r.taskRevision=? AND r.rowid<(SELECT rowid FROM runs WHERE id=?)
      AND i.id<>? AND i.kind IN ('answer','rework','continuation') AND i.state='entered'
      GROUP BY i.id ORDER BY MAX(r.rowid)`).all(run.taskId,run.taskRevision,run.id,run.inputId) as
      unknown as (Omit<WorkerPriorInput,'order'>&{previousRunId:string})[];
    return inputs.map(({previousRunId,...input},index)=>{
      const context=input.kind==='continuation'?this.recoveryWorkPlan(previousRunId)?.context:undefined;
      const priorDirections=context?.priorDirections?.map(direction=>direction.text)??(context?.priorDirection?[context.priorDirection]:[]);
      return {...input,order:index+1,...(priorDirections.length?{priorDirections}:{})};
    });
  }
  pendingInput(taskId:string):RunInput|null {
    const input=this.db.prepare("SELECT * FROM inputs WHERE taskId=? AND kind IN ('answer','rework') AND state='accepted' ORDER BY createdAt,id LIMIT 1").get(taskId) as unknown as RunInput|undefined;
    return input?{...input}:null;
  }
  heldRuns():Run[] {return this.db.prepare('SELECT runs.* FROM runs JOIN resources ON resources.runId=runs.id').all() as unknown as Run[];}
  deletedBotRuns(botId?:string):Run[] {
    return this.db.prepare(`SELECT runs.* FROM runs JOIN resources ON resources.runId=runs.id
      JOIN tasks ON tasks.id=runs.taskId JOIN bots ON bots.id=tasks.botId WHERE bots.deletedAt IS NOT NULL
      ${botId===undefined?'':'AND bots.id=?'}`).all(...(botId===undefined?[]:[botId])) as unknown as Run[];
  }
  deletedWorkerRunsForSession(sessionId:string):Run[] {
    return this.db.prepare(`SELECT runs.* FROM runs JOIN tasks ON tasks.id=runs.taskId JOIN bots ON bots.id=tasks.botId
      JOIN inputs ON inputs.id=runs.inputId WHERE runs.sessionId=? AND bots.deletedAt IS NOT NULL
      AND inputs.messageId IS NOT NULL`).all(sessionId) as unknown as Run[];
  }
  /** Confirmed external settlement of a previously retained reservation. */
  finishDeletedRun(id:string,confirmed:boolean,note:string):void {
    this.command(`delete-run-release:${id}`,'run.delete-release',{id},()=>{
      const run=this.getRun(id);
      if(!this.isBotDeleted(this.getTask(run.taskId).botId))throw new AppError('run-stale','执行所属 Bot 仍然有效。');
      this.releaseDeletedRun(run,confirmed,note);
      return {};
    });
  }
  private releaseDeletedRun(run:Run,confirmed:boolean,note:string):void {
    if(!this.db.prepare('DELETE FROM resources WHERE runId=?').run(run.id).changes)return;
    if(run.finishedAt===null)this.db.prepare('UPDATE runs SET state=?,finishedAt=?,note=? WHERE id=?')
      .run(confirmed?'cancelled':'interrupted',Date.now(),note,run.id);
    this.db.prepare("UPDATE inputs SET state=? WHERE id=? AND state!='entered'")
      .run(confirmed?'discarded':'unknown',run.inputId);
    this.event('run.delete-release',run.taskId,{runId:run.id,confirmed,note});
  }
  runTurn(runId:string):RunTurn|null {return this.db.prepare('SELECT * FROM run_turns WHERE runId=?').get(runId) as unknown as RunTurn??null;}
  finalReport(runId:string):{id:string;kind:string}|null {
    return this.db.prepare("SELECT id,kind FROM reports WHERE runId=? AND kind!='progress' LIMIT 1").get(runId) as {id:string;kind:string}??null;
  }
  runFinalReport(runId:string):RecoveryWorkContext['priorReport']|undefined {
    const row=this.db.prepare("SELECT data FROM reports WHERE runId=? AND kind!='progress' LIMIT 1").get(runId);
    if(row) {
      const {kind,summary,checks}=JSON.parse(String(row.data)) as WorkReport;
      return {kind,summary,checks};
    }
  }
  /** Recognizes legacy normal settlements from the ledger without treating a report alone as an end receipt. */
  verifiedBlocker(run:Run):'settled-failure'|'verified-end'|null {
    if(run.state!=='failed'&&run.state!=='interrupted'&&run.state!=='settled')return null;
    return this.db.prepare(`SELECT ${settledBlockerSql} AS kind FROM runs latest WHERE latest.id=?`).get(run.id)?.kind as
      'settled-failure'|'verified-end'|null;
  }
  associateRunTurn(runId:string,turn:number,startSeq:number,inputSeq:number):void {
    if(!this.runTurn(runId))return; // Legacy attempts are never backfilled from a guess.
    if(![turn,startSeq,inputSeq].every(Number.isSafeInteger)||turn<1||startSeq<0||inputSeq<=startSeq)throw new AppError('turn-proof','自动轮次归属坐标无效。');
    this.command(`turn:${runId}`,'run.turn',{runId,turn,startSeq,inputSeq},()=>{
      if(this.getRunInput(runId).state!=='entered')throw new AppError('turn-proof','自动输入未确认进入上下文。');
      this.db.prepare('UPDATE run_turns SET turn=?,startSeq=?,inputSeq=? WHERE runId=?').run(turn,startSeq,inputSeq,runId);return {};
    });
  }
  observeRunEnd(runId:string,endSeq:number,endKind:string,quiet:boolean,jobIds?:string[]):void {
    const proof=this.runTurn(runId);if(!proof||proof.inputSeq===null)return;
    if(!Number.isSafeInteger(endSeq)||endSeq<=proof.inputSeq)throw new AppError('turn-proof','自动轮次结束坐标无效。');
    const report=this.finalReport(runId),reportId=report?.id??null;
    this.command(`turn-end:${runId}`,'run.turn-end',{runId,endSeq,endKind,quiet,reportId,...(jobIds?{jobIds}:{})},()=>{
      this.db.prepare('UPDATE run_turns SET endSeq=?,endKind=?,quiet=?,reportId=? WHERE runId=?')
        .run(endSeq,endKind,Number(quiet),reportId,runId);
      if(!quiet&&jobIds?.length&&(!report||report.kind==='failed'||report.kind==='blocked')) {
        const run=this.getRun(runId),task=this.getTask(run.taskId);
        const dispatchVersion=this.db.prepare("SELECT json_extract(payload,'$.dispatchRowVersion') AS version FROM outbox WHERE id=?")
          .get(`input:${run.inputId}`)?.version;
        if(run.state==='running'&&task.controlMode==='auto'&&task.lifecycle==='open'&&task.taskRevision===run.taskRevision&&
          task.rowVersion===Number(dispatchVersion)+1&&this.activeBinding(task.id)?.id===run.bindingId&&
          !this.taskClose(task.id)&&!this.recoveryWorkPlan(run.id)?.context.lateJobs) {
          const pending:LateJobRecovery={ids:jobIds,rowVersion:task.rowVersion,deadline:Date.now()+15*60*1000,state:'waiting'};
          this.set(`late-job:${runId}`,JSON.stringify(pending));
        }
      }
      return {};
    });
  }
  lateJobRecovery(runId:string):LateJobRecovery|null {
    const value=this.get(`late-job:${runId}`);
    return value?JSON.parse(value):null;
  }
  lateJobTarget(runId:string,includePaused=false) {
    const pending=this.lateJobRecovery(runId);
    if(!pending||!['waiting','ready'].includes(pending.state))return;
    const run=this.getRun(runId),task=this.getTask(run.taskId);
    const binding=this.activeBinding(task.id),proof=this.runTurn(runId);
    const instruction=pending.instructionId?this.recoveryInstruction(task.id):null;
    const controlled=task.controlMode==='auto'||includePaused&&task.controlMode==='paused';
    if(task.rowVersion!==pending.rowVersion||
      pending.instructionId&&(instruction?.id!==pending.instructionId||instruction.priorRunId!==runId||instruction.runId)||
      task.lifecycle!=='open'||!controlled||this.isBotDeleted(task.botId)||this.taskClose(task.id)||
      run.state!=='interrupted'||this.latestRun(task.id)?.id!==run.id||task.taskRevision!==run.taskRevision||
      binding?.state!=='ready'||binding.id!==run.bindingId||binding.generation!==run.generation||
      binding.sessionId!==run.sessionId||binding.taskRevision!==task.taskRevision||proof?.quiet!==0||proof.endSeq===null||
      this.getRunInput(runId).state!=='entered'||!this.db.prepare('SELECT 1 FROM resources WHERE runId=?').get(runId)||
      !this.db.prepare("SELECT 1 FROM attentions WHERE id=? AND state='open'").get(`run:${runId}`)||
      this.db.prepare(`SELECT 1 FROM attentions WHERE taskId=? AND id!=? AND
        (state IN ('open','responding') OR kind='approval' AND state='stale')`).get(task.id,`run:${runId}`)||
      this.db.prepare("SELECT 1 FROM inputs WHERE taskId=? AND kind!='goal' AND state IN ('accepted','enqueued','unknown')").get(task.id)) return;
    return {pending,run,task,binding,proof,instruction};
  }
  updateLateJob(runId:string,outcome:{reason:string}|{proof:LateJobProof}):void {
    const target=this.lateJobTarget(runId,true);
    if(!target||('proof' in outcome&&target.pending.state!=='waiting'))return;
    const {task,pending}=target,state='proof' in outcome?'ready':'blocked';
    this.command(`late-job-${state}:${runId}`,`run.late-job-${state}`,{runId,outcome},()=>{
      if(!this.lateJobTarget(runId,true))return {};
      this.set(`late-job:${runId}`,JSON.stringify({...pending,state,...outcome}));
      if('reason' in outcome)this.settleManagerEvent(`manager-event:late-job-ready:${runId}`);
      const note='reason' in outcome?outcome.reason:'后台 Job 结果已在原生会话消费。等待按原授权接续，任务尚未交付。';
      this.db.prepare('UPDATE attentions SET question=? WHERE id=?').run(note,`run:${runId}`);
      this.enqueueManager(task.botId,`late-job-${state}:${runId}`,note,task.id,10);
      this.event(`run.late-job-${state}`,task.id,{runId,...outcome});return {};
    });
  }
  observeLateJobTerminal(runId:string):void {
    const target=this.lateJobTarget(runId,true);
    if(target?.pending.state!=='waiting'||target.pending.terminalObserved)return;
    this.command(`late-job-terminal:${runId}`,'run.late-job-terminal',{runId},()=>{
      this.set(`late-job:${runId}`,JSON.stringify({...target.pending,terminalObserved:true}));
      this.db.prepare('UPDATE attentions SET question=? WHERE id=?')
        .run('原 Job 已进入终态，Bot 正等待原生通知轮消费结果。原任务仍待接续，报告尚未交付。',`run:${runId}`);
      this.event('run.late-job-terminal',target.task.id,{runId});return {};
    });
  }
  lateJobCanDispatch(runId:string):boolean {
    // The continuation transfers the existing slot. Capacity reductions never evict holders.
    return this.lateJobTarget(runId)?.pending.state==='ready';
  }
  reserveLateJobContinuation(runId:string,proof:LateJobProof,expectedModel:WorkerModelPlan):Run {
    return this.command(`late-job-continue:${runId}`,'run.late-job-continue',{runId,proof},()=>{
      const target=this.lateJobTarget(runId);
      if(!target||target.pending.state!=='ready'||JSON.stringify(target.pending.proof)!==JSON.stringify(proof)) {
        throw new AppError('recovery-stale','任务、原生 Job 回执或 Worker 关联已改变。');
      }
      const {task,binding,pending,instruction}=target;
      const priorProgress=this.taskProgress(task,target.run,null).worker;
      this.db.prepare('DELETE FROM resources WHERE runId=?').run(runId);
      this.db.prepare("UPDATE attentions SET state='resolved' WHERE id=? AND state='open'").run(`run:${runId}`);
      const next=this.allocateRun(task,binding,true,expectedModel,instruction??undefined,true);
      const context:RecoveryWorkContext={priorRunId:runId,mode:instruction?.mode??'authorized-work',effectUncertain:true,probes:[],
        priorReport:this.runFinalReport(runId),
        ...(instruction?{priorDirections:instruction.directions?.map(({id,source})=>({id,text:source.text})),
          directionIds:instruction.directions?.map(direction=>direction.id)}:{}),
        lateJobs:pending.ids,...(priorProgress?.runId===runId?{priorProgress:priorProgress.summary}:{})};
      this.set(`recovery-work:${next.id}`,JSON.stringify({context,authorizedProbes:[]}));
      this.set(`late-job:${runId}`,JSON.stringify({...pending,state:'continued',nextRunId:next.id}));
      if(instruction) {
        this.writeRecoveryInstruction(task.id,{...instruction,runId:next.id});
        this.settleManagerEvent(`manager-event:continuation:${instruction.id}`);
      }
      for(const state of ['waiting','ready'])this.settleManagerEvent(`manager-event:late-job-${state}:${runId}`);
      this.enqueueManager(task.botId,`late-job-continued:${runId}`,
        '原生 Job 结果已消费，已为原任务安排接续。旧操作的外部效果仍未核实；续轮只读取材料和生成单独的本地报告。请核对 Worker 是否收到输入，报告仍待交付。',task.id,9);
      this.event('run.late-job-continued',task.id,{runId:next.id,priorRunId:runId});
      return next;
    });
  }
  workerTaskForSession(sessionId:string):string|undefined {
    return this.db.prepare("SELECT taskId FROM bindings WHERE sessionId=? AND state='ready'").get(sessionId)?.taskId as string|undefined;
  }
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
  dispatchBlocker(taskId:string):'capacity'|null {return this.dispatchWait(taskId)?.code??null;}
  /** Earlier live waiters of the same Bot keep their place when its execution slots free up. */
  dispatchWait(taskId:string):DispatchWait|null {
    const task = this.db.prepare('SELECT botId FROM tasks WHERE id=?').get(taskId);
    if (!task) throw new AppError('not-found', '任务不存在。');
    return this.dispatchWaitForBot(taskId, String(task.botId));
  }
  private dispatchWaitForBot(taskId: string, botId: string): DispatchWait | null {
    const slots = (this.botCapacityOverride(botId) ?? DEFAULT_BOT_RUNNING_TASKS) - this.heldCapacity(botId);
    if (slots <= 0) return { code: 'capacity', scope: 'bot', holderTaskId: null, holderGoal: null };

    const seq = this.db.prepare('SELECT seq FROM waits WHERE taskId=?').get(taskId)?.seq ?? null;
    // The waiter reserving the last available slot blocks this task, if one exists.
    const holder = this.db.prepare(`SELECT w.taskId,t.goal FROM waits w JOIN tasks t ON t.id=w.taskId
      JOIN bindings b ON b.taskId=w.taskId AND b.state='ready' AND b.sessionId IS NOT NULL
      WHERE t.botId=? AND w.taskId!=? AND (? IS NULL OR w.seq<?) AND t.lifecycle='open' AND t.controlMode='auto'
      AND t.scope!='' AND t.acceptance!=''
      AND NOT EXISTS (SELECT 1 FROM attentions a WHERE a.taskId=w.taskId AND a.state='open'
        AND NOT (a.kind='recovery' AND EXISTS (SELECT 1 FROM metadata m
          WHERE m.key='recovery-instruction:' || w.taskId
          AND json_extract(m.value,'$.taskRevision')=t.taskRevision AND json_extract(m.value,'$.runId') IS NULL
          AND 'run:' || json_extract(m.value,'$.priorRunId')=a.id)))
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.taskId=w.taskId AND r.finishedAt IS NULL)
      AND NOT EXISTS (SELECT 1 FROM resources q JOIN runs r ON r.id=q.runId WHERE r.taskId=w.taskId)
      AND EXISTS (SELECT 1 FROM outbox o WHERE o.kind='manager.notify' AND o.taskId=w.taskId
        AND (o.id GLOB 'manager-event:capacity:' || w.taskId || ':*' OR o.id GLOB 'manager-event:stage-ready:*')
        AND o.state IN ('pending','sending','entered')
        AND json_extract(o.payload,'$.botId')=t.botId)
      ORDER BY w.seq LIMIT 1 OFFSET ?`).get(botId, taskId, seq, seq, slots - 1);
    return holder ? { code: 'capacity', scope: 'bot', holderTaskId: String(holder.taskId), holderGoal: String(holder.goal) } : null;
  }
  /** Joins the FIFO line once; a later deferral of the same task keeps its original place. */
  recordWait(taskId:string):void {
    this.db.prepare('INSERT OR IGNORE INTO waits(taskId,createdAt,seq) SELECT ?,?,coalesce(max(seq),0)+1 FROM waits')
      .run(taskId,Date.now());
  }
  recordCapacityWait(requestId: string, taskId: string, expectedRowVersion: number): void {
    const receipt = `capacity-wait:${createHash('sha256').update(requestId).digest('hex')}`;
    this.command(receipt, 'task.wait-capacity', { taskId, expectedRowVersion }, () => {
      const task = this.getTask(taskId);
      if (task.rowVersion !== expectedRowVersion) throw new AppError('version-conflict', '任务已更新，请重新读取执行状态。');
      this.getBot(task.botId);
      this.recordWait(taskId);
      if(task.stageState!=='ready')this.ensureCapacityNotification(task.botId, taskId, expectedRowVersion);
      return {};
    });
  }
  private ensureCapacityNotification(botId: string, taskId: string, rowVersion: number): void {
    const key = `capacity:${taskId}:${rowVersion}`;
    const previous = this.db.prepare(`SELECT count(*) FILTER (WHERE id=?) AS sameId, count(*) FILTER (WHERE state IN ('pending','blocked')
      AND attempts=0 AND json_extract(payload,'$.messageId') IS NULL) AS unsent FROM outbox
      WHERE kind='manager.notify' AND taskId=? AND json_extract(payload,'$.botId')=?
        AND id GLOB 'manager-event:capacity:' || taskId || ':*'`).get(`manager-event:${key}`, taskId, botId);
    if (previous?.unsent) return;
    // Keep any earlier wake receipt and its row version before the optional suffix for reconciliation.
    this.enqueueManager(botId, previous?.sameId ? `${key}:${randomUUID()}` : key,
      '等待此 Bot 的执行名额：名额可用后再次核对任务并派发。', taskId);
  }
  reserveRun(requestId:string,taskId:string,expectedRowVersion:number,expectedModel?:WorkerModelPlan):Run {
    return this.command(requestId,'task.dispatch',{taskId,expectedRowVersion},()=>{
      const task=this.getTask(taskId);const b=this.activeBinding(taskId);
      if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后再执行。');
      if(task.status==='blocked')throw new AppError('work-blocked','已记录上一轮阻塞。请先核对具体前置或保存明确的后续指示。');
      const previous=this.latestRun(taskId);
      const work=previous?.taskRevision===task.taskRevision&&previous.bindingId===b?.id
        ?this.recoveryWorkPlan(previous.id):null;
      const next=this.allocateRun(task,b,false,expectedModel);
      if(work)this.set(`recovery-work:${next.id}`,JSON.stringify(work));
      return next;
    });
  }
  private allocateRun(task:Task,b:Binding|null,recovering:boolean,expectedModel?:WorkerModelPlan,instruction?:RecoveryInstruction,transferSlot=false):Run {
    const taskId=task.id;
    this.assertNoTaskClose(taskId);
    if(task.lifecycle!=='open'||task.controlMode!=='auto'||!task.scope||!task.acceptance)throw new AppError('not-ready','任务当前不能自动执行，请核对目标和管理方式。');
    if(!b||b.state!=='ready'||!b.sessionId)throw new AppError('not-ready','请先准备执行会话。');
    if(this.db.prepare("SELECT 1 FROM attentions WHERE taskId=? AND state='open'").get(taskId))throw new AppError('needs-attention','请先处理当前待办。');
    if(this.db.prepare('SELECT 1 FROM runs r JOIN resources q ON q.runId=r.id WHERE r.taskId=?').get(taskId))throw new AppError('run-active','这个任务的上次执行尚未收敛。');
    const wait=transferSlot?null:this.dispatchWaitForBot(taskId,task.botId);
    if(wait)throw new AppError(wait.code,'此 Bot 的执行名额已占用，请等待或核对已有执行。');
    const previous=this.latestRun(taskId);
    const previousStage=previous&&previous.bindingId===b.id?this.currentStage(task,previous):null;
    const stage=recovering?null:previousStage;
    if(stage&&(stage.state!=='ready'||this.stageOwnerFollowUp(task,previous!)||
      stage.deadlineAt!==undefined&&stage.deadlineAt<=Date.now())) {
      throw new AppError('stage-pending','请先核对阶段前置或待处理的用户指示。');
    }
    const pending=this.pendingInput(taskId);
    if(recovering&&pending&&(pending.messageId!==null||pending.messageJson!==null||
      this.db.prepare("SELECT 1 FROM outbox WHERE id=? AND state!='pending'").get(`input:${pending.id}`))) {
      throw new AppError('input-uncertain','已有任务输入的投递状态无法确认，请先核对该输入。');
    }
    this.db.prepare('DELETE FROM waits WHERE taskId=?').run(taskId);
    const id=randomUUID(),inputId=pending?.id??randomUUID(),now=Date.now();
    if(stage&&pending)throw new AppError('needs-attention','有待处理的用户输入，请先核对阶段和用户指示。');
    const stageEvidence=stage&&{
      phase:stage.name, source:stage.evidenceRef, summary:stage.summary, checks:stage.checks, observation:stage.observation,
    };
    const supplement=stage?this.stageSupplement(taskId,stage.runId):null;
    const notes=supplement?.directions?.map(direction=>({text:direction.source.text,scope:direction.mode}));
    const release=stage&&this.gitLabReleaseForStage(stage.runId);
    const stageInput=stage?`Continue the authorized next stage: ${stage.nextStep}\nAuthorized scope: ${task.scope}\nPrior stage evidence: ${JSON.stringify(stageEvidence)}`+
      (release?'\nCall super_bot_gitlab_play with no arguments. The host records and reports the exact job outcome.':'')+
      (notes?.length?`\nOwner additions for this stage, in order and within their own stated scope: ${JSON.stringify(notes)}`:''):null;
    if(!pending)this.db.prepare('INSERT INTO inputs(id,taskId,kind,content,createdAt) VALUES (?,?,?,?,?)')
      .run(inputId,taskId,stage?'stage':instruction?'continuation':'dispatch',stageInput??instruction?.source.text??task.goal,now);
    this.db.prepare('INSERT INTO runs(id,taskId,bindingId,sessionId,taskRevision,generation,inputId,state,createdAt) VALUES (?,?,?,?,?,?,?,?,?)').run(id,taskId,b.id,b.sessionId,task.taskRevision,b.generation,inputId,'queued',now);
    this.db.prepare('INSERT INTO run_turns(runId) VALUES (?)').run(id);
    if(expectedModel)this.set(`run-model-plan:${id}`,JSON.stringify(expectedModel));
    this.db.prepare('INSERT INTO resources(runId) VALUES (?)').run(id);
    this.db.prepare('INSERT INTO outbox(id,kind,taskId,payload,createdAt) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(`input:${inputId}`,'input.deliver',taskId,JSON.stringify({runId:id,inputId,dispatchRowVersion:task.rowVersion}),now);
    this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(now,taskId);
    if(stage) {
      this.db.prepare("UPDATE work_stages SET state='dispatched',details=json_set(details,'$.dispatchedRunId',?) WHERE runId=? AND state='ready'")
        .run(id,stage.runId);
      this.settleManagerEvent(`manager-event:${stageReadyKey(stage)}`);
      if(supplement)this.writeRecoveryInstruction(taskId,{...supplement,runId:id});
      this.event('stage.dispatched',task.id,{priorRunId:stage.runId,runId:id,directionIds:supplement?.directions?.map(item=>item.id)});
    }else if(previousStage) {
      this.supersedeStage(previousStage);
    }
    this.event('run.queued',taskId,{runId:id,inputId});return this.getRun(id);
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
    this.command(`enqueued:${id}`,'input.enqueued',{id},()=>{
      const run=this.getRun(id),task=this.getTask(run.taskId);
      this.db.prepare("UPDATE inputs SET state='enqueued' WHERE id=? AND state='accepted'").run(run.inputId);
      const receipt=this.db.prepare("SELECT json_extract(payload,'$.dispatchRowVersion') AS dispatchRowVersion FROM outbox WHERE id=?").get(`input:${run.inputId}`);
      this.db.prepare("UPDATE outbox SET state='done' WHERE id IN (?,?)").run(`input:${run.inputId}`,`run:${id}`);
      // An already sent notice still needs its own Manager receipt or recovery.
      if(run.finishedAt===null)this.db.prepare(`UPDATE outbox SET state='done',payload=json_set(payload,'$.fulfilledByRunId',?)
        WHERE kind='manager.notify' AND taskId=? AND id GLOB 'manager-event:capacity:' || taskId || ':*'
          AND json_extract(payload,'$.botId')=? AND state IN ('pending','blocked') AND attempts=0
          AND json_extract(payload,'$.messageId') IS NULL
          AND coalesce(CAST(substr(id,length('manager-event:capacity:' || taskId || ':')+1) AS INTEGER)<=?,createdAt<?)`)
        .run(id,task.id,task.botId,receipt?.dispatchRowVersion??null,run.createdAt);
      return {};
    });
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
  runRecovery(id:string,note:string,notify=true):void {
    if(this.getRun(id).finishedAt!==null)return;
    this.command(`recovery:${id}`,'run.recovery',{id,note},()=>{
      const run=this.getRun(id);if(run.finishedAt!==null)return {};
      this.db.prepare("UPDATE runs SET state='interrupted',finishedAt=?,note=? WHERE id=?").run(Date.now(),note,id);
      this.db.prepare("UPDATE inputs SET state='unknown' WHERE id=? AND state!='entered'").run(run.inputId);
      if(this.isBotDeleted(this.getTask(run.taskId).botId)) {
        this.event('run.recovery',run.taskId,{runId:id,note});return {};
      }
      this.db.prepare("UPDATE attentions SET state='stale' WHERE taskId=? AND kind='approval' AND state='open'").run(run.taskId);
      const late=this.lateJobRecovery(id);
      this.db.prepare('INSERT OR IGNORE INTO attentions(id,taskId,kind,question,taskRevision,createdAt) VALUES (?,?,?,?,?,?)')
        .run(`run:${id}`,run.taskId,'recovery',late?JOB_RECOVERY_WAIT:note,run.taskRevision,Date.now());
      if(!this.taskClose(run.taskId)) {
        const botId=this.getTask(run.taskId).botId;
        if(late)this.enqueueManager(botId,`late-job-waiting:${id}`,JOB_RECOVERY_WAIT,run.taskId,10);
        else if(notify)this.enqueueManager(botId,`recovery:${id}`,`执行待核对：${note} 不会自动重投旧任务。`,run.taskId,10);
      }
      this.event('run.recovery',run.taskId,{runId:id,note});return {};
    });
  }
  nativeApprovalAsked(runId:string,requestId:string,toolName:string,reason:string):void {
    this.command(`approval-asked:${requestId}`,'approval.asked',{runId,requestId,toolName,reason},()=>{
      const run=this.getRun(runId);if(run.finishedAt!==null||this.isBotDeleted(this.getTask(run.taskId).botId))return {};
      this.db.prepare('INSERT OR IGNORE INTO attentions(id,taskId,kind,question,taskRevision,state,createdAt) VALUES (?,?,?,?,?,?,?)').run(`approval:${requestId}`,run.taskId,'approval',`原生工具 ${toolName} 等待审批。${reason?`\n${reason}`:''}\n请打开任务会话处理；工作台不代替原生批准或拒绝。`,run.taskRevision,'open',Date.now());
      this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(Date.now(),run.taskId);
      this.enqueueManager(this.getTask(run.taskId).botId,`approval:${requestId}`,`原生工具 ${toolName} 等待审批。请打开原生任务会话 ${run.sessionId} 处理批准或拒绝；Bot 和工作台不能代替原生审批。执行仍占用资源，不要再次派发。`,run.taskId,10);
      this.event('approval.asked',run.taskId,{runId,requestId,toolName});return {};
    });
  }
  nativeApprovalDecided(sessionId:string,requestId:string,outcome:string):void {
    const attention=this.db.prepare('SELECT * FROM attentions WHERE id=?').get(`approval:${requestId}`) as unknown as Attention|undefined;
    if(!attention||this.activeBinding(attention.taskId)?.sessionId!==sessionId)return;
    this.command(`approval-decided:${requestId}`,'approval.decided',{sessionId,requestId,outcome},()=>{
      // A decision does not settle the Run or prove the requested effect has finished.
      this.db.prepare("UPDATE attentions SET state='resolved' WHERE id=? AND state IN ('open','stale')").run(attention.id);
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
  resultAttachment(resultId: string, fileIndex: number): Uint8Array | undefined {
    const row = this.db.prepare('SELECT data FROM result_attachments WHERE resultId=? AND fileIndex=?')
      .get(resultId, fileIndex) as { data: Uint8Array } | undefined;
    return row?.data;
  }
  workerReportReceipt(runId:string,callId:string,report:WorkReport):{accepted:true;resultId?:string}|undefined {
    const row=this.db.prepare('SELECT data FROM reports WHERE id=?').get(`${runId}:${callId}`) as {data:string}|undefined;
    const saved=row?JSON.parse(row.data) as WorkReport:undefined;
    const payload=workerReportPayload(runId,callId,report,saved?.evidence??[]);
    if(!row)return;
    return this.commandReceipt(`report:${runId}:${callId}`,'worker.report',payload);
  }
  workerReport(runId:string,callId:string,report:WorkReport,captured?:readonly CapturedEvidence[]):{accepted:true;resultId?:string} {
    const evidence = captured?.map(({file})=>file) ?? report.evidence ?? [];
    const payload=workerReportPayload(runId,callId,report,evidence),{summary}=payload;
    if(report.kind==='ready'&&(!payload.checks||payload.evidence.length===0||(report.requestedFiles&&!captured))) {
      throw new AppError('evidence-required','提交成果必须有验收说明和文件证据。');
    }
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
      if (captured) {
        const insert = this.db.prepare('INSERT INTO result_attachments(resultId,fileIndex,data) VALUES (?,?,?)');
        captured.forEach(({data}, index) => insert.run(resultId, index, data));
      }
      return {accepted:true as const,resultId};
    });
    if(!outcome.accepted)throw new AppError('report-stale','当前执行或目标已改变，报告未成为当前成果。');
    return outcome;
  }
  settleRun(id:string,notify=true):void {
    if(this.getRun(id).finishedAt!==null)return;
    this.command(`settle:${id}`,'run.settle',{id},()=>{
      const run=this.getRun(id);const task=this.getTask(run.taskId);
      if(run.state==='cancelling')throw new AppError('stop-pending','停止意图尚待结算，不能补成功。');
      if(this.db.prepare("SELECT 1 FROM attentions WHERE taskId=? AND kind='approval' AND state='open'").get(task.id))throw new AppError('approval-pending','原生审批尚未得到结果，不能确认执行结束。');
      const last=this.db.prepare("SELECT kind,data FROM reports WHERE runId=? AND kind!='progress' ORDER BY createdAt DESC LIMIT 1").get(id) as {kind:WorkReport['kind'];data:string}|undefined;
      if(!last||this.getRunInput(id).state!=='entered'||task.controlMode==='manual')throw new AppError('no-result','执行已空闲，但没有可确认的最终报告。');
      const report=JSON.parse(last.data) as WorkReport;const failed=last.kind==='blocked'||last.kind==='failed';
      this.db.prepare('UPDATE runs SET state=?,finishedAt=?,note=? WHERE id=?').run(failed?'failed':'settled',Date.now(),report.summary,id);
      this.db.prepare('DELETE FROM resources WHERE runId=?').run(id);
      const direction=this.recoveryInstruction(task.id);
      const pending=!!direction?.mode&&!direction.runId&&direction.priorRunId===run.id&&direction.taskRevision===task.taskRevision&&
        this.botForSession(direction.source.sessionId)?.id===task.botId;
      if(pending&&!failed) {
        // Preserve the report and any candidate. A newer owner direction arrived before this attempt ended.
        this.set(`run-verified-end:${id}`,JSON.stringify({supersededBy:direction.id}));
        this.db.prepare("UPDATE tasks SET lifecycle='open',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(Date.now(),task.id);
        this.enqueueManager(task.botId,`continuation:${direction.id}:settled`,'上一轮已结束，请处理已保存的用户指示。',task.id,10);
        this.event('run.settled',task.id,{runId:id,kind:last.kind,supersededBy:direction.id});
        return {};
      }
      if(last.kind==='stage') {
        this.settleStage(run,task,report);
        this.event('run.settled',task.id,{runId:id,kind:last.kind});
        return {};
      }
      const kind=last.kind==='ready'?'review':last.kind==='waiting'?'input':'recovery';
      this.db.prepare('INSERT OR IGNORE INTO attentions(id,taskId,kind,question,taskRevision,createdAt) VALUES (?,?,?,?,?,?)').run(`run:${id}`,run.taskId,kind,last.kind==='ready'?'成果与执行已核对，请检查证据并验收。':report.summary,run.taskRevision,Date.now());
      this.db.prepare('UPDATE tasks SET lifecycle=?,rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(last.kind==='ready'?'review':'open',Date.now(),run.taskId);
      if(!notify){
        if(!failed)this.db.prepare("UPDATE tasks SET controlMode='paused' WHERE id=?").run(run.taskId);
        this.event('run.reconciled',run.taskId,{runId:id});
      }
      if(notify)this.enqueueManager(task.botId,`settled:${id}`,`执行已结束，报告类型 ${last.kind}。请读当前账本和成果，不要重放旧输入。`,task.id);
      else if(failed&&this.runTurn(id)?.quiet===1) {
        // The restarted process can verify this attempt, but still must reconcile newer input.
        this.enqueueManager(task.botId,`settled:${id}`,`执行已结束，报告类型 ${last.kind}。请读当前账本核对阻塞。`,task.id);
      }
      this.event('run.settled',run.taskId,{runId:id,kind:last.kind});return {};
    });
  }
  gitLabTaskAuthorization(taskId:string,reference:string):ReleaseAuthorization|null {
    const task=this.getTask(taskId);
    if(task.taskRevision!==1)return null;
    const row=this.db.prepare("SELECT data FROM events WHERE taskId=? AND kind='task.created' ORDER BY id LIMIT 1").get(taskId);
    if(!row)return null;
    const {source,release}=JSON.parse(String(row.data));
    return source&&release?.reference===reference?{source,intent:'publish',jobName:release.jobName,requiresJobName:release.requiresJobName}:null;
  }
  private saveGitLabRelease(task:Task,stage:WorkStage,condition:StageCondition|undefined,authorization:ReleaseAuthorization):void {
    const {source,jobName,intent,selection}=authorization;
    const prior=this.gitLabReleaseDetail(task);
    const canRetry=intent==='retry'&&prior?.state==='needs-permission'&&stage.evidenceRef===prior.url;
    const earlierAuthorization=canRetry&&this.gitLabReleaseForStage(prior.stageRunId);
    const checked=earlierAuthorization?earlierAuthorization.condition:exactMergeReference(stage.evidenceRef);
    const previous=this.gitLabReleaseForStage(stage.runId);
    const chosen=intent==='select'&&selection&&previous?.source.sessionId===source.sessionId&&previous.source.seq<source.seq&&
      selection.observedAt===stage.observation?.at&&selection.target.name===jobName&&
      stage.observation.releaseChoices?.some(option=>JSON.stringify(option)===JSON.stringify(selection.target))?selection.target:undefined;
    if(!condition||condition.kind!=='gitlab-merge'||
      this.botForSession(source.sessionId)?.id!==task.botId||
      !checked||JSON.stringify(checked)!==JSON.stringify(condition)||
      !(intent==='publish'||intent==='clarify'&&!jobName||chosen||earlierAuthorization)) {
      throw new AppError('gitlab-release-scope','需要当前任务的可信 GitLab MR 引用和原聊天中明确的发布授权。若意图不清楚，请在原聊天点明该合并请求并询问是否执行发布。');
    }
    const subjects=[...source.text.matchAll(/!(\d+)\b/g)].map(match=>Number(match[1]));
    const urls=mergeReferences(source.text);
    if((subjects.length>0&&!subjects.includes(condition.number))||
      (urls.length>0&&!urls.some(item=>JSON.stringify(item)===JSON.stringify(condition)))) {
      throw new AppError('gitlab-release-scope','用户指令中的合并请求与此阶段不匹配。');
    }
    if(prior&&!['needs-permission','unsubmitted'].includes(prior.state)) {
      throw new AppError('gitlab-release-tracked','此任务已登记正式作业。请读取该作业的已核对状态。');
    }
    const requiresJobName=intent==='clarify'||authorization.requiresJobName===true||previous?.requiresJobName===true;
    if(prior&&(JSON.stringify(prior.condition??this.gitLabReleaseForStage(prior.stageRunId)?.condition)!==JSON.stringify(condition)||
      jobName&&jobName!==prior.target.name)) throw new AppError('gitlab-release-tracked','请继续核对已登记的同一作业。');
    const boundTarget=chosen??(intent==='clarify'?undefined:prior?.target);
    const plan={source,jobName,requiresJobName,condition,
      ...(boundTarget?{retryTarget:boundTarget}:{})};
    this.db.prepare(`INSERT INTO gitlab_release_plans VALUES (?,?)
      ON CONFLICT(stageRunId) DO UPDATE SET authorization=excluded.authorization`).run(stage.runId,JSON.stringify(plan));
  }
  private clearGitLabReleasePlan(stageRunId:string):void {
    this.db.prepare('DELETE FROM gitlab_release_plans WHERE stageRunId=? AND NOT EXISTS (SELECT 1 FROM gitlab_release_receipts WHERE stageRunId=?)')
      .run(stageRunId,stageRunId);
  }
  gitLabReleaseForStage(stageRunId:string):(ReleasePlan&{ source:ChatSource; condition:StageCondition; retryTarget?:ReleaseTarget })|null {
    const row=this.db.prepare('SELECT authorization FROM gitlab_release_plans WHERE stageRunId=?').get(stageRunId);
    return row?JSON.parse(String(row.authorization)):null;
  }
  gitLabReleaseForRun(run:Run) {
    const row=this.db.prepare(`SELECT s.runId,s.details FROM work_stages s JOIN gitlab_release_plans p ON p.stageRunId=s.runId
      WHERE s.taskId=? AND s.taskRevision=? AND s.state='dispatched' AND json_extract(s.details,'$.dispatchedRunId')=?`)
      .get(run.taskId,run.taskRevision,run.id);
    const stage=row?JSON.parse(String(row.details)) as WorkStage:null;
    const plan=stage&&this.gitLabReleaseForStage(stage.runId);
    const target=stage?.observation?.releaseJob;
    return stage&&plan&&target?{ stage,plan,target }:null;
  }
  private gitLabReleaseDetail(task:Task):ReleaseReceipt|null {
    const row=this.db.prepare(`SELECT r.snapshot FROM gitlab_release_receipts r JOIN work_stages s ON s.runId=r.stageRunId
      WHERE r.taskId=? AND s.taskRevision=? ORDER BY r.rowid DESC LIMIT 1`).get(task.id,task.taskRevision);
    return row?JSON.parse(String(row.snapshot)):null;
  }
  gitLabReleaseReceipt(stageRunId:string):ReleaseReceipt|null {
    const row=this.db.prepare('SELECT snapshot FROM gitlab_release_receipts WHERE stageRunId=?').get(stageRunId);
    return row?JSON.parse(String(row.snapshot)):null;
  }
  private releaseRunTarget(runId:string) {
    const run=this.getRun(runId),task=this.getTask(run.taskId),binding=this.activeBinding(task.id);
    const action=this.gitLabReleaseForRun(run);
    const direction=this.recoveryInstruction(task.id);
    this.assertNoTaskClose(task.id);
    if(!action||task.lifecycle!=='open'||task.controlMode!=='auto'||task.taskRevision!==run.taskRevision||
      run.state!=='running'||this.latestRun(task.id)?.id!==runId||this.isBotDeleted(task.botId)||
      binding?.state!=='ready'||binding.id!==run.bindingId||binding.generation!==run.generation||
      this.botForSession(action.plan.source.sessionId)?.id!==task.botId||
      (direction&&direction.stageRunId!==action.stage.runId&&direction.source.seq>action.plan.source.seq&&
        (direction.mode==='read-only'||!!direction.change))||this.finalReport(runId)) {
      throw new AppError('gitlab-release-stale','正式作业的任务版本、执行或授权已改变。');
    }
    return {run,task,...action};
  }
  beginGitLabRelease(runId:string,now=Date.now()):ReleaseReceipt {
    const first=this.command(`gitlab-release-begin:${runId}`,'gitlab-release.begin',{runId},()=>{
      const {run,task,stage,target,plan}=this.releaseRunTarget(runId);
      const previous=this.gitLabReleaseDetail(task);
      const restoredAt=Number(this.get('restoredAt')??0);
      const previousClaim=this.db.prepare('SELECT 1 FROM gitlab_release_claims WHERE target=?').get(releaseKey(target));
      const readback=!!previousClaim||restoredAt>=stage.at||
        !!previous&&releaseKey(previous.target)===releaseKey(target)&&!['needs-permission','unsubmitted'].includes(previous.state);
      const deadlineAt=previous?.state==='unsubmitted'&&releaseKey(previous.target)===releaseKey(target)
        ?previous.deadlineAt:now+RELEASE_WAIT_MS;
      const receipt:ReleaseReceipt={taskId:task.id,runId:run.id,stageRunId:stage.runId,target,condition:plan.condition,
        state:readback?'unknown':'unsubmitted',status:stage.observation?.stateLabel,
        detail:readback?'已存在执行认领或恢复记录，继续核对原作业。':'已核对确切发布作业。',
        url:releaseUrl(target),nextCheckAt:readback?now:null,deadlineAt};
      this.db.prepare('INSERT INTO gitlab_release_receipts VALUES (?,?,?,?,?)')
        .run(stage.runId,run.id,task.id,JSON.stringify(receipt),receipt.nextCheckAt);
      return receipt;
    });
    return this.gitLabReleaseReceipt(first.stageRunId)??first;
  }
  claimGitLabRelease(runId:string,now=Date.now()):boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const {stage,target,task}=this.releaseRunTarget(runId);
      const receipt=this.gitLabReleaseReceipt(stage.runId);
      let granted=false;
      if(receipt?.runId===runId&&receipt.state==='unsubmitted'&&receipt.status==='manual'&&receipt.deadlineAt>now&&
        !this.db.prepare('SELECT 1 FROM gitlab_release_claims WHERE target=?').get(releaseKey(target))) {
        this.db.prepare('INSERT INTO gitlab_release_claims VALUES (?,?,?)').run(releaseKey(target),runId,now);
        this.writeGitLabRelease({...receipt,state:'claim-pending',detail:'正式入口已认领，等待同一作业回执。',
          nextCheckAt:Math.min(now+RELEASE_CHECK_MS,receipt.deadlineAt)});
        this.event('gitlab-release.claimed',task.id,{runId,target});
        granted=true;
      }
      this.db.exec('COMMIT');return granted;
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  private writeGitLabRelease(receipt:ReleaseReceipt):void {
    this.db.prepare('UPDATE gitlab_release_receipts SET snapshot=?,nextCheckAt=? WHERE stageRunId=?')
      .run(JSON.stringify(receipt),receipt.nextCheckAt,receipt.stageRunId);
  }
  dueGitLabReleases(limit:number,now=Date.now()):ReleaseReceipt[] {
    return this.db.prepare(`SELECT r.snapshot FROM gitlab_release_receipts r JOIN work_stages s ON s.runId=r.stageRunId
      JOIN tasks t ON t.id=r.taskId AND t.taskRevision=s.taskRevision AND t.lifecycle='open' AND t.controlMode='auto'
      JOIN bots ON bots.id=t.botId AND bots.deletedAt IS NULL
      WHERE r.nextCheckAt<=? ORDER BY r.nextCheckAt,r.stageRunId LIMIT ?`).all(now,limit)
      .map(row=>JSON.parse(String(row.snapshot)) as ReleaseReceipt);
  }
  private scheduleUnsubmittedGitLabRelease(previous:ReleaseReceipt,task:Task,now:number):boolean {
    const run=this.latestRun(task.id);
    const stage=run&&this.currentStage(task,run);
    const plan=this.gitLabReleaseForStage(previous.stageRunId);
    if(!run||run.id!==previous.runId||run.state!=='settled'||this.runTurn(run.id)?.quiet!==1||
      !stage||stage.state!=='awaiting-decision'||stage.evidenceRef!==previous.url||!plan||
      this.botForSession(plan.source.sessionId)?.id!==task.botId||this.stageOwnerFollowUp(task,run)||
      this.activeBinding(task.id)?.id!==run.bindingId||this.taskClose(task.id))return false;
    const opened=this.db.prepare("SELECT json_extract(details,'$.releaseOpenedAt') AS at FROM work_stages WHERE runId=?").get(previous.stageRunId)?.at;
    const details:WorkStage={...stage,state:'ready',nextStep:'运行已授权的同一 GitLab 作业',
      condition:plan.condition,observation:{state:'satisfied',stateLabel:'manual',url:previous.url,
        releaseJob:previous.target,detail:'已恢复读取，同一作业处于 manual，正式入口尚未认领。',at:now},
      deadlineAt:previous.deadlineAt,...(typeof opened==='number'?{releaseOpenedAt:opened}:{})};
    this.db.prepare('INSERT INTO gitlab_release_plans VALUES (?,?)')
      .run(run.id,JSON.stringify({...plan,retryTarget:previous.target}));
    this.db.prepare("UPDATE work_stages SET state='ready',details=?,observerOrigin=? WHERE runId=?")
      .run(JSON.stringify(details),previous.target.origin,run.id);
    this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(now,task.id);
    this.enqueueStageReady(task.botId,task.id,details);
    this.event('gitlab-release.preclaim-resumed',task.id,{runId:run.id,target:previous.target});
    return true;
  }
  recordGitLabRelease(previous:ReleaseReceipt,next:ReleaseReceipt,fromWorker=false,formalDenial=false):ReleaseReceipt {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current=this.gitLabReleaseReceipt(previous.stageRunId);
      const task=this.getTask(previous.taskId);
      // The Worker can record a response to a request it already made. Background
      // observations that return after pause, takeover or replan are discarded.
      const fresh=this.getRun(previous.runId).taskRevision===task.taskRevision&&
        task.lifecycle==='open'&&task.controlMode==='auto'&&!this.isBotDeleted(task.botId);
      if(!current||JSON.stringify(current)!==JSON.stringify(previous)||!fromWorker&&!fresh) {
        this.db.exec('COMMIT');return current??previous;
      }
      if(!fromWorker&&current.state==='unsubmitted'&&next.state==='unsubmitted'&&next.nextCheckAt===null&&next.status==='manual') {
        const now=Date.now(), checkAt=Math.min(now+RELEASE_CHECK_MS,next.deadlineAt);
        const claimed=this.db.prepare('SELECT 1 FROM gitlab_release_claims WHERE target=?').get(releaseKey(current.target));
        if(claimed)next={...next,state:'unknown',nextCheckAt:checkAt,detail:'该作业已有正式认领。将继续只读核对同一作业。'};
        else if(!this.scheduleUnsubmittedGitLabRelease(current,task,now))next={...next,nextCheckAt:checkAt};
      }
      const changed=current.state!==next.state||current.status!==next.status||
        current.state==='unsubmitted'&&current.nextCheckAt===null&&next.nextCheckAt!==null;
      this.writeGitLabRelease(next);
      if(formalDenial&&current.state==='claim-pending'&&next.state==='needs-permission') {
        this.db.prepare('DELETE FROM gitlab_release_claims WHERE target=? AND runId=?').run(releaseKey(current.target),current.runId);
      }
      if(changed) {
        this.event('gitlab-release.observed',task.id,{runId:next.runId,state:next.state,status:next.status,url:next.url});
        if(fresh&&next.state!=='claim-pending') this.enqueueManager(task.botId,
          `gitlab-release:${next.stageRunId}:${next.state}:${next.status??'unconfirmed'}`,`${next.detail}\n${next.url}`,task.id,9);
      }
      this.db.exec('COMMIT');return next;
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  private currentStage(task:Task,run:Run):WorkStage|null {
    if(run.taskRevision!==task.taskRevision||run.sessionId!==task.sessionId||run.finishedAt===null)return null;
    const row=this.db.prepare('SELECT state,details FROM work_stages WHERE runId=?').get(run.id);
    return row?{...JSON.parse(String(row.details)),state:row.state}:null;
  }
  taskStage(task:Task):WorkStage|null {
    const run=this.latestRun(task.id);
    return run?this.currentStage(task,run):null;
  }
  private stageHistory(task:Task):WorkStage[] {
    return this.db.prepare(`SELECT s.state,s.details FROM work_stages s JOIN runs r ON r.id=s.runId
      WHERE s.taskId=? AND s.taskRevision=? ORDER BY r.rowid DESC LIMIT 10`)
      .all(task.id,task.taskRevision).map(row=>({...JSON.parse(String(row.details)),state:row.state} as WorkStage));
  }
  private stageOwnerFollowUp(task:Task,run:Run):boolean {
    const instruction=this.recoveryInstruction(task.id);
    return !!instruction?.mode&&!instruction.runId&&instruction.taskRevision===task.taskRevision&&
      instruction.priorRunId===run.id&&instruction.stageRunId!==run.id;
  }
  stageSupplement(taskId:string,runId:string):RecoveryInstruction|null {
    const instruction=this.recoveryInstruction(taskId);
    return instruction?.stageRunId===runId&&!instruction.runId?instruction:null;
  }
  private supersedeStage(stage:WorkStage):void {
    this.db.prepare("UPDATE work_stages SET state='superseded',nextCheckAt=NULL WHERE runId=? AND state!='dispatched'").run(stage.runId);
    this.settleManagerEvent(`manager-event:${stageReadyKey(stage)}`);
    this.settleManagerEvent(`manager-event:stage-unavailable:${stage.runId}:${stage.planVersion??0}`);
  }
  private settleStage(run:Run,task:Task,report:WorkReport):void {
    const name=report.stage!, evidenceRef=report.evidenceRef!, checks=report.checks!, now=Date.now();
    const fingerprint=createHash('sha256').update(JSON.stringify([evidenceRef,checks.replace(/\s+/gu,' ')])).digest('hex');
    const repeated=this.db.prepare(`SELECT 1 FROM work_stages WHERE taskId=? AND taskRevision=?
      AND json_extract(details,'$.fingerprint')=? LIMIT 1`).get(task.id,task.taskRevision,fingerprint);
    const reason=repeated?'此证据和核对结果已登记。请核对真正的新进展或处理阻塞。':undefined;
    this.db.prepare('INSERT INTO work_stages(runId,taskId,taskRevision,state,details) VALUES (?,?,?,?,?)')
      .run(run.id,task.id,run.taskRevision,repeated?'blocked':'awaiting-decision',
        JSON.stringify({runId:run.id,name,evidenceRef,summary:report.summary,checks,fingerprint,reason,at:now}));
    this.set(`run-verified-end:${run.id}`,JSON.stringify({stage:true}));
    this.db.prepare("UPDATE tasks SET lifecycle='open',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(now,task.id);
    const formal=this.gitLabReleaseForRun(run);
    if(!formal||!this.gitLabReleaseReceipt(formal.stage.runId)) {
      this.enqueueManager(task.botId,`stage-settled:${run.id}`,'已记录阶段进展，任务仍未完成。请读取阶段证据与目标。',task.id,8);
    }
  }
  private stageDecisionTarget(botId:string,taskId:string,version:number,runId:string,replacing=false) {
    const task=this.getTask(taskId),run=this.latestRun(taskId),binding=this.activeBinding(taskId);
    const stage=run?.id===runId?this.currentStage(task,run):null;
    if(task.botId!==botId||task.rowVersion!==version||task.controlMode!=='auto'||task.lifecycle!=='open'||
      !run||!stage||binding?.state!=='ready'||binding.id!==run.bindingId||binding.generation!==run.generation||
      !replacing&&this.stageOwnerFollowUp(task,run)||
      this.db.prepare("SELECT 1 FROM attentions WHERE taskId=? AND state='open'").get(taskId)) {
      throw new AppError('stage-stale','阶段、任务版本或执行授权已改变。请核对原任务。');
    }
    return {task,stage};
  }
  advanceStage(requestId:string,botId:string,taskId:string,version:number,runId:string,step:unknown,dependency:unknown,
    origin:string|null,ownerRetry=false,options?:{source?:ChatSource;release?:ReleaseAuthorization}) {
    const nextStep=requiredText(step,'已授权的具体下一步',3000),condition=readStageCondition(dependency);
    const observerOrigin=condition?.sourceOrigin??null;
    return this.command(requestId,'stage.advance',{botId,taskId,version,runId,nextStep,condition,origin,ownerRetry,options},()=>{
      const source=options?.source;
      const {task,stage}=this.stageDecisionTarget(botId,taskId,version,runId,!!source);
      if(source&&this.botForSession(source.sessionId)?.id!==botId)throw new AppError('manager-scope','只能在任务当前 Bot 对话替换阶段。');
      const retry=stage.state==='blocked'&&ownerRetry&&(stage.expired||stage.observation?.state==='unavailable')&&
        stage.nextStep===nextStep&&JSON.stringify(stage.condition)===JSON.stringify(condition);
      const releaseSelection=stage.state==='blocked'&&options?.release?.intent==='select'&&!!stage.observation?.releaseChoices?.length;
      const releaseDirected=stage.state==='blocked'&&options?.release?.intent==='publish'&&!!options.release.jobName;
      if(stage.state!=='awaiting-decision'&&!retry&&!source&&!releaseSelection&&!releaseDirected) {
        throw new AppError('stage-decided','此阶段已有处理决定。请读取当前任务。');
      }
      if(source&&['awaiting-decision','dispatched'].includes(stage.state)) {
        throw new AppError('stage-stale','当前阶段没有可替换的步骤，请核对任务。');
      }
      if(source) {
        requiredText(source.text,'用户指令原文',32_000);
        const priorInstruction=this.recoveryInstruction(taskId);
        const latest=Math.max(stage.planSource?.sessionId===source.sessionId?stage.planSource.seq:-1,
          priorInstruction?.source.sessionId===source.sessionId?priorInstruction.source.seq:-1);
        if(source.seq<=latest)throw new AppError('stage-stale','已保存该消息或更新的用户指示，请核对原任务。');
        if(priorInstruction&&!priorInstruction.runId&&priorInstruction.priorRunId===runId&&priorInstruction.taskRevision===task.taskRevision) {
          this.db.prepare('DELETE FROM metadata WHERE key=?').run(`recovery-instruction:${taskId}`);
          for(const suffix of ['',':settled',':restart'])this.settleManagerEvent(`manager-event:continuation:${priorInstruction.id}${suffix}`);
        }
      }
      const repeated=condition&&!options?.release&&this.db.prepare(`SELECT 1 FROM work_stages WHERE taskId=? AND taskRevision=? AND runId!=?
        AND json_extract(details,'$.condition')=? LIMIT 1`).get(taskId,task.taskRevision,runId,JSON.stringify(condition));
      const now=Date.now();
      const details:WorkStage={...stage,nextStep,condition,observation:undefined,reason:undefined,expired:undefined,
        releaseOpenedAt:JSON.stringify(stage.condition)===JSON.stringify(condition)?stage.releaseOpenedAt:undefined,
        deadlineAt:repeated?undefined:now+STAGE_WAIT_MS,
        ...(source||retry||releaseSelection||releaseDirected?{planVersion:task.rowVersion+1}:{}),...(source?{planSource:source}:{})};
      const decision:WorkStage['state']=repeated?'blocked':condition?'waiting':'ready';
      if(repeated)details.reason='已经核对过同一外部条件。请确认下一阶段需要的具体前提。';
      else if(condition&&condition.sourceOrigin!==origin) {
        details.reason=`本端正在核对 ${condition.sourceOrigin} 的可信只读来源。可用后会核对同一对象。`;
        details.observation={state:'unavailable',detail:details.reason,at:now};
      }
      this.settleManagerEvent(`manager-event:${stageReadyKey(stage)}`);
      this.settleManagerEvent(`manager-event:stage-unavailable:${stage.runId}:${stage.planVersion??0}`);
      this.db.prepare('DELETE FROM waits WHERE taskId=?').run(taskId);
      if(options?.release&&!repeated)this.saveGitLabRelease(task,stage,condition,options.release);
      else if(source)this.clearGitLabReleasePlan(runId);
      this.db.prepare('UPDATE work_stages SET state=?,details=?,nextCheckAt=?,failures=0,observerOrigin=? WHERE runId=?')
        .run(decision,JSON.stringify({...details,state:undefined}),decision==='waiting'?now:null,observerOrigin,runId);
      this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(now,taskId);
      this.event('stage.decided',taskId,{runId,nextStep,condition,state:decision,source});
      this.settleManagerEvent(`manager-event:stage-settled:${runId}`);
      if(decision==='ready')this.enqueueStageReady(botId,taskId,details);
      return {task:this.getTask(taskId),stage:{...details,state:decision}};
    });
  }
  blockStage(requestId:string,botId:string,taskId:string,version:number,runId:string,note:unknown) {
    const reason=requiredText(note,'阶段不能继续的具体原因',3000);
    return this.command(requestId,'stage.block',{botId,taskId,version,runId,reason},()=>{
      const {stage}=this.stageDecisionTarget(botId,taskId,version,runId);
      if(stage.state!=='awaiting-decision')throw new AppError('stage-decided','此阶段已有处理决定。请读取当前任务。');
      this.db.prepare("UPDATE work_stages SET state='blocked',details=json_set(details,'$.reason',?) WHERE runId=?").run(reason,runId);
      this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(Date.now(),taskId);
      this.event('stage.blocked',taskId,{runId,reason});
      this.settleManagerEvent(`manager-event:stage-settled:${runId}`);
      return {task:this.getTask(taskId),stage:{...stage,reason,state:'blocked' as const}};
    });
  }
  private enqueueStageReady(botId:string,taskId:string,stage:WorkStage) {
    this.recordWait(taskId);
    this.enqueueManager(botId,stageReadyKey(stage),'阶段之后的已授权下一步可以执行。请沿用同一 Task 和 Worker。',taskId,8);
  }
  superviseStages(now=Date.now()):void {
    const candidates=this.db.prepare(`SELECT s.runId,s.taskId FROM work_stages s
      JOIN tasks t ON t.id=s.taskId AND t.taskRevision=s.taskRevision AND t.lifecycle='open' AND t.controlMode='auto'
      JOIN bots ON bots.id=t.botId AND bots.deletedAt IS NULL
      JOIN runs r ON r.id=s.runId AND r.sessionId=t.sessionId AND r.finishedAt IS NOT NULL
      JOIN bindings b ON b.id=r.bindingId AND b.state='ready' AND b.sessionId=t.sessionId
      WHERE r.id=(SELECT id FROM runs WHERE taskId=t.id ORDER BY createdAt DESC,rowid DESC LIMIT 1) AND
        (s.state IN ('waiting','ready') AND coalesce(json_extract(s.details,'$.deadlineAt'),0)<=? OR
         s.state='blocked' AND json_extract(s.details,'$.observation.state')='unavailable'
          AND json_extract(s.details,'$.deadlineAt') IS NULL)
      ORDER BY coalesce(json_extract(s.details,'$.deadlineAt'),0),s.runId LIMIT 16`).all(now);
    for(const row of candidates) {
      const task=this.getTask(String(row.taskId)),run=this.latestRun(task.id)!;
      const stage=this.currentStage(task,run);
      if(!stage)continue;
      const deadlineAt=stage.deadlineAt??(stage.observation?.at??stage.at)+STAGE_WAIT_MS;
      this.command(`stage-supervise:${run.id}:${stage.planVersion??0}:${deadlineAt}:${stage.deadlineAt===undefined?'legacy':'expire'}`,
        'stage.supervise',{taskId:task.id,runId:run.id,deadlineAt},()=>{
          if(deadlineAt<=now&&stage.nextStep) {
            this.expireStage(task,{...stage,deadlineAt},now);
          }else if(stage.deadlineAt===undefined) {
            const legacyUnavailable=stage.state==='blocked'&&!!stage.condition;
            this.db.prepare(`UPDATE work_stages SET details=json_set(details,'$.deadlineAt',?),
              state=CASE WHEN ? THEN 'waiting' ELSE state END,
              nextCheckAt=CASE WHEN ? THEN ? ELSE nextCheckAt END,
              observerOrigin=coalesce(observerOrigin,?) WHERE runId=?`)
              .run(deadlineAt,Number(legacyUnavailable),Number(legacyUnavailable),now,stage.condition?.sourceOrigin??null,run.id);
          }
          return {};
        });
    }
  }
  private expireStage(task:Task,stage:WorkStage,now:number):void {
    const last=stage.observation?.detail?`最近一次核对：${stage.observation.detail}`:'';
    const reason=stage.state==='ready'
      ? this.dispatchBlocker(task.id)?'已到执行名额等待期限，原阶段下一步尚未派发。请确认是否继续等待。'
        :'已到接续派发期限，已保存的下一步仍未派出。请核对当前派发状态并确认是否继续。'
      : `已到外部条件核对期限，尚未确认 ${stage.condition?stageConditionText(stage.condition):'指定条件'}。${last}请确认是否继续跟踪。`;
    this.db.prepare("UPDATE work_stages SET state='blocked',details=?,nextCheckAt=NULL WHERE runId=?")
      .run(JSON.stringify({...stage,state:undefined,expired:true,reason}),stage.runId);
    this.settleManagerEvent(`manager-event:${stageReadyKey(stage)}`);
    this.settleManagerEvent(`manager-event:stage-unavailable:${stage.runId}:${stage.planVersion??0}`);
    this.db.prepare('DELETE FROM waits WHERE taskId=?').run(task.id);
    this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(now,task.id);
    this.event('stage.expired',task.id,{runId:stage.runId,deadlineAt:stage.deadlineAt,reason});
    this.enqueueManager(task.botId,`stage-blocked:${stage.runId}:${task.rowVersion}`,reason,task.id,8);
  }
  dueStages(limit:number,now=Date.now()):DueStage[] {
    return this.db.prepare(`SELECT s.runId,s.taskId,s.nextCheckAt AS checkAt,t.rowVersion,s.observerOrigin AS origin,
      json_extract(s.details,'$.condition') AS condition FROM work_stages s
      JOIN tasks t ON t.id=s.taskId AND t.taskRevision=s.taskRevision AND t.lifecycle='open' AND t.controlMode='auto'
      JOIN bots ON bots.id=t.botId AND bots.deletedAt IS NULL
      JOIN runs r ON r.id=s.runId AND r.sessionId=t.sessionId AND r.finishedAt IS NOT NULL
      JOIN bindings b ON b.id=r.bindingId AND b.state='ready' AND b.sessionId=t.sessionId
      WHERE s.state='waiting' AND s.nextCheckAt<=? AND s.observerOrigin IS NOT NULL
        AND coalesce(json_extract(s.details,'$.deadlineAt'),?)>=?
        AND r.id=(SELECT id FROM runs WHERE taskId=t.id ORDER BY createdAt DESC,rowid DESC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM metadata m WHERE m.key='recovery-instruction:' || t.id
          AND json_extract(m.value,'$.taskRevision')=t.taskRevision AND json_extract(m.value,'$.priorRunId')=r.id
          AND json_extract(m.value,'$.stageRunId') IS NOT r.id
          AND json_extract(m.value,'$.mode') IS NOT NULL AND json_extract(m.value,'$.runId') IS NULL)
      ORDER BY s.nextCheckAt,s.runId LIMIT ?`).all(now,now,now,limit)
      .map(row=>({...row,condition:JSON.parse(String(row.condition))} as DueStage));
  }
  recordStageObservation(due:DueStage,observation:StageObservation,now=Date.now()):void {
    const task=this.getTask(due.taskId),run=this.latestRun(due.taskId),binding=this.activeBinding(due.taskId);
    const stage=run?.id===due.runId?this.currentStage(task,run):null;
    const row=this.db.prepare('SELECT nextCheckAt,failures,observerOrigin FROM work_stages WHERE runId=?').get(due.runId);
    if(stage?.state!=='waiting'||!row||row.nextCheckAt!==due.checkAt||row.observerOrigin!==due.origin||
      JSON.stringify(stage.condition)!==JSON.stringify(due.condition)||
      task.rowVersion!==due.rowVersion||task.controlMode!=='auto'||task.lifecycle!=='open'||this.isBotDeleted(task.botId)||
      binding?.state!=='ready'||binding.id!==run?.bindingId||this.stageOwnerFollowUp(task,run))return;
    // No asynchronous work between the fresh checks and commit in this single-owner ledger.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(stage.deadlineAt!==undefined&&now>=stage.deadlineAt) {
        this.expireStage(task,stage,now);
        this.db.exec('COMMIT');return;
      }
      const failures=observation.state==='transient'||observation.state==='unavailable'?Number(row.failures)+1:0;
      const outcome:StageObservation=observation.state==='transient'&&failures>=5?{state:'unavailable',detail:
        `GitLab 连续读取暂不可用。最近一次核对：${observation.detail} 本端会在期限内低频重查指定对象。`}:observation;
      const state=outcome.state==='satisfied'?'ready':outcome.state==='unsatisfied'?'blocked':'waiting';
      const delay=outcome.state==='unavailable'?Math.min(5*60_000*failures,15*60_000)
        :STAGE_OBSERVE_MS*2**Math.min(Math.max(failures-1,0),4);
      const next=state==='waiting'?now+delay:null;
      const details:WorkStage={...stage,state,observation:{...outcome,at:now},
        ...(outcome.releaseMergeOpen?{releaseOpenedAt:stage.releaseOpenedAt??now}:{}),
        deadlineAt:state==='ready'?now+STAGE_WAIT_MS:stage.deadlineAt,
        reason:state==='blocked'||outcome.state==='unavailable'?outcome.detail:undefined};
      this.db.prepare('UPDATE work_stages SET state=?,details=?,nextCheckAt=?,failures=? WHERE runId=?')
        .run(state,JSON.stringify({...details,state:undefined}),next,failures,due.runId);
      if(stage.observation?.stateLabel!==outcome.stateLabel||stage.observation?.state!==outcome.state) {
        const {releaseChoices:_choices,...observed}=outcome;
        this.event('stage.observed',task.id,{runId:due.runId,condition:stage.condition,...observed});
      }
      const unavailableKey=`stage-unavailable:${stage.runId}:${stage.planVersion??0}`;
      if(outcome.state==='unavailable') {
        this.enqueueManager(task.botId,unavailableKey,
          `暂时无法核对外部条件：${stageConditionText(due.condition)}。请说明实际缺口和仍在跟踪的状态。`,task.id,8);
      }else this.settleManagerEvent(`manager-event:${unavailableKey}`);
      if(state!=='waiting') {
        this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(now,task.id);
        if(state==='ready')this.enqueueStageReady(task.botId,task.id,details);
        else this.enqueueManager(task.botId,`stage-blocked:${due.runId}:${due.rowVersion}`,
          `外部条件未满足或不可读：${stageConditionText(due.condition)}。请从任务详情说明当前事实。`,task.id,8);
      }
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  acceptResult(requestId:string,taskId:string,expectedRowVersion:number,resultId:string,source?:ChatSource):Task {
    return this.command(requestId,'result.accept',{taskId,expectedRowVersion,resultId,...(source?{source}:{})},()=>{
      const task=this.getTask(taskId);const run=this.latestRun(taskId);const result=run?this.runResult(run.id):null;
      if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后再验收。');
      this.assertNoTaskClose(taskId);
      if(task.lifecycle!=='review'||!result||result.id!==resultId||result.taskRevision!==task.taskRevision||run?.state!=='settled')throw new AppError('result-stale','当前成果不能验收，请重新核对。');
      if(this.db.prepare('SELECT 1 FROM resources WHERE runId=?').get(run.id)||this.db.prepare("SELECT 1 FROM attentions WHERE taskId=? AND state='open' AND kind!='review'").get(taskId))throw new AppError('needs-attention','还有执行或待办未处理。');
      const now=Date.now(),note=source?'用户在原对话接受当前成果':'用户检查当前证据后接受';
      this.db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?,?)').run(randomUUID(),resultId,'user','accepted',note,now);
      this.db.prepare('UPDATE results SET humanAcceptedAt=? WHERE id=?').run(now,resultId);
      this.db.prepare("UPDATE tasks SET lifecycle='completed',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(now,taskId);
      this.db.prepare("UPDATE attentions SET state='resolved' WHERE taskId=? AND state='open' AND kind='review'").run(taskId);
      this.event('result.accepted',taskId,{resultId,source});return this.getTask(taskId);
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
  requestStop(requestId:string,taskId:string,expectedRowVersion:number,expectedRunId?:string):{runId:string;requested:true} {
    return this.command(requestId,'task.stop',{taskId,expectedRowVersion,expectedRunId},()=>{
      const task=this.getTask(taskId);const run=this.latestRun(taskId);
      if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后再停止。');
      if(expectedRunId) {
        const binding=this.activeBinding(taskId);
        if(!run||run.id!==expectedRunId||binding?.state!=='ready'||binding.id!==run.bindingId||
          binding.sessionId!==run.sessionId||binding.generation!==run.generation||task.taskRevision!==run.taskRevision) {
          throw new AppError('run-stale','指定执行或会话关联已经改变，请重新读取任务。');
        }
        if(run.state==='cancelling')return {runId:run.id,requested:true};
      }
      if(!run||run.finishedAt!==null)throw new AppError('no-active-run','没有正在执行的尝试；未知状态请使用核对。');
      this.db.prepare("UPDATE tasks SET controlMode='paused',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(Date.now(),taskId);
      this.markRunStopping(run);
      return {runId:run.id,requested:true as const};
    });
  }
  private markRunStopping(run:Run):void {
    this.db.prepare("UPDATE runs SET state='cancelling' WHERE id=?").run(run.id);
    this.db.prepare("UPDATE outbox SET state='cancelled' WHERE id IN (?,?) AND state='pending'").run(`input:${run.inputId}`,`run:${run.id}`);
    this.event('run.stop-requested',run.taskId,{runId:run.id});
  }
  settleCancelled(id:string,notify=true):void {
    if(this.getRun(id).finishedAt!==null)return;
    this.command(`cancelled:${id}`,'run.cancelled',{id},()=>{
      const run=this.getRun(id);if(run.state!=='cancelling')throw new AppError('stop-not-requested','没有停止请求。');
      this.finishStoppedRun(run,notify);return {};
    });
  }
  private finishStoppedRun(run:Run,notify:boolean,unsent=false):void {
    const {id,taskId}=run;
    const budget=this.db.prepare("SELECT 1 FROM events WHERE kind='run.budget-reached' AND taskId=? AND json_extract(data,'$.runId')=?").get(taskId,id);
    this.db.prepare("UPDATE runs SET state='cancelled',finishedAt=?,note=? WHERE id=?").run(Date.now(),budget?run.note:'已核对停止',id);
    if(budget)this.db.prepare('INSERT OR IGNORE INTO attentions(id,taskId,kind,question,taskRevision,createdAt) VALUES (?,?,?,?,?,?)').run(`run:${id}`,taskId,'recovery',`${run.note} 已确认停止；不会自动重试。`,run.taskRevision,Date.now());
    this.db.prepare("UPDATE inputs SET state='discarded' WHERE id=? AND state!='entered'").run(run.inputId);
    this.db.prepare("UPDATE attentions SET state='stale' WHERE taskId=? AND kind='approval' AND state='open'").run(taskId);
    const input=this.getRunInput(id);if(input.attentionId&&input.state==='discarded')this.db.prepare("UPDATE attentions SET state='open' WHERE id=? AND state='responding'").run(input.attentionId);
    this.db.prepare('DELETE FROM resources WHERE runId=?').run(id);
    this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(Date.now(),taskId);
    if(budget&&notify)this.enqueueManager(this.getTask(taskId).botId,`budget-stopped:${id}`,`${run.note} 已确认停止；不会自动重试。请在任务详情检查进展并明确核对后再安排。`,taskId,10);
    this.event('run.cancelled',taskId,{runId:id,...(unsent?{unsent:true}:{})});
  }
  /** Chat can fill missing task essentials, never replace existing authorization or a goal. */
  completeTaskInput(requestId:string,taskId:string,attentionId:string,expectedRowVersion:number,input:{scope?:string;acceptance?:string},source:ChatSource):Task {
    const fields={...(input.scope!==undefined?{scope:requiredText(input.scope,'任务范围')}:{}),...(input.acceptance!==undefined?{acceptance:requiredText(input.acceptance,'验收条件')}:{})};
    return this.command(requestId,'task.complete-input',{taskId,attentionId,expectedRowVersion,...fields,source},()=>{
      const task=this.getTask(taskId),attention=this.db.prepare('SELECT * FROM attentions WHERE id=?').get(attentionId) as unknown as Attention|undefined;
      if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后补充。');
      this.assertNoTaskClose(taskId);
      if(!attention||attention.taskId!==taskId||attention.kind!=='input'||attention.state!=='open'||attention.taskRevision!==task.taskRevision)throw new AppError('attention-stale','问题已失效或已有回答。');
      if(this.activeBinding(taskId))throw new AppError('execution-attached','执行会话已关联，不能通过补充缺项修改任务范围。');
      if(task.lifecycle!=='open'||(task.scope&&task.acceptance))throw new AppError('not-incomplete','当前任务没有可补充的缺项。');
      if((task.scope&&fields.scope!==undefined&&fields.scope!==task.scope)||(task.acceptance&&fields.acceptance!==undefined&&fields.acceptance!==task.acceptance))throw new AppError('scope-change','补充缺项不能覆盖已有范围或验收条件。');
      const scope=fields.scope??task.scope,acceptance=fields.acceptance??task.acceptance;
      if(scope===task.scope&&acceptance===task.acceptance)throw new AppError('invalid-input','请根据真实用户补充填写尚缺的范围或验收条件。');
      const now=Date.now();
      this.db.prepare('UPDATE tasks SET scope=?,acceptance=?,taskRevision=taskRevision+1,rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(scope,acceptance,now,taskId);
      this.db.prepare("UPDATE attentions SET state='resolved' WHERE id=?").run(attentionId);
      if(!scope||!acceptance)this.db.prepare('INSERT INTO attentions(id,taskId,kind,question,taskRevision,createdAt) VALUES (?,?,?,?,?,?)').run(randomUUID(),taskId,'input','请补充任务范围和验收条件，然后再安排执行。',task.taskRevision+1,now);
      this.enqueueManager(task.botId,`revision:${taskId}:${task.taskRevision+1}`,'用户已补充任务缺项，请读取新版本和控制状态后安排。',taskId,10);
      this.event('task.revised',taskId,{taskRevision:task.taskRevision+1,attentionId,source});return this.getTask(taskId);
    });
  }
  private pendingWorkerQuestions(task:Task,binding:Binding|null,attentions:Attention[]):Attention[] {
    if(this.taskClose(task.id)||task.lifecycle!=='open'||binding?.state!=='ready'||!binding.sessionId||binding.sessionId!==task.sessionId
      ||binding.taskRevision!==task.taskRevision)return [];
    const open=attentions.filter(a=>a.taskId===task.id&&a.kind==='input'&&a.state==='open'&&a.taskRevision===task.taskRevision&&a.id.startsWith('run:'));
    if(!open.length||this.heldRuns().some(run=>run.taskId===task.id))return [];
    const waitingRun=this.db.prepare(`SELECT 1 FROM runs JOIN reports ON reports.runId=runs.id
      WHERE runs.id=? AND runs.taskId=? AND runs.bindingId=? AND runs.taskRevision=? AND runs.generation=?
      AND runs.sessionId=? AND runs.state='settled' AND reports.kind='waiting'`);
    return open.filter(a=>waitingRun.get(a.id.slice(4),task.id,binding.id,task.taskRevision,binding.generation,binding.sessionId));
  }

  respondAttention(requestId:string,attentionId:string,expectedRowVersion:number,text:string,source?:ChatSource):RunInput {
    const content=requiredText(text,'回答');
    return this.command(requestId,'attention.respond',{attentionId,expectedRowVersion,content,...(source?{source}:{})},()=>{
      const attention=this.db.prepare('SELECT * FROM attentions WHERE id=?').get(attentionId) as unknown as Attention|undefined;
      if(!attention)throw new AppError('not-found','待办不存在。');const task=this.getTask(attention.taskId);
      if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后回答。');
      this.assertNoTaskClose(task.id);
      if(attention.kind!=='input'||attention.state!=='open'||attention.taskRevision!==task.taskRevision||task.lifecycle!=='open')throw new AppError('attention-stale','问题已失效或已有回答。');
      const binding=this.activeBinding(task.id);
      if(!binding)throw new AppError('not-execution-question','请使用修改任务补全范围和验收条件。');
      if(this.heldRuns().some(r=>r.taskId===task.id))throw new AppError('run-active','执行尚未收敛，暂未提交回答。');
      if(!this.pendingWorkerQuestions(task,binding,[attention]).length)throw new AppError('attention-stale','问题已失效或已有回答。');
      const id=randomUUID();this.db.prepare('INSERT INTO inputs(id,taskId,kind,content,attentionId,createdAt) VALUES (?,?,?,?,?,?)').run(id,task.id,'answer',content,attentionId,Date.now());
      this.db.prepare('INSERT INTO outbox(id,kind,taskId,payload,createdAt) VALUES (?,?,?,?,?)').run(`input:${id}`,'input.deliver',task.id,JSON.stringify({inputId:id}),Date.now());
      this.db.prepare("UPDATE attentions SET state='responding' WHERE id=?").run(attentionId);
      this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(Date.now(),task.id);
      this.enqueueManager(task.botId,`answer:${id}`,'用户回答已保存，请核对管理方式后继续。',task.id,10);
      this.event('attention.answered',task.id,{attentionId,inputId:id,...(source?{source}:{})});
      return {...this.db.prepare('SELECT * FROM inputs WHERE id=?').get(id)} as unknown as RunInput;
    });
  }
  rejectResult(requestId:string,taskId:string,expectedRowVersion:number,resultId:string,text:string,source?:ChatSource):Task {
    const content=requiredText(text,'返工要求');
    return this.command(requestId,'result.reject',{taskId,expectedRowVersion,resultId,content,...(source?{source}:{})},()=>{
      const task=this.getTask(taskId),run=this.latestRun(taskId),result=run?this.runResult(run.id):null;
      if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后再返工。');
      this.assertNoTaskClose(taskId);
      if(task.lifecycle!=='review'||!result||result.id!==resultId||result.taskRevision!==task.taskRevision)throw new AppError('result-stale','这份成果已失效。');
      if(this.heldRuns().some(r=>r.taskId===taskId))throw new AppError('run-active','执行尚未收敛，暂未安排返工。');
      this.db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?,?)').run(randomUUID(),resultId,'user','rejected',content,Date.now());
      const inputId=randomUUID();this.db.prepare('INSERT INTO inputs(id,taskId,kind,content,createdAt) VALUES (?,?,?,?,?)').run(inputId,taskId,'rework',content,Date.now());
      this.db.prepare('INSERT INTO outbox(id,kind,taskId,payload,createdAt) VALUES (?,?,?,?,?)').run(`input:${inputId}`,'input.deliver',taskId,JSON.stringify({inputId}),Date.now());
      this.db.prepare("UPDATE attentions SET state='resolved' WHERE taskId=? AND kind='review' AND state='open'").run(taskId);
      this.db.prepare("UPDATE tasks SET lifecycle='open',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(Date.now(),taskId);
      this.enqueueManager(task.botId,`user-rework:${inputId}`,'用户返工要求已保存，请核对管理方式后继续。',taskId,10);
      this.event('result.rejected',taskId,{resultId,inputId,...(source?{source}:{})});return this.getTask(taskId);
    });
  }
  recoveryTarget(taskId:string,expectedRowVersion:number,continuation?:RecoveryContinuation) {
    const task=this.getTask(taskId),latest=this.latestRun(taskId),binding=this.activeBinding(taskId);
    if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后核对。');
    if(latest?.finishedAt===null)throw new AppError('run-active','请先停止当前执行。');
    const run=latest&&binding&&latest.bindingId===binding.id&&latest.sessionId===binding.sessionId&&
      latest.generation===binding.generation&&latest.taskRevision===task.taskRevision?latest:null;
    const close=this.taskClose(taskId);
    const attentions=this.db.prepare(`SELECT id FROM attentions WHERE taskId=? AND taskRevision=? AND kind='recovery'
      AND state='open' AND id IN (?,?,?) ORDER BY id`).all(taskId,task.taskRevision,`restore:${taskId}`,run?`run:${run.id}`:null,
        close&&close.runId===run?.id?`close:${close.id}`:null)
      .map(row=>String(row.id));
    if(!['open','review'].includes(task.lifecycle)||!attentions.length)throw new AppError('recovery-stale','当前没有可核对的执行恢复事项。');
    if(this.heldRuns().some(held=>held.taskId===taskId&&held.id!==run?.id))throw new AppError('run-active','还有其他执行占用待核对。');
    if(binding?(binding.state!=='ready'||!binding.sessionId||task.sessionId!==binding.sessionId||task.taskRevision!==binding.taskRevision):task.sessionId!==null) {
      throw new AppError('binding-stale','执行会话关联待核对，请先确认当前关联。');
    }
    if(continuation) {
      this.assertNoTaskClose(taskId);
      if(!attentions.includes(continuation.attentionId))throw new AppError('recovery-stale','这个恢复事项已经改变，请刷新后核对。');
      if(!binding||binding.id!==continuation.bindingId||binding.generation!==continuation.expectedBindingGeneration) {
        throw new AppError('binding-stale','执行会话关联已经改变，请刷新后核对。');
      }
      if(task.lifecycle!=='open'||!task.scope||!task.acceptance)throw new AppError('not-ready','当前任务只能完成核对，请保留已有成果或先补全任务。');
    }
    return {task,binding,run,attentions};
  }
  recoveryInstruction(taskId:string):RecoveryInstruction|null {
    const value=this.get(`recovery-instruction:${taskId}`);
    if(!value)return null;
    const {directionRefs,...instruction}=JSON.parse(value) as StoredRecoveryInstruction;
    if(directionRefs)instruction.directions=directionRefs.map(ref=>{
      const source=this.get(`recovery-direction-source:${ref.id}`);
      if(!source)throw new AppError('direction-unproven','待处理指示缺少原始消息记录，请核对任务。');
      return {...ref,source:JSON.parse(source) as ChatSource};
    });
    if(!instruction.directions) {
      const source=instruction.priorDirection??instruction.source;
      instruction.directions=instruction.mode?[{id:directionId(source),source,mode:instruction.mode}]:[];
    }
    return instruction;
  }
  private writeRecoveryInstruction(taskId:string,{directions,...instruction}:RecoveryInstruction):void {
    const directionRefs=directions?.map(({id,mode,source})=>{
      const key=`recovery-direction-source:${id}`;
      if(!this.get(key))this.set(key,JSON.stringify(source));
      return {id,mode};
    });
    this.set(`recovery-instruction:${taskId}`,JSON.stringify({...instruction,directionRefs}));
  }
  recoveryDirectionStatus(instruction:RecoveryInstruction):RecoveryDirectionStatus {
    const run=this.getRun(instruction.runId??instruction.priorRunId),task=this.getTask(run.taskId);
    if(task.taskRevision!==instruction.taskRevision||this.latestRun(task.id)?.id!==run.id)return 'archived';
    if(instruction.runId) {
      const state=this.getRunInput(instruction.runId).state;
      if(state==='entered')return 'entered';
      if(state==='enqueued')return 'queued';
      if(state==='unknown')return 'delivery-unknown';
      return state==='discarded'?'discarded':'recorded';
    }
    if(task.lifecycle!=='open')return 'archived';
    if(instruction.change?.kind==='revoke'&&!instruction.mode)return 'revoked';
    const staged=instruction.stageRunId===run.id&&['awaiting-decision','waiting','ready'].includes(task.stageState??'');
    return task.controlMode==='auto'&&instruction.mode&&(run.finishedAt===null||staged)?'next-run':'recorded';
  }
  recoveryWorkPlan(runId:string):RecoveryWorkPlan|null {
    const value=this.get(`recovery-work:${runId}`);
    return value?JSON.parse(value):null;
  }
  saveRecoveryInstruction(taskId:string,expectedRowVersion:number,source:ChatSource,
    mode?:RecoveryInstruction['mode'],keepPendingDirection=false,resumeManagement=false,change?:RecoveryDirectionChange,
    extra?:{earlier?:Omit<RecoveryDirection,'id'>[];onlyWhileActive?:boolean;stageFollowUp?:StageFollowUp;lateJobFollowUp?:'append'}) {
    const id=directionId(source);
    this.command(`recovery-owner:${id}`,'task.recovery-instruction',{taskId,source,mode,keepPendingDirection,resumeManagement,change,extra},()=>{
      const task=this.getTask(taskId),run=this.latestRun(taskId);
      this.assertNoTaskClose(taskId);
      if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请重新读取状态。');
      if(this.botForSession(source.sessionId)?.id!==task.botId)throw new AppError('manager-scope','只能在任务当前的 Bot 对话保存指示。');
      requiredText(source.text,'用户指令原文',32_000);
      if(mode!==undefined&&mode!=='read-only'&&mode!=='authorized-work')throw new AppError('invalid-input','后续授权范围无效。');
      if(task.lifecycle!=='open'||!run||run.taskRevision!==task.taskRevision||
        (run.finishedAt!==null&&!['blocked','recovery','paused','manual'].includes(task.status)&&task.stageState!=='ready')) {
        throw new AppError('recovery-stale','没有需要后续指示的当前执行。');
      }
      const late=this.lateJobTarget(run.id)?.pending;
      const appendLate=extra?.lateJobFollowUp==='append';
      if(appendLate&&(!late||change||resumeManagement||extra?.stageFollowUp||mode!=='authorized-work')) {
        throw new AppError('recovery-stale','只能把同一报告的补充追加到仍在等待的后台恢复。');
      }
      if(extra?.onlyWhileActive&&(!mode||change||keepPendingDirection||resumeManagement||
        run.finishedAt!==null||!['queued','running'].includes(run.state))) {
        throw new AppError('direction-stale','只能把同轮较早的独立指示加到仍在执行的任务。');
      }
      if(resumeManagement&&(task.controlMode!=='paused'||!mode||keepPendingDirection)) {
        throw new AppError('recovery-human-control','仅能根据明确的本次续跑指示恢复已暂停的任务。');
      }
      if(change&&(!['replace','revoke'].includes(change.kind)||keepPendingDirection||extra?.earlier?.length||
        change.kind==='replace'&&!mode||change.kind==='revoke'&&mode)) {
        throw new AppError('invalid-input','替代指示需给出具体新方向。撤回仅处理已保存的指示。');
      }
      const previous=this.recoveryInstruction(taskId);
      const stage=this.currentStage(task,run),activeStage=stage&&!['superseded','dispatched'].includes(stage.state)?stage:null;
      const stageFollowUp=extra?.stageFollowUp??(activeStage&&mode&&!keepPendingDirection?'replace':undefined);
      if(stageFollowUp&&!activeStage||stageFollowUp==='append'&&!mode&&!change||stageFollowUp==='append'&&resumeManagement||
        stageFollowUp==='replace'&&(!mode||change||keepPendingDirection)||
        stageFollowUp==='revoke'&&(mode||change||keepPendingDirection||extra?.earlier?.length)) {
        throw new AppError('stage-stale','请核对当前阶段及用户要求的追加、替换或撤回。');
      }
      if(previous?.source.sessionId===source.sessionId&&previous.source.seq>=source.seq||
        activeStage?.planSource?.sessionId===source.sessionId&&activeStage.planSource.seq>=source.seq) {
        throw new AppError('recovery-stale','此任务有更新的用户指示。');
      }
      if(this.get(`recovery-direction-source:${id}`))throw new AppError('direction-stale','该用户消息已保存。');
      let previousSeq=previous?.source.sessionId===source.sessionId?previous.source.seq:-1;
      const additions=(extra?.earlier??[]).map(direction=>{
        const original=direction.source;
        requiredText(original.text,'用户指令原文',32_000);
        if(original.sessionId!==source.sessionId||original.seq<=previousSeq||original.seq>=source.seq||
          !['read-only','authorized-work'].includes(direction.mode)) {
          throw new AppError('direction-stale','补充消息的来源或顺序已经改变。');
        }
        previousSeq=original.seq;
        const directionKey=directionId(original);
        if(this.get(`recovery-direction-source:${directionKey}`)||
          this.db.prepare('SELECT 1 FROM requests WHERE id=?').get(`recovery-owner:${directionKey}`)) {
          throw new AppError('direction-stale','这条较早的用户消息已经保存。');
        }
        return {id:directionKey,...direction};
      });
      const pending=!(previous?.stageRunId&&stageFollowUp!=='append')&&previous&&!previous.runId&&previous.priorRunId===run.id&&
        previous.taskRevision===task.taskRevision&&previous.source.sessionId===source.sessionId?previous.directions??[]:[];
      const removedIds=change?(change.ids??pending.map(direction=>direction.id)):[];
      if(change&&(!removedIds.length||new Set(removedIds).size!==removedIds.length||
        removedIds.some(removed=>!pending.some(direction=>direction.id===removed)))) {
        throw new AppError('direction-stale','要撤回或替代的指示已不在本次待处理范围内，请核对当前任务。');
      }
      const directions=[...pending.filter(direction=>!removedIds.includes(direction.id)),...additions];
      if(mode)directions.push({id,source,mode});
      // A narrower direction remains in force until the owner explicitly replaces or revokes it.
      const effectiveMode=directions.some(direction=>direction.mode==='read-only')?'read-only':directions.at(-1)?.mode;
      const instruction:RecoveryInstruction={id,source,taskRevision:task.taskRevision,priorRunId:run.id,directions,mode:effectiveMode,
        ...(stageFollowUp==='append'?{stageRunId:run.id}:{}),
        ...(keepPendingDirection&&directions.length===1?{priorDirection:directions[0]!.source}:{}),
        ...(change?{change:{kind:change.kind,removedIds}}:stageFollowUp==='revoke'?{change:{kind:'revoke',removedIds:[]}}:{})};
      if(previous&&!previous.runId) {
        const notice=`manager-event:continuation:${previous.id}`;
        for(const suffix of ['',':settled',':restart'])this.settleManagerEvent(notice+suffix);
      }
      this.writeRecoveryInstruction(taskId,instruction);
      if(activeStage&&(stageFollowUp==='replace'||stageFollowUp==='revoke')) {
        this.supersedeStage(activeStage);
        this.clearGitLabReleasePlan(activeStage.runId);
        this.db.prepare('DELETE FROM waits WHERE taskId=?').run(taskId);
        this.event('stage.superseded',taskId,{runId:run.id,instructionId:id,stageFollowUp});
      }
      this.db.prepare("UPDATE tasks SET controlMode=?,rowVersion=rowVersion+1,updatedAt=? WHERE id=?")
        .run(resumeManagement?'auto':task.controlMode,Date.now(),taskId);
      if(late&&(appendLate||keepPendingDirection&&!change&&!resumeManagement)) {
        this.set(`late-job:${run.id}`,JSON.stringify({...late,rowVersion:task.rowVersion+1,instructionId:id}));
      }
      if(effectiveMode&&stageFollowUp!=='append'&&!appendLate) {
        this.enqueueManager(task.botId,`continuation:${id}`,'有待处理的用户指示，请结合上一轮已核对的事实继续。',taskId,10);
      }else if(change?.kind==='revoke'&&stageFollowUp!=='append')this.db.prepare('DELETE FROM waits WHERE taskId=?').run(taskId);
      for(const extra of additions)this.event('task.recovery-instruction',taskId,
        {instructionId:extra.id,priorRunId:run.id,source:extra.source,mode:extra.mode});
      this.event('task.recovery-instruction',taskId,{instructionId:id,priorRunId:run.id,source,mode,resumeManagement,
        change:instruction.change,stageFollowUp});
      return {};
    });
    return {task:this.getTask(taskId),instruction:this.recoveryInstruction(taskId)!};
  }
  /** Returns only the pending instruction bound to the current attempt. */
  continuationTarget(taskId:string,rowVersion:number,managerId:string) {
    const task=this.getTask(taskId),run=this.latestRun(taskId),binding=this.activeBinding(taskId);
    const instruction=this.recoveryInstruction(taskId),manager=this.activeManager(task.botId);
    if(task.rowVersion!==rowVersion)throw new AppError('version-conflict','任务或用户指示已经更新。');
    if(!manager||manager.id!==managerId||manager.state!=='ready'||!manager.sessionId||
      this.botForSession(manager.sessionId)?.id!==task.botId)throw new AppError('manager-scope','原管理会话的授权已改变。');
    if(task.controlMode!=='auto'||task.lifecycle!=='open')throw new AppError('recovery-human-control','任务已暂停、接管或结束。');
    if(!instruction||instruction.runId||instruction.stageRunId||instruction.taskRevision!==task.taskRevision||instruction.source.sessionId!==manager.sessionId||
      !run||instruction.priorRunId!==run.id||run.bindingId!==binding?.id||
      binding.state!=='ready'||!binding.sessionId||run.sessionId!==binding.sessionId||run.generation!==binding.generation||
      run.taskRevision!==task.taskRevision||binding.taskRevision!==task.taskRevision) {
      throw new AppError('recovery-stale','上一轮执行、后续指示或会话关联已经变更。');
    }
    if(run.finishedAt===null)throw new AppError('run-active','上次执行仍在进行。');
    if(this.db.prepare(`SELECT 1 FROM attentions WHERE taskId=? AND state IN ('open','responding','stale')
      AND ((kind='approval' AND taskRevision=?) OR (state!='stale' AND id!=? AND kind IN ('input','recovery')))`)
      .get(taskId,task.taskRevision,`run:${run.id}`)||
      this.db.prepare("SELECT 1 FROM inputs WHERE taskId=? AND kind!='goal' AND state IN ('accepted','enqueued','unknown')").get(taskId)||
      this.heldRuns().some(held=>held.taskId===taskId&&held.id!==run.id)) {
      throw new AppError('recovery-pending','还有未处理的输入、原生审批或执行占用，旧输入仍保留。');
    }
    return {task,run,binding:{...binding,sessionId:binding.sessionId},instruction};
  }
  verifyInterruptedEnd(taskId:string,rowVersion:number,managerId:string):void {
    const {task,run}=this.continuationTarget(taskId,rowVersion,managerId);
    const proof=this.runTurn(run.id);
    if(run.state!=='interrupted'||this.getRunInput(run.id).state!=='entered'||!proof?.quiet||proof.endSeq===null) {
      throw new AppError('recovery-unproven','没有可归属的原轮结束证据，保留占用。');
    }
    this.command(`verified-end:${run.id}`,'run.end-verified',{taskId,runId:run.id},()=>{
      this.db.prepare('DELETE FROM resources WHERE runId=?').run(run.id);
      this.set(`run-verified-end:${run.id}`,String(proof.endSeq));
      this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(Date.now(),task.id);
      this.event('run.end-verified',task.id,{runId:run.id,managerId,endSeq:proof.endSeq});
      return {};
    });
  }
  reserveRecoveryContinuation(taskId:string,rowVersion:number,managerId:string,work:RecoveryWorkPlan,expectedModel:WorkerModelPlan):Run {
    const {task,run,binding,instruction}=this.continuationTarget(taskId,rowVersion,managerId);
    return this.command(`recovery-work:${instruction.id}`,'task.continue',{taskId,instructionId:instruction.id},()=>{
      if(work.context.priorRunId!==run.id||work.context.mode!==instruction.mode||
        work.context.mode==='authorized-work'&&work.context.effectUncertain||!this.verifiedBlocker(run)) {
        throw new AppError('recovery-unproven','原轮结束或后续执行的归属无法确认。');
      }
      this.db.prepare("UPDATE attentions SET state='resolved' WHERE id=? AND state='open'").run(`run:${run.id}`);
      const next=this.allocateRun(task,binding,true,expectedModel,instruction);
      this.set(`recovery-work:${next.id}`,JSON.stringify(work));
      this.writeRecoveryInstruction(taskId,{...instruction,runId:next.id});
      this.settleManagerEvent(`manager-event:continuation:${instruction.id}`);
      this.event('run.continued',taskId,{runId:next.id,priorRunId:run.id,instructionId:instruction.id});
      return next;
    });
  }
  autoRecoveryTarget(taskId:string,rowVersion:number,runId:string,managerId:string) {
    const target=this.recoveryTarget(taskId,rowVersion),{task,run,attentions}=target;
    const manager=this.activeManager(task.botId);
    if(!manager||manager.id!==managerId||manager.state!=='ready'||
      manager.configRevision!==this.getBot(task.botId).configRevision) {
      throw new AppError('manager-scope','原管理会话的授权已改变。');
    }
    if(task.controlMode!=='auto'||task.lifecycle!=='open') {
      throw new AppError('recovery-human-control','任务已暂停、接管或结束。');
    }
    if(run?.id!==runId||!target.binding?.sessionId||attentions.length!==1||attentions[0]!==`run:${runId}`) {
      throw new AppError('recovery-stale','上一轮执行、恢复事项或工作会话已被替换。');
    }
    if(this.db.prepare("SELECT 1 FROM attentions WHERE taskId=? AND id!=? AND state IN ('open','responding','stale') AND kind IN ('input','approval') AND taskRevision=? AND (state!='stale' OR kind='approval')").get(taskId,attentions[0],task.taskRevision)||
      this.pendingInput(taskId)) {
      throw new AppError('recovery-pending','还有未处理的输入或没有回执的原生审批。');
    }
    const input=this.getRunInput(runId),proof=this.runTurn(runId);
    if(input.state!=='entered'||!proof?.quiet||proof.endSeq===null) {
      throw new AppError('recovery-unproven','没有可归属的持久轮次结束和后台收敛证据。');
    }
    return {...target,run,binding:{...target.binding,sessionId:target.binding.sessionId},input,proof};
  }
  preflightReceipt(runId:string,callId:string):{probe:ClusterProbe;auth:string|null;result:ProbeResult}|null {
    const value=this.get(`worker-preflight:${runId}:${callId}`);
    return value?JSON.parse(value):null;
  }
  recordPreflightReceipt(runId:string,callId:string,probe:ClusterProbe,auth:string|null,result:ProbeResult):void {
    const payload={runId,callId,probe,auth,result};
    this.command(`worker-preflight:${runId}:${callId}`,'worker.preflight',payload,()=>{
      this.set(`worker-preflight:${runId}:${callId}`,JSON.stringify({probe,auth,result}));
      return {};
    });
  }
  readQueryReceipt(runId:string,callId:string):ReadQueryReceipt|null {
    const value=this.get(`worker-read-query:${runId}:${callId}`);
    return value?JSON.parse(value):null;
  }
  recordReadQueryReceipt(runId:string,callId:string,receipt:ReadQueryReceipt):void {
    const key=`worker-read-query:${runId}:${callId}`;
    this.command(key,'worker.read-query',{runId,callId,receipt},()=>{
      this.set(key,JSON.stringify(receipt));
      return {};
    });
  }
  recoveryCheck(runId:string):RecoveryCheck|null {
    const value=this.get(`run-recovery-check:${runId}`);
    return value?JSON.parse(value):null;
  }
  claimRecoveryCheck(taskId:string,runId:string,managerId:string,rowVersion:number,evidence:ProbeEvidence,effectUncertain=false):boolean {
    if(this.recoveryCheck(runId))return false;
    return this.command(`auto-recovery:${runId}`,'run.recovery-check',{taskId,runId,managerId,rowVersion,evidence,effectUncertain},()=>{
      const {proof}=this.autoRecoveryTarget(taskId,rowVersion,runId,managerId);
      if(proof.startSeq===null||!(proof.startSeq<evidence.callSeq&&evidence.callSeq<evidence.resultSeq&&evidence.resultSeq<proof.endSeq!)) {
        throw new AppError('recovery-unproven','读取工具与原轮次结束的证据不匹配。');
      }
      const receipt:RecoveryCheck={managerId,rowVersion,evidence,...(effectUncertain?{effectUncertain:true}:{})};
      this.set(`run-recovery-check:${runId}`,JSON.stringify(receipt));
      this.event('run.recovery-check-started',taskId,{runId,actor:'manager',managerId,turn:proof.turn,
        callSeq:evidence.callSeq,resultSeq:evidence.resultSeq,endSeq:proof.endSeq,probe:evidence.probe,effectUncertain});
      return true;
    });
  }
  finishRecoveryCheck(taskId:string,runId:string,managerId:string,result:ProbeResult,performed:boolean):void {
    const receipt=this.recoveryCheck(runId);
    if(!receipt||receipt.managerId!==managerId||receipt.resolution)throw new AppError('recovery-stale','恢复核对凭据已失效。');
    this.command(`auto-recovery-result:${runId}`,'run.recovery-check-result',{taskId,runId,managerId,result,performed},()=>{
      const target=this.autoRecoveryTarget(taskId,receipt.rowVersion,runId,managerId);
      this.set(`run-recovery-check:${runId}`,JSON.stringify({...receipt,resolution:result}));
      if(receipt.effectUncertain||result.status==='unavailable') {
        this.event('run.recovery-observed',taskId,{runId,actor:'manager',managerId,result,performed,
          effectUncertain:receipt.effectUncertain??false});
      } else {
        if(target.run?.state==='interrupted')this.set(`run-verified-end:${runId}`,String(target.run.finishedAt));
        this.closeRecovery(target,'auto',{managerId,result,performed});
        this.db.prepare('DELETE FROM waits WHERE taskId=?').run(taskId);
      }
      return {};
    });
  }
  resolveRunRecovery(requestId:string,taskId:string,expectedRowVersion:number,source?:ChatSource,ownerFact?:string):Task {
    return this.command(requestId,'run.resolve-recovery',{taskId,expectedRowVersion,...(source?{source,ownerFact}:{})},()=>{
      const target=this.recoveryTarget(taskId,expectedRowVersion);
      this.closeRecovery(target,'paused',undefined,source,ownerFact);
      return this.getTask(taskId);
    });
  }
  continueRunRecovery(requestId:string,taskId:string,expectedRowVersion:number,continuation:RecoveryContinuation,
    expectedModel?:WorkerModelPlan,source?:ChatSource,ownerFact?:string):Run {
    return this.command(requestId,'run.continue-recovery',{taskId,expectedRowVersion,...continuation,...(source?{source,ownerFact}:{})},()=>{
      const target=this.recoveryTarget(taskId,expectedRowVersion,continuation);
      this.closeRecovery(target,'auto',undefined,source,ownerFact);
      return this.allocateRun(this.getTask(taskId),target.binding,true,expectedModel);
    });
  }
  private closeRecovery({task,run,attentions}:ReturnType<Store['recoveryTarget']>,mode:'paused'|'auto',
    checked?:{managerId:string;result:ProbeResult;performed:boolean},source?:ChatSource,ownerFact?:string):void {
    if(run) {
      this.db.prepare('DELETE FROM resources WHERE runId=?').run(run.id);
      this.db.prepare("UPDATE inputs SET state='discarded' WHERE id=? AND state IN ('accepted','unknown','enqueued')").run(run.inputId);
      const input=this.getRunInput(run.id);
      if(input.state==='discarded') {
        this.db.prepare("UPDATE outbox SET state='cancelled' WHERE id IN (?,?) AND state IN ('pending','sending','unknown')")
          .run(`input:${input.id}`,`run:${run.id}`);
        if(input.attentionId)this.db.prepare("UPDATE attentions SET state='open' WHERE id=? AND state='responding'").run(input.attentionId);
      }
    }
    for(const id of attentions)this.db.prepare("UPDATE attentions SET state='resolved' WHERE id=?").run(id);
    this.db.prepare("UPDATE attentions SET state='stale' WHERE taskId=? AND kind='approval' AND state='open'").run(task.id);
    this.db.prepare('UPDATE tasks SET controlMode=?,rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(mode,Date.now(),task.id);
    this.event('run.recovery-confirmed',task.id,{runId:run?.id??null,
      ...(checked?{actor:'manager',...checked}:{actor:'user',source,ownerFact})});
  }
  managerReview(requestId:string,botId:string,taskId:string,expectedRowVersion:number,resultId:string,verdict:'accept'|'rework'|'human',text:string,requested?:{verdict:'accept';note:string},chatReview?:{reviewSessionId:string;reviewCallId:string}):Task {
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
      if(decision!=='rework')this.enqueueManager(botId,`delivery:${resultId}`,RESULT_DELIVERY_REASON,taskId,5,{resultId,taskRevision:task.taskRevision,...chatReview});
      this.event('manager.reviewed',taskId,{resultId,decision,note});return this.getTask(taskId);
    });
  }
  controlTask(requestId: string, id: string, expectedRowVersion: number, mode: ControlMode): Task {
    if (!['auto','paused','manual'].includes(mode)) throw new AppError('invalid-input', '控制模式无效。');
    return this.command(requestId, 'task.control', { id, expectedRowVersion, mode }, () => {
      const task = this.getTask(id);
      if (task.rowVersion !== expectedRowVersion) throw new AppError('version-conflict', '任务已经更新，请刷新后再操作。');
      if (task.lifecycle === 'completed' || task.lifecycle === 'cancelled') throw new AppError('task-ended', '任务已结束。');
      if(mode!=='paused')this.assertNoTaskClose(id);
      const current=mode!=='manual'?this.latestRun(id):null;
      const late=current&&this.lateJobTarget(current.id,true);
      this.db.prepare('UPDATE tasks SET controlMode=?,rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(mode,Date.now(),id);
      if(late) {
        // Pause and resume carry forward only this still-current plan. Takeover, close and changed intent
        // fail the identity/version checks above and cannot re-authorize it.
        this.set(`late-job:${late.run.id}`,JSON.stringify({...late.pending,rowVersion:task.rowVersion+1}));
      }else if(mode==='auto'&&task.stageState==='awaiting-decision') {
        const run=this.latestRun(id)!;
        if(this.managerEvent(`manager-event:stage-settled:${run.id}`)?.state!=='pending') {
          this.enqueueManager(task.botId,`stage-settled:${run.id}:${task.rowVersion+1}`,'任务恢复自动管理，请核对阶段证据。',id,8);
        }
      }else if(mode==='auto'&&!task.stageState) {
        this.enqueueManager(task.botId,`resume:${id}:${task.rowVersion+1}`,'任务恢复自动管理，请读取最新状态。',id,10);
      }
      this.event('task.control',id,{ mode }); return this.getTask(id);
    });
  }
  taskClose(taskId:string):TaskCloseRequest|null {
    const value=this.get(`task-close:${taskId}`);
    return value?JSON.parse(value) as TaskCloseRequest:null;
  }
  pendingTaskCloses():string[] {
    return this.db.prepare(`SELECT t.id FROM tasks t JOIN metadata m ON m.key='task-close:' || t.id
      WHERE t.lifecycle IN ('open','review')`).all().map(row=>String(row.id));
  }
  private assertNoTaskClose(taskId:string):void {
    if(this.taskClose(taskId))throw new AppError('task-closing','此任务已请求关闭，请先完成关闭核对。');
  }
  requestTaskClose(requestId:string,taskId:string,expectedRowVersion:number,finishingRunId?:string):{stopRunId:string|null} {
    return this.command(requestId,'task.close',{taskId,expectedRowVersion},()=>{
      const task=this.getTask(taskId);
      this.getBot(task.botId);
      if(task.lifecycle==='cancelled')return {stopRunId:null};
      if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后再关闭。');
      if(!['open','review'].includes(task.lifecycle))throw new AppError('task-ended','任务已完成。');
      if(this.taskClose(taskId))return {stopRunId:null};
      const run=this.latestRun(taskId),binding=this.activeBinding(taskId);
      const current=run?.taskRevision===task.taskRevision&&run.bindingId===binding?.id?run:null;
      const intent:TaskCloseRequest={id:randomUUID(),taskRevision:task.taskRevision,runId:current?.id??null,activeRun:current?.finishedAt===null};
      this.set(`task-close:${taskId}`,JSON.stringify(intent));
      this.db.prepare("UPDATE tasks SET controlMode='paused',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(Date.now(),taskId);
      this.db.prepare('DELETE FROM waits WHERE taskId=?').run(taskId);
      this.event('task.close-requested',taskId,intent);
      if(!current||current.finishedAt!==null||current.state==='cancelling'||current.id===finishingRunId)return {stopRunId:null};
      const input=this.getRunInput(current.id);
      const delivery=this.db.prepare('SELECT state,attempts FROM outbox WHERE id IN (?,?)')
        .all(`input:${input.id}`,`run:${current.id}`);
      const unsent=input.state==='accepted'&&delivery.length>0&&delivery.every(row=>row.attempts===0&&row.state==='pending');
      this.markRunStopping(current);
      if(unsent)this.finishStoppedRun(current,false,true);
      return {stopRunId:unsent?null:current.id};
    });
  }
  closeRunNeedsReadback(run:Run,activeRun:boolean):boolean {
    if(!activeRun&&run.state!=='cancelled'&&run.state!=='interrupted'&&!this.verifiedBlocker(run))return false;
    return !this.db.prepare(`SELECT 1 FROM events WHERE taskId=? AND json_extract(data,'$.runId')=? AND
      (kind='run.cancelled' AND json_extract(data,'$.unsent')=1 OR
       kind='run.recovery-confirmed' AND json_extract(data,'$.actor')='user')`).get(run.taskId,run.id);
  }
  recordCloseBlocker(taskId:string,intentId:string,blocker:NonNullable<TaskCloseRequest['blocker']>,notify:boolean):void {
    const intent=this.taskClose(taskId);
    if(intent?.id!==intentId||JSON.stringify(intent.blocker)===JSON.stringify(blocker))return;
    this.command(`close-blocker:${randomUUID()}`,'task.close-blocked',{taskId,intentId,blocker},()=>{
      this.set(`task-close:${taskId}`,JSON.stringify({...intent,blocker}));
      if(['effect-uncertain','run-proof','recovery-new-input','recovery-scope-changed'].includes(blocker.code)&&intent.runId) {
        const raised=this.db.prepare('INSERT OR IGNORE INTO attentions(id,taskId,kind,question,taskRevision,createdAt) VALUES (?,?,?,?,?,?)')
          .run(`close:${intentId}`,taskId,'recovery',blocker.message,intent.taskRevision,Date.now()).changes;
        if(raised)this.db.prepare('UPDATE tasks SET rowVersion=rowVersion+1,updatedAt=? WHERE id=?').run(Date.now(),taskId);
      }
      this.event('task.close-blocked',taskId,{intentId,...blocker});
      if(notify)this.enqueueManager(this.getTask(taskId).botId,`close-blocked:${intentId}:${blocker.code}`,
        `任务的关闭请求已保存。尚不能关闭：${blocker.message} 请说明这一项，并保持任务暂停。`,taskId,10);
      return {};
    });
  }
  confirmTaskClose(taskId:string,intentId:string,expectedRowVersion:number,notify:boolean):Task {
    return this.command(`close-finish:${intentId}`,'task.close-finish',{taskId,intentId,expectedRowVersion},()=>{
      const task=this.getTask(taskId),intent=this.taskClose(taskId);
      if(intent?.id!==intentId||task.taskRevision!==intent.taskRevision||task.rowVersion!==expectedRowVersion) {
        throw new AppError('version-conflict','核对期间任务或关闭请求有变化，请重新读取。');
      }
      this.getBot(task.botId);
      this.assertTaskSettled(taskId);
      const cancelled=this.finishTaskCancellation(taskId,{closeRequestId:intentId,runId:intent.runId});
      this.db.prepare('DELETE FROM metadata WHERE key=?').run(`task-close:${taskId}`);
      if(notify)this.enqueueManager(task.botId,`task-closed:${intentId}`,'已核对执行结束，任务应用户的明确要求已关闭。请在原对话简短确认。',taskId,10);
      return cancelled;
    });
  }
  assertTaskSettled(taskId:string):void {
    if(this.db.prepare('SELECT 1 FROM runs LEFT JOIN resources ON resources.runId=runs.id WHERE runs.taskId=? AND (runs.finishedAt IS NULL OR resources.runId IS NOT NULL)').get(taskId))throw new AppError('run-active','请先停止执行并完成恢复核对，当前占用尚未释放。');
    const run=this.latestRun(taskId),task=this.getTask(taskId);
    const settled=run?.taskRevision===task.taskRevision&&this.verifiedBlocker(run);
    const check=settled&&run?this.recoveryCheck(run.id):null;
    if(check&&(check.effectUncertain||!check.resolution)||settled&&run&&this.recoveryWorkPlan(run.id)?.context.effectUncertain) {
      throw new AppError('effect-uncertain','旧轮外部操作或核对结果仍未确认，暂未取消任务。');
    }
    const attention=this.db.prepare(`SELECT kind,question FROM attentions WHERE taskId=? AND id!=? AND
      (kind='recovery' AND state='open' OR kind='approval' AND state IN ('open','stale') AND taskRevision=?)
      ORDER BY kind='approval' DESC,createdAt,id LIMIT 1`)
      .get(taskId,settled?`run:${run!.id}`:'',task.taskRevision);
    if(attention)throw new AppError('needs-attention',attention.kind==='approval'
      ?`原生审批尚无结算回执。请核对会话中的审批结果。 ${attention.question}`:`请先完成恢复核对。 ${attention.question}`);
    if(this.db.prepare("SELECT 1 FROM inputs WHERE taskId=? AND state IN ('enqueued','unknown')").get(taskId)) {
      throw new AppError('input-uncertain','还有送达状态没有确认的输入。');
    }
    const binding=this.activeBinding(taskId);if(binding&&binding.state!=='ready')throw new AppError('session-recovery','请先核对会话创建结果。');
  }
  private discardPendingWork(taskId:string):void {
    this.db.prepare("UPDATE work_stages SET state='superseded',nextCheckAt=NULL WHERE taskId=? AND state!='dispatched'").run(taskId);
    this.db.prepare("UPDATE inputs SET state='discarded' WHERE taskId=? AND state IN ('accepted','enqueued','unknown')").run(taskId);
    this.db.prepare("UPDATE outbox SET state='superseded' WHERE taskId=? AND state='pending'").run(taskId);
    this.db.prepare("UPDATE attentions SET state='stale' WHERE taskId=? AND state IN ('open','responding')").run(taskId);
  }
  /** Runs inside the confirmed force-delete transaction after revoking the Bot. */
  private retireBotTasks(botId:string):void {
    for(const run of this.deletedBotRuns(botId)) {
      const input=this.getRunInput(run.id);
      const delivery=this.db.prepare('SELECT state,attempts FROM outbox WHERE id IN (?,?)')
        .all(`input:${input.id}`,`run:${run.id}`);
      if(input.state==='accepted'&&delivery.length>0&&delivery.every(row=>row.attempts===0&&row.state==='pending')) {
        this.releaseDeletedRun(run,true,'强制删除 Bot 时撤销尚未投递的执行。');
      } else {
        this.db.prepare("UPDATE runs SET state='cancelling' WHERE id=? AND finishedAt IS NULL").run(run.id);
        this.event('run.stop-requested',run.taskId,{runId:run.id,reason:'bot-deleted'});
      }
    }
    const owned='SELECT id FROM tasks WHERE botId=?';
    this.db.prepare(`DELETE FROM waits WHERE taskId IN (${owned})`).run(botId);
    this.db.prepare("DELETE FROM metadata WHERE key IN (SELECT 'task-close:' || id FROM tasks WHERE botId=?)").run(botId);
    this.db.prepare(`UPDATE inputs SET state='discarded' WHERE taskId IN (${owned}) AND state='accepted'
      AND NOT EXISTS (SELECT 1 FROM runs JOIN resources ON resources.runId=runs.id WHERE runs.inputId=inputs.id)`).run(botId);
    this.db.prepare(`UPDATE outbox SET state='superseded' WHERE taskId IN (${owned}) AND state IN ('pending','blocked')`).run(botId);
    this.db.prepare(`UPDATE attentions SET state='stale' WHERE taskId IN (${owned}) AND state IN ('open','responding')`).run(botId);
    this.db.prepare(`UPDATE bindings SET state='released' WHERE taskId IN (${owned}) AND state IN ('creating','recovery')`).run(botId);
    this.db.prepare(`UPDATE tasks SET lifecycle='cancelled',controlMode='paused',rowVersion=rowVersion+1,updatedAt=?
      WHERE botId=? AND lifecycle IN ('open','review')`).run(Date.now(),botId);
  }
  detachSession(requestId:string,taskId:string,expectedRowVersion:number):Task {
    return this.command(requestId,'session.detach',{taskId,expectedRowVersion},()=>{
      const task=this.getTask(taskId);if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后解除关联。');
      this.assertNoTaskClose(taskId);
      if(task.lifecycle!=='open')throw new AppError('task-ended','仅未完成任务可以解除关联；待验收成果请先返工或取消任务。');
      this.assertTaskSettled(taskId);const binding=this.activeBinding(taskId);if(!binding)throw new AppError('not-found','没有当前执行会话。');
      this.db.prepare("UPDATE bindings SET state='released' WHERE id=?").run(binding.id);
      this.discardPendingWork(taskId);this.db.prepare('DELETE FROM waits WHERE taskId=?').run(taskId);
      this.db.prepare("UPDATE tasks SET sessionId=NULL,controlMode='paused',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(Date.now(),taskId);
      this.event('session.detached',taskId,{bindingId:binding.id,sessionId:binding.sessionId});return this.getTask(taskId);
    });
  }
  cancelTask(requestId:string,taskId:string,expectedRowVersion:number):Task {
    return this.command(requestId,'task.cancel',{taskId,expectedRowVersion},()=>{
      const task=this.getTask(taskId);if(task.rowVersion!==expectedRowVersion)throw new AppError('version-conflict','任务已经更新，请刷新后取消。');
      if(!['open','review'].includes(task.lifecycle))throw new AppError('task-ended','任务已经结束。');
      this.assertNoTaskClose(taskId);
      this.assertTaskSettled(taskId);return this.finishTaskCancellation(taskId,{});
    });
  }
  private finishTaskCancellation(taskId:string,receipt:Record<string,unknown>):Task {
    this.discardPendingWork(taskId);this.db.prepare('DELETE FROM waits WHERE taskId=?').run(taskId);
    this.db.prepare("UPDATE tasks SET lifecycle='cancelled',controlMode='paused',rowVersion=rowVersion+1,updatedAt=? WHERE id=?").run(Date.now(),taskId);
    this.event('task.cancelled',taskId,receipt);return this.getTask(taskId);
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
