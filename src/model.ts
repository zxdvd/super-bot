/** Values crossing the product/host boundary; no DSH or UI types. */
export interface WorkspaceStatus {
  product: 'Super Bot';
  version: string;
  runtime: string;
  sqliteVersion: string;
  journalMode: string;
  startedAt: number;
  savedSessionId: string | null;
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
  status: 'unscheduled' | 'needs-input' | 'paused' | 'manual' | 'completed' | 'cancelled' | 'review';
}
export interface TaskPage {
  items: Task[];
  total: number;
  offset: number;
  limit: number;
  snapshotVersion: number;
  counts: { all: number; open: number; review: number; completed: number; cancelled: number };
}
export interface NewBot { name: string; instructions: string }
export interface NewTask { botId: string; goal: string; scope: string; acceptance: string; reviewPolicy: 'human' | 'bot' }
export interface Attention {
  id: string; taskId: string; kind: 'input' | 'approval' | 'review' | 'recovery';
  question: string; taskRevision: number; state: 'open' | 'resolved' | 'stale'; createdAt: number;
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
