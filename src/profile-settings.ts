import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './model.ts';

export const FILE = 'super-bot.json';
const SETTINGS_LIMIT = 64 * 1024;
const LEGACY_LIMIT = 4096;
export const STORAGE_ERROR = '无法读取或保存当前 profile 的 Super Bot 设置。请核对本机设置文件及权限。';

export type Document = Record<string, unknown>;

export function storageError(): AppError {
  return new AppError('feishu-settings-storage', STORAGE_ERROR);
}

export function isDocument(value: unknown): value is Document {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readDocument(path: string, legacy = false): Document | undefined {
  const limit = legacy ? LEGACY_LIMIT : SETTINGS_LIMIT;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw storageError();
  }
  try {
    const stat = fstatSync(fd);
    const unsafeMode = legacy ? Boolean(stat.mode & 0o077) : (stat.mode & 0o7777) !== 0o600;
    if (!stat.isFile() || stat.size > limit || (process.getuid && stat.uid !== process.getuid())
      || stat.nlink !== 1 || unsafeMode) throw storageError();
    const buffer = Buffer.alloc(limit + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    const content = buffer.subarray(0, bytes);
    if (bytes !== stat.size || !isUtf8(content)) throw storageError();
    const document: unknown = JSON.parse(content.toString('utf8'));
    if (!isDocument(document)) throw storageError();
    return document;
  } finally {
    closeSync(fd);
  }
}

export function publish(profileDir: string, document: Document): void {
  const content = JSON.stringify(document, null, 2) + '\n';
  if (Buffer.byteLength(content) > SETTINGS_LIMIT) throw storageError();
  const tempPath = join(profileDir, `.${FILE}.${randomUUID()}.tmp`);
  const fd = openSync(tempPath, 'wx', 0o600);
  try {
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, content, { flush: true });
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, join(profileDir, FILE));
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* Keep the publication error. */ }
    throw error;
  }
}

export function developerMode(dir: string): boolean {
  const value = readDocument(join(dir, FILE))?.developerMode;
  if (value !== undefined && typeof value !== 'boolean') throw storageError();
  return value === true;
}

export function saveDeveloperMode(dir: string, enabled: boolean): void {
  // Synchronous read/merge/rename keeps both settings sections intact within the owning host.
  const document = readDocument(join(dir, FILE)) ?? {};
  publish(dir, { ...document, developerMode: enabled });
}
