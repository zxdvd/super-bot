import type {
  Attention, Binding, ChatDeliveryStatus, ChildWaitDetail, DeliveredResult, DispatchWait, ManagerBinding, RecoveryDetail, Result, Run,
  RunInput, Task, TaskProgress, UncertainDelivery, WorkerModelPreview,
} from '../../model.ts';
import type { RecoveryCheck } from '../../read-only-recovery.ts';

export type AuditEvent = { id: number; kind: string; data: string; createdAt: number };
export type VisibleResult = Result & Partial<Pick<DeliveredResult, 'links' | 'deliveryText'>>;
export type Detail = {
  task: Task; binding: Binding | null; bindingHistory: Binding[]; run: Run | null; input: RunInput | null;
  result: Result | null; attentions: Attention[]; pendingQuestions: Attention[]; events: AuditEvent[]; wait?: DispatchWait | null;
  deliveredResult: DeliveredResult | null; linkedResult?: VisibleResult | null;
  autoDispatchPending?: boolean; recovery?: RecoveryDetail | null; model?: WorkerModelPreview;
  recoveryCheck?: Pick<RecoveryCheck, 'resolution'> | null;
  settledBlocker?: 'settled-failure' | 'verified-end' | null;
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
