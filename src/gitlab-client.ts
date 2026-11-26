import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitLabObservationOrigin } from './work-stage.ts';

export type GitLabReply = { code: number; data?: unknown };
export type GitLabRequest = (
  path: string,
  signal: AbortSignal,
  method?: 'GET' | 'POST',
) => Promise<GitLabReply>;

const exec = promisify(execFile);
const MAX_BODY = 1024 * 1024;

async function readBody(response: Response): Promise<unknown> {
  if (!response.body) return;
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let bytes = 0,
    body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(body + decoder.decode());
      bytes += value.byteLength;
      if (bytes > MAX_BODY) return;
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export function gitLabHttp(
  origin: string,
  token?: string,
  request: typeof fetch = fetch,
): GitLabRequest {
  return async (path, signal, method = 'GET') => {
    if (gitLabObservationOrigin(origin) !== origin || !path.startsWith('/api/v4/projects/'))
      return { code: 0 };
    try {
      const response = await request(new URL(path, origin), {
        method,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        headers: { Accept: 'application/json', ...(token ? { 'PRIVATE-TOKEN': token } : {}) },
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return { code: response.status };
      }
      return { code: response.status, data: await readBody(response).catch(() => undefined) };
    } catch {
      return { code: 0 };
    }
  };
}

/** Read the existing glab login for this exact host. Send API requests ourselves
 * so credentials cannot follow redirects and a POST is never retried by a CLI. */
export async function glabGitLab(
  origin: string,
  signal: AbortSignal,
): Promise<GitLabRequest | undefined> {
  if (gitLabObservationOrigin(origin) !== origin) return;
  const hostname = new URL(origin).host;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      [
        'PATH',
        'HOME',
        'USER',
        'LOGNAME',
        'XDG_CONFIG_HOME',
        'GLAB_CONFIG_DIR',
        'SYSTEMROOT',
      ].includes(key),
    ),
  );
  try {
    const { stdout } = await exec('glab', ['config', 'get', 'token', '--host', hostname], {
      cwd: '/',
      env,
      signal,
      timeout: 4000,
      maxBuffer: 8192,
      killSignal: 'SIGKILL',
    });
    const token = stdout.trim();
    if (/^[A-Za-z0-9_.~-]{12,512}$/.test(token)) return gitLabHttp(origin, token);
  } catch {
    /* A missing executable or matching login is an unavailable capability. */
  }
}

export async function gitLabReader(
  origin: string,
  configuredOrigin: string | undefined,
  signal: AbortSignal,
) {
  const http =
    gitLabObservationOrigin(configuredOrigin) === origin
      ? gitLabHttp(origin, process.env.SUPER_BOT_GITLAB_READ_TOKEN)
      : undefined;
  let login: Promise<GitLabRequest | undefined> | undefined;
  // The configured token may have lost access. The second route is read-only
  // even when the already logged-in local user can also play jobs.
  return async (path: string, readSignal: AbortSignal): Promise<GitLabReply> => {
    const primary = await http?.(path, readSignal);
    if (primary && ![401, 403, 404].includes(primary.code)) return primary;
    if (signal.aborted || readSignal.aborted) return { code: 0 };
    const cli = await (login ??= glabGitLab(origin, readSignal));
    return cli ? cli(path, readSignal) : (primary ?? { code: -1 });
  };
}
