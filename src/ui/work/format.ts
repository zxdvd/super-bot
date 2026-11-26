/** Pure labels and grouping for tasks; no React so tests can import it directly. */
import { isTestTask, RESULT_FRESH_MS, type Task, type WorkdirInfo } from '../../model.ts';
import type { Detail } from './types.ts';

export function canStartTask({ binding, task, wait, autoDispatchPending }: Detail): boolean {
  return (
    binding?.state === 'ready' && task.status === 'unscheduled' && !wait && !autoDispatchPending
  );
}

const labels: Record<Task['status'], string> = {
  unscheduled: '待安排',
  'needs-input': '等你补充',
  approval: '原生审批待处理',
  paused: '已暂停',
  manual: '人工接管',
  completed: '已完成',
  cancelled: '已取消',
  review: '待验收',
  queued: '待投递',
  running: '执行中',
  stopping: '正在停止',
  recovery: '待核对',
  blocked: '前提未满足',
};
const eventLabels: Record<string, string> = {
  'task.created': '创建任务',
  'task.revised': '更新目标与验收条件',
  'task.control': '更新管理方式',
  'session.preparing': '准备执行会话',
  'session.attached': '用户授权关联已有会话',
  'session.ready': '执行会话已关联',
  'session.recovery': '会话创建待核对',
  'run.budget-reached': '执行已达到预算上限',
  'run.queued': '已接收执行请求',
  'input.entered': '任务输入已进入模型上下文',
  'work.report': '收到工作报告',
  'run.settled': '执行已收敛',
  'run.recovery': '执行需要核对',
  'result.accepted': '用户接受成果',
  'native.intervention': '原生会话人工介入',
  'run.stop-requested': '已请求停止',
  'run.cancelled': '已核对停止',
  'attention.answered': '回答已保存',
  'result.rejected': '返工要求已保存',
  'run.recovery-confirmed': '用户完成恢复核对',
  'manager.reviewed': 'Bot 检查成果',
  'run.recovery-check-started': 'Bot 开始只读核对',
  'run.recovery-observed': 'Bot 记录恢复核对结果',
  'run.end-verified': 'Bot 已核实上轮结束',
  'task.recovery-instruction': '已保存聊天中的后续指示',
  'run.continued': '已按最新指示续跑',
  'task.cancelled': '任务已关闭',
  'task.close-requested': '用户请求关闭任务',
  'task.close-blocked': '关闭任务待核对',
  'session.detached': '解除执行会话关联',
  'work.report-stale': '保留已失效报告的审计',
  'approval.asked': '原生工具请求审批',
  'approval.decided': '原生审批已有结果',
  'workdir.failed': '工作目录准备失败',
  'workdir.cleanup': '工作目录已清理',
  'workdir.cleanup-failed': '工作目录自动清理失败',
  'dev.reload-applied': '关联构建的原生重载已确认',
};
const approvalOutcomes: Record<string, string> = {
  'allowed-once': '原生审批：仅允许本次',
  rejected: '原生审批：已拒绝',
  cancelled: '原生审批：已撤回',
  unavailable: '原生审批：当前无可用处理入口',
};

export function eventTitle(event: { kind: string; data: string }): string {
  if (event.kind === 'manager.delivered') {
    try {
      const data = JSON.parse(event.data);
      if (data.explicit) return '历史交付工具回包';
      if (data.resultId) return '原聊天成果链接已确认';
    } catch {
      /* Older audit entries may not contain detail. */
    }
    return '原聊天已回复通知';
  }
  if (event.kind === 'approval.decided')
    try {
      const outcome = JSON.parse(event.data).outcome as string;
      return approvalOutcomes[outcome] ?? eventLabels[event.kind]!;
    } catch {
      /* Older audit entries may not contain detail. */
    }
  if (event.kind === 'run.recovery-confirmed')
    try {
      const data = JSON.parse(event.data);
      if (data.actor === 'manager') {
        const outcome = data.outcome ?? data.result?.status;
        if (
          ['denied', 'missing', 'not-ready'].includes(outcome) ||
          data.result?.observed?.ready === false
        ) {
          return 'Bot 确认前提未满足';
        }
        return 'Bot 完成恢复核对';
      }
    } catch {
      /* Older audit entries may not contain detail. */
    }
  return eventLabels[event.kind] ?? event.kind;
}
export function recoveryEventMessage(event: { kind: string; data: string }): string | undefined {
  if (!['run.recovery-confirmed', 'run.recovery-observed'].includes(event.kind)) return;
  try {
    const data = JSON.parse(event.data);
    if (data.actor === 'manager' && typeof data.result?.message === 'string')
      return data.result.message;
  } catch {
    /* Older audit entries may not contain detail. */
  }
}
export const taskLabel = (task: Task) =>
  task.lifecycle === 'review' && task.status === 'paused' ? '待验收 · 已暂停' : labels[task.status];
