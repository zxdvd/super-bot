import type { Task } from '../../model.ts';
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

function StageDetails({ milestone }: { milestone: WorkStage }) {
  return <>
    <p className="full-text">{milestone.summary}</p>
    {milestone.condition && <p>
      条件 · {milestone.observation?.url
        ? <a href={milestone.observation.url} target="_blank" rel="noreferrer">{stageConditionText(milestone.condition)}</a>
        : stageConditionText(milestone.condition)}
    </p>}
    {milestone.observation && <p className="full-text">
      {milestone.observation.detail} <span className="muted">· 核对于 {time(milestone.observation.at)}</span>
    </p>}
    {milestone.reason && milestone.reason !== milestone.observation?.detail && <p className="full-text">{milestone.reason}</p>}
    {milestone.nextStep && <p className="full-text">下一步 · {milestone.nextStep}</p>}
    <details>
      <summary>阶段依据</summary>
      <p className="full-text">{milestone.checks}</p>
      <p className="muted caption full-text">{milestone.evidenceRef}</p>
    </details>
  </>;
}

export function TaskStages({ current, history, task }: {
  current?: WorkStage | null; history: WorkStage[]; task: Task;
}) {
  const previous = history.filter(item => item.runId !== current?.runId);
  if (!current && !previous.length) return null;
  const status = task.controlMode === 'auto' || current?.state === 'superseded'
    ? current && labels[current.state]
    : task.controlMode === 'manual' ? '人工接管' : '自动管理已暂停';
  return <Section title={current ? '当前阶段' : '阶段记录'}>
    {current && <div className="attention-box">
      <strong>{current.name} · {status}</strong>
      <StageDetails milestone={current}/>
    </div>}
    {previous.map(item => <details key={item.runId}>
      <summary>{item.name} · {labels[item.state]} · {time(item.at)}</summary>
      <StageDetails milestone={item}/>
    </details>)}
  </Section>;
}
