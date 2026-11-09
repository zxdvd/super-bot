/** Lifecycle filters, search, grouped task rows and pagination. */
import { Tag } from '../kit.tsx';
import { groupTitles, reviewLabel, taskLabel, time, workGroup, workGroups } from './format.ts';
import { PAGE_SIZE, type WorkspaceState } from './useWorkspace.ts';

const FILTERS = [['', '全部', 'all'], ['open', '未完成', 'open'], ['review', '待验收', 'review'],
  ['completed', '已完成', 'completed'], ['cancelled', '已取消', 'cancelled']] as const;

export function TaskFilters({ w }: { w: WorkspaceState }) {
  return <div className="stats">{FILTERS.map(([value, label, key]) =>
    <button key={key} className={w.filter === value ? 'active' : ''} disabled={w.locked}
      onClick={() => { w.resetView({ filter: value }); w.setForm(null); }}>
      {label}<strong>{w.page?.counts[key] ?? '—'}</strong>
    </button>)}
  </div>;
}

function EmptyList({ w }: { w: WorkspaceState }) {
  const narrowed = Boolean(w.query || w.filter);
  return <div className="empty">
    <h2>{narrowed ? '没有匹配的任务' : '还没有任务'}</h2>
    <p>{narrowed ? '调整关键词或状态筛选。' : '把一个具体目标放进来，先写清怎样算完成。'}</p>
    {!narrowed && <button disabled={!w.online} onClick={() => w.setForm('task')}>新建任务</button>}
  </div>;
}

function Groups({ w }: { w: WorkspaceState }) {
  const items = w.page?.items ?? [];
  return <>{workGroups.map(group => {
    const tasks = items.filter(t => workGroup(t) === group);
    return tasks.length > 0 && <div key={group} className="work-group">
      <h3>{groupTitles[group]} <span className="muted">· 本页 {tasks.length}</span></h3>
      {tasks.map(t => <button key={t.id} className={`task ${w.selected === t.id ? 'selected' : ''}`} aria-pressed={w.selected === t.id}
        disabled={w.busy} onClick={() => w.select(t.id)}>
        <div className="task-top">
          <span className="task-goal">{t.goal}</span>
          <Tag tone={t.status === 'needs-input' ? 'attention' : 'neutral'}>{taskLabel(t)}</Tag>
        </div>
        <div className="task-meta"><span>{reviewLabel(t)}</span><span>{time(t.updatedAt)}</span></div>
      </button>)}
    </div>;
  })}</>;
}

function Pagination({ w }: { w: WorkspaceState }) {
  const page = w.page; if (!page) return null;
  const { offset } = w, last = Math.min(offset + page.items.length, page.total);
  return <footer className="pagination">
    <span>
      {page.total} 项任务 · {page.total ? offset + 1 : 0}–{last} · 第 {Math.floor(offset / PAGE_SIZE) + 1}/
      {Math.max(1, Math.ceil(page.total / PAGE_SIZE))} 页
    </span>
    <div>
      <button disabled={w.locked || offset === 0}
        onClick={() => w.resetView({ offset: Math.max(0, offset - PAGE_SIZE) })}>上一页</button>{' '}
      <button disabled={w.locked || offset + PAGE_SIZE >= page.total}
        onClick={() => w.resetView({ offset: offset + PAGE_SIZE })}>下一页</button>
    </div>
  </footer>;
}

export function TaskList({ w }: { w: WorkspaceState }) {
  return <section className="card task-list" aria-label="任务列表">
    <div className="card-head">
      <input disabled={w.busy} aria-label="搜索任务" maxLength={200} placeholder="搜索任务目标…" value={w.query}
        onChange={e => { w.resetView({ query: e.target.value.slice(0, 200) }); w.setForm(null); }}/>
    </div>
    {!w.page ? <div className="empty">读取任务…</div> : w.page.items.length === 0 ? <EmptyList w={w}/> : <Groups w={w}/>}
    <Pagination w={w}/>
  </section>;
}
