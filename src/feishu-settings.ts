import { join } from 'node:path';
import { AppError } from './model.ts';
import {
  FILE,
  STORAGE_ERROR,
  storageError,
  isDocument,
  readDocument,
  publish,
  type Document,
} from './profile-settings.ts';
import {
  isFeishuOpenId,
  type FeishuConfig,
  type FeishuCredentials,
  type FeishuIdentity,
} from './feishu-types.ts';
const LEGACY_FILE = 'super-bot.feishu.json';
const LEGACY_ERROR = '无法导入旧飞书设置。请在 Super Bot 的飞书设置中填写完整凭证。';
type SelfTestEvidence = FeishuIdentity & { confirmedAt: number };
export type SavedFeishuSettings = FeishuConfig & {
  enabled: boolean;
  selfTestSkipped?: true;
  selfTestEvidence?: SelfTestEvidence;
};

function readSettings(document: Document): SavedFeishuSettings | undefined {
  if (!Object.hasOwn(document, 'feishu')) return;
  const { feishu } = document;
  if (!isDocument(feishu) || typeof feishu.enabled !== 'boolean') throw storageError();
  const ownerOpenId =
    typeof feishu.ownerOpenId === 'string' ? feishu.ownerOpenId.trim() : feishu.ownerOpenId;
  if (ownerOpenId !== undefined && !isFeishuOpenId(ownerOpenId)) throw storageError();
  if (feishu.selfTestSkipped !== undefined && feishu.selfTestSkipped !== true) throw storageError();
  if (ownerOpenId && feishu.selfTestSkipped) throw storageError();
  const credentials = feishuCredentials(feishu);
  const evidence = feishu.selfTestEvidence;
  const selfTestEvidence =
    ownerOpenId &&
    isDocument(evidence) &&
    evidence.appId === credentials.appId &&
    evidence.ownerOpenId === ownerOpenId &&
    typeof evidence.confirmedAt === 'number' &&
    Number.isSafeInteger(evidence.confirmedAt) &&
    evidence.confirmedAt > 0
      ? { appId: credentials.appId, ownerOpenId, confirmedAt: evidence.confirmedAt }
      : undefined;
  return {
    ...credentials,
    enabled: feishu.enabled,
    ownerOpenId,
    selfTestSkipped: feishu.selfTestSkipped,
    selfTestEvidence,
  };
}

export function feishuCredentials(fields: Document, saved?: FeishuCredentials): FeishuCredentials {
  const appId = typeof fields.appId === 'string' ? fields.appId.trim() : '';
  let appSecret = fields.appSecret;
  if (!/^cli_[a-zA-Z0-9]{1,196}$/.test(appId)) {
    throw new AppError('feishu-settings-input', '请输入有效的飞书 App ID。');
  }
  if ((appSecret === undefined || appSecret === '') && saved?.appId === appId)
    appSecret = saved.appSecret;
  if (typeof appSecret !== 'string' || !appSecret.trim() || appSecret.length > 2048) {
    throw new AppError('feishu-settings-input', '请填写此飞书应用的 App Secret。');
  }
  return { appId, appSecret };
}

export function loadFeishuSettings(
  profileDir: string | undefined,
  legacyEnabled: boolean,
): { saved?: SavedFeishuSettings; error?: string } {
  if (!profileDir) return { error: STORAGE_ERROR };
  let document: Document | undefined;
  try {
    document = readDocument(join(profileDir, FILE));
    if (document && Object.hasOwn(document, 'feishu')) return { saved: readSettings(document) };
  } catch {
    return { error: STORAGE_ERROR };
  }

  let saved: SavedFeishuSettings;
  try {
    const legacy = readDocument(join(profileDir, LEGACY_FILE), true);
    if (!legacy) return legacyEnabled && !document ? { error: LEGACY_ERROR } : {};
    const ownerOpenId =
      typeof legacy.ownerOpenId === 'string' ? legacy.ownerOpenId.trim() : undefined;
    if (!isFeishuOpenId(ownerOpenId)) return { error: LEGACY_ERROR };
    saved = { ...feishuCredentials(legacy), enabled: legacyEnabled, ownerOpenId };
  } catch {
    return { error: LEGACY_ERROR };
  }
  try {
    publish(profileDir, { ...document, feishu: saved });
    return { saved };
  } catch {
    return { error: STORAGE_ERROR };
  }
}

export function saveFeishuSettings(
  profileDir: string | undefined,
  saved: SavedFeishuSettings,
): void {
  if (!profileDir) throw storageError();
  try {
    const document = readDocument(join(profileDir, FILE)) ?? {};
    readSettings(document);
    const feishu = isDocument(document.feishu) ? document.feishu : {};
    publish(profileDir, {
      ...document,
      feishu: {
        ...feishu,
        ...saved,
        ownerOpenId: saved.ownerOpenId,
        selfTestSkipped: saved.selfTestSkipped,
        selfTestEvidence: saved.selfTestEvidence,
      },
    });
  } catch {
    throw storageError();
  }
}
