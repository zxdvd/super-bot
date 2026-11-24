import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-app-boot';
import type {} from '@deepseek-ai/dsh-hmr';
import type {} from '@deepseek-ai/dsh-cmdline';
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename,extname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeveloperLease, developerSettings } from './developer-reload.ts';
import { profileSource } from './dev-reload-paths.ts';
import { startReloadHost } from './dev-reload-host.ts';
import { ReloadAdmission } from './reload-admission.ts';
import { readEvidence } from './evidence.ts';
import { Store } from './store.ts';
import { BotMemory } from './bot-memory.ts';
import { DshExecution } from './dsh.ts';
import {runtimeLimits,type RuntimeOptions} from './runtime.ts';
import { Managers } from './manager.ts';
import { NativeSidebar } from './sidebar.ts';
import { createLedgerBackup } from './backups.ts';
import { bindMirror, parseMirrorQuery, startMirror } from './mirror-host.ts';
import { startFeishuHost } from './feishu-host.ts';
import { readLocalMirror } from './mirror-queries.ts';
import { RESULT_FILE_PATH } from './work-links.ts';
import { managedSessionId, oppositeOwner, type BotOwner, type MirrorBot, type MirrorCatalog, type SessionOrigin } from './mirror.ts';
import { AppError, requiredText, optionalText,type WorkspaceStatus, type NewBot, type NewTask, type ControlMode } from './model.ts';

export const name = 'super-bot';
const previewExtensions = new Set(['.md', '.diff', '.patch', '.json', '.jsonl', '.txt']);
export const inject = ['connection', 'sessionController', 'workspaceRegistry','agents','tools','jobs','systemPrompt','workingDirectory','sessionProjections','webServer','permissionPresets','sessions','sessionPersistence','sessionTitle'];
const roleModel=Schema.union([Schema.const(undefined),Schema.object({provider:Schema.string().required(),model:Schema.string().required(),reasoningEffort:Schema.string()})]);
const workdirHook=Schema.object({
  description:Schema.string().description('写给 Bot 的用途说明：什么时候用这个 hook、args 是什么'),
  create:Schema.string().required().description('创建命令模板（sh -c 执行）；可用 {name} {taskId} {args.x}，或环境变量 SB_NAME、SB_TASK_ID、SB_ARG_X；stdout 最后输出 SB_WORKDIR=<绝对路径>'),
  remove:Schema.string().description('可选清理命令模板；可用 {name} {taskId} {workdir}；不配置则从不删除'),
  cwd:Schema.string().description('命令执行目录，必须在 allowedRoots 内；默认第一个根目录'),
  timeoutSeconds:Schema.natural().min(1).max(3600).default(300).description('超时秒数；应小于 Bot 单轮时限'),
  argNames:Schema.array(Schema.string()).description('Bot 可以传入的参数名白名单'),
});
export const Config = Schema.object({ dataDir: Schema.string().description('Super Bot 本地数据目录'), fullAccess:Schema.boolean().default(true).description('默认开启 Bot 查询工具（含 Shell）及 Worker 原生 Full Access；false 关闭 Bot 原生工具并将 Worker 限为任务目录文件工具'),
  allowedRoots:Schema.array(Schema.string()).description('Bot 为任务选择工作目录时允许的根目录（绝对路径；不能是 HOME 或 /）'),
  defaultWorkdir:Schema.union([Schema.const('isolated'),Schema.const('worktree'),Schema.const('hook'),Schema.const('none')]).description('Bot 未指定 workdir 时的方式；未配置根目录时为 none（数据目录下的私有目录）'),
  defaultIsolatedDir:Schema.string().description('isolated / worktree 目录所在位置，相对第一个根目录（默认 .super-bot-workspaces）'),
  deniedPaths:Schema.array(Schema.string()).description('在内置敏感目录之外额外禁止的路径'),
  workdirHook:Schema.union([Schema.const(undefined),workdirHook]),
  workdirCleanup:Schema.union([Schema.const('manual'),Schema.const('on-complete')]).default('manual').description('任务完成或取消后是否自动清理隔离目录 / worktree / hook 目录；已有目录从不清理'),
  workspace:Schema.string().description('已弃用：等同 allowedRoots: [workspace]'),
  mirrorDir: Schema.string().description('可选。同机 Web 与 Desktop 只读镜像的私有配对目录，含 pair.json。'),
  feishu: Schema.union([Schema.const(undefined), Schema.object({ enabled: Schema.boolean().default(false) })])
    .description('仅用于导入当前 profile 的旧飞书设置。之后由 Super Bot 设置管理。'),
  maxRunningTasks:Schema.natural().min(1).default(2).description('全局同时执行的 Worker 任务数'),managerWakesPerHour:Schema.natural().min(1).default(20).description('每个 Bot 每小时自动唤醒上限；达到后记录问题并暂停自动唤醒'),managerConcurrentWakes:Schema.natural().min(1).default(2).description('同时自动唤醒的 Bot 数'),managerTurnMinutes:Schema.natural().min(1).default(5).description('单次自动 Bot 轮次上限（分钟）'),managerModel:roleModel,workerModel:roleModel });

