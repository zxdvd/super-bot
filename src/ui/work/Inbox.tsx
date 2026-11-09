/** Default work view: what needs the user, what is moving, and a short recent tail. System problems sit on top. */
import type { ReactNode } from 'react';
import type { Task } from '../../model.ts';
import { inboxGroups, unseenResult } from './format.ts';
import { SystemIssues } from './SystemIssues.tsx';
import { TaskRow } from './TaskRow.tsx';
import type { WorkspaceState } from './useWorkspace.ts';

function Group({ w, title, tasks, empty, aside }: {
  w: WorkspaceState; title: string; tasks: Task[]; empty?: string; aside?: ReactNode;
}) {
  if (!tasks.length && !empty) return null;
  return <section className="card inbox-group" aria-label={title}>
    <header className="group-head"><h3>{title}</h3><span className="count">{tasks.length}</span><span className="spacer"/>{aside}</header>
    {tasks.length ? tasks.map(task => <TaskRow key={task.id} w={w} task={task}/>) : <p className="group-empty muted">{empty}</p>}
  </section>;
}

export function Inbox({ w }: { w: WorkspaceState }) {
  const items = w.page?.items;
  if (!items) return <div className="card"><div className="skeleton"/><div className="skeleton"/><div className="skeleton"/></div>;
  const groups = inboxGroups(items, w.seen, w.now);
  const fresh = groups.attention.filter(task => unseenResult(task, w.seen[task.id], w.now));
  const clear = fresh.length > 0 && <button className="small" onClick={() => w.markAllSeen(fresh)}>新成果标为已读</button>;
  return <div className="inbox">
    <SystemIssues w={w}/>
    {items.length === 0 ? <div className="card empty">
      <h2>还没有任务</h2>
      <p>在聊天里把事情交给 Bot，例如“调研某个方案并写对比表”或“修复某个页面的样式问题”。它会在这里出现。</p>
      <button disabled={!w.online} onClick={() => w.setForm('task')}>或直接新建任务</button>
    </div> : <>
      <Group w={w} title="需要你" tasks={groups.attention} empty="暂时没有需要你处理的事。" aside={clear}/>
      <Group w={w} title="进行中" tasks={groups.active}/>
      <Group w={w} title="最近完成" tasks={groups.recent}/>
      {w.page?.truncated && <p className="muted hint">任务较多，这里只显示最近的未完成任务；完整记录请切换到“全部”。</p>}
    </>}
  </div>;
}
