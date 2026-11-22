/** One task in a drawer: header with the one main action, open questions, result, workdir, definition, session and audit. */
import type { Attention } from '../../model.ts';
import { ownerLabel, type MirrorDetail, type MirrorEvent, type ResultRecord } from '../../mirror.ts';
import { useEffect, useRef } from 'react';
import { workUrl, type WorkLink } from '../../work-links.ts';
import { ConfirmAction, Section, Tag } from '../kit.tsx';
import { canStartTask, eventTitle, reviewLabel, settling, stageText, stageTone, time } from './format.ts';
import { ReplyForm, TaskForm } from './forms.tsx';
import { ChildWaitHistory, CurrentChildWaits } from './ChildWaits.tsx';
import { ModelHistory, ModelPreview } from './ModelDetails.tsx';
import { RecoveryPanel } from './RecoveryPanel.tsx';
import { ResultCard, ResultFiles, ResultLoadReceipt, ResultReport } from './ResultCard.tsx';
import { deliveryLabels, ResultDeliveryCheck } from './SystemIssues.tsx';
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

function AttentionBox({ w, detail, attention }: { w: WorkspaceState; detail: Detail; attention: Attention }) {
  const { task, binding } = detail;
  const canReply = detail.pendingQuestions.some(question => question.id === attention.id);
  return <div className="attention-box" id={`sb-attention-${attention.id}`}>
    <strong>{attentionTitles[attention.kind]}</strong><p className="clamp">{attention.question}</p>
    <details><summary>完整说明</summary><p className="full-text">{attention.question}</p></details>
    {attention.kind === 'approval' && binding?.sessionId && <p>
      <button disabled={w.locked} onClick={() => w.api.openSession(binding.sessionId!)}>打开会话处理审批</button>
    </p>}
    {attention.state === 'responding' && <p>回答已保存，等待投递和进入上下文。</p>}
    {canReply && <ReplyForm key={attention.id} label="回答" busy={w.locked} submit={(text, requestId) =>
      w.mutate('attention.respond', { requestId, id: task.id, attentionId: attention.id, expectedRowVersion: task.rowVersion, text })}/>}
  </div>;
}

function Attentions({ w, detail }: { w: WorkspaceState; detail: Detail }) {
  return <>{detail.attentions.filter(a => a.id !== detail.recovery?.attentionId && (a.state === 'open' || a.state === 'responding'))
    .map(attention =>
    <AttentionBox key={attention.id} w={w} detail={detail} attention={attention}/>)}</>;
}

