/** Bot work view: composes the state hook with small view modules under ./work. */
import type { Bot, Task } from '../model.ts';
import type { BackupInfo } from '../backups.ts';
import { styles } from './styles.ts';
import { time } from './work/format.ts';
import { BotForm, TaskForm } from './work/forms.tsx';
import { BotPanel } from './work/BotPanel.tsx';
import { TaskDetail } from './work/TaskDetail.tsx';
import { TaskFilters, TaskList } from './work/TaskList.tsx';
import { useWorkspace, type WorkspaceProps, type WorkspaceState } from './work/useWorkspace.ts';

export type { WorkspaceApi } from './work/api.ts';
export { resultHeading, workGroup } from './work/format.ts';

function Header({ w, onReturn }: { w: WorkspaceState; onReturn?: () => void }) {
  return <header className="sb-header">
    <div>{onReturn && <button className="back-chat" onClick={onReturn}>← 返回聊天</button>}<h1>{w.bot?.name ?? 'Super Bot'} · 工作</h1></div>
    <div className="connection">
      <span className={`dot ${w.online ? '' : 'offline'}`}/>{w.loading ? '连接中…' : w.online ? '宿主在线' : '宿主离线'}
      {w.synced > 0 && <span className="muted">· {time(w.synced)}</span>}
    </div>
  </header>;
}

function Notices({ w }: { w: WorkspaceState }) {
  const problem = w.error || w.connectionError, warnings = w.status?.configWarnings ?? [];
  return <>
    {problem && <div className="notice error" role="alert"><span>{problem}</span>
      <button onClick={() => { w.setError(''); w.setConnectionError(''); w.setRefresh(n => n + 1); }}>刷新状态</button>
    </div>}
    {w.backupInfo && <div className="notice" ref={w.backupNotice} role="status">
      <div><strong>账本备份已保存</strong><p className="wrap">{w.backupInfo.path}</p><p className="muted">{w.backupInfo.scope}</p></div>
      <button onClick={() => w.setBackupInfo(undefined)}>关闭</button>
    </div>}
    {warnings.length > 0 && <div className="notice" role="status">
      <div><strong>配置提示</strong>{warnings.map(text => <p key={text} className="wrap">{text}</p>)}</div>
    </div>}
    {!w.online && !w.loading && <div className="notice">
      {w.synced ? '当前显示上次同步的快照。' : '尚未读取到工作台数据。'}重新连接前，操作暂不可用。
    </div>}
  </>;
}

function Toolbar({ w }: { w: WorkspaceState }) {
  if (!w.bots.length || w.sessionId) return null;
  return <details className="advanced"><summary>更多操作与 Bot 切换</summary><div className="toolbar">
    <select aria-label="选择 Bot" disabled={w.busy} value={w.botId} onChange={e => w.pickBot(e.target.value)}>
      {w.bots.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
    </select>
    <button disabled={w.locked} onClick={() => w.setForm(w.form === 'bot' ? null : 'bot')}>＋ 新 Bot</button>
    <span className="spacer"/>
    <button className="primary" disabled={w.locked || !w.bot} onClick={() => w.setForm(w.form === 'task' ? null : 'task')}>＋ 新任务</button>
  </div></details>;
}

function Welcome({ w }: { w: WorkspaceState }) {
  return <div className="welcome"><h2>先认识你的第一位 Bot</h2>
    <p className="muted">定义长期职责，再把具体目标交给它。任务与成果会保存在这里。</p>
    <ul><li>不同 Bot，各自负责自己的工作</li><li>任务有明确目标、范围和验收条件</li><li>需要你回答或验收时，集中呈现</li></ul>
    <button className="primary" disabled={!w.online} onClick={() => w.setForm('bot')}>创建第一个 Bot</button>
  </div>;
}

function Forms({ w }: { w: WorkspaceState }) {
  const { bot, form, detail } = w, close = () => { w.setForm(null); w.setError(''); };
  const editBot = form === 'bot-edit' && bot, editTask = form === 'edit' && detail;
  return <>
    {(form === 'bot' || editBot) && <BotForm key={editBot ? bot.id : 'new-bot'} bot={editBot ? bot : undefined} busy={w.locked}
      cancel={close}
      submit={data => w.mutate<Bot>(editBot ? 'bot.update' : 'bot.create', editBot ? { ...data, id: bot.id } : data, b => {
        if (form === 'bot') w.pickBot(b.id); w.setManagerInfo(undefined); w.setForm(null);
      })}/>}
  </>;
}

function TaskEditor({ w }: { w: WorkspaceState }) {
  const { form, detail } = w, editing = form === 'edit' && detail ? detail.task : undefined;
  if (form !== 'task' && !editing) return null;
  return <TaskForm key={editing?.id ?? 'new'} task={editing} busy={w.locked} cancel={() => { w.setForm(null); w.setError(''); }}
    submit={data => w.mutate<Task>(editing ? 'task.revise' : 'task.create',
      editing ? { ...data, id: editing.id } : { ...data, botId: w.botId },
      t => { w.setSelected(t.id); w.setForm(null); w.setOffset(0); w.setFilter(''); w.setQuery(''); })}/>;
}

function Foot({ w }: { w: WorkspaceState }) {
  return <details className="foot advanced"><summary>账本维护与运行信息</summary>
    {w.status && <>DSH {w.status.runtime} · 本地 SQLite / {w.status.journalMode.toUpperCase()} · </>}关闭面板不删除任务。
    <button className="inline" disabled={w.locked}
      onClick={() => w.mutate<BackupInfo>('backup.create', { requestId: crypto.randomUUID() }, w.setBackupInfo)}>备份账本</button>
  </details>;
}

export function Workspace(props: WorkspaceProps) {
  const w = useWorkspace(props), compact = props.compact ?? false, bot = w.bot;
  return <div ref={w.scroller} className={`sb ${compact ? 'sb-compact' : ''}`}><style>{styles}</style><div className="sb-wrap">
    <Header w={w} onReturn={props.onReturn}/>
    <Notices w={w}/>
    {w.loading ? <div className="empty">正在读取工作台…</div> : <>
      <Toolbar w={w}/>
      <Forms w={w}/>
      {w.online && w.bots.length === 0 && w.form !== 'bot' && <Welcome w={w}/>}
      {bot && <>
        <BotPanel w={w} bot={bot}/>
        <p className="muted">聊天交代工作，这里查看进展与成果。最终接受仍由你确认。</p>
        <TaskEditor w={w}/>
        <TaskFilters w={w}/>
        <div className={`grid ${w.selected ? 'has-selection' : ''}`}><TaskList w={w}/><TaskDetail w={w} compact={compact}/></div>
      </>}
    </>}
    <Foot w={w}/>
  </div></div>;
}
