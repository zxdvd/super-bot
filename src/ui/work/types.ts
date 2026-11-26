import type {
  Attention, Binding, ChatDeliveryStatus, ChildWaitDetail, DeliveredResult, DispatchWait, ManagerBinding, RecoveryDetail, Result, Run,
  LateJobRecovery, RecoveryDirectionStatus, RunInput, Task, TaskCloseRequest, TaskProgress, UncertainDelivery, WorkerModelPreview,
} from '../../model.ts';
import type { RecoveryCheck } from '../../read-only-recovery.ts';
import type { WorkStage } from '../../work-stage.ts';
import type { ReleaseReceipt } from '../../gitlab-release.ts';

export type AuditEvent = { id: number; kind: string; data: string; createdAt: number };
export type VisibleResult = Result & Partial<Pick<DeliveredResult, 'links' | 'deliveryText' | 'primaryLink'>>;
export type Detail = {
  task: Task; binding: Binding | null; bindingHistory: Binding[]; run: Run | null; input: RunInput | null;
  stage?: WorkStage | null; stages?: WorkStage[];
  gitLabRelease?: ReleaseReceipt | null;
  result: Result | null; attentions: Attention[]; pendingQuestions: Attention[]; events: AuditEvent[]; wait?: DispatchWait | null;
  deliveredResult: DeliveredResult | null; linkedResult?: VisibleResult | null;
  closeRequest?: TaskCloseRequest | null;
  autoDispatchPending?: boolean; recovery?: RecoveryDetail | null; model?: WorkerModelPreview;
  recoveryCheck?: Pick<RecoveryCheck, 'resolution'> | null;
  lateJobRecovery?: LateJobRecovery; lateJobPriorEffects?: string;
  directionStatus?: RecoveryDirectionStatus | null;
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
