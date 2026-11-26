import { CLARIFICATION_ACTIONS, type ClarificationAction } from '../chat-work-actions.ts';
import { AppError, requiredText } from '../model.ts';
import type { Store } from '../store.ts';

type ClarificationOption = {
  taskId: string;
  name: string;
  rowVersion: number;
  attentionId?: string;
  resultId?: string;
  label?: string;
};

const OPEN_TASK_ACTIONS: readonly ClarificationAction[] = [
  'continue',
  'respond',
  'revise',
  'recover-and-continue',
  'session-prepare',
  'session-inspect',
  'session-detach',
];
const UNFINISHED_TASK_ACTIONS: readonly ClarificationAction[] = [
  'pause',
  'resume',
  'close',
  'cancel',
  'recover',
];

export function clarificationOptions(
  store: Store,
  botId: string,
  action: ClarificationAction,
  { taskIds, resultIds }: Record<string, unknown>,
): ClarificationOption[] {
  const selectsResult = action === 'accept' || action === 'rework';
  const exactResults = action === 'accept' && Array.isArray(resultIds);
  const requested = exactResults ? resultIds : taskIds;
  const ids = Array.isArray(requested) ? [...new Set(requested)] : [];
  if (!CLARIFICATION_ACTIONS.includes(action) || ids.length < 2 || ids.length > 8) {
    throw new AppError('clarification-scope', '请选择当前 Bot 中确实可能对应这条消息的候选任务。');
  }

  return ids.map((id) => {
    const requestedResult = exactResults
      ? store.resultById(requiredText(id, '候选成果标识', 200))
      : null;
    if (exactResults && !requestedResult)
      throw new AppError('result-stale', '该候选成果已经无法核对。');
    const task = store.getTask(requestedResult?.taskId ?? requiredText(id, '候选任务标识', 200));
    const open = task.lifecycle === 'open';
    const review = task.lifecycle === 'review';
    if (
      task.botId !== botId ||
      (selectsResult && !review) ||
      (OPEN_TASK_ACTIONS.includes(action) && !open) ||
      (UNFINISHED_TASK_ACTIONS.includes(action) && !open && !review) ||
      (action === 'stop' && store.latestRun(task.id)?.finishedAt !== null) ||
      (action === 'session-reconcile' && !store.activeBinding(task.id))
    ) {
      throw new AppError('manager-scope', '只能澄清当前 Bot 的有效业务目标。');
    }

    const choice = { taskId: task.id, name: task.goal, rowVersion: task.rowVersion };
    if (selectsResult) {
      const { result } = store.taskDetail(task.id);
      if (!result || (requestedResult && result.id !== requestedResult.id)) {
        throw new AppError('result-stale', '请重新核对当前待验收的候选成果。');
      }
      return {
        ...choice,
        resultId: result.id,
        label: `${task.goal} · 当前成果 · ${result.summary.slice(0, 100)}`,
      };
    }
    if (action === 'respond') {
      const detail = store.taskDetail(task.id);
      const questions = detail.binding
        ? detail.pendingQuestions
        : detail.attentions.filter((item) => item.kind === 'input' && item.state === 'open');
      if (questions.length !== 1) {
        throw new AppError('clarification-stale', '候选任务需要有一个当前可回答的问题。');
      }
      return { ...choice, attentionId: questions[0]!.id };
    }
    return choice;
  });
}
