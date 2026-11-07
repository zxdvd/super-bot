/** Values crossing the product/host boundary; no DSH or UI types. */
export interface WorkspaceStatus {
  product: 'Super Bot';
  version: string;
  runtime: string;
  sqliteVersion: string;
  journalMode: string;
  startedAt: number;
}

export class AppError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface Bot {
  id: string;
  name: string;
  instructions: string;
  configRevision: number;
  managerSessionId: string | null;
  createdAt: number;
  materials:ReferenceInfo[];
}
export interface ReferenceInfo {path:string;sha256:string;bytes:number}
export interface ReferenceMaterial extends ReferenceInfo {text:string}
export interface TaskBotContext {instructions:string;materials:ReferenceMaterial[]}
export type Lifecycle = 'open' | 'review' | 'completed' | 'cancelled';
export type ControlMode = 'auto' | 'paused' | 'manual';
export interface Task {
  id: string;
  botId: string;
  goal: string;
  scope: string;
  acceptance: string;
  reviewPolicy: 'human' | 'bot';
  lifecycle: Lifecycle;
  controlMode: ControlMode;
  taskRevision: number;
  rowVersion: number;
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
  status: 'unscheduled' | 'needs-input' | 'approval' | 'paused' | 'manual' | 'completed' | 'cancelled' | 'review' | 'queued' | 'running' | 'stopping' | 'recovery';
  managerReviewed?:boolean;
  botConfigRevision:number;
}
export interface TaskPage {
  items: Task[];
  total: number;
  offset: number;
  limit: number;
  snapshotVersion: number;
  counts: { all: number; open: number; review: number; completed: number; cancelled: number };
}
export interface NewBot { name: string; instructions: string;referencePaths?:string[] }
export function botDraft(input:NewBot):NewBot {
  const paths=input.referencePaths??[];
  if(!Array.isArray(paths)||paths.length>4)throw new AppError('invalid-input','最多指定四份本地参考文本。');
  const referencePaths=[...new Set(paths.map(path=>requiredText(path,'参考文本路径',2000)))];
  return {name:requiredText(input.name,'Bot 名称',80),instructions:requiredText(input.instructions,'Bot 职责'),...(referencePaths.length?{referencePaths}:{})};
}
export interface NewTask { botId: string; goal: string; scope: string; acceptance: string; reviewPolicy: 'human' | 'bot'; startPaused?:boolean }
export interface Binding {
  id: string; taskId: string; generation: number; taskRevision: number;
  requestedSessionId: string; sessionId: string | null; cwd: string;
  state: 'creating' | 'ready' | 'recovery' | 'released'; createdAt: number;
}
export interface ExistingSessionGrant {
  taskId:string;expectedRowVersion:number;sessionId:string;cwd:string;
  fullHistoryApproved:boolean;directoryApproved:boolean;
}
export interface ExistingSessionPreview {sessionId:string;cwd:string;quiet:boolean;reason:string}
export interface ManagerBinding {id:string;botId:string;generation:number;configRevision:number;requestedSessionId:string;sessionId:string|null;cwd:string;state:'creating'|'ready'|'recovery'|'released';createdAt:number}
export interface ManagerEvent {id:string;taskId:string|null;payload:string;state:string;createdAt:number}
export interface Run {
  id:string; taskId:string; bindingId:string; sessionId:string; taskRevision:number; generation:number;
  inputId:string; state:'queued'|'running'|'settled'|'failed'|'cancelling'|'cancelled'|'interrupted';
  createdAt:number; finishedAt:number|null; note:string;
}
export interface RunInput {id:string; taskId:string; kind:string; content:string; state:string; messageId:string|null; messageJson:string|null; attentionId:string|null; createdAt:number}
export interface Evidence {path:string;sha256:string;bytes:number}
export interface WorkReport {kind:'progress'|'waiting'|'ready'|'blocked'|'failed';summary:string;checks?:string;evidence?:Evidence[];requestedFiles?:string[]}
export interface Result {id:string;runId:string;taskId:string;taskRevision:number;summary:string;checks:string;evidence:Evidence[];createdAt:number;humanAcceptedAt:number|null}
export interface Attention {
  id: string; taskId: string; kind: 'input' | 'approval' | 'review' | 'recovery';
  question: string; taskRevision: number; state: 'open' | 'responding' | 'resolved' | 'stale'; createdAt: number;
}

export function taskStatus(task: Pick<Task, 'lifecycle' | 'controlMode' | 'scope' | 'acceptance'>): Task['status'] {
  if (task.lifecycle === 'completed' || task.lifecycle === 'cancelled') return task.lifecycle;
  if (!task.scope || !task.acceptance) return 'needs-input';
  if (task.controlMode === 'paused' || task.controlMode === 'manual') return task.controlMode;
  return task.lifecycle === 'review' ? 'review' : 'unscheduled';
}

export function requiredText(value: unknown, label: string, max = 10000): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError('invalid-input', `请填写${label}。`);
  const text = value.trim();
  if (text.length > max) throw new AppError('invalid-input', `${label}不能超过 ${max} 字符。`);
  return text;
}
export function optionalText(value: unknown, label: string, max = 10000): string {
  if (value === '' || value === undefined) return '';
  return requiredText(value, label, max);
}

/** Actual host user message, supplied by the adapter rather than model arguments. */
export interface ChatSource { sessionId:string; messageId:string; seq:number; text:string }
