import type {
  Attention, Binding, DispatchWait, ManagerBinding, Result, Run, RunInput, Task,
} from '../../model.ts';

export type AuditEvent = { id: number; kind: string; data: string; createdAt: number };
export type Detail = {
  task: Task; binding: Binding | null; bindingHistory: Binding[]; run: Run | null; input: RunInput | null;
  result: Result | null; attentions: Attention[]; events: AuditEvent[]; wait?: DispatchWait | null;
};
export type ManagerInfo = {
  binding: ManagerBinding | null; pending: number; uncertain: number; hourlyWakes: number; wakeLimit?: number;
  problem: { message: string; at: number } | null;
};
export type FormKind = 'bot' | 'bot-edit' | 'task' | 'edit' | null;
export type Submit = (data: Record<string, unknown>) => Promise<boolean>;
