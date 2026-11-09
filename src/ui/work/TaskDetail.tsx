/** One task in a drawer: header with the one main action, open questions, result, workdir, definition, session and audit. */
import type { Attention } from '../../model.ts';
import { useEffect } from 'react';
import { ConfirmAction, Section, Tag } from '../kit.tsx';
import { eventTitle, reviewLabel, settling, stageText, stageTone, time } from './format.ts';
import { RecoveryPanel, ReplyForm, TaskForm } from './forms.tsx';
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
    <div className="attention-box" key={a.id} id={`sb-attention-${task.id}`}>
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

function PrimaryAction({ w, detail }: { w: WorkspaceState; detail: Detail }) {
  const { task, run, result, binding } = detail, version = { id: task.id, expectedRowVersion: task.rowVersion };
  if (task.lifecycle === 'review' && result) return <button className="primary" disabled={w.locked}
    onClick={() => w.mutate('result.accept', {
    requestId: `accept:${result.id}:${task.rowVersion}`, ...version, resultId: result.id,
  })}>接受成果</button>;
  if (run && ['running', 'queued', 'cancelling'].includes(run.state)) return <button disabled={w.locked || run.state === 'cancelling'}
    onClick={() => w.mutate('task.stop', { requestId: `stop:${run.id}:${task.rowVersion}`, ...version })}>
    {run.state === 'cancelling' ? '正在核对停止…' : '停止执行'}</button>;
  if (detail.attentions.some(a => a.state === 'open' && a.kind === 'input' && binding)) return <button className="primary"
    onClick={() => document.getElementById(`sb-attention-${task.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>
    去回答</button>;
  if (binding?.state === 'ready' && task.status === 'unscheduled') return <button className="primary" disabled={w.locked}
    onClick={() => w.mutate('task.dispatch', { requestId: `dispatch:${task.id}:${task.rowVersion}`, ...version })}>开始执行</button>;
  return null;
}

function Head({ w, detail, close }: { w: WorkspaceState; detail: Detail; close: () => void }) {
  const { task, binding } = detail;
  return <header className="drawer-head">
    <div className="drawer-title">
      <Tag tone={stageTone(task)}>{stageText(task)}</Tag>
      {task.controlMode === 'paused' && task.status !== 'paused' && <Tag>自动管理已暂停</Tag>}
      {task.controlMode === 'manual' && task.status !== 'manual' && <Tag>人工接管</Tag>}
      <span className="spacer"/>
      <button className="icon" aria-label="关闭任务详情" title="关闭（Esc）" onClick={close}>✕</button>
    </div>
    <h2 className="detail-goal clamp">{task.goal}</h2>
    <p className="caption">{w.bot?.name} · 创建 {time(task.createdAt)} · 更新 {time(task.updatedAt)} · {reviewLabel(task)}</p>
    <div className="actions">
      <PrimaryAction w={w} detail={detail}/>
      {binding?.sessionId && <button onClick={() => w.api.openSession(binding.sessionId!)}>打开 Worker 会话</button>}
    </div>
  </header>;
}

function Definition({ w, detail }: { w: WorkspaceState; detail: Detail }) {
  const { task } = detail, editable = !detail.binding && task.lifecycle === 'open';
  return <Section title="目标、范围与验收" aside={editable && <button className="small" disabled={w.locked}
    onClick={() => w.setForm('edit')}>修改</button>}>
    {task.goal.length > 120 && <details><summary className="muted">完整目标</summary><p className="full-text">{task.goal}</p></details>}
    <dl>
      <dt>任务范围</dt><dd>{task.scope || '尚未填写'}</dd>
      <dt>验收条件</dt><dd>{task.acceptance || '尚未填写'}</dd>
      <dt>最终验收</dt><dd>{reviewLabel(task, true)}</dd>
    </dl>
  </Section>;
}

function MoreActions({ w, detail }: { w: WorkspaceState; detail: Detail }) {
  const { task } = detail, version = { id: task.id, expectedRowVersion: task.rowVersion };
  const toggle = () => w.mutate('task.control', {
    requestId: crypto.randomUUID(), ...version, mode: task.controlMode === 'auto' ? 'paused' : 'auto',
  });
  const cancel = () => w.mutate('task.cancel', { requestId: `cancel:${task.id}:${task.rowVersion}`, ...version });
  if (['completed', 'cancelled'].includes(task.lifecycle)) return null;
  return <details className="advanced"><summary>更多操作</summary>
    <div className="actions">
      <button disabled={w.locked} onClick={toggle}>{task.controlMode === 'auto' ? '暂停自动管理' : '恢复自动管理'}</button>
    </div>
    <ConfirmAction key={`cancel:${task.id}:${task.rowVersion}`} label="取消任务" disabled={w.locked || settling(task)} submit={cancel}
      explanation="结束这个任务，未送出的回答与返工要求不再执行。会话、成果和文件保留；取消不会接受成果。执行中或待核对时，请先停止并完成核对。"/>
  </details>;
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

/** Task detail as a drawer over the work list; Esc or the backdrop closes it. */
export function TaskDrawer({ w, compact }: { w: WorkspaceState; compact: boolean }) {
  const detail = w.detail, close = () => { w.deselect(); w.setForm(null); };
  useEffect(() => {
    if (!w.selected) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) close(); };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [w.selected]);
  if (!w.selected) return null;
  return <>
    {!compact && <div className="sb-backdrop" onClick={close} aria-hidden/>}
    <aside className={`sb sb-drawer ${compact ? 'sb-compact' : ''}`} aria-label="任务详情" role="dialog">
      {!detail ? <div className="drawer-body">
        <div className="drawer-title">
          <span className="spacer"/><button className="icon" aria-label="关闭任务详情" onClick={close}>✕</button>
        </div>
        <div className="skeleton"/><div className="skeleton"/>
      </div> : <div className="drawer-body task-detail">
        <Head w={w} detail={detail} close={close}/>
        <Attentions w={w} detail={detail}/>
        {detail.task.status === 'recovery' && (!detail.run || detail.run.finishedAt !== null) && <RecoveryPanel key={detail.task.id}
          busy={w.locked} confirm={() => w.mutate('run.recover', {
            requestId: `recover:${detail.task.id}:${detail.task.rowVersion}`, id: detail.task.id,
            expectedRowVersion: detail.task.rowVersion, acknowledged: true,
          })}/>}
        <ResultCard w={w} detail={detail}/>
        <WorkdirCard w={w} detail={detail}/>
        {w.form === 'edit' ? <TaskForm key={detail.task.id} task={detail.task} busy={w.locked} cancel={() => w.setForm(null)}
          submit={data => w.mutate('task.revise', { ...data, id: detail.task.id }, () => w.setForm(null))}/>
          : <Definition w={w} detail={detail}/>}
        <InputState detail={detail}/>
        <SessionControls w={w} detail={detail}/>
        <MoreActions w={w} detail={detail}/>
        <Audit detail={detail}/>
      </div>}
    </aside>
  </>;
}
