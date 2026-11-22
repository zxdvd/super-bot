import type {
  Attention, Binding, ChatDeliveryStatus, ChildWaitDetail, DispatchWait, ManagerBinding, RecoveryDetail, Result, Run,
  RunInput, Task, TaskProgress, UncertainDelivery, WorkerModelPreview,
} from '../../model.ts';

export type AuditEvent = { id: number; kind: string; data: string; createdAt: number };
export type Detail = {
  task: Task; binding: Binding | null; bindingHistory: Binding[]; run: Run | null; input: RunInput | null;
  result: Result | null; attentions: Attention[]; pendingQuestions: Attention[]; events: AuditEvent[]; wait?: DispatchWait | null;
  autoDispatchPending?: boolean; linkedResult?: Result | null; recovery?: RecoveryDetail | null; model?: WorkerModelPreview;
  childWaits?: ChildWaitDetail[]; chatDelivery?: ChatDeliveryStatus | null; linkedChatDelivery?: ChatDeliveryStatus | null;
  progress?: TaskProgress; reloadEligible?: boolean;
};
export type ManagerInfo = {
  binding: ManagerBinding | null; pending: number; uncertain: number; hourlyWakes: number; wakeLimit?: number;
  uncertainDeliveries?: UncertainDelivery[];
  problem: { message: string; at: number; eventId?: string } | null;
};
export type FormKind = 'bot' | 'bot-edit' | 'task' | 'edit' | null;
export type Submit = (data: Record<string, unknown>) => Promise<boolean>;
