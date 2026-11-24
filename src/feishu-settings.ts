import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './model.ts';
import { isFeishuOpenId, type FeishuConfig, type FeishuCredentials, type FeishuIdentity } from './feishu-types.ts';

const FILE = 'super-bot.json';
const LEGACY_FILE = 'super-bot.feishu.json';
const SETTINGS_LIMIT = 64 * 1024;
const LEGACY_LIMIT = 4096;
const STORAGE_ERROR = '无法读取或保存当前 profile 的 Super Bot 设置。请核对本机设置文件及权限。';
const LEGACY_ERROR = '无法导入旧飞书设置。请在 Super Bot 的飞书设置中填写完整凭证。';

type Document = Record<string, unknown>;
type SelfTestEvidence = FeishuIdentity & { confirmedAt: number };
export type SavedFeishuSettings = FeishuConfig & { enabled: boolean; selfTestSkipped?: true; selfTestEvidence?: SelfTestEvidence };

function storageError(): AppError {
  return new AppError('feishu-settings-storage', STORAGE_ERROR);
}

function isDocument(value: unknown): value is Document {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readDocument(path: string, legacy = false): Document | undefined {
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

function readSettings(document: Document): SavedFeishuSettings | undefined {
  if (!Object.hasOwn(document, 'feishu')) return;
  const { feishu } = document;
  if (!isDocument(feishu) || typeof feishu.enabled !== 'boolean') throw storageError();
  const ownerOpenId = typeof feishu.ownerOpenId === 'string' ? feishu.ownerOpenId.trim() : feishu.ownerOpenId;
  if (ownerOpenId !== undefined && !isFeishuOpenId(ownerOpenId)) throw storageError();
  if (feishu.selfTestSkipped !== undefined && feishu.selfTestSkipped !== true) throw storageError();
  if (ownerOpenId && feishu.selfTestSkipped) throw storageError();
  const credentials = feishuCredentials(feishu);
  const evidence = feishu.selfTestEvidence;
  const selfTestEvidence = ownerOpenId && isDocument(evidence) && evidence.appId === credentials.appId && evidence.ownerOpenId === ownerOpenId
    && typeof evidence.confirmedAt === 'number' && Number.isSafeInteger(evidence.confirmedAt) && evidence.confirmedAt > 0
    ? { appId: credentials.appId, ownerOpenId, confirmedAt: evidence.confirmedAt } : undefined;
  return { ...credentials, enabled: feishu.enabled, ownerOpenId, selfTestSkipped: feishu.selfTestSkipped, selfTestEvidence };
}

function publish(profileDir: string, document: Document): void {
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

export function feishuCredentials(fields: Document, saved?: FeishuCredentials): FeishuCredentials {
  const appId = typeof fields.appId === 'string' ? fields.appId.trim() : '';
  let appSecret = fields.appSecret;
  if (!/^cli_[a-zA-Z0-9]{1,196}$/.test(appId)) {
    throw new AppError('feishu-settings-input', '请输入有效的飞书 App ID。');
  }
  if ((appSecret === undefined || appSecret === '') && saved?.appId === appId) appSecret = saved.appSecret;
  if (typeof appSecret !== 'string' || !appSecret.trim() || appSecret.length > 2048) {
    throw new AppError('feishu-settings-input', '请填写此飞书应用的 App Secret。');
  }
  return { appId, appSecret };
}

export function loadFeishuSettings(profileDir: string | undefined, legacyEnabled: boolean): {
  saved?: SavedFeishuSettings; error?: string;
} {
  if (!profileDir) return { error: STORAGE_ERROR };
  try {
    const document = readDocument(join(profileDir, FILE));
    if (document) return { saved: readSettings(document) };
  } catch {
    return { error: STORAGE_ERROR };
  }

  let saved: SavedFeishuSettings;
  try {
    const legacy = readDocument(join(profileDir, LEGACY_FILE), true);
    if (!legacy) return legacyEnabled ? { error: LEGACY_ERROR } : {};
    const ownerOpenId = typeof legacy.ownerOpenId === 'string' ? legacy.ownerOpenId.trim() : undefined;
    if (!isFeishuOpenId(ownerOpenId)) return { error: LEGACY_ERROR };
    saved = { ...feishuCredentials(legacy), enabled: legacyEnabled, ownerOpenId };
  } catch {
    return { error: LEGACY_ERROR };
  }
  try {
    publish(profileDir, { feishu: saved });
    return { saved };
  } catch {
    return { error: STORAGE_ERROR };
  }
}

export function saveFeishuSettings(profileDir: string | undefined, saved: SavedFeishuSettings): void {
  if (!profileDir) throw storageError();
  try {
    const document = readDocument(join(profileDir, FILE)) ?? {};
    readSettings(document);
    const feishu = isDocument(document.feishu) ? document.feishu : {};
    publish(profileDir, { ...document, feishu: {
      ...feishu, ...saved, ownerOpenId: saved.ownerOpenId, selfTestSkipped: saved.selfTestSkipped, selfTestEvidence: saved.selfTestEvidence,
    } });
  } catch {
    throw storageError();
  }
}