export const time = (value: number) =>
  new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
/** Statuses in which control actions such as cancel or detach must wait. */
export const settling = (task: Task) =>
  ['running', 'queued', 'stopping', 'recovery', 'approval'].includes(task.status);
export const reviewLabel = (task: Task, long = false) =>
  task.lifecycle === 'review' && task.managerReviewed
    ? long
      ? '本次需人工验收（原因见待办）'
      : '本次需人工验收'
    : task.reviewPolicy === 'human'
      ? long
        ? '由你确认'
        : '由你最终验收'
      : long
        ? '已授权 Bot 验收'
        : 'Bot 可最终验收';

export const canReviewResult = (task: Task) =>
  !task.blockingAttention &&
  !['blocked', 'recovery'].includes(task.status) &&
  task.lifecycle === 'review';

export function resultHeading(task: Task): string {
  if (task.lifecycle === 'completed') return '成果 · 已接受';
  if (task.lifecycle === 'cancelled') return '历史报告 · 任务已取消';
  if (task.lifecycle === 'review') return '成果 · 待你验收';
  return '候选报告 · 当前不可验收';
}

export type WorkGroup = 'doing' | 'needs-you' | 'delivered' | 'cancelled';
export const workGroups: readonly WorkGroup[] = ['needs-you', 'doing', 'delivered', 'cancelled'];
export const groupTitles: Record<WorkGroup, string> = {
  'needs-you': '哪里需要我',
  doing: '正在做什么',
  delivered: '成果',
  cancelled: '已取消',
};
export function workGroup(task: Task): WorkGroup {
  if (task.lifecycle === 'cancelled') return 'cancelled';
  if (task.lifecycle === 'review' || task.lifecycle === 'completed') return 'delivered';
  if (task.activity === 'attention') return 'needs-you';
  if (
    task.status === 'recovery' &&
    task.blockingAttention === null &&
    (task.activity === 'working' || (task.activity === null && task.controlMode === 'paused'))
  )
    return 'doing';
  if (task.waitingForPrerequisite) return 'doing';
  return ['needs-input', 'approval', 'recovery', 'blocked', 'paused', 'manual'].includes(
    task.status,
  )
    ? 'needs-you'
    : 'doing';
}

export const workdirModeLabels: Record<WorkdirInfo['mode'], string> = {
  existing: '已有目录',
  isolated: '独立目录',
  worktree: 'Git worktree',
  hook: '脚本创建',
  default: '默认目录',
};
export const workdirStateLabels: Record<WorkdirInfo['state'], string> = {
  provisioned: '使用中',
  removed: '已清理',
  'remove-failed': '清理未完成',
};

/** Six user-facing stages; pause, takeover and review policy stay secondary tags. */
export type Stage = 'needs-you' | 'review' | 'running' | 'waiting' | 'done' | 'cancelled';
export type StageTone = 'neutral' | 'attention' | 'success' | 'danger' | 'info';
export const stageLabels: Record<Stage, string> = {
  'needs-you': '等你处理',
  review: '待验收',
  running: '执行中',
  waiting: '待安排',
  done: '已完成',
  cancelled: '已取消',
};
export const stageTones: Record<Stage, StageTone> = {
  'needs-you': 'attention',
  review: 'info',
  running: 'success',
  waiting: 'neutral',
  done: 'neutral',
  cancelled: 'neutral',
};
const BLOCKERS = { input: 'needs-input', approval: 'approval', recovery: 'recovery' } as const;
const RUNNING = ['running', 'queued', 'stopping'];

function blocker(task: Task): Task['status'] | undefined {
  if (task.blockingAttention) return BLOCKERS[task.blockingAttention];
  if (task.status === 'blocked' && !task.waitingForPrerequisite) return task.status;
  // Older mirrored sources only include the display status.
  if (
    task.blockingAttention === undefined &&
    Object.values(BLOCKERS).some((status) => status === task.status)
  )
    return task.status;
}

