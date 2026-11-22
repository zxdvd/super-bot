/** Values crossing the product/host boundary; no DSH or UI types. */
import type {WorkdirRequest,WorkdirInfo} from './workdir.ts';
export type {WorkdirRequest,WorkdirInfo};
export interface WorkspaceStatus {
  product: 'Super Bot';
  version: string;
  runtime: string;
  sqliteVersion: string;
  journalMode: string;
  startedAt: number;
  configWarnings?: string[];
  mirrorIssue?: string;
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
export interface TaskBotContext {
  instructions: string;
  materials: ReferenceMaterial[];
  workConvention?: { source: 'default' | 'override'; text: string };
}
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
  blockingAttention?: 'input' | 'approval' | 'recovery' | null;
  deliveredAt?: number;
  botConfigRevision:number;
  /** What the Bot asked for when creating the task; null means the configured default. */
  workdirRequest?:WorkdirRequest|null;
}
export const RESULT_FRESH_MS = 3 * 24 * 3600 * 1000;
export const TEST_TASK_PREFIX = '【测试】';
export const isTestTask = (task: Pick<Task, 'goal'>): boolean => task.goal.startsWith(TEST_TASK_PREFIX);

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
export interface NewTask { botId: string; goal: string; scope: string; acceptance: string; reviewPolicy: 'human' | 'bot'; startPaused?:boolean; workdir?:WorkdirRequest }
export interface Binding {
  id: string; taskId: string; generation: number; taskRevision: number;
  requestedSessionId: string; sessionId: string | null; cwd: string;
  state: 'creating' | 'ready' | 'recovery' | 'released'; createdAt: number;
  workdir?: WorkdirInfo | null;
}
export interface ExistingSessionGrant {
  taskId:string;expectedRowVersion:number;sessionId:string;cwd:string;
  fullHistoryApproved:boolean;directoryApproved:boolean;
}
export interface ExistingSessionPreview {sessionId:string;cwd:string;quiet:boolean;reason:string}
export interface ManagerBinding {id:string;botId:string;generation:number;configRevision:number;requestedSessionId:string;sessionId:string|null;cwd:string;state:'creating'|'ready'|'recovery'|'released';createdAt:number}
export interface ManagerEvent {id:string;taskId:string|null;payload:string;state:string;createdAt:number}
export type ChatDeliveryStatus = { state: 'awaiting-review' | 'pending' | 'uncertain' | 'delivered' | 'handled'; reason?: string };
export type UncertainDelivery = {
  id: string; taskId: string; taskGoal: string; resultId: string;
  reason: string; sessionId: string | null; at: number; turn?: number;
};
export type ReloadReceipt = { resultId: string; build: string; from: string; to: string; pid: number; at: number };
export type TaskProgress = {
  worker: { runId: string; summary: string; at: number } | null;
  runId: string | null;
  inputEnteredAt: number | null;
  acceptance: { actor: 'user' | 'bot'; at: number } | null;
  reload: ReloadReceipt | null;
};
export interface Run {
  id:string; taskId:string; bindingId:string; sessionId:string; taskRevision:number; generation:number;
  inputId:string; state:'queued'|'running'|'settled'|'failed'|'cancelling'|'cancelled'|'interrupted';
  createdAt:number; finishedAt:number|null; note:string;
}
export interface RunInput {id:string; taskId:string; kind:string; content:string; state:string; messageId:string|null; messageJson:string|null; attentionId:string|null; createdAt:number}

export interface ModelRoute {
  provider: string;
  model: string;
  reasoningEffort: string | null;
}
export type WorkerModelPlan = ModelRoute & (
  { source: 'role-override' | 'native-selection' } |
  { source: 'manager-inheritance'; sourceSessionId: string }
);
export interface ActualModelRequest extends ModelRoute {
  turn: number;
  step: number;
  eventSeq: number;
  headerSeq: number | null;
  evidence: 'assistant/message' | 'assistant/attempt';
}
export interface RunModels {
  runId: string;
  sessionId: string;
  createdAt: number;
  expected: WorkerModelPlan | null;
  actual: ActualModelRequest[];
}
export interface WorkerModelPreview {
  current: ModelRoute | null;
  expected: WorkerModelPlan | null;
}
export interface TaskModelHistory {
  taskId: string;
  runs: RunModels[];
}
export interface ChildWaitMember {
  nativeRunId: string;
  childId: string;
  parentSessionId: string;
  sessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  stopReason: string | null;
}
export interface RunChildWait {
  id: string;
  runId: string;
  turn: number;
  startSeq: number;
  inputSeq: number;
  source: 'ready' | 'turn-stopping';
  startedAt: number;
  endedAt: number | null;
  outcome: 'waiting' | 'checking' | 'converged' | 'clear' | 'cancelled' | 'unknown';
  pendingCount: number | null;
  children: ChildWaitMember[];
}
export type ChildWaitDetail = RunChildWait & { elapsedMs: number | null };

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

/** Actual host user input supplied by the adapter, never model arguments.
 * A single message retains its original shape. For a multi-message turn, the top-level
 * identity is the latest message; text is complete and messages preserves each source.
 */
export interface ChatSource { sessionId:string; messageId:string; seq:number; text:string; messages?:{messageId:string;seq:number;text:string}[] }

/** Why a prepared task is not running yet; holder is the task that has (or is ahead in line for) the slot or directory. */
export interface DispatchWait {code:'capacity'|'resource-conflict';holderTaskId:string|null;holderGoal:string|null}

export interface RecoveryContinuation {
  attentionId: string; bindingId: string; expectedBindingGeneration: number;
}
export type RecoveryInputKind = 'human' | 'task' | 'job-result' | 'child-result' | 'other';
export interface RecoveryInput {
  queue: 'next-turn' | 'next-step'; kind: RecoveryInputKind; count: number;
}
export interface RecoveryDetail {
  attentionId: string | null;
  canContinue: boolean;
  worker: { sessionId: string; status: string | null; inputs: RecoveryInput[] | null } | null;
  jobs: { id: string; sessionId: string; status: string }[] | null;
  subtree: { state: 'active' | 'clear' | 'unknown'; children: { sessionId: string; status: string }[] };
}

/** Immutable process-observed boundary; quiet is evidence from the original process, not a fresh Job list. */
export interface RunTurn {
  runId:string; turn:number|null; startSeq:number|null; inputSeq:number|null;
  endSeq:number|null; endKind:string|null; quiet:number; reportId:string|null;
}
