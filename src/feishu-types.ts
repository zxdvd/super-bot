export interface FeishuCredentials {
  appId: string;
  appSecret: string;
}

export interface FeishuConfig extends FeishuCredentials {
  ownerOpenId?: string;
}

export interface FeishuIdentity {
  appId: string;
  ownerOpenId: string;
}

export type FeishuSelfBinding = 'unbound' | 'skipped' | 'bound';
export type FeishuCredentialStatus = 'passed' | 'failed' | 'unverified';

export interface FeishuSettingsView {
  appId: string;
  ownerOpenId: string;
  configurationId: string;
  selfBinding: FeishuSelfBinding;
  credentials: FeishuCredentialStatus;
  privateTest: 'passed' | 'untested';
  privateTestAt?: number;
  testStartToken?: string;
  hasSecret: boolean;
  enabled: boolean;
  connection: Exclude<FeishuConnectionState, 'reconnected'> | 'disabled' | 'offline';
  lastMessageAt: number | null;
  error?: string;
}

export interface FeishuCheckResult {
  credentials: FeishuCredentialStatus;
}

export interface FeishuGroupDiagnosis {
  ordinaryTextGrant: 'present' | 'missing' | 'unknown';
  receiveSubscription: 'present' | 'missing' | 'unknown';
}

export interface FeishuTextMessage {
  readonly chatId: string;
  readonly messageId: string;
  readonly senderOpenId: string;
  readonly text: string;
  readonly createdAt: number;
}

export interface FeishuGroupTextMessage extends FeishuTextMessage {
  readonly receiptKind: 'plain' | 'bot-mention' | 'unclassified';
  /** The normal message enters the host while the SDK verifies the bot's identity. */
  readonly botMentionProof?: Promise<boolean>;
}

export interface FeishuGroupEvidence {
  plainTextAt: number | null;
  botMentionAt: number | null;
}

export interface FeishuPrivateTextMessage extends FeishuTextMessage {
  readonly appId: string;
}

export interface FeishuSelfTestCandidate {
  readonly openId: string;
  readonly receivedAt: number;
  readonly preview: string;
  readonly confirmationToken: string;
}

export type FeishuSelfTestView = { sessionId: string; expiresAt: number } & (
  { state: 'waiting' | 'conflict' | 'expired' | 'interrupted' }
  | { state: 'sending' | 'send-failed' | 'sent'; candidate: FeishuSelfTestCandidate }
);

export type FeishuConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'reconnected' | 'stopped';

export interface FeishuGroup {
  chatId: string;
  name: string;
}

export interface FeishuBinding extends FeishuGroup {
  id: string;
  botId: string;
  boundAt: number;
}

export interface FeishuGroupPreview extends FeishuGroup {
  confirmationToken: string;
}

export interface FeishuHandlers {
  onMessage(message: FeishuGroupTextMessage): void | Promise<void>;
  onPrivateMessage?(message: FeishuPrivateTextMessage): void;
  onConnection(state: FeishuConnectionState): void;
}

export interface FeishuTransport {
  start(handlers: FeishuHandlers): void;
  stop(): void;
  sendText(chatId: string, text: string, uuid: string, canDispatch?: () => boolean): Promise<void>;
  inspectGroup(chatId: string): Promise<FeishuGroup>;
  createGroup(name: string, uuid: string): Promise<FeishuGroup>;
  diagnoseGroup(): Promise<FeishuGroupDiagnosis>;
}

export function isFeishuChatId(value: unknown): value is string {
  return typeof value === 'string' && /^oc_[A-Za-z0-9_]{1,125}$/.test(value);
}

export function isFeishuOpenId(value: unknown): value is string {
  return typeof value === 'string' && /^ou_[a-zA-Z0-9]{1,197}$/.test(value);
}
