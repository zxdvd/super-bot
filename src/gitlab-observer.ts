import type { Store } from './store.ts';
import { gitLabHttp, gitLabReader, type GitLabRequest } from './gitlab-client.ts';
import { discoverRelease, releaseJobPath, releaseReadback } from './gitlab-release.ts';
import {
  gitLabObservationOrigin,
  type DueStage,
  type StageCondition,
  type StageObservation,
} from './work-stage.ts';

const unavailable = (detail: string): StageObservation => ({ state: 'unavailable', detail });
const temporary = (detail: string): StageObservation => ({ state: 'transient', detail });

async function observeStatus(
  condition: StageCondition,
  signal: AbortSignal,
  read: GitLabRequest,
): Promise<StageObservation> {
  const project = encodeURIComponent(condition.project);
  const type = condition.kind === 'gitlab-merge' ? 'merge_requests' : 'pipelines';
  const path = `/api/v4/projects/${project}/${type}/${condition.number}`;
  const reply = await read(path, signal);
  if (reply.code === 0 || reply.code === 429 || reply.code >= 500) {
    return temporary('GitLab 暂时无法提供状态。请核对本端网络和 GitLab 服务。');
  }
  if (reply.code === -1) {
    return unavailable(
      '没有该 GitLab 实例的可信读取能力。请由宿主负责人恢复当前配置或同实例的本机 glab 登录。',
    );
  }
  if (reply.code < 200 || reply.code >= 300) {
    return unavailable(
      `GitLab 无法读取指定对象（HTTP ${reply.code}）。请由项目负责人确认对象及本端只读权限。`,
    );
  }
  const data = reply.data as
    | { iid?: number; id?: number; state?: string; status?: string }
    | undefined;
  const isMerge = condition.kind === 'gitlab-merge';
  const statuses = isMerge
    ? ['opened', 'locked', 'merged', 'closed']
    : [
        'created',
        'waiting_for_resource',
        'preparing',
        'pending',
        'running',
        'scheduled',
        'manual',
        'success',
        'failed',
        'canceled',
        'skipped',
        'canceling',
      ];
  const stateLabel = isMerge ? data?.state : data?.status;
  if (
    (isMerge ? data?.iid : data?.id) !== condition.number ||
    !stateLabel ||
    !statuses.includes(stateLabel)
  ) {
    return unavailable('GitLab 回执缺少匹配对象或已知状态。需要项目负责人提供该对象的状态。');
  }
  const state = ['merged', 'success'].includes(stateLabel)
    ? 'satisfied'
    : ['closed', 'failed', 'canceled', 'skipped'].includes(stateLabel)
      ? 'unsatisfied'
      : 'pending';
  const url = condition.project.includes('/')
    ? `${condition.sourceOrigin}/${condition.project}/-/${type}/${condition.number}`
    : undefined;
  const detail =
    stateLabel === 'manual'
      ? 'GitLab 流水线处于 manual，等待拥有权限的人处理原生步骤。'
      : `GitLab 状态为 ${stateLabel}。`;
  const releaseMergeOpen =
    isMerge &&
    stateLabel === 'opened' &&
    !!url &&
    (data as { web_url?: string } | undefined)?.web_url === url;
  return {
    state,
    stateLabel,
    ...(url ? { url } : {}),
    ...(releaseMergeOpen ? { releaseMergeOpen: true } : {}),
    detail,
  };
}

export async function observeGitLabStage(
  origin: string,
  condition: StageCondition,
  signal: AbortSignal,
  token?: string,
  request: typeof fetch = fetch,
): Promise<StageObservation> {
  if (origin !== condition.sourceOrigin || gitLabObservationOrigin(origin) !== origin) {
    return unavailable('指定对象的 GitLab 来源与本端配置不一致。');
  }
  return observeStatus(condition, signal, gitLabHttp(origin, token, request));
}

/** One bounded reader per host. Durable dates and decisions live in the ledger. */
export function startStageObservation(
  store: Pick<
    Store,
    | 'dueStages'
    | 'recordStageObservation'
    | 'superviseStages'
    | 'gitLabReleaseForStage'
    | 'dueGitLabReleases'
    | 'recordGitLabRelease'
  >,
  configuredOrigin: string | undefined,
  read?: (due: DueStage, signal: AbortSignal) => Promise<StageObservation>,
) {
  const origin = gitLabObservationOrigin(configuredOrigin),
    stop = new AbortController();
  const signal = stop.signal;
  let running = false;
  const tick = async () => {
    if (signal.aborted || running) return;
    running = true;
    try {
      store.superviseStages();
      await Promise.allSettled([
        ...store.dueStages(4).map(async (due) => {
          let result: StageObservation;
          if (read)
            result =
              origin === due.origin
                ? await read(due, signal)
                : unavailable('宿主未配置此 GitLab 来源。');
          else {
            const plan = store.gitLabReleaseForStage(due.runId);
            const reader = await gitLabReader(due.origin, configuredOrigin, signal);
            result = plan
              ? await discoverRelease(due.condition, plan, reader, signal)
              : await observeStatus(due.condition, signal, reader);
          }
          if (!signal.aborted) store.recordStageObservation(due, result);
        }),
        ...store.dueGitLabReleases(2).map(async (receipt) => {
          const reader = await gitLabReader(receipt.target.origin, configuredOrigin, signal);
          const reply =
            Date.now() < receipt.deadlineAt
              ? await reader(releaseJobPath(receipt.target), signal)
              : { code: 0 };
          if (!signal.aborted) store.recordGitLabRelease(receipt, releaseReadback(receipt, reply));
        }),
      ]);
    } catch {
      // An unreadable ledger cannot release any stage. Leave the durable waits intact.
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 1000);
  timer.unref();
  void tick();
  return () => {
    stop.abort();
    clearInterval(timer);
  };
}
