/** Pure labels and grouping for tasks; no React so tests can import it directly. */
import type { Task, WorkdirInfo } from '../../model.ts';

const labels: Record<Task['status'], string> = {
  unscheduled: '待安排', 'needs-input': '等你补充', approval: '原生审批待处理', paused: '已暂停', manual: '人工接管',
  completed: '已完成', cancelled: '已取消', review: '待验收', queued: '待投递', running: '执行中', stopping: '正在停止',
  recovery: '待核对',
};
const eventLabels: Record<string, string> = {
  'task.created': '创建任务', 'task.revised': '更新目标与验收条件', 'task.control': '更新管理方式',
  'session.preparing': '准备执行会话', 'session.attached': '用户授权关联已有会话', 'session.ready': '执行会话已关联',
  'session.recovery': '会话创建待核对', 'run.budget-reached': '执行已达到预算上限', 'run.queued': '已接收执行请求',
  'input.entered': '任务输入已进入模型上下文', 'work.report': '收到工作报告', 'run.settled': '执行已收敛',
  'run.recovery': '执行需要核对', 'result.accepted': '用户接受成果', 'native.intervention': '原生会话人工介入',
  'run.stop-requested': '已请求停止', 'run.cancelled': '已核对停止', 'attention.answered': '回答已保存',
  'result.rejected': '返工要求已保存', 'run.recovery-confirmed': '用户完成恢复核对', 'manager.reviewed': 'Bot 检查成果',
  'task.cancelled': '用户取消任务', 'session.detached': '解除执行会话关联', 'work.report-stale': '保留已失效报告的审计',
  'approval.asked': '原生工具请求审批', 'approval.decided': '原生审批已有结果', 'workdir.failed': '工作目录准备失败',
  'workdir.cleanup': '工作目录已清理', 'workdir.cleanup-failed': '工作目录自动清理失败',
};
const approvalOutcomes: Record<string, string> = {
  'allowed-once': '原生审批：仅允许本次', rejected: '原生审批：已拒绝', cancelled: '原生审批：已撤回',
  unavailable: '原生审批：当前无可用处理入口',
};

export function eventTitle(event: { kind: string; data: string }): string {
  if (event.kind === 'approval.decided') try {
    const outcome = JSON.parse(event.data).outcome as string;
    return approvalOutcomes[outcome] ?? eventLabels[event.kind]!;
  } catch { /* Older audit entries may not contain detail. */ }
  return eventLabels[event.kind] ?? event.kind;
}
export const taskLabel = (task: Task) => task.lifecycle === 'review' && task.status === 'paused' ? '待验收 · 已暂停' : labels[task.status];
export const time = (value: number) =>
  new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
/** Statuses in which control actions such as cancel or detach must wait. */
export const settling = (task: Task) => ['running', 'queued', 'stopping', 'recovery', 'approval'].includes(task.status);
export const reviewLabel = (task: Task, long = false) => task.lifecycle === 'review' && task.managerReviewed
  ? long ? '本次需人工验收（原因见待办）' : '本次需人工验收'
  : task.reviewPolicy === 'human' ? long ? '由你确认' : '由你最终验收' : long ? '已授权 Bot 验收' : 'Bot 可最终验收';

export function resultHeading(task: Task): string {
  if (task.lifecycle === 'completed') return '成果 · 已接受';
  if (task.lifecycle === 'cancelled') return '历史报告 · 任务已取消';
  if (task.lifecycle === 'review') return '成果 · 待你验收';
  return '候选报告 · 当前不可验收';
}

export type WorkGroup = 'doing' | 'needs-you' | 'delivered' | 'cancelled';
export const workGroups: readonly WorkGroup[] = ['needs-you', 'doing', 'delivered', 'cancelled'];
export const groupTitles: Record<WorkGroup, string> = {
  'needs-you': '哪里需要我', doing: '正在做什么', delivered: '交付了什么', cancelled: '已取消',
};
export function workGroup(task: Task): WorkGroup {
  if (task.lifecycle === 'cancelled') return 'cancelled';
  if (task.lifecycle === 'review' || task.lifecycle === 'completed') return 'delivered';
  return ['needs-input', 'approval', 'recovery', 'paused', 'manual'].includes(task.status) ? 'needs-you' : 'doing';
}

export const workdirModeLabels: Record<WorkdirInfo['mode'], string> = {
  existing: '已有目录', isolated: '独立目录', worktree: 'Git worktree', hook: '脚本创建', default: '默认目录',
};
export const workdirStateLabels: Record<WorkdirInfo['state'], string> = {
  provisioned: '使用中', removed: '已清理', 'remove-failed': '清理未完成',
};
