import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { promisify } from 'node:util';
import { AppError } from './model.ts';

export const GIT_STATUS_QUERY = 'git-working-tree-status';
export const WORKER_QUERY_TOOL = 'super_bot_query';
export type GitStatusResult = {
  status: 'ok' | 'unavailable';
  message: string;
  head?: string;
  porcelain?: string;
};

const run = promisify(execFile);
const sandbox = '/usr/bin/sandbox-exec';
const appleGit = [
  '/Library/Developer/CommandLineTools/usr/bin/git',
  '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
];
// Execute only the system-installed Git binary. Repo-defined filters, external file
// monitors, helper programs, network connections and persistent writes are denied.
const profile = `(version 1)
  (deny default)
  (allow file-read*)
  (allow file-write-data (literal "/dev/null"))
  (allow process-fork)
  (allow process-exec ${appleGit.map((path) => `(literal "${path}")`).join(' ')})
  (allow sysctl-read)
  (allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))`;

export function parseGitStatusQuery(value: unknown): { kind: typeof GIT_STATUS_QUERY } {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 1 ||
    !('kind' in value) ||
    value.kind !== GIT_STATUS_QUERY
  ) {
    throw new AppError('invalid-query', '请选择固定的 Git 工作区状态查询。');
  }
  return { kind: GIT_STATUS_QUERY };
}

export async function gitWorkingTreeStatus(
  cwd: string,
  signal: AbortSignal,
  beforeRead: () => void,
): Promise<GitStatusResult> {
  if (process.platform !== 'darwin')
    return { status: 'unavailable', message: '当前宿主没有此 Git 查询所需的 macOS 只读沙箱。' };
  let git: string | undefined;
  for (const path of appleGit) {
    try {
      await access(path, constants.X_OK);
      git = path;
      break;
    } catch {
      /* Try the next supported Apple toolchain installation. */
    }
  }
  if (!git)
    return {
      status: 'unavailable',
      message: '未找到 Apple Command Line Tools 或标准 Xcode 安装提供的 Git。',
    };
  const invoke = (args: string[]) =>
    run(
      sandbox,
      [
        '-p',
        profile,
        git,
        '--no-pager',
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        '-c',
        'core.preloadIndex=false',
        '-c',
        'status.submoduleSummary=false',
        ...args,
      ],
      {
        cwd,
        signal,
        timeout: 5000,
        maxBuffer: 64 * 1024,
        killSignal: 'SIGKILL',
        env: {
          LC_ALL: 'C',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_ATTR_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    );
  beforeRead();
  try {
    const { stdout, stderr } = await invoke([
      'status',
      '--porcelain=v1',
      '--no-renames',
      '--untracked-files=all',
      '--ignore-submodules=dirty',
      '--',
      '.',
    ]);
    const head = (
      await invoke(['rev-parse', '--verify', 'HEAD']).catch(() => undefined)
    )?.stdout.trim();
    if (!stderr.trim())
      return {
        status: 'ok',
        porcelain: stdout,
        ...(head && /^([a-f0-9]{40}|[a-f0-9]{64})$/.test(head) ? { head } : {}),
        message: '已读取工作目录中的 Git 暂存、未暂存和未跟踪状态。子模块仅报告已记录的提交变化。',
      };
  } catch {
    /* A failed or partial query supplies no working-tree status. */
  }
  return {
    status: 'unavailable',
    message: '只读沙箱内无法取得完整 Git 状态。请核对工作目录及 Git 配置。',
  };
}
