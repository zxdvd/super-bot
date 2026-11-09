/** Bot work view: an inbox first, an optional board and full list, settings behind ⋯, and task detail in a drawer. */
import type { Bot, Task } from '../model.ts';
import { styles } from './styles.ts';
import { inboxGroups, stage, time, type Stage } from './work/format.ts';
import { BotForm, TaskForm } from './work/forms.tsx';
import { BotPanel } from './work/BotPanel.tsx';
import { Board } from './work/Board.tsx';
import { Inbox } from './work/Inbox.tsx';
import { TaskDrawer } from './work/TaskDetail.tsx';
import { TaskFilters, TaskList } from './work/TaskList.tsx';
import type { WorkView } from './work/storage.ts';
import { useWorkspace, type WorkspaceProps, type WorkspaceState } from './work/useWorkspace.ts';

export type { WorkspaceApi } from './work/api.ts';
export { resultHeading, workGroup } from './work/format.ts';

const VIEWS: readonly (readonly [WorkView, string])[] = [['inbox', '收件箱'], ['board', '看板'], ['list', '全部']];

function Summary({ w }: { w: WorkspaceState }) {
  if (w.view === 'list' || w.view === 'settings' || !w.page) return null;
  const groups = inboxGroups(w.page.items, w.seen, w.now), count = (key: Stage) => groups.attention.filter(t => stage(t) === key).length;
  return <span className="summary">
    需要你 <strong>{count('needs-you')}</strong> · 待验收 <strong>{count('review')}</strong> · 进行中 <strong>{groups.active.length}</strong>
  </span>;
}

function Header({ w, compact, onReturn }: { w: WorkspaceState; compact: boolean; onReturn?: () => void }) {
  const views = compact ? VIEWS.filter(([key]) => key !== 'board') : VIEWS, settings = w.view === 'settings';
  return <header className="sb-header">
    <div className="sb-title">
      {onReturn && <button className="small" onClick={onReturn}>← 返回聊天</button>}
      <h1>{w.bot?.name ?? 'Super Bot'}</h1>
      <span className="connection" title={w.synced ? `同步于 ${time(w.synced)}` : undefined}>
        <span className={`dot ${w.online ? '' : 'offline'}`}/>{w.loading ? '连接中…' : w.online ? '在线' : '离线'}
      </span>
      <Summary w={w}/>
    </div>
    {w.bot && <div className="header-actions">
      {!settings && <div className="segmented" role="tablist" aria-label="视图">
        {views.map(([key, label]) => <button key={key} role="tab" aria-selected={w.view === key}
          className={w.view === key ? 'active' : ''} onClick={() => w.setView(key)}>{label}</button>)}
      </div>}
      {!settings && <button className="primary" disabled={w.locked} onClick={() => w.setForm(w.form === 'task' ? null : 'task')}>
        ＋ 新任务</button>}
      <button className={`icon ${settings ? 'active' : ''}`} aria-label="设置与维护" aria-pressed={settings} title="设置与维护"
        onClick={() => w.setView(settings ? 'inbox' : 'settings')}>{settings ? '✕' : '⋯'}</button>
    </div>}
  </header>;
}

function Notices({ w }: { w: WorkspaceState }) {
  const problem = w.error || w.connectionError;
  return <>
    {problem && <div className="notice error" role="alert"><span>{problem}</span>
      <button onClick={() => { w.setError(''); w.setConnectionError(''); w.setRefresh(n => n + 1); }}>刷新状态</button>
    </div>}
    {!w.online && !w.loading && <div className="notice slim">
      离线 · {w.synced ? `显示 ${time(w.synced)} 的快照` : '尚未读取到工作台数据'}，重新连接前操作暂不可用。
    </div>}
  </>;
}

function Welcome({ w }: { w: WorkspaceState }) {
  return <div className="welcome"><h2>先认识你的第一位 Bot</h2>
    <p className="muted">定义长期职责，再在聊天里把具体目标交给它。需要你回答或验收时，会集中出现在这里。</p>
    <button className="primary" disabled={!w.online} onClick={() => w.setForm('bot')}>创建第一个 Bot</button>
  </div>;
}

function BotForms({ w }: { w: WorkspaceState }) {
  const { bot, form } = w, close = () => { w.setForm(null); w.setError(''); };
  const editBot = form === 'bot-edit' && bot;
  if (form !== 'bot' && !editBot) return null;
  return <BotForm key={editBot ? bot.id : 'new-bot'} bot={editBot ? bot : undefined} busy={w.locked} cancel={close}
    submit={data => w.mutate<Bot>(editBot ? 'bot.update' : 'bot.create', editBot ? { ...data, id: bot.id } : data, b => {
      if (form === 'bot') w.pickBot(b.id); w.setManagerInfo(undefined); w.setForm(null);
    })}/>;
}

function NewTask({ w }: { w: WorkspaceState }) {
  if (w.form !== 'task') return null;
  return <TaskForm key="new" busy={w.locked} cancel={() => { w.setForm(null); w.setError(''); }}
    submit={data => w.mutate<Task>('task.create', { ...data, botId: w.botId },
      t => { w.setForm(null); w.select(t.id); })}/>;
}

function Body({ w, bot }: { w: WorkspaceState; bot: Bot }) {
  if (w.view === 'settings') return <BotPanel w={w} bot={bot}/>;
  if (w.view === 'board') return <Board w={w}/>;
  if (w.view === 'list') return <><TaskFilters w={w}/><TaskList w={w}/></>;
  return <Inbox w={w}/>;
}

export function Workspace(props: WorkspaceProps) {
  const w = useWorkspace(props), compact = props.compact ?? false, bot = w.bot;
  return <div className={`sb-shell ${compact ? 'sb-compact' : ''}`}><style>{styles}</style>
    <div ref={w.scroller} className="sb"><div className={`sb-wrap ${w.view === 'board' ? 'wide' : ''}`}>
      <Header w={w} compact={compact} onReturn={props.onReturn}/>
      <Notices w={w}/>
      {w.loading ? <div className="card"><div className="skeleton"/><div className="skeleton"/><div className="skeleton"/></div> : <>
        <BotForms w={w}/>
        {w.online && w.bots.length === 0 && w.form !== 'bot' && <Welcome w={w}/>}
        {bot && <><NewTask w={w}/><Body w={w} bot={bot}/></>}
      </>}
    </div></div>
    <TaskDrawer w={w} compact={compact}/>
  </div>;
}
