import { useState } from 'react';
import type { RecoveryDetail, RecoveryInputKind } from '../../model.ts';
import type { Detail } from './types.ts';
import type { WorkspaceState } from './useWorkspace.ts';
import { WorkMarkdown } from './WorkMarkdown.tsx';

const inputLabel: Record<RecoveryInputKind, string> = {
  human: '用户消息',
  task: 'Super Bot 任务输入',
  'job-result': '已完成的作业结果待读取',
  'child-result': '子 Agent 结果待读取',
  other: '其他原生输入',
};
const statuses: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  stopping: '停止中',
  completed: '已完成',
  failed: '失败',
  killed: '已停止',
};

export function RecoveryPanel({
  w,
  detail,
  recovery,
}: {
  w: WorkspaceState;
  detail: Detail;
  recovery: RecoveryDetail;
}) {
  const { attentions, lateJobRecovery: late } = detail;
  const { attentionId, worker, jobs, subtree } = recovery;
  const recoveryItem = attentions.find((item) => item.id === attentionId);
  const automatic = late?.state === 'waiting' || late?.state === 'ready';
  const title =
    automatic && detail.task.controlMode === 'paused'
      ? '后台接续已暂停'
      : late?.state === 'waiting'
        ? late.terminalObserved
          ? '等待消费后台结果'
          : '等待后台结束'
        : late?.state === 'ready'
          ? '准备接续原任务'
          : '恢复核对';
  return (
    <section className="attention-box" aria-label="恢复核对">
      <strong>{title}</strong>
      {recoveryItem && <WorkMarkdown text={recoveryItem.question} />}
      <dl>
        <dt>Worker</dt>
        <dd>
          {worker?.status
            ? (statuses[worker.status] ?? worker.status)
            : worker
              ? '当前未加载，状态待确认'
              : '无可确认的当前 Worker'}
        </dd>
        <dt>待处理输入</dt>
        <dd>
          {worker?.inputs == null
            ? '待确认'
            : worker.inputs.length
              ? worker.inputs.map((input) => (
                  <div key={`${input.queue}:${input.kind}`}>
                    {input.queue === 'next-step' ? '下一步' : '下一轮'} · {inputLabel[input.kind]}（
                    {input.count}）
                  </div>
                ))
              : '无'}
        </dd>
        <dt>原生 Job</dt>
        <dd>
          {jobs == null
            ? '待确认'
            : jobs.length
              ? jobs.map((job) => (
                  <div key={job.id}>
                    {statuses[job.status] ?? job.status} · <code>{job.id}</code>
                  </div>
                ))
              : '未发现已登记的 Job'}
        </dd>
        <dt>子 Agent 树</dt>
        <dd>
          {subtree.state === 'unknown'
            ? '完整状态待确认'
            : subtree.state === 'clear'
              ? '未发现活动'
              : subtree.children.length
                ? subtree.children.map((child) => (
                    <div key={child.sessionId}>
                      {statuses[child.status] ?? child.status} · <code>{child.sessionId}</code>
                    </div>
                  ))
                : '仍有子树活动或清理'}
        </dd>
      </dl>
      {worker && (
        <div className="actions">
          <button onClick={() => w.api.botNavigation.openWorker(detail.task, worker.sessionId)}>
            查看原 Worker 会话
          </button>
        </div>
      )}
      {!automatic && attentionId && (
        <ManualRecoveryActions
          w={w}
          detail={detail}
          recovery={recovery}
          attentionId={attentionId}
        />
      )}
    </section>
  );
}

function ManualRecoveryActions({
  w,
  detail,
  recovery,
  attentionId,
}: {
  w: WorkspaceState;
  detail: Detail;
  recovery: RecoveryDetail;
  attentionId: string;
}) {
  const [checked, setChecked] = useState(false);
  const { task, binding, lateJobRecovery: late } = detail;
  const { worker, jobs, subtree } = recovery;
  const busy = Boolean(
    (worker?.status && worker.status !== 'idle') ||
      worker?.inputs?.length ||
      jobs?.some((job) => ['running', 'stopping'].includes(job.status)) ||
      subtree.state === 'active',
  );
  const disabled = w.locked || !checked || busy;
  const version = { id: task.id, expectedRowVersion: task.rowVersion, acknowledged: true };
  return (
    <>
      <p>
        {late?.state === 'blocked'
          ? '可在原聊天请 Bot 核对缺少的回执。已有可核实的事实时，也可用下方入口。'
          : '请在原会话处理待处理输入和作业结果，并检查文件与外部效果。宿主会在确认时再次核对当前活动。'}
      </p>
      <label className="check">
        <input
          disabled={w.locked}
          type="checkbox"
          checked={checked}
          onChange={(event) => setChecked(event.target.checked)}
        />
        我已检查，确认可以结束本次尝试
      </label>
      <div className="actions">
        {recovery.canContinue && binding && (
          <button
            className="primary"
            disabled={disabled}
            onClick={() =>
              w.mutate('run.recover-and-continue', {
                ...version,
                requestId: `continue:${task.id}:${task.rowVersion}`,
                attentionId,
                bindingId: binding.id,
                expectedBindingGeneration: binding.generation,
              })
            }
          >
            核对并继续
          </button>
        )}
        <button
          disabled={disabled}
          onClick={() =>
            w.mutate('run.recover', {
              ...version,
              requestId: `recover:${task.id}:${task.rowVersion}`,
            })
          }
        >
          {detail.closeRequest ? '确认核对并关闭任务' : '仅核对并保持暂停'}
        </button>
      </div>
    </>
  );
}
