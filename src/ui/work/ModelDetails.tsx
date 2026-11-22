import type { ModelRoute, RunModels, TaskModels, WorkerModelPlan } from '../../model.ts';
import { Section } from '../kit.tsx';
import { time } from './format.ts';

const sourceLabels: Record<WorkerModelPlan['source'], string> = {
  'role-override': 'Super Bot Worker 角色覆盖',
  'native-selection': 'Worker 原生会话选择',
  'manager-inheritance': '由 Bot 派发时继承当前 Bot 会话的原生选择',
};

function route(model: ModelRoute) {
  return `${model.provider} / ${model.model} · 推理档位 ${model.reasoningEffort ?? '未知'}`;
}

function expected(plan: WorkerModelPlan | null) {
  return plan ? `${route(plan)} · ${sourceLabels[plan.source]}` : '未知';
}

export function ModelPreview({ model, showExpected, canStartManually }: {
  model: TaskModels; showExpected: boolean; canStartManually: boolean;
}) {
  return <dl className="full-text">
    {showExpected && <><dt>下次派发预计 Worker 模型</dt><dd>{expected(model.expected)}</dd></>}
    <dt>Worker 当前原生选择</dt><dd>{model.current ? route(model.current) : '未知'}
      {canStartManually && model.expected?.source !== 'role-override' && !model.current &&
        <span className="muted"> · 手动开始前请在 Worker 会话选择模型</span>}
    </dd>
  </dl>;
}

function RunModelEvidence({ run, title }: { run: RunModels; title: string }) {
  const trajectory = run.actual.map(route).filter((label, index, labels) => label !== labels[index - 1]);
  return <div className="full-text">
    <dl>
      <dt>{title}</dt><dd>{trajectory.length ? trajectory.join(' → ') : '未知（暂无可归属的调用证据）'}</dd>
      <dt>派发时预计</dt><dd>{expected(run.expected)}</dd>
    </dl>
    <details className="advanced"><summary>原生证据</summary>
      <dl><dt>Run</dt><dd>{run.runId}</dd><dt>原生会话</dt><dd>{run.sessionId}</dd></dl>
      {run.actual.map(call => <div key={call.eventSeq} className="event">
        {`第 ${call.turn} 轮 · 步骤 ${call.step} · ${route(call)}`}<br/>
        <span className="muted">{`${call.evidence} #${call.eventSeq}${call.headerSeq == null ? '' :
          ` · request/header #${call.headerSeq}`}`}</span>
      </div>)}
    </details>
  </div>;
}

export function ModelHistory({ model, runId }: { model: TaskModels; runId?: string }) {
  const first = runId ? model.runs.find(run => run.runId === runId) : model.runs[0];
  if (!first) return null;
  const history = model.runs.filter(run => run.runId !== first.runId);
  return <Section title="执行模型">
    <RunModelEvidence run={first} title="本轮实际模型"/>
    {history.length > 0 && <details className="advanced"><summary>其他 Run（{history.length}）</summary>
      {history.map(run => <RunModelEvidence key={run.runId} run={run} title={`${time(run.createdAt)} · 实际模型`}/>)}
    </details>}
  </Section>;
}
