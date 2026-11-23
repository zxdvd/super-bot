/** Where the task works: mode, path, branch, queue position and manual cleanup. */
import { ConfirmAction, CopyButton, Section, Tag } from '../kit.tsx';
import { workdirModeLabels, workdirStateLabels } from './format.ts';
import type { Detail } from './types.ts';
import type { WorkspaceState } from './useWorkspace.ts';

const CLEANABLE = ['isolated', 'worktree', 'hook'];

export function WorkdirCard({ w, detail }: { w: WorkspaceState; detail: Detail }) {
  const { task } = detail, binding = detail.binding ?? detail.bindingHistory[0];
  const requested = task.workdirRequest;
  if (!binding && !requested) return null;
  const info = binding?.workdir;
  const ended = ['completed', 'cancelled'].includes(task.lifecycle) || binding?.state === 'released';
  const cleanable = !!info && CLEANABLE.includes(info.mode) && info.state !== 'removed' && ended;
  const mode = info?.mode ?? requested?.mode;
  return <Section title="工作目录" aside={mode && <Tag tone="info">{workdirModeLabels[mode]}</Tag>}>
    {binding ? <p className="path"><code>{binding.cwd}</code> <CopyButton text={binding.cwd}/></p>
      : <p className="muted">尚未准备；Bot 请求：{requested!.path ?? requested!.repo ?? requested!.name ?? '按默认策略'}</p>}
    {info && <p className="muted">
      <Tag tone={info.state === 'provisioned' ? 'success' : info.state === 'removed' ? 'neutral' : 'attention'}>
        {workdirStateLabels[info.state]}
      </Tag>
      {info.branch && <> 分支 <code>{info.branch}</code></>}{info.repo && <> · 仓库 <code>{info.repo}</code></>}
      {info.note && <> · {info.note}</>}
    </p>}
    {info?.mode === 'existing' && <p className="muted hint">多个任务可以共用这个目录。目录由用户维护。</p>}
    {cleanable && <ConfirmAction key={`cleanup:${binding!.id}`} label="清理工作目录" disabled={w.locked}
      explanation="将删除此任务创建的目录。含未提交改动的 worktree 会保留。已保存的成果附件仍可下载，旧成果若只有原路径将无法下载。"
      submit={() => w.mutate('workdir.cleanup', { id: task.id })}/>}
  </Section>;
}
