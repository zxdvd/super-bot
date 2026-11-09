/** Where the task works: mode, path, branch, queue position and manual cleanup. */
import { ConfirmAction, CopyButton, Section, Tag } from '../kit.tsx';
import { workdirModeLabels, workdirStateLabels } from './format.ts';
import type { Detail } from './types.ts';
import type { WorkspaceState } from './useWorkspace.ts';

const CLEANABLE = ['isolated', 'worktree', 'hook'];

function WaitNotice({ wait }: { wait: NonNullable<Detail['wait']> }) {
  const reason = wait.code === 'resource-conflict' ? '工作目录被占用' : '等待执行名额';
  return <p className="notice" role="status">
    排队中：{reason}{wait.holderTaskId && <>，排在「{(wait.holderGoal ?? wait.holderTaskId).slice(0, 80)}」之后</>}。轮到时自动开始。
  </p>;
}

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
    {info?.mode === 'existing' && <p className="muted hint">已有目录由用户维护，Super Bot 不会删除它；同一目录的其他任务会排队。</p>}
    {detail.wait && <WaitNotice wait={detail.wait}/>}
    {cleanable && <ConfirmAction key={`cleanup:${binding!.id}`} label="清理工作目录" disabled={w.locked}
      explanation="删除这个任务创建的目录（worktree 有未提交改动时不会强删）。成果文件链接会随之失效；任务记录保留。"
      submit={() => w.mutate('workdir.cleanup', { id: task.id })}/>}
  </Section>;
}
