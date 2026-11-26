import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const reloadPackage = '@zxdvd/super-bot';
export const reloadProtocol = 1;
export const reloadId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export const reloadArtifacts = ['index.js.map', 'client.js.map', 'client.js', 'index.js'] as const;
export const reloadDirectory = (profile: string) => join(profile, '.super-bot-reload');
export const reloadStage = (root: string, id: string) => join(root, '.runtime', `dev-reload-${id}`);

/** One physical output tree per checkout and canonical host profile. */
export function profilePackage(source: string, dir: string): string {
  const key = createHash('sha256').update(realpathSync(dir)).digest('hex');
  return join(source, '.runtime', 'profile-packages', key);
}

export function profileSource(root: string, dir: string): string | undefined {
  const source = resolve(root, '../../..');
  return root === profilePackage(source, dir) ? source : undefined;
}

export interface ReloadEndpoint {
  protocol: number;
  profile: string;
  dir: string;
  root: string;
  pid: number;
  instance: string;
  port: number;
  token: string;
}

export function isLinkedCheckout(dir: string, root: string): boolean {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const link = manifest.dependencies?.[reloadPackage];
  const installed = join(dir, 'node_modules', reloadPackage);
  return (
    typeof link === 'string' &&
    link.startsWith('link:') &&
    existsSync(installed) &&
    realpathSync(resolve(dir, link.slice(5))) === root &&
    realpathSync(installed) === root
  );
}

export function liveReloadEndpoints(dir: string): ReloadEndpoint[] {
  const directory = reloadDirectory(dir);
  if (!existsSync(directory)) return [];
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    (process.getuid && (info.uid !== process.getuid() || info.mode & 0o077))
  ) {
    throw Error('unsafe reload discovery directory');
  }
  const live: ReloadEndpoint[] = [];
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith('.json') || !reloadId.test(entry.slice(0, -5))) continue;
    const path = join(directory, entry);
    let endpoint: ReloadEndpoint;
    try {
      const file = lstatSync(path);
      if (
        !file.isFile() ||
        file.size > 8192 ||
        (process.getuid && (file.uid !== process.getuid() || file.mode & 0o077))
      ) {
        throw Error('unsafe reload discovery file');
      }
      endpoint = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (
      endpoint.protocol !== reloadProtocol ||
      endpoint.dir !== dir ||
      `${endpoint.instance}.json` !== entry ||
      !Number.isInteger(endpoint.pid) ||
      endpoint.pid < 1 ||
      !Number.isInteger(endpoint.port) ||
      endpoint.port < 1 ||
      endpoint.port > 65535 ||
      !/^[0-9a-f]{64}$/.test(endpoint.token)
    ) {
      throw Error('invalid reload discovery record');
    }
    try {
      process.kill(endpoint.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
      throw error;
    }
    live.push(endpoint);
  }
  return live;
}
