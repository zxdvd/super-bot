/** Optional board: columns by stage. Cancelled tasks are left to the full list. */
import { boardColumns, boardGroups, boardTitles } from './format.ts';
import { TaskRow } from './TaskRow.tsx';
import type { WorkspaceState } from './useWorkspace.ts';

export function Board({ w }: { w: WorkspaceState }) {
  const items = w.page?.items;
  if (!items) return <div className="card"><div className="skeleton"/><div className="skeleton"/></div>;
  const groups = boardGroups(items);
  return <div className="board" role="list" aria-label="任务看板">
    {boardColumns.map(column => <section key={column} className={`board-column ${column}`} role="listitem" aria-label={boardTitles[column]}>
      <header className="group-head"><h3>{boardTitles[column]}</h3><span className="count">{groups[column].length}</span></header>
      {groups[column].length ? groups[column].map(task => <TaskRow key={task.id} w={w} task={task} card/>)
        : <p className="group-empty muted">—</p>}
    </section>)}
  </div>;
}