function PrimaryAction({ w, detail }: { w: WorkspaceState; detail: Detail }) {
  const { task, run, result } = detail, version = { id: task.id, expectedRowVersion: task.rowVersion };
  if (!task.blockingAttention && task.status !== 'recovery' && task.lifecycle === 'review' && result) return <button className="primary"
    disabled={w.locked}
    onClick={() => w.mutate('result.accept', {
    requestId: `accept:${result.id}:${task.rowVersion}`, ...version, resultId: result.id,
  })}>接受成果</button>;
  if (run && ['running', 'queued', 'cancelling'].includes(run.state)) return <button disabled={w.locked || run.state === 'cancelling'}
    onClick={() => w.mutate('task.stop', { requestId: `stop:${run.id}:${task.rowVersion}`, ...version })}>
    {run.state === 'cancelling' ? '正在核对停止…' : '停止执行'}</button>;
  const question = detail.pendingQuestions[0];
  if (question) return <button className="primary" onClick={event => {
    const drawer = event.currentTarget.closest('.sb-drawer');
    drawer?.querySelector(`#${CSS.escape(`sb-attention-${question.id}`)}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }}>去回答</button>;
  if (canStartTask(detail)) return <button className="primary" disabled={w.locked}
    onClick={() => w.mutate('task.dispatch', { requestId: `dispatch:${task.id}:${task.rowVersion}`, ...version })}>开始执行</button>;
  return null;
}

export function TaskDetailHeader({ w, detail, close, controls = true, onReturn, recoveryPanel = false }: {
  w: WorkspaceState; detail: Detail; close: () => void; controls?: boolean; onReturn?: () => void; recoveryPanel?: boolean;
}) {
  const { task, binding, wait, autoDispatchPending } = detail;
  const queued = wait || autoDispatchPending;
  const blocker = wait?.holderGoal || wait?.holderTaskId;
  return <header className="drawer-head">
    <div className="drawer-title">
      <Tag tone={queued ? 'attention' : stageTone(task)}>{queued ? '排队中' : stageText(task)}</Tag>
      {task.controlMode === 'paused' && task.status !== 'paused' && <Tag>自动管理已暂停</Tag>}
      {task.controlMode === 'manual' && task.status !== 'manual' && <Tag>人工接管</Tag>}
      <span className="spacer"/>
      {onReturn && <button className="small" onClick={onReturn}>← 返回聊天</button>}
      <button className="icon" aria-label="关闭任务详情" title="关闭（Esc）" onClick={close}>✕</button>
    </div>
    <h2 className="detail-goal clamp">{task.goal}</h2>
    <p className="caption">{w.bot?.name} · 创建 {time(task.createdAt)} · 更新 {time(task.updatedAt)} · {reviewLabel(task)}</p>
    {controls && detail.model && <ModelPreview model={detail.model} showExpected={task.lifecycle === 'open'}
      canStartManually={canStartTask(detail)}/>}
    {controls && queued && <p className="notice" role="status">
      {wait && <>{wait.code === 'resource-conflict' ? '工作目录被占用' : '等待执行名额'}
        {blocker && <>，排在「{blocker.slice(0, 80)}」之后</>}。</>}
      {autoDispatchPending
        ? (wait ? '资源就绪且管理会话可用时，Bot 会继续安排。' : '资源已就绪，等管理会话可用后由 Bot 继续安排。')
        : '资源就绪后可手动开始。'}
    </p>}
    {controls && <div className="actions">
      <PrimaryAction w={w} detail={detail}/>
      {binding?.sessionId && !recoveryPanel && <button onClick={() => w.api.openSession(binding.sessionId!)}>打开 Worker 会话</button>}
    </div>}
  </header>;
}

function Definition({ w, detail }: { w: WorkspaceState; detail: Pick<Detail, 'task'> & Partial<Pick<Detail, 'binding'>> }) {
  const { task } = detail, editable = !w.mirror && !detail.binding && task.lifecycle === 'open';
  return <Section title="目标、范围与验收" aside={editable && <button className="small" disabled={w.locked}
    onClick={() => w.setForm('edit')}>修改</button>}>
    {task.goal.length > 120 && <details><summary className="muted">完整目标</summary><p className="full-text">{task.goal}</p></details>}
    <dl>
      <dt>任务范围</dt><dd>{task.scope || '尚未填写'}</dd>
      <dt>验收条件</dt><dd>{task.acceptance || '尚未填写'}</dd>
      <dt>最终验收</dt><dd>{w.mirror ? task.reviewPolicy === 'human' ? '在创建端由用户确认' : '已授权 Bot 验收'
        : reviewLabel(task, true)}</dd>
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

const reportLabels: Record<string, string> = { progress: '进度', waiting: '等待', ready: '成果已报告', blocked: '受阻', failed: '执行失败' };

function Audit({ detail, readOnly = false }: { detail: Pick<Detail, 'task'> & { events: MirrorEvent[] }; readOnly?: boolean }) {
  const { task } = detail;
  return <details className="advanced"><summary>执行与审计记录</summary>
    <dl><dt>{readOnly ? '最近 50 条关键事件' : '关键事件'}</dt><dd>{detail.events.map(e => <div className="event" key={e.id}>
      {time(e.createdAt)} · {e.report ? reportLabels[e.report.kind] ?? eventTitle(e) : eventTitle(e)}
      {e.report && <p className="full-text">{e.report.summary}</p>}
    </div>)}</dd></dl>
    <div className="muted caption">目标版本 {task.taskRevision} · 创建时 Bot 配置 {task.botConfigRevision} · 修改 {task.rowVersion}</div>
  </details>;
}

export function LinkedTaskContent({ w, detail, link, close, onReturn }: {
  w: WorkspaceState; detail: Detail; link: Exclude<WorkLink, { kind: 'task' }>; close: () => void; onReturn?: () => void;
}) {
  const { task, result } = detail;
  if (link.kind === 'question') {
    const question = detail.attentions.find(a => a.id === link.attentionId && a.taskId === task.id && a.kind === 'input');
    const current = task.id === link.taskId && question?.taskRevision === task.taskRevision ? question : undefined;
    return <>
      <TaskDetailHeader w={w} detail={detail} close={close} controls={false} onReturn={onReturn}/>
      {current && (current.state === 'responding' || detail.pendingQuestions.some(a => a.id === current.id))
        ? <AttentionBox w={w} detail={detail} attention={current}/>
        : <p role="status">{current?.state === 'resolved' ? '这个问题已回答。' : '这个问题链接已失效或不属于此任务。'}</p>}
    </>;
  }
  const linked = detail.linkedResult?.id === link.resultId && detail.linkedResult.taskId === link.taskId
    && task.id === link.taskId ? detail.linkedResult : undefined;
  const current = !!linked && result?.id === linked.id;
  const newer = linked && result && !current ? result : undefined;
  return <>
    <TaskDetailHeader w={w} detail={detail} close={close} controls={current && task.lifecycle === 'review'} onReturn={onReturn}/>
    {current ? <ResultCard w={w} detail={detail} onReturn={onReturn}/> : linked ? <div className="attention-box result">
      <h3>历史成果 · 只读</h3>
      <p role="status">{newer ? '这份成果已被新版替代。' : '这份成果当前不可验收。'}</p>
      <p className="clamp">{linked.summary}</p>
      <ResultReport summary={linked.summary} checks={linked.checks}/>
      <ResultFiles result={linked} sessionId={w.sessionId}/>
      {newer && ['review', 'completed'].includes(task.lifecycle)
        && <a href={workUrl({ kind: 'result', taskId: task.id, resultId: newer.id })}>查看新版成果</a>}
      <ResultDeliveryCheck w={w} result={linked} status={detail.linkedChatDelivery} onReturn={onReturn} historical/>
    </div> : <p role="status">这个成果链接无效或不属于此任务。</p>}
    {current && <Progress detail={detail}/>}
    {current && detail.model && <ModelHistory key={`${w.sessionId}:${task.id}:${result.runId}`} api={w.api}
      sessionId={w.sessionId} taskId={task.id} runId={result.runId}/>}
    {current && <ChildWaitHistory detail={detail} api={w.api} runId={result.runId}/>}
  </>;
}

const runLabels: Record<string, string> = {
  queued: '待投递', running: '执行中', settled: '已收敛', failed: '失败', cancelling: '正在停止', cancelled: '已取消', interrupted: '中断',
};
function Progress({ detail }: { detail: Detail | MirrorDetail }) {
  const { task, run, result } = detail, progress = detail.progress;
  if (!run && !progress?.worker) return null;
  const currentRun = progress && progress.runId !== run?.id ? null : run;
  const events: MirrorEvent[] = detail.events;
  const legacy = !progress ? events.find(e => e.report?.kind === 'progress' && e.report.runId === run?.id) : undefined;
  const worker = progress?.worker ?? (legacy?.report ? { summary: legacy.report.summary, at: legacy.createdAt, runId: run?.id } : null);
  const accepted = progress?.acceptance ?? (result?.humanAcceptedAt ? { actor: 'user', at: result.humanAcceptedAt } : null);
  return <Section title="任务进度">
    <p className="muted">Worker 报告{worker && <> · {time(worker.at)}{worker.runId !== currentRun?.id && ' · 先前执行'}</>}</p>
    {worker ? <p className="full-text">{worker.summary}</p> : <p className="muted">当前目标暂无进度报告。</p>}
    {currentRun && <dl>
      <dt>程序记录 · 执行</dt><dd>已安排 {time(currentRun.createdAt)}
        {progress?.inputEnteredAt && ` · 输入进入模型 ${time(progress.inputEnteredAt)}`}
        {' · '}{runLabels[currentRun.state] ?? currentRun.state}
        {currentRun.finishedAt && ` ${time(currentRun.finishedAt)}`}</dd>
      {result && <><dt>程序记录 · 交付</dt><dd>{task.deliveredAt !== undefined ? `原聊天链接已确认 ${time(task.deliveredAt)}`
        : '尚无原聊天交付回执'}</dd></>}
      {result && <><dt>程序记录 · 验收</dt><dd>{accepted
        ? `${accepted.actor === 'user' ? '用户' : 'Bot'}接受 ${time(accepted.at)}`
        : task.lifecycle === 'review' ? '待验收' : '暂无验收记录'}</dd></>}
    </dl>}
  </Section>;
}

const verdictLabels: Record<string, string> = {
  accepted: '接受', accept: '接受', rejected: '要求返工', rework: '要求返工', human: '转人工验收',
};

function MirrorResult({ result }: { result: ResultRecord }) {
  return <>
    <p>{result.summary}</p><ResultReport summary={result.summary} checks={result.checks}/>
    <p className="muted">成果 {result.id} · {time(result.createdAt)}
      {result.humanAcceptedAt !== null && ` · 人工接受于 ${time(result.humanAcceptedAt)}`}</p>
    {result.fileCount > 0 && <p className="muted">已报告 {result.fileCount} 份文件，请在创建端打开或下载附件。</p>}
  </>;
}

function MirrorTaskContent({ w, detail, owner, close }: {
  w: WorkspaceState; detail: MirrorDetail; owner: keyof typeof ownerLabel; close: () => void;
}) {
  const { task, result, records, chatDelivery } = detail;
  const history = records.results.filter(record => record.id !== result?.id);
  return <>
    <header className="drawer-head">
      <div className="drawer-title"><Tag tone={stageTone(task)}>{stageText(task, true)}</Tag><span className="spacer"/>
        <button className="icon" aria-label="关闭任务详情" onClick={close}>✕</button></div>
      <h2 className="detail-goal clamp">{task.goal}</h2>
      <p className="caption">{ownerLabel[owner]} 创建 · 只读 · 更新 {time(task.updatedAt)}</p>
    </header>
    <Progress detail={detail}/>
    {result && <div className="attention-box result">
      <h3>{task.lifecycle === 'review' ? '成果 · 待来源端验收' : task.lifecycle === 'completed' ? '成果 · 已接受' : '成果记录'}</h3>
      {chatDelivery && <p className="muted">{deliveryLabels[chatDelivery]}</p>}
      <MirrorResult result={result}/>
      {detail.progress?.reload && <ResultLoadReceipt host={`创建端 ${ownerLabel[owner]}`} resultId={result.id}
        receipt={detail.progress.reload}/>}
    </div>}
    <Definition w={w} detail={detail}/>
    {(history.length > 0 || records.reviews.length > 0) && <details className="advanced"><summary>历史成果与验收记录</summary>
      {records.reviews.map(review => <p key={review.id}>{time(review.createdAt)} · {review.actor === 'user' ? '用户' : 'Bot'}
        {` · ${verdictLabels[review.verdict] ?? review.verdict} · 成果 ${review.resultId}`}</p>)}
      {history.map(record => <div key={record.id} className="attention-box"><MirrorResult result={record}/></div>)}
      {(records.moreResults || records.moreReviews) && <p className="muted">更多记录请在创建端核对。</p>}
    </details>}
    <Audit detail={detail} readOnly/>
  </>;
}

/** Task detail as a drawer over the work list; Esc or the backdrop closes it. */
export function TaskDrawer({ w, compact, onReturn }: { w: WorkspaceState; compact: boolean; onReturn?: () => void }) {
  const detail = w.detail, close = () => { w.deselect(); w.setForm(null); w.setError(''); };
  const linked = w.link?.kind === 'task' ? undefined : w.link;
  const linkedContent = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (linked && detail) linkedContent.current?.focus({ preventScroll: true });
  }, [linked, detail?.task.id]);
  useEffect(() => {
    if (!w.selected) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) close(); };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [w.selected]);
  if (!w.selected) return null;
  return <>
    {!compact && <div className="sb-backdrop" onClick={close} aria-hidden/>}
    <aside className={`sb sb-drawer ${compact ? 'sb-compact' : ''}`} aria-label="任务详情" role="dialog">
      {w.mirrorDetail && w.mirror ? <div className="drawer-body task-detail">
        <MirrorTaskContent w={w} detail={w.mirrorDetail} owner={w.mirror.owner} close={close}/>
      </div> : !detail ? <div className="drawer-body">
        <div className="drawer-title">
          <span className="spacer"/>
          {onReturn && <button className="small" onClick={onReturn}>← 返回聊天</button>}
          <button className="icon" aria-label="关闭任务详情" onClick={close}>✕</button>
        </div>
        {w.missingLink ? <p role="alert">链接中的任务不属于当前 Bot 或已不可用。</p>
          : w.connectionError ? <p role="alert">{w.connectionError}</p> : <><div className="skeleton"/><div className="skeleton"/></>}
      </div> : <div className="drawer-body task-detail">
        {w.error && <p role="alert" className="notice error">{w.error}</p>}
        {linked ? <div ref={linkedContent} tabIndex={-1}>
          <LinkedTaskContent w={w} detail={detail} link={linked} close={close} onReturn={onReturn}/>
        </div> : <>
        <TaskDetailHeader w={w} detail={detail} close={close} onReturn={onReturn} recoveryPanel={!!detail.recovery?.worker}/>
        {detail.recovery && <RecoveryPanel w={w} detail={detail} recovery={detail.recovery}
          key={`${detail.task.id}:${detail.task.rowVersion}:${detail.recovery.attentionId}:${detail.binding?.generation}`}/>}
        <Attentions w={w} detail={detail}/>
        <CurrentChildWaits detail={detail} api={w.api} online={w.online}/>
        <Progress detail={detail}/>
        <ResultCard w={w} detail={detail} onReturn={onReturn}/>
        <ChildWaitHistory detail={detail} api={w.api}/>
        {detail.model && detail.run && <ModelHistory key={`${w.sessionId}:${detail.task.id}:${detail.run.id}`} api={w.api}
          sessionId={w.sessionId} taskId={detail.task.id} runId={detail.run.id}/>}
        <WorkdirCard w={w} detail={detail}/>
        {w.form === 'edit' ? <TaskForm key={detail.task.id} task={detail.task} busy={w.locked} cancel={() => w.setForm(null)}
          submit={data => w.mutate('task.revise', { ...data, id: detail.task.id }, () => w.setForm(null))}/>
          : <Definition w={w} detail={detail}/>}
        <InputState detail={detail}/>
        <SessionControls w={w} detail={detail}/>
        <MoreActions w={w} detail={detail}/>
        <Audit detail={detail}/>
        </>}
      </div>}
    </aside>
  </>;
}