export async function apply(ctx: Context, config: RuntimeOptions & {
  dataDir?: string; mirrorDir?: string; feishu?: { enabled?: boolean };
} = {}): Promise<void> {
  const checkout = fileURLToPath(new URL('..', import.meta.url));
  const dataDir = resolve(config.dataDir ?? process.env.SUPER_BOT_DATA_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'super-bot'));
  const profile = ctx.get?.('profileContext');
  const owner: BotOwner = (profile?.name ?? process.env.DSH_PROFILE) === 'desktop' ? 'desktop' : 'web';
  const peer = oppositeOwner(owner), binding = bindMirror(dataDir, owner, profile, config.mirrorDir);
  const store = new Store(join(dataDir, 'ledger.sqlite'), new BotMemory(dataDir));
  store.maxRunningTasks=runtimeLimits(config).maxRunningTasks;
  let pairingIssue = binding.issue;
  const mirrorReady = binding.pair && startMirror(binding.pair, query => readLocalMirror(store, query)).catch(() => {
    pairingIssue = '无法启动本端只读镜像监听。';
    ctx.logger.warn(`[super-bot] ${pairingIssue}`);
  });
  const reloadAdmission=new ReloadAdmission();
  const execution=new DshExecution(ctx,store,dataDir,config,reloadAdmission);
  const managers=new Managers(ctx,store,execution,dataDir,()=>ctx.webServer.getOrigin(),config,reloadAdmission);
  const sidebar=new NativeSidebar(ctx,store);
  let reloadHost: ReturnType<typeof startReloadHost>;
  const build = typeof __SUPER_BOT_RELOAD_BUILD__ === 'string' ? __SUPER_BOT_RELOAD_BUILD__ : '';
  const root = realpathSync(checkout);
  const source = (profile && profileSource(root, profile.dir)) ?? root;
  const developer = developerSettings(profile, root, build, () => reloadHost?.available() ? reloadHost.ready : undefined);
  let feishuReady: ReturnType<typeof startFeishuHost> | undefined;
  ctx.effect(() => async () => {
    reloadHost?.close();
    await (await feishuReady)?.close();
    await (await mirrorReady)?.close();
    await managers.dispose();await execution.dispose();store.close();
    reloadHost?.retired();
  });
  const mirror = await mirrorReady;
  execution.install();
  managers.install();
  const feishu = await (feishuReady = startFeishuHost(ctx, store, managers, config.feishu?.enabled === true, profile?.dir, undefined, reloadAdmission));
  const require = createRequire(import.meta.url);
  const runtime = require('@deepseek-ai/dsh-agent/package.json').version as string;
  const startedAt = Date.now();
  const status = (): WorkspaceStatus => ({ product: 'Super Bot', version: require('../package.json').version as string, runtime,
    ...store.sqliteInfo(), startedAt, configWarnings:execution.policy.warnings, mirrorIssue: pairingIssue ?? mirror?.configurationIssue() });

  function taskInScope(payload: Record<string, unknown>) {
    const task = store.getTask(requiredText(payload.id, '任务标识', 200));
    if (payload.sessionId !== undefined && store.botForSession(requiredText(payload.sessionId, '会话标识', 200))?.id !== task.botId) {
      throw new AppError('not-found', '链接中的任务不属于当前 Bot 对话或已不可用。');
    }
    return task;
  }

  async function mirrorCatalog(): Promise<MirrorCatalog> {
    if (!mirror) return { owner, peer, state: pairingIssue ? 'unverified' : 'disabled', reason: pairingIssue, bots: [] };
    try {
      const bots = await mirror.read({ op: 'catalog' }) as MirrorBot[];
      return { owner, peer, state: 'online', bots };
    } catch (cause) {
      if (cause instanceof AppError && cause.code === 'mirror-offline') return { owner, peer, state: 'offline', bots: [] };
      return { owner, peer, state: 'unverified', reason: cause instanceof AppError ? cause.message : '镜像暂不可用。', bots: [] };
    }
  }

  async function sessionOrigin(payload: Record<string, unknown>): Promise<SessionOrigin | null> {
    const { sessionId } = payload;
    if (Object.keys(payload).some(key => key !== 'action' && key !== 'sessionId') || typeof sessionId !== 'string') {
      throw new AppError('invalid-input', '请仅提供当前原生会话标识。');
    }
    if (!managedSessionId.test(sessionId)) return null;
    if (store.ownsManagedSession(sessionId)) return { owner, local: true };
    try {
      const owned = await mirror?.read({ op: 'session-origin', sessionId });
      if (store.ownsManagedSession(sessionId)) return { owner, local: true };
      return owned === true ? { owner: peer, local: false } : null;
    } catch { return null; }
  }

  async function invoke(endpoint: string, payload: Record<string, unknown>) {
    try {
      if (endpoint === 'session.origin') return { ok: true, value: await sessionOrigin(payload) };
      if (endpoint === 'mirror.catalog' && Object.keys(payload).length === 1) return { ok: true, value: await mirrorCatalog() };
      if (endpoint === 'mirror.tasks' || endpoint === 'mirror.detail') {
        const { action: _action, owner: requestedOwner, ...fields } = payload;
        if (requestedOwner !== peer || 'op' in fields) throw new AppError('invalid-input', '镜像来源不匹配。');
        const query = parseMirrorQuery({ ...fields, op: endpoint === 'mirror.tasks' ? 'tasks' : 'detail' });
        if (!mirror) throw new AppError('mirror-unverified', pairingIssue ?? '尚未启用配对镜像。');
        return { ok: true, value: await mirror.read(query) };
      }
      if ('owner' in payload) throw new AppError('invalid-input', '此入口只操作本机原账本。');
      if (endpoint.startsWith('developer.')) return { ok: true, value: await developer(endpoint, payload) };
      if (endpoint.startsWith('feishu.')) return { ok: true, value: await feishu.invoke(endpoint, payload) };
      if (endpoint === 'manager.notification.resolve') {
        const botId = requiredText(payload.botId, 'Bot 标识', 200);
        if (payload.sessionId !== undefined && store.botForSession(requiredText(payload.sessionId, '会话标识', 200))?.id !== botId) {
          throw new AppError('not-found', '通知不属于当前 Bot 对话或已不可用。');
        }
        managers.resolveNotification(requiredText(payload.requestId, '请求标识', 200), botId,
          requiredText(payload.eventId, '通知标识', 300), payload.resolution as 'handled' | 'retry-unsent', payload.acknowledged);
        return { ok: true, value: store.managerInfo(botId) };
      }
      if (endpoint === 'status') return { ok: true, value: status() };
      if (endpoint === 'backup.create') return {ok:true,value:await createLedgerBackup(store,dataDir,requiredText(payload.requestId,'请求标识',200))};
      if (endpoint === 'bot.list') return { ok: true, value: store.listBots() };
      if (endpoint === 'bot.for-session') return { ok: true, value: store.botForSession(requiredText(payload.sessionId,'会话标识',200)) };
      if (endpoint === 'sidebar.tidy' || endpoint === 'sidebar.pin') {
        const botId=requiredText(payload.botId,'Bot 标识',200),sessionId=requiredText(payload.sessionId,'主聊天标识',200);
        return {ok:true,value:endpoint==='sidebar.tidy'?await sidebar.tidy(botId,sessionId):await sidebar.pin(botId,sessionId)};
      }
      if (endpoint === 'manager.prepare') return {ok:true,value:await managers.prepare(requiredText(payload.requestId,'请求标识',200),requiredText(payload.botId,'Bot 标识',200))};
      if (endpoint === 'manager.replace') return {ok:true,value:await managers.replace(requiredText(payload.requestId,'请求标识',200),requiredText(payload.botId,'Bot 标识',200),payload.expectedGeneration as number)};
      if (endpoint === 'manager.status') return {ok:true,value:{...store.managerInfo(requiredText(payload.botId,'Bot 标识',200)),wakeLimit:runtimeLimits(config).managerWakesPerHour}};
      if (endpoint === 'workdir.cleanup') return {ok:true,value:await execution.cleanupWorkdir(requiredText(payload.id,'任务标识',200))};
      if (endpoint === 'bot.create') return {ok:true,value:await managers.createBot(requiredText(payload.requestId,'请求标识',200),payload as unknown as NewBot)};
      if (endpoint === 'bot.update') return {ok:true,value:await managers.updateBot(requiredText(payload.requestId,'请求标识',200),requiredText(payload.id,'Bot 标识',200),payload.expectedRevision as number,payload as unknown as NewBot)};
      if (endpoint === 'task.create') return { ok: true, value: store.createTask(requiredText(payload.requestId,'请求标识',200),payload as unknown as NewTask) };
      if (endpoint === 'task.inbox') return { ok: true, value: store.taskInbox(requiredText(payload.botId,'Bot 标识',200)) };
      if (endpoint === 'task.list') return { ok: true, value: store.listTasks({
        botId: requiredText(payload.botId,'Bot 标识',200), q: optionalText(payload.q,'搜索',200),
        lifecycle: optionalText(payload.lifecycle,'状态',30), limit: payload.limit as number | undefined, offset: payload.offset as number | undefined,
      }) };
      if (endpoint === 'task.detail') {
        const task = taskInScope(payload), snapshot = store.taskDetail(task.id);
        const recovery = execution.recoveryDetail(snapshot);
        const childWaits = execution.childWaitDetails(task.id);
        const model = await execution.modelPreview(task.botId, task.id);
        taskInScope(payload);
        const detail = { ...snapshot, recovery, model, childWaits,
          reloadEligible: snapshot.binding?.cwd === source };
        if (payload.resultId === undefined) return { ok: true, value: detail };
        const result = store.resultById(requiredText(payload.resultId, '成果标识', 200));
        const linkedResult = result?.taskId === task.id ? store.deliveredResult(task, result) ?? result : null;
        const linkedChatDelivery = linkedResult?.id === detail.result?.id ? detail.chatDelivery : store.chatDeliveryStatus(task, linkedResult, true);
        return { ok: true, value: { ...detail, linkedResult, linkedChatDelivery, linkedResultBelongs: linkedResult !== null } };
      }
      if (endpoint === 'task.model-history') {
        if (Object.keys(payload).some(key => !['action', 'id', 'sessionId'].includes(key))) {
          throw new AppError('invalid-input', '请仅提供本端任务与当前 Bot 会话标识。');
        }
        const task = taskInScope(payload);
        const runs = await execution.modelHistory(task.id);
        taskInScope(payload);
        return { ok: true, value: { taskId: task.id, runs } };
      }
      if (endpoint === 'task.dispatch') {
        const { id } = taskInScope(payload);
        return {ok:true,value:await execution.dispatch(requiredText(payload.requestId,'请求标识',200),id,
          payload.expectedRowVersion as number,()=>{taskInScope(payload);})};
      }
      if (endpoint === 'task.stop') return {ok:true,value:await execution.stop(requiredText(payload.requestId,'请求标识',200),requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number)};
      if (endpoint === 'task.cancel'||endpoint==='session.detach') return {ok:true,value:await execution.endTaskLink(endpoint,requiredText(payload.requestId,'请求标识',200),requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number)};
      if (endpoint === 'run.recover' || endpoint === 'run.recover-and-continue') {
        const { id } = taskInScope(payload);
        const continuation = endpoint === 'run.recover-and-continue' ? {
          attentionId: requiredText(payload.attentionId, '恢复事项标识', 200),
          bindingId: requiredText(payload.bindingId, '会话关联标识', 200),
          expectedBindingGeneration: payload.expectedBindingGeneration as number,
        } : undefined;
        if (continuation && (!Number.isSafeInteger(continuation.expectedBindingGeneration) || continuation.expectedBindingGeneration < 1)) {
          throw new AppError('invalid-input', '请刷新后使用当前会话关联版本核对。');
        }
        return {ok:true,value:await execution.recover(requiredText(payload.requestId,'请求标识',200),id,
          payload.expectedRowVersion as number,payload.acknowledged,continuation,()=>{taskInScope(payload);})};
      }
      if (endpoint === 'result.accept' || endpoint === 'result.reject') {
        const args = [requiredText(payload.requestId,'请求标识',200), taskInScope(payload).id,
          payload.expectedRowVersion as number, requiredText(payload.resultId,'成果标识',200)] as const;
        const authorize = payload.sessionId === undefined ? undefined : () => { taskInScope(payload); };
        return {ok:true,value:endpoint === 'result.accept' ? await execution.accept(...args,authorize)
          : store.rejectResult(...args,requiredText(payload.text,'返工要求'))};
      }
      if (endpoint === 'attention.respond') {
        const attentionId = requiredText(payload.attentionId,'待办标识',200);
        if (payload.id !== undefined || payload.sessionId !== undefined) {
          const task = taskInScope(payload);
          if (!store.taskDetail(task.id).attentions.some(attention => attention.id === attentionId)) {
            throw new AppError('not-found', '问题不属于当前任务。');
          }
        }
        return {ok:true,value:store.respondAttention(requiredText(payload.requestId,'请求标识',200),attentionId,
          payload.expectedRowVersion as number,requiredText(payload.text,'回答'))};
      }
      if (endpoint === 'session.prepare') return {ok:true,value:await execution.prepareSession(requiredText(payload.requestId,'请求标识',200),requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number)};
      if (endpoint === 'session.inspect') return {ok:true,value:await execution.inspectExistingSession(requiredText(payload.id,'任务标识',200),requiredText(payload.sessionId,'会话标识',200))};
      if (endpoint === 'session.attach') return {ok:true,value:await execution.attachExistingSession(requiredText(payload.requestId,'请求标识',200),{taskId:requiredText(payload.id,'任务标识',200),expectedRowVersion:payload.expectedRowVersion as number,sessionId:requiredText(payload.sessionId,'会话标识',200),cwd:requiredText(payload.cwd,'工作目录'),fullHistoryApproved:payload.fullHistoryApproved===true,directoryApproved:payload.directoryApproved===true})};
      if (endpoint === 'session.reconcile') return {ok:true,value:await execution.reconcileBinding(requiredText(payload.id,'会话关联标识',200))};
      if (endpoint === 'task.control') return { ok: true, value: store.controlTask(requiredText(payload.requestId,'请求标识',200),
        requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number,payload.mode as ControlMode) };
      if (endpoint === 'task.revise') return { ok: true, value: store.reviseTask(requiredText(payload.requestId,'请求标识',200),
        requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number,payload as unknown as NewTask) };
      throw new AppError('not-found', '未知操作。');
    } catch (error) {
      return { ok: false, error: { code: error instanceof AppError ? error.code : 'internal',
        message: error instanceof AppError ? error.message : '操作未完成，请检查宿主日志并核对状态。', details: {} } };
    }
  }
  // Read-only artifact links work in native chat. Never accept a caller-supplied path.
  ctx.effect(()=>ctx.connection.fetch.register({path:RESULT_FILE_PATH,methods:['GET'],requestBody:'buffered',fetch:async request=>{
    const headers = { 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' };
    try {
      const params=new URL(request.url).searchParams,resultId=params.get('resultId')??'',index=Number(params.get('index'));
      const result=store.resultById(resultId);
      const sessions=params.getAll('sessionId');
      if(!result||!params.has('index')||!Number.isSafeInteger(index)||index<0||!result.evidence[index]
        ||(sessions.length>0&&(sessions.length!==1||store.botForSession(sessions[0])?.id!==store.getTask(result.taskId).botId))) {
        return new Response('找不到成果文件。',{status:404,headers});
      }
      const evidence = result.evidence[index];
      let bytes = store.resultAttachment(result.id, index);
      if (bytes === undefined) {
        const run = store.getRun(result.runId), binding = store.getBinding(run.bindingId);
        bytes = await readEvidence(binding.cwd, evidence);
      } else if (bytes.length !== evidence.bytes || createHash('sha256').update(bytes).digest('hex') !== evidence.sha256) {
        throw new AppError('attachment-invalid','保存的附件副本无法通过校验。请从有效的账本备份恢复，或请 Bot 重新提交成果。');
      }
      if (params.get('preview') === '1') {
        if (!previewExtensions.has(extname(evidence.path).toLowerCase()) || !isUtf8(bytes) || bytes.includes(0)) {
          return new Response('此文件不支持文本预览，可下载原文件。',{status:415,headers});
        }
        return new Response(new Uint8Array(bytes),{headers:{...headers,'Content-Type':'text/plain; charset=utf-8'}});
      }
      return new Response(new Uint8Array(bytes),{headers:{...headers,'Content-Type':'application/octet-stream',
        'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(basename(evidence.path))}`}});
    }catch(error){return new Response(error instanceof AppError?error.message:'无法读取成果文件。',{status:409,headers});}
  }}));
  // Exact routes are authenticated and owner-only by DSH Connection on every carrier.
  // Do not take its sole shared-RPC interceptor (that belongs to the API Gateway).
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/super-bot', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      let body: unknown;
      try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
      const envelope = body as { type?: string; rpcId?: string; method?: string; payload?: Record<string,unknown> } | null;
      if (!envelope || envelope.type !== 'client-request' || typeof envelope.rpcId !== 'string'
        || envelope.method !== 'super-bot' || typeof envelope.payload?.action !== 'string') {
        return new Response('Invalid command envelope', { status: 400 });
      }
      return Response.json({ type: 'server-response', rpcId: envelope.rpcId,
        result: await invoke(envelope.payload.action, envelope.payload) }, { headers: { 'Cache-Control': 'no-store' } });
    },
  }));

  // HMR is optional for the product. Register its development control only once the launcher is ready.
  await ctx.inject(['profileContext','hmr','appReady'],scope=>{
    const {profileContext:profile,hmr,appReady}=scope;
    if(typeof hmr.watchConfig!=='function'||typeof hmr.reconcileProfile!=='function'||!appReady)return;
    scope.effect(()=>{
      let host: ReturnType<typeof startReloadHost>;
      const log=(message:string)=>ctx.logger.warn(`[super-bot] ${message}`);
      const unsubscribe=appReady.onReady(()=>{
        try {
          host=reloadHost=startReloadHost({profile,hmr,root,
            build,checkLease:id=>checkDeveloperLease(realpathSync(profile.dir),id),admission:reloadAdmission,
            reloadResult:{evidence:id=>store.devReloadResult(id,source).result.evidence,record:receipt=>store.recordDevReload(source,receipt)},
            blockers:()=>[...execution.reloadBlockers(),...managers.reloadBlockers(),...feishu.reloadBlockers()],log});
        } catch(error) { log(`Development reload unavailable: ${error instanceof Error?error.message:'unknown failure'}`); }
      });
      return ()=>{unsubscribe();host?.close();};
    });
  });
}

declare const __SUPER_BOT_RELOAD_BUILD__: string;
