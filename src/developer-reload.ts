import { fork } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { developerMode, saveDeveloperMode } from './profile-settings.ts';
import { profileSource, reloadId, type ReloadEndpoint } from './dev-reload-paths.ts';
import { AppError } from './model.ts';

type Operation = { id: string; state: 'running' | 'applied' | 'failed' | 'unconfirmed'; build?: string; message?: string };
export type DeveloperView = { enabled: boolean; profile: string; unavailable?: string; build: string; operation?: Operation };
const key = Symbol.for('@zxdvd/super-bot/developer-operations');
const scope = globalThis as typeof globalThis & { [key]?: Map<string, Operation> };
const operations = scope[key] ??= new Map();
type Profile = { name: string; dir: string; home: string };

export function checkDeveloperLease(dir: string, id: string): string[] {
  const job = operations.get(dir);
  return job?.state === 'running' && job.id === id && !developerMode(dir) ? ['本端开发者模式已关闭。'] : [];
}

export function developerSettings(profile: Profile | undefined, root: string, build: string,
  ready: () => Promise<ReloadEndpoint> | undefined) {
  const dir = profile && realpathSync(profile.dir);
  const source = dir && profileSource(root, dir);
  function view(): DeveloperView {
    if (!profile || !dir) throw new AppError('profile-unavailable', '当前宿主缺少 profile。');
    return { enabled: developerMode(dir), profile: profile.name, build, operation: operations.get(dir),
      unavailable: !source ? '此安装未使用本 profile 的独立开发包。请按开发热加载说明配置。'
        : !ready() ? '本端原生 HMR 未就绪，请检查 HMR 已启用且 root 为空。' : undefined };
  }
  return async (action: string, payload: Record<string, unknown>) => {
    if (!profile || !dir) throw new AppError('profile-unavailable', '当前宿主缺少 profile。');
    const current = view();
    const fields = action === 'developer.save' ? ['enabled'] : action === 'developer.reload' ? ['requestId','previousId'] : [];
    if (Object.keys(payload).some(k => k !== 'action' && !fields.includes(k))) {
      throw new AppError('invalid-input', '请使用当前宿主的开发者设置。');
    }
    if (action === 'developer.get') return current;
    if (action === 'developer.save' && typeof payload.enabled === 'boolean') {
      if (current.operation?.state === 'running') throw new AppError('busy', '本端重载正在进行。');
      saveDeveloperMode(dir, payload.enabled);
      return view();
    }
    if (action !== 'developer.reload' || typeof payload.requestId !== 'string' || !reloadId.test(payload.requestId)) {
      throw new AppError('invalid-input', '开发者设置请求无效。');
    }
    if (!current.enabled) throw new AppError('disabled', '本端开发者模式已关闭。');
    const connection = ready();
    if (!source || !connection || current.unavailable) throw new AppError('unavailable', current.unavailable ?? '本端 HMR 未就绪。');
    const endpoint = await connection.catch(() => { throw new AppError('unavailable', '无法连接本端 HMR。'); });
    if (!developerMode(dir)) throw new AppError('disabled', '本端开发者模式已关闭。');
    const previous = operations.get(dir);
    if (previous?.id === payload.requestId) return view();
    if (previous?.state === 'running' || (payload.previousId ?? null) !== (previous?.id ?? null)) {
      throw new AppError('busy', '重载状态已变化，请核对当前操作。');
    }
    const job: Operation = { id: payload.requestId, state: 'running' };
    operations.set(dir, job);
    try {
      const child = fork(join(source, 'scripts/dev-reload.mjs'), [], {
        cwd: source, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: profile.home,
          SUPER_BOT_PROFILE: profile.name, SUPER_BOT_EXPECT_INSTANCE: endpoint.instance, SUPER_BOT_OPERATION_ID: job.id },
      });
      child.on('message', (message: Record<string, unknown>) => {
        if (message.state === 'applied' && message.build === job.id) {
          job.build = job.id; job.state = 'applied';
        } else if (message.state === 'failed' || message.state === 'unconfirmed') {
          job.state = message.state;
          job.message = String(message.message ?? '请检查宿主日志。').slice(0, 1500);
        }
      });
      child.once('error', () => { job.state = 'failed'; job.message = '启动本地构建工具失败。'; });
      child.once('close', () => {
        if (job.state === 'running') { job.state = 'unconfirmed'; job.message = '未收到发布回执，请核对插件和宿主日志。'; }
      });
    } catch {
      job.state = 'failed'; job.message = '无法启动本地构建工具。';
    }
    return view();
  };
}
