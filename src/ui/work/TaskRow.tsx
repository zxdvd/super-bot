/** One task line shared by the inbox, board and list: state dot, goal, status and relative time. */
import type { Task } from '../../model.ts';
import { Tag } from '../kit.tsx';
import { ago, stageText, stageTone, unseenResult, workdirModeLabels } from './format.ts';
import type { WorkspaceState } from './useWorkspace.ts';

export function TaskRow({
  w,
  task,
  card = false,
}: {
  w: WorkspaceState;
  task: Task;
  card?: boolean;
}) {
  const tone = stageTone(task),
    fresh = !w.mirror && unseenResult(task, w.seen[task.id], w.now),
    selected = w.selected === task.id;
  const mode = task.workdirRequest?.mode;
  const state = stageText(task, !!w.mirror);
  return (
    <button
      className={`${card ? 'board-card' : 'task'} ${selected ? 'selected' : ''}`}
      aria-pressed={selected}
      disabled={w.busy}
      onClick={() => w.select(task.id)}
    >
      <div className="task-top">
        <span className={`state-dot ${tone}`} aria-hidden />
        <span className="task-goal">{task.goal}</span>
        {!card && <Tag tone={tone}>{state}</Tag>}
      </div>
      {task.activityQuestion && <span className="muted clamp">{task.activityQuestion}</span>}
      <div className="task-meta">
        {card && <span>{state}</span>}
        {fresh && <Tag tone="info">新成果</Tag>}
        {task.controlMode === 'paused' && task.lifecycle === 'review' && (
          <span>自动管理已暂停</span>
        )}
        {mode && <span>{workdirModeLabels[mode]}</span>}
        <span>{ago(task.updatedAt, w.now)}</span>
      </div>
    </button>
  );
}
