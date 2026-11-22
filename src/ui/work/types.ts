import type {
  Attention, Binding, ChatDeliveryStatus, ChildWaitDetail, DispatchWait, ManagerBinding, RecoveryDetail, Result, Run,
  RunInput, Task, TaskModels, TaskProgress,
} from '../../model.ts';

export type AuditEvent = { id: number; kind: string; data: string; createdAt: number };
export type Detail = {
  task: Task; binding: Binding | null; bindingHistory: Binding[]; run: Run | null; input: RunInput | null;
  result: Result | null; attentions: Attention[]; pendingQuestions: Attention[]; events: AuditEvent[]; wait?: DispatchWait | null;
  autoDispatchPending?: boolean; linkedResultBelongs?: boolean; recovery?: RecoveryDetail | null; model?: TaskModels;
  childWaits?: ChildWaitDetail[]; chatDelivery?: ChatDeliveryStatus | null;
  progress?: TaskProgress; reloadEligible?: boolean;
};
export type ManagerInfo = {
  binding: ManagerBinding | null; pending: number; uncertain: number; hourlyWakes: number; wakeLimit?: number;
  problem: { message: string; at: number } | null;
};
export type FormKind = 'bot' | 'bot-edit' | 'task' | 'edit' | null;
export type Submit = (data: Record<string, unknown>) => Promise<boolean>;
