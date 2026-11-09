import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-host-webserver';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename,join,resolve } from 'node:path';
import { readEvidence } from './evidence.ts';
import { Store } from './store.ts';
import { DshExecution } from './dsh.ts';
import {runtimeLimits,type RuntimeOptions} from './runtime.ts';
import { Managers } from './manager.ts';
import { NativeSidebar } from './sidebar.ts';
import { createLedgerBackup } from './backups.ts';
import { AppError, requiredText, optionalText,type WorkspaceStatus, type NewBot, type NewTask, type ControlMode } from './model.ts';

export const name = 'super-bot';
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
  maxRunningTasks:Schema.natural().min(1).default(2).description('全局同时执行的 Worker 任务数'),managerWakesPerHour:Schema.natural().min(1).default(20).description('每个 Bot 每小时自动唤醒上限；达到后记录问题并暂停自动唤醒'),managerConcurrentWakes:Schema.natural().min(1).default(2).description('同时自动唤醒的 Bot 数'),managerTurnMinutes:Schema.natural().min(1).default(5).description('单次自动 Bot 轮次上限（分钟）'),managerModel:roleModel,workerModel:roleModel });

export function apply(ctx: Context, config: RuntimeOptions & { dataDir?: string } = {}): void {
  const dataDir = resolve(config.dataDir ?? process.env.SUPER_BOT_DATA_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'super-bot'));
  const store = new Store(join(dataDir, 'ledger.sqlite'));store.maxRunningTasks=runtimeLimits(config).maxRunningTasks;
  const execution=new DshExecution(ctx,store,dataDir,config);
  const managers=new Managers(ctx,store,execution,dataDir,()=>ctx.webServer.getOrigin(),config);
  const sidebar=new NativeSidebar(ctx,store);
  ctx.effect(() => async () => {await managers.dispose();await execution.dispose();store.close();});
  execution.install();
  managers.install();
  const require = createRequire(import.meta.url);
  const runtime = require('@deepseek-ai/dsh-agent/package.json').version as string;
  const startedAt = Date.now();
  const status = (): WorkspaceStatus => ({ product: 'Super Bot', version: require('../package.json').version as string, runtime,
    ...store.sqliteInfo(), startedAt, configWarnings:execution.policy.warnings });

  async function invoke(endpoint: string, payload: Record<string, unknown>) {
    try {
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
      if (endpoint === 'task.list') return { ok: true, value: store.listTasks({
        botId: requiredText(payload.botId,'Bot 标识',200), q: optionalText(payload.q,'搜索',200),
        lifecycle: optionalText(payload.lifecycle,'状态',30), limit: payload.limit as number | undefined, offset: payload.offset as number | undefined,
      }) };
      if (endpoint === 'task.detail') return { ok: true, value: store.taskDetail(requiredText(payload.id,'任务标识',200)) };
      if (endpoint === 'task.dispatch') return {ok:true,value:await execution.dispatch(requiredText(payload.requestId,'请求标识',200),requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number)};
      if (endpoint === 'task.stop') return {ok:true,value:await execution.stop(requiredText(payload.requestId,'请求标识',200),requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number)};
      if (endpoint === 'task.cancel'||endpoint==='session.detach') return {ok:true,value:await execution.endTaskLink(endpoint,requiredText(payload.requestId,'请求标识',200),requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number)};
      if (endpoint === 'run.recover') return {ok:true,value:await execution.recover(requiredText(payload.requestId,'请求标识',200),requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number,payload.acknowledged)};
      if (endpoint === 'result.accept') return {ok:true,value:await execution.accept(requiredText(payload.requestId,'请求标识',200),requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number,requiredText(payload.resultId,'成果标识',200))};
      if (endpoint === 'result.reject') return {ok:true,value:store.rejectResult(requiredText(payload.requestId,'请求标识',200),requiredText(payload.id,'任务标识',200),payload.expectedRowVersion as number,requiredText(payload.resultId,'成果标识',200),requiredText(payload.text,'返工要求'))};
      if (endpoint === 'attention.respond') return {ok:true,value:store.respondAttention(requiredText(payload.requestId,'请求标识',200),requiredText(payload.attentionId,'待办标识',200),payload.expectedRowVersion as number,requiredText(payload.text,'回答'))};
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
  ctx.effect(()=>ctx.connection.fetch.register({path:'/api/super-bot-file',methods:['GET'],requestBody:'buffered',fetch:async request=>{
    try {
      const params=new URL(request.url).searchParams,resultId=params.get('resultId')??'',index=Number(params.get('index'));
      const result=store.resultById(resultId);
      if(!result||!params.has('index')||!Number.isSafeInteger(index)||index<0||!result.evidence[index])return new Response('找不到成果文件。',{status:404});
      const run=store.getRun(result.runId),binding=store.getBinding(run.bindingId),evidence=result.evidence[index];
      const bytes=await readEvidence(binding.cwd,evidence);
      return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(basename(evidence.path))}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }catch(error){return new Response(error instanceof AppError?error.message:'无法读取成果文件。',{status:409,headers:{'Cache-Control':'no-store'}});}
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
        result: await invoke(envelope.payload.action, envelope.payload) });
    },
  }));
}
