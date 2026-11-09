/** One task: open questions, definition, controls, working directory, session, result and audit trail. */
import type { Attention } from '../../model.ts';
import { ConfirmAction, Tag } from '../kit.tsx';
import { eventTitle, reviewLabel, settling, taskLabel, time } from './format.ts';
import { RecoveryPanel, ReplyForm } from './forms.tsx';
import { ResultCard } from './ResultCard.tsx';
import { SessionControls } from './SessionControls.tsx';
import type { Detail } from './types.ts';
import type { WorkspaceState } from './useWorkspace.ts';
import { WorkdirCard } from './WorkdirCard.tsx';

const attentionTitles: Record<Attention['kind'], string> = {
  recovery: '需要核对', review: '请验收成果', approval: '请处理原生审批', input: '需要你补充',
};
const inputStates: Record<string, string> = {
  accepted: '已接收', enqueued: '已投递', entered: '已进入上下文', unknown: '送达状态待核对', discarded: '已撤回',
};

function Attentions({ w, detail }: { w: WorkspaceState; detail: Detail }) {
  const { task, binding } = detail;
  return <>{detail.attentions.filter(a => a.state === 'open' || a.state === 'responding').map(a =>
    <div className="attention-box" key={a.id}>
      <strong>{attentionTitles[a.kind] ?? attentionTitles.input}</strong><p className="clamp">{a.question}</p>
      <details><summary>完整说明</summary><p className="full-text">{a.question}</p></details>
      {a.kind === 'approval' && binding?.sessionId && <p>
        <button disabled={w.locked} onClick={() => w.api.openSession(binding.sessionId!)}>打开会话处理审批</button>
      </p>}
      {a.state === 'responding' ? <p>回答已保存，等待投递和进入上下文。</p> : a.kind === 'input' && binding
        && <ReplyForm key={a.id} label="回答" busy={w.locked} submit={(text, requestId) =>
          w.mutate('attention.respond', { requestId, attentionId: a.id, expectedRowVersion: task.rowVersion, text })}/>}
    </div>)}</>;
}

function Controls({ w, detail }: { w: WorkspaceState; detail: Detail }) {
  const { task, run } = detail, version = { id: task.id, expectedRowVersion: task.rowVersion };
  const toggle = () => w.mutate('task.control', {
    requestId: crypto.randomUUID(), ...version, mode: task.controlMode === 'auto' ? 'paused' : 'auto',
  });
  const cancel = () => w.mutate('task.cancel', { requestId: `cancel:${task.id}:${task.rowVersion}`, ...version });
  const stop = () => w.mutate('task.stop', { requestId: `stop:${run!.id}:${task.rowVersion}`, ...version });
  return <>
    <div className="actions">
      <button disabled={w.locked || !!detail.binding || task.lifecycle !== 'open'} onClick={() => w.setForm('edit')}>修改任务</button>
      <button disabled={w.locked || ['completed', 'cancelled'].includes(task.lifecycle)} onClick={toggle}>
        {task.controlMode === 'auto' ? '暂停自动管理' : '恢复自动管理'}
      </button>
    </div>
    {['open', 'review'].includes(task.lifecycle) && <details><summary className="muted">不再需要这个任务？</summary>
      <ConfirmAction key={`cancel:${task.id}:${task.rowVersion}`} label="取消任务" disabled={w.locked || settling(task)} submit={cancel}
        explanation="结束这个任务，未送出的回答与返工要求不再执行。会话、成果和文件保留；取消不会接受成果。执行中或待核对时，请先停止并完成核对。"/>
    </details>}
    {run && ['running', 'queued', 'cancelling'].includes(run.state) && <div className="actions">
      <button disabled={w.locked || run.state === 'cancelling'} onClick={stop}>
        {run.state === 'cancelling' ? '正在核对停止…' : '停止当前执行'}
      </button>
      <span className="muted">停止后任务保留；不会清空你的原生输入。</span>
    </div>}
  </>;
}

function InputState({ detail }: { detail: Detail }) {
  const { task, run, input } = detail;
  if (!input) return null;
  const historic = run && (run.taskRevision !== task.taskRevision || run.bindingId !== detail.binding?.id);
  return <p className="muted">
    {historic ? '历史输入' : '任务输入'}（目标版本 {run?.taskRevision ?? task.taskRevision}）：{inputStates[input.state] ?? input.state}
  </p>;
}

function Audit({ detail }: { detail: Detail }) {
  const { task } = detail;
  return <details className="advanced"><summary>执行与审计记录</summary>
    <dl><dt>关键事件</dt><dd>{detail.events.map(e => <div className="event" key={e.id}>{time(e.createdAt)} · {eventTitle(e)}</div>)}</dd></dl>
    <div className="muted caption">目标版本 {task.taskRevision} · 创建时 Bot 配置 {task.botConfigRevision} · 修改 {task.rowVersion}</div>
  </details>;
}

export function TaskDetail({ w, compact }: { w: WorkspaceState; compact: boolean }) {
  const detail = w.detail;
  return <section className="card task-detail" aria-label="任务详情">
    {compact && w.selected && <div className="card-head">
      <button onClick={() => { w.deselect(); w.setForm(null); }}>← 全部工作</button>
    </div>}
    {!detail ? <div className="empty"><h2>任务的来龙去脉</h2><p>选择任务，查看范围、验收条件、待办和关键事件。</p></div> : <div className="card-body">
      <p className="detail-goal clamp">{detail.task.goal}</p>
      <Tag tone={detail.task.status === 'needs-input' ? 'attention' : 'neutral'}>{taskLabel(detail.task)}</Tag>
      <Attentions w={w} detail={detail}/>
      <details className="advanced"><summary>完整目标、范围与验收条件</summary>
        <p className="full-text">{detail.task.goal}</p>
        <dl>
          <dt>任务范围</dt><dd>{detail.task.scope || '尚未填写'}</dd>
          <dt>验收条件</dt><dd>{detail.task.acceptance || '尚未填写'}</dd>
          <dt>最终验收</dt><dd>{reviewLabel(detail.task, true)}</dd>
        </dl>
      </details>
      <Controls w={w} detail={detail}/>
      <WorkdirCard w={w} detail={detail}/>
      <SessionControls w={w} detail={detail}/>
      {detail.task.status === 'recovery' && (!detail.run || detail.run.finishedAt !== null) && <RecoveryPanel key={detail.task.id}
        busy={w.locked} confirm={() => w.mutate('run.recover', {
          requestId: `recover:${detail.task.id}:${detail.task.rowVersion}`, id: detail.task.id,
          expectedRowVersion: detail.task.rowVersion, acknowledged: true,
        })}/>}
      <InputState detail={detail}/>
      <ResultCard w={w} detail={detail}/>
      <Audit detail={detail}/>
    </div>}
  </section>;
}