export function stage(task: Task): Stage {
  if (task.lifecycle === 'cancelled') return 'cancelled';
  if (task.lifecycle === 'completed') return 'done';
  if (blocker(task)) return 'needs-you';
  if (task.lifecycle === 'review') return 'review';
  return RUNNING.includes(task.status) ? 'running' : 'waiting';
}
/** The short status a row shows: the stage, refined by the concrete reason where that helps. */
export function stageText(task: Task, readOnly = false): string {
  const s = stage(task);
  if (s === 'needs-you') {
    const status = blocker(task) ?? task.status;
    return status === 'needs-input' && readOnly ? '待补充' : labels[status];
  }
  if (task.activity === 'attention') return task.stageState ? '后续待核对' : '通知待核对';
  if (task.status === 'blocked' && task.stageState === 'waiting') return '等待外部条件';
  if (
    task.status === 'blocked' &&
    task.stageState === 'awaiting-decision' &&
    (task.activity === undefined || task.activity === 'working')
  )
    return 'Bot 正在核对下一步';
  if (task.activity === 'working' && s === 'done') return 'Bot 正在交付';
  if (task.activity === 'working' && s === 'review')
    return task.managerReviewed ? 'Bot 正在交付' : 'Bot 跟进中';
  if (task.activity === 'working' && s === 'waiting') return '等待自动跟进';
  if (s === 'waiting' && task.controlMode === 'paused') return labels.paused;
  if (s === 'waiting' && task.waitingForPrerequisite) return '任务受阻';
  if (
    s === 'running' ||
    (s === 'waiting' && (task.status === 'paused' || task.status === 'manual'))
  )
    return labels[task.status];
  return stageLabels[s];
}
export function stageTone(task: Task): StageTone {
  if (blocker(task) === 'recovery') return 'danger';
  if (task.activity === 'attention') return 'attention';
  if (task.activity === 'working') return 'success';
  return stageTones[stage(task)];
}

export function unseenResult(task: Task, seenAt: number | undefined, now: number): boolean {
  const at = task.deliveredAt;
  return (
    (task.lifecycle === 'review' || task.lifecycle === 'completed') &&
    at !== undefined &&
    (seenAt ?? 0) < at &&
    now - at < RESULT_FRESH_MS
  );
}

function urgency(task: Task): number {
  const status = blocker(task);
  if (status === 'recovery' || status === 'blocked') return 0;
  if (status === 'approval') return 1;
  if (status === 'needs-input') return 2;
  return RUNNING.includes(task.status) ? 3 : 4;
}
const newest = (a: Task, b: Task) => b.updatedAt - a.updatedAt;
const byUrgency = (a: Task, b: Task) => urgency(a) - urgency(b) || newest(a, b);

export function inboxGroups(
  tasks: readonly Task[],
  seen: Record<string, number>,
  now: number,
  recentLimit = 8,
) {
  const groups = {
    attention: [] as Task[],
    review: [] as Task[],
    fresh: [] as Task[],
    active: [] as Task[],
    waiting: [] as Task[],
    recent: [] as Task[],
    tests: [] as Task[],
    blockedTests: [] as Task[],
  };
  for (const task of tasks) {
    const s = stage(task);
    const needs = task.activity === 'attention' || s === 'needs-you';
    if (isTestTask(task)) {
      (needs ? groups.blockedTests : groups.tests).push(task);
      continue;
    }
    const fresh = unseenResult(task, seen[task.id], now);
    if (fresh) groups.fresh.push(task);
    if (needs) groups.attention.push(task);
    else if (task.activity === 'working' || s === 'running') groups.active.push(task);
    else if (task.activity === 'review' || s === 'review') groups.review.push(task);
    else if (s === 'waiting') groups.waiting.push(task);
    else if (!fresh) groups.recent.push(task);
  }
  groups.attention.sort(byUrgency);
  groups.active.sort(byUrgency);
  groups.tests.sort(byUrgency);
  groups.review.sort(newest);
  groups.waiting.sort(newest);
  groups.blockedTests.sort(byUrgency);
  groups.fresh.sort((a, b) => (b.deliveredAt ?? 0) - (a.deliveredAt ?? 0));
  groups.recent = groups.recent.sort(newest).slice(0, recentLimit);
  return { ...groups, attentionCount: groups.attention.length + groups.blockedTests.length };
}

export type BoardColumn = Exclude<Stage, 'cancelled'>;
export const boardColumns: readonly BoardColumn[] = [
  'waiting',
  'running',
  'needs-you',
  'review',
  'done',
];
export const boardTitles: Record<BoardColumn, string> = {
  waiting: '待安排',
  running: '执行中',
  'needs-you': '需要你',
  review: '待验收',
  done: '已完成',
};
/** Board columns by stage; cancelled tasks stay out of the board. */
export function boardGroups(tasks: readonly Task[]): Record<BoardColumn, Task[]> {
  const groups: Record<BoardColumn, Task[]> = {
    waiting: [],
    running: [],
    'needs-you': [],
    review: [],
    done: [],
  };
  for (const task of tasks) {
    const s = stage(task);
    if (s !== 'cancelled') groups[s].push(task);
  }
  for (const key of boardColumns) groups[key].sort(byUrgency);
  return groups;
}

/** Compact relative time for rows: 刚刚 / 5 分钟前 / 3 小时前 / 2 天前, then the date. */
export function ago(value: number, now: number): string {
  const minutes = Math.floor((now - value) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / 1440)} 天前`;
  return time(value);
}
