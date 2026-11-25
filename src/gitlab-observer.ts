import type { Store } from './store.ts';
import { gitLabObservationOrigin, type DueStage, type StageCondition, type StageObservation } from './work-stage.ts';

const TOKEN_VARIABLE = 'SUPER_BOT_GITLAB_READ_TOKEN';
const MAX_BODY_BYTES = 1024 * 1024;

async function readStatusBody(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(body + decoder.decode());
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) return null;
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

const unavailable = (detail: string): StageObservation => ({ state: 'unavailable', detail });
const temporary = (detail: string): StageObservation => ({ state: 'transient', detail });

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
  const project = encodeURIComponent(condition.project);
  const type = condition.kind === 'gitlab-merge' ? 'merge_requests' : 'pipelines';
  const path = `/api/v4/projects/${project}/${type}/${condition.number}`;
  try {
    const response = await request(new URL(path, origin), {
      method: 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      headers: { Accept: 'application/json', ...(token ? { 'PRIVATE-TOKEN': token } : {}) },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 429 || response.status >= 500) {
        return temporary(`GitLab 暂时无法提供状态（HTTP ${response.status}）。`);
      }
      if ([401, 403, 404].includes(response.status)) {
        return unavailable(`GitLab 无法读取指定对象（HTTP ${response.status}）。请由项目负责人确认对象及本端只读权限。`);
      }
      return unavailable(`GitLab 状态接口未返回预期响应（HTTP ${response.status}）。需要项目负责人提供该对象的状态。`);
    }
    const data = await readStatusBody(response) as { iid?: number; id?: number; state?: string; status?: string } | null;
    const isMerge = condition.kind === 'gitlab-merge';
    const statuses = isMerge ? ['opened', 'locked', 'merged', 'closed']
      : ['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled', 'manual',
        'success', 'failed', 'canceled', 'skipped', 'canceling'];
    const stateLabel = isMerge ? data?.state : data?.status;
    if ((isMerge ? data?.iid : data?.id) !== condition.number || !stateLabel || !statuses.includes(stateLabel)) {
      return unavailable('GitLab 回执缺少匹配对象或已知状态。需要项目负责人提供该对象的状态。');
    }
    const state = ['merged', 'success'].includes(stateLabel) ? 'satisfied'
      : ['closed', 'failed', 'canceled', 'skipped'].includes(stateLabel) ? 'unsatisfied' : 'pending';
    const url = condition.project.includes('/')
      ? `${origin}/${condition.project}/-/${type}/${condition.number}` : undefined;
    const detail = stateLabel === 'manual' ? 'GitLab 流水线处于 manual，等待拥有权限的人处理原生步骤。'
      : `GitLab 状态为 ${stateLabel}。`;
    return { state, stateLabel, ...(url ? { url } : {}), detail };
  } catch {
    return temporary('GitLab 暂时无法读取。请核对本端网络和 GitLab 服务。');
  }
}

/** One bounded reader per host. Durable dates and decisions live in the ledger. */
export function startStageObservation(
  store: Pick<Store, 'dueStages' | 'recordStageObservation'>,
  configuredOrigin: string | undefined,
  read: (due: DueStage, signal: AbortSignal) => Promise<StageObservation> = (due, signal) => (
    observeGitLabStage(due.origin, due.condition, signal, process.env[TOKEN_VARIABLE])
  ),
) {
  const origin = gitLabObservationOrigin(configuredOrigin), stop = new AbortController();
  let running = false;
  const tick = async () => {
    if (stop.signal.aborted || running) return;
    running = true;
    try {
      await Promise.allSettled(store.dueStages(4).map(async due => {
        const result = origin && due.origin === origin ? await read(due, stop.signal)
          : unavailable('宿主未配置此 GitLab 来源。请由本端负责人恢复相同只读观察源，或提供指定对象的状态。');
        if (!stop.signal.aborted) store.recordStageObservation(due, result);
      }));
    } catch {
      // An unreadable ledger cannot release any stage. Leave the durable waits intact.
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 1000);
  timer.unref();
  void tick();
  return () => { stop.abort(); clearInterval(timer); };
}
