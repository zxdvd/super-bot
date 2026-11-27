import type { ChildWaitDetail, ChildWaitMember, Task } from '../../model.ts';
import { Section } from '../kit.tsx';
import type { WorkspaceApi } from './api.ts';
import type { Detail } from './types.ts';

const outcomes: Record<ChildWaitDetail['outcome'], string> = {
  waiting: '正在等待子 Agent',
  checking: '正在核对子 Agent 树',
  converged: '原生等待已收敛',
  clear: '已核对，无需等待',
  cancelled: '等待已取消',
  unknown: '等待状态未知',
};
const childOutcomes: Record<string, string> = {
  completed: '已结束',
  aborted: '已取消',
  error: '执行出错',
  refusal: '已拒绝',
  'max-tokens': '达到输出上限',
};
const timestamp = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' });
function Time({ value }: { value: number }) {
  return <time dateTime={new Date(value).toISOString()}>{timestamp.format(value)}</time>;
}

function duration(ms: number | null) {
  if (ms === null) return '未知';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

function Member({
  child,
  api,
  current,
  task,
}: {
  child: ChildWaitMember;
  api: WorkspaceApi;
  current: boolean;
  task: Task;
}) {
  const { sessionId, parentSessionId, stopReason, endedAt } = child;
  const state =
    endedAt === null
      ? current
        ? '尚未观察到结束'
        : '结局未知'
      : stopReason
        ? (childOutcomes[stopReason] ?? '结局未知')
        : '结局未知';
  return (
    <li className="full-text">
      {sessionId && api.openChildSession ? (
        <button
          className="small"
          onClick={() => api.botNavigation.openChildWorker(task, parentSessionId, sessionId)}
        >
          打开子会话 <code>{sessionId}</code>
        </button>
      ) : (
        <span>
          子 Agent <code>{child.childId}</code>
        </span>
      )}
      <span>
        {' '}
        · {state}
        {endedAt !== null && (
          <>
            {' '}
            · <Time value={endedAt} />
          </>
        )}
      </span>
      {!current && (
        <div className="muted caption">
          原生执行 <code>{child.nativeRunId}</code> · 发布 <Time value={child.startedAt} />
        </div>
      )}
    </li>
  );
}

function currentWait(detail: Detail, wait: ChildWaitDetail) {
  return detail.run?.finishedAt === null && detail.run.id === wait.runId && wait.endedAt === null;
}

export function CurrentChildWaits({
  detail,
  api,
  online,
}: {
  detail: Detail;
  api: WorkspaceApi;
  online: boolean;
}) {
  const waits = detail.childWaits?.filter((wait) => currentWait(detail, wait)) ?? [];
  return waits.map((wait) => (
    <section key={wait.id} className="sb-section" aria-label="子 Agent 等待">
      <header>
        <h3>{outcomes[online ? wait.outcome : 'unknown']}</h3>
      </header>
      <dl>
        <dt>等待开始</dt>
        <dd>
          <Time value={wait.startedAt} />
        </dd>
        <dt>已用时</dt>
        <dd>{duration(online ? wait.elapsedMs : null)}</dd>
        <dt>待完成数量</dt>
        <dd>
          {online && wait.outcome !== 'unknown' && wait.pendingCount !== null
            ? `已知 ${wait.pendingCount} 个 · 完整数量未知`
            : '未知'}
        </dd>
      </dl>
      {!online && <p className="muted">宿主连接中断，以下为上次收到的记录。</p>}
      {wait.children.length > 0 && (
        <ul>
          {wait.children.map((child) => (
            <Member
              key={child.nativeRunId}
              child={child}
              api={api}
              task={detail.task}
              current={online && wait.outcome !== 'unknown'}
            />
          ))}
        </ul>
      )}
    </section>
  ));
}

export function ChildWaitHistory({
  detail,
  api,
  runId,
}: {
  detail: Detail;
  api: WorkspaceApi;
  runId?: string;
}) {
  const waits =
    detail.childWaits?.filter(
      (wait) => !currentWait(detail, wait) && (!runId || wait.runId === runId),
    ) ?? [];
  if (!waits.length) return null;
  return (
    <Section title="子 Agent 等待记录">
      {waits.map((wait) => (
        <details className="advanced" key={wait.id}>
          <summary>
            <Time value={wait.startedAt} /> · 第 {wait.turn} 轮 · {outcomes[wait.outcome]}
          </summary>
          <dl className="full-text">
            <dt>等待结束</dt>
            <dd>{wait.endedAt === null ? '未知' : <Time value={wait.endedAt} />}</dd>
            <dt>总用时</dt>
            <dd>{duration(wait.elapsedMs)}</dd>
            <dt>观察到的子执行</dt>
            <dd>{wait.children.length ? `${wait.children.length} 个` : '未知'}</dd>
            <dt>等待来源</dt>
            <dd>{wait.source === 'ready' ? 'Worker 提交 ready' : '原生轮次即将结束'}</dd>
            <dt>父 Run</dt>
            <dd>
              <code>{wait.runId}</code>
            </dd>
            <dt>原生轮次证据</dt>
            <dd>
              turn/start #{wait.startSeq} · user/message #{wait.inputSeq}
            </dd>
          </dl>
          {wait.children.length > 0 && (
            <ul>
              {wait.children.map((child) => (
                <Member
                  key={child.nativeRunId}
                  child={child}
                  api={api}
                  task={detail.task}
                  current={false}
                />
              ))}
            </ul>
          )}
        </details>
      ))}
    </Section>
  );
}
