/** Execution session preparation, attaching an existing native session, detaching and history. */
import { useRef, useState } from 'react';
import type { ExistingSessionPreview, Task } from '../../model.ts';
import { ConfirmAction, Hint } from '../kit.tsx';
import type { WorkspaceApi } from './api.ts';
import { settling } from './format.ts';
import type { Detail, Submit } from './types.ts';
import type { WorkspaceState } from './useWorkspace.ts';

function ExistingSessionForm({ api, busy, task, submit }: { api: WorkspaceApi; busy: boolean; task: Task; submit: Submit }) {
  const [sessionId, setSessionId] = useState(''); const [preview, setPreview] = useState<ExistingSessionPreview>();
  const [history, setHistory] = useState(false); const [directory, setDirectory] = useState(false);
  const [checking, setChecking] = useState(false); const [error, setError] = useState(''); const request = useRef(crypto.randomUUID());
  async function inspect() {
    setChecking(true); setError(''); setPreview(undefined); setHistory(false); setDirectory(false); request.current = crypto.randomUUID();
    try { setPreview(await api.call<ExistingSessionPreview>('session.inspect', { id: task.id, sessionId: sessionId.trim() })); }
    catch (error) { setError(error instanceof Error ? error.message : '无法检查会话。'); } finally { setChecking(false); }
  }
  const approve = (set: (value: boolean) => void) => (event: { target: { checked: boolean } }) => {
    set(event.target.checked); request.current = crypto.randomUUID();
  };
  const attach = (value: ExistingSessionPreview) => void submit({
    requestId: request.current, id: task.id, expectedRowVersion: task.rowVersion, sessionId: value.sessionId, cwd: value.cwd,
    fullHistoryApproved: history, directoryApproved: directory,
  });
  return <details><summary>关联已有原生会话</summary><div className="form">
    <p className="muted">已有会话会保留整段历史。若不希望模型读取旧内容，请使用上方的新会话。</p>
    <label htmlFor="sb-existing-session">Session ID</label>
    <input id="sb-existing-session" value={sessionId} maxLength={200} disabled={busy || checking} placeholder="session-…"
      onChange={event => { setSessionId(event.target.value); setPreview(undefined); setError(''); }}/>
    <button disabled={busy || checking || !sessionId.trim()} onClick={() => void inspect()}>{checking ? '检查中…' : '检查会话与目录'}</button>
    {error && <p className="notice error" role="alert">{error}</p>}
    {preview && <>
      <p className="wrap">当前工作目录：{preview.cwd}</p>
      <button disabled={busy} onClick={() => api.openSession(preview.sessionId)}>查看原会话</button>
      {!preview.quiet ? <p className="notice" role="alert">{preview.reason} 本次未关联；处理后重新检查。</p> : <>
        <label className="check"><input type="checkbox" disabled={busy} checked={history} onChange={approve(setHistory)}/>
          允许本任务的模型读取整个原生会话历史</label>
        <label className="check"><input type="checkbox" disabled={busy} checked={directory} onChange={approve(setDirectory)}/>
          允许按本任务范围在上述目录内读取、写入和编辑文件</label>
        <p className="muted">关联后任务保持暂停，不调用模型、不重放旧消息。核对后再恢复自动管理。</p>
        <button disabled={busy || !history || !directory} onClick={() => attach(preview)}>确认关联并保持暂停</button>
      </>}
    </>}
  </div></details>;
}

function Unbound({ w, detail }: { w: WorkspaceState; detail: Detail }) {
  const { task } = detail;
  const prepare = () => w.mutate('session.prepare', {
    requestId: `prepare:${task.id}:${task.rowVersion}`, id: task.id, expectedRowVersion: task.rowVersion,
  });
  return <>
    <p className="muted">为这个任务创建专用工作目录和原生会话。准备会话不会调用模型。</p>
    <button disabled={w.locked || task.status === 'needs-input' || task.lifecycle !== 'open'} onClick={prepare}>准备执行会话</button>
    {task.lifecycle === 'open' && task.scope && task.acceptance && <ExistingSessionForm key={`${task.id}:${task.rowVersion}`}
      api={w.api} task={task} busy={w.locked} submit={data => w.mutate('session.attach', data)}/>}
  </>;
}

function Bound({ w, detail }: { w: WorkspaceState; detail: Detail }) {
  const { task } = detail, binding = detail.binding!;
  const dispatch = () => w.mutate('task.dispatch', {
    requestId: `dispatch:${task.id}:${task.rowVersion}`, id: task.id, expectedRowVersion: task.rowVersion,
  });
  return <>
    <p className="muted wrap">{binding.cwd}</p>
    {binding.state === 'ready' ? <>
      <button onClick={() => w.api.openSession(binding.sessionId!)}>打开任务会话</button>{' '}
      <button className="primary" disabled={w.locked || task.status !== 'unscheduled'} onClick={dispatch}>开始执行</button>
      <Hint>可打开任务会话查看执行过程；尚未配置模型时可在会话中选择。会话关联后暂锁定目标，避免执行版本不一致。</Hint>
    </> : <>
      <p>会话创建需要核对。</p>
      <button disabled={w.locked} onClick={() => w.mutate('session.reconcile', { id: binding.id })}>核对会话</button>
    </>}
  </>;
}

export function SessionControls({ w, detail }: { w: WorkspaceState; detail: Detail }) {
  const { task, binding } = detail;
  const detach = () => w.mutate('session.detach', {
    requestId: `detach:${task.id}:${task.rowVersion}`, id: task.id, expectedRowVersion: task.rowVersion,
  });
  return <details className="session-box advanced"><summary>执行会话与高级控制</summary>
    {binding ? <Bound w={w} detail={detail}/> : <Unbound w={w} detail={detail}/>}
    {binding?.state === 'ready' && task.lifecycle === 'open' && <details><summary className="muted">调整执行会话</summary>
      <ConfirmAction key={`detach:${task.id}:${task.rowVersion}`} label="解除会话关联"
        explanation="任务将暂停，未送出的回答与返工要求失效；原会话和文件保留。之后可以修改目标，再准备全新会话与目录，不会自动读取旧对话。"
        disabled={w.locked || settling(task)} submit={detach}/>
    </details>}
    {detail.bindingHistory.length > 0 && <details><summary className="muted">历史执行会话（{detail.bindingHistory.length}）</summary>
      {detail.bindingHistory.filter(old => old.sessionId).map(old => <p key={old.id}>
        <button onClick={() => w.api.openSession(old.sessionId!)}>打开第 {old.generation} 个会话</button>
        <span className="muted"> · 目标版本 {old.taskRevision}</span>
      </p>)}
    </details>}
  </details>;
}
