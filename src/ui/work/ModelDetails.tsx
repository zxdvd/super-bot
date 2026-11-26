import { useEffect, useState } from 'react';
import type {
  ModelRoute,
  RunModels,
  TaskModelHistory,
  WorkerModelPlan,
  WorkerModelPreview,
} from '../../model.ts';
import type { WorkspaceApi } from './api.ts';
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

function compactRoute(model: ModelRoute) {
  const name = model.model === 'codex/gpt-6.2-sol' ? 'Sol 6.2' : model.model;
  return `${name} · ${model.reasoningEffort ?? '档位未知'}`;
}

function ModelChip({ label, description }: { label: string; description: string }) {
  return (
    <span className="badge" title={description}>
      <span aria-hidden="true">{label}</span>
      <span className="model-chip-description">{description}</span>
    </span>
  );
}

export function ModelPreview({
  model,
  showExpected,
  canStartManually,
}: {
  model: WorkerModelPreview;
  showExpected: boolean;
  canStartManually: boolean;
}) {
  const { current, expected: next } = model;
  const differs =
    current?.provider !== next?.provider ||
    current?.model !== next?.model ||
    current?.reasoningEffort !== next?.reasoningEffort;
  const sameNext =
    showExpected && !differs
      ? ` · 下次派发预计${next ? `相同 · ${sourceLabels[next.source]}` : '未知'}`
      : '';
  const currentDescription = `Worker 当前原生选择：${current ? route(current) : '未知'}${sameNext}`;
  return (
    <div className="model-preview">
      <ModelChip
        label={current ? compactRoute(current) : 'Worker 模型未知'}
        description={currentDescription}
      />
      {showExpected && differs && (
        <ModelChip
          label={`下次派发预计 · ${next ? compactRoute(next) : '未知'}`}
          description={`下次派发预计 Worker 模型：${expected(next)}`}
        />
      )}
      {canStartManually && next?.source !== 'role-override' && !current && (
        <span className="muted">手动开始前请在 Worker 会话选择模型</span>
      )}
    </div>
  );
}

function RunModelEvidence({ run, title }: { run: RunModels; title: string }) {
  const trajectory = run.actual
    .map(route)
    .filter((label, index, labels) => label !== labels[index - 1]);
  return (
    <div className="full-text">
      <dl>
        <dt>{title}</dt>
        <dd>{trajectory.length ? trajectory.join(' → ') : '未知（暂无可归属的调用证据）'}</dd>
        <dt>派发时预计</dt>
        <dd>{expected(run.expected)}</dd>
      </dl>
      <details className="advanced">
        <summary>原生证据</summary>
        <dl>
          <dt>Run</dt>
          <dd>{run.runId}</dd>
          <dt>原生会话</dt>
          <dd>{run.sessionId}</dd>
        </dl>
        {run.actual.map((call) => (
          <div key={call.eventSeq} className="event">
            {`第 ${call.turn} 轮 · 步骤 ${call.step} · ${route(call)}`}
            <br />
            <span className="muted">{`${call.evidence} #${call.eventSeq}${
              call.headerSeq == null ? '' : ` · request/header #${call.headerSeq}`
            }`}</span>
          </div>
        ))}
      </details>
    </div>
  );
}

type HistoryScope = { api: WorkspaceApi; taskId: string; sessionId?: string };

export function loadModelHistory(
  { api, taskId, sessionId }: HistoryScope,
  receive: (history: TaskModelHistory | null) => void,
) {
  const controller = new AbortController(),
    { signal } = controller;
  const nativeSession = api.currentSession?.();
  const current = () => !signal.aborted && nativeSession === api.currentSession?.();
  if (sessionId && nativeSession !== sessionId) {
    receive(null);
    return;
  }
  const unsubscribe = api.watchCurrentSession?.(() => {
    if (signal.aborted) return;
    controller.abort();
    receive(null);
  });
  void api
    .call<TaskModelHistory>(
      'task.model-history',
      { id: taskId, ...(sessionId ? { sessionId } : {}) },
      signal,
    )
    .then((history) => {
      if (current()) receive(history.taskId === taskId ? history : null);
    })
    .catch(() => {
      if (current()) receive(null);
    });
  return () => {
    controller.abort();
    unsubscribe?.();
  };
}

function ExpandedModelHistory({ api, taskId, sessionId, runId }: HistoryScope & { runId: string }) {
  const [model, setModel] = useState<TaskModelHistory | null>();
  useEffect(() => loadModelHistory({ api, taskId, sessionId }, setModel), [api, taskId, sessionId]);
  if (model === undefined) return <p role="status">正在读取执行模型…</p>;
  const first = model?.runs.find((run) => run.runId === runId);
  if (!model || !first) return <p role="status">执行模型未知。可收起后重新读取。</p>;
  const history = model.runs.filter((run) => run.runId !== first.runId);
  return (
    <>
      <RunModelEvidence run={first} title="本轮实际模型" />
      {history.length > 0 && (
        <details className="advanced">
          <summary>其他 Run（{history.length}）</summary>
          {history.map((run) => (
            <RunModelEvidence
              key={run.runId}
              run={run}
              title={`${time(run.createdAt)} · 实际模型`}
            />
          ))}
        </details>
      )}
    </>
  );
}

export function ModelHistory(props: HistoryScope & { runId: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details className="advanced" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>执行模型</summary>
      {expanded && <ExpandedModelHistory {...props} />}
    </details>
  );
}
