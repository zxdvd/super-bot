import type { Task } from '../../model.ts';
import type { ReleaseReceipt, ReleaseState } from '../../gitlab-release.ts';
import { stageConditionText, type WorkStage } from '../../work-stage.ts';
import { Section } from '../kit.tsx';
import { time } from './format.ts';

const labels: Record<WorkStage['state'], string> = {
  'awaiting-decision': 'Bot 正在核对下一步',
  waiting: '等待外部条件',
  ready: '下一步可安排',
  dispatched: '已接续下一步',
  blocked: '下一步待处理',
  superseded: '已结束等待',
};

const releaseLabels: Record<ReleaseState, string> = {
  unsubmitted: '尚未启动',
  'claim-pending': '等待正式入口回执',
  tracking: '已启动 · 核对中',
  success: '已成功',
  failed: '未成功',
  'needs-permission': '缺少执行权限',
  unknown: '执行结果待核对',
  expired: '已到核对期限',
};

function StageDetails({ milestone }: { milestone: WorkStage }) {
  const job = milestone.observation?.releaseJob;
  const conditionUrl =
    job && milestone.condition
      ? `${job.origin}/${job.project}/-/merge_requests/${milestone.condition.number}`
      : milestone.observation?.url;
  return (
    <>
      <p className="full-text">{milestone.summary}</p>
      {milestone.condition && (
        <p>
          条件 ·{' '}
          {conditionUrl ? (
            <a href={conditionUrl} target="_blank" rel="noreferrer">
              {stageConditionText(milestone.condition)}
            </a>
          ) : (
            stageConditionText(milestone.condition)
          )}
        </p>
      )}
      {job && milestone.observation?.url && (
        <p>
          <a href={milestone.observation.url} target="_blank" rel="noreferrer">
            发布作业 · {job.name} #{job.jobId}
          </a>
          {' · '}
          {milestone.observation.stateLabel}
        </p>
      )}
      {milestone.observation && (
        <p className="full-text">
          {milestone.observation.detail}{' '}
          <span className="muted">· 核对于 {time(milestone.observation.at)}</span>
        </p>
      )}
      {milestone.reason && milestone.reason !== milestone.observation?.detail && (
        <p className="full-text">{milestone.reason}</p>
      )}
      {milestone.nextStep && <p className="full-text">下一步 · {milestone.nextStep}</p>}
      {milestone.state === 'waiting' && milestone.deadlineAt && !milestone.expired && (
        <p className="muted">首次核对期限 · {time(milestone.deadlineAt)}</p>
      )}
      <details>
        <summary>阶段依据</summary>
        <p className="full-text">{milestone.checks}</p>
        <p className="muted caption full-text">{milestone.evidenceRef}</p>
      </details>
    </>
  );
}

export function TaskStages({
  current,
  history,
  task,
  release,
}: {
  current?: WorkStage | null;
  history: WorkStage[];
  task: Task;
  release?: ReleaseReceipt | null;
}) {
  const previous = history.filter((item) => item.runId !== current?.runId);
  if (!current && !previous.length && !release) return null;
  const status =
    task.controlMode === 'auto' || current?.state === 'superseded'
      ? current && labels[current.state]
      : task.controlMode === 'manual'
        ? '人工接管'
        : '自动管理已暂停';
  return (
    <Section title={current ? '当前阶段' : '阶段记录'}>
      {release && (
        <div className="attention-box">
          <strong>GitLab 正式作业 · {releaseLabels[release.state]}</strong>
          <p>
            <a href={release.url} target="_blank" rel="noreferrer">
              {release.target.name} #{release.target.jobId}
            </a>
            {' · 流水线 #'}
            {release.target.pipelineId}
          </p>
          <p className="full-text">{release.detail}</p>
        </div>
      )}
      {current && (
        <div className="attention-box">
          <strong>
            {current.name} · {status}
          </strong>
          <StageDetails milestone={current} />
        </div>
      )}
      {previous.map((item) => (
        <details key={item.runId}>
          <summary>
            {item.name} · {labels[item.state]} · {time(item.at)}
          </summary>
          <StageDetails milestone={item} />
        </details>
      ))}
    </Section>
  );
}
