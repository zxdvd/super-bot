import { AppError, type ChatSource } from './model.ts';
import { parse } from 'yaml';
import type { GitLabReply, GitLabRequest } from './gitlab-client.ts';
import { gitLabObservationOrigin, type StageCondition, type StageObservation } from './work-stage.ts';

export const GITLAB_PLAY_TOOL = 'super_bot_gitlab_play';
export const GITLAB_RELEASE_GUIDANCE = 'For an affirmative owner authorization to publish after an exact GitLab MR checkpoint, use advance_stage with gitLabRelease.intent publish, current rowVersion and the exact merge condition referenced in stage.evidenceRef. Copy the complete current owner message to userInstruction. For an exact MR URL and publication already explicitly delegated with the original task, specify the same gitLabRelease intent and reference during create, so the saved grant can be used after the checkpoint. If the next step has no clear release target or the owner asks for a particular environment, set requiresJobName true. Pass jobName when the owner named it. When detail returns gitLabReleaseQuestion, use that compact question verbatim in the visible answer once. Interpret the next owner reply in context and use intent select with the exact name of their chosen displayed job and the recorded version. An explicit new delegation naming a verified exact job can use publish directly. A status question or quoted text grants no write. When a possible delegation is ambiguous, use intent clarify so the host identifies the job and waits for an affirmative choice in the original chat. Use detail.gitLabRelease for observed status and its exact job link. If the owner asks for a fresh status check, call detail with refreshGitLabRelease and expectedRowVersion. After explicit owner recovery of a permission denial, use intent retry and detail.gitLabRelease.condition from the earlier job. Never use general continuation, Bash or another job for this action. The host follows the exact job until the receipt or deadline.';
export const RELEASE_CHECK_MS = 30_000;
export const RELEASE_WAIT_MS = 30 * 60_000;

export interface ReleaseAuthorization {
  source: ChatSource; intent: 'publish' | 'select' | 'retry' | 'clarify'; jobName?: string; requiresJobName?: boolean;
  selection?: { observedAt: number; target: ReleaseTarget };
}
export type ReleasePlan = Pick<ReleaseAuthorization, 'jobName'> & {
  source?: ChatSource; requiresJobName?: boolean; requiresSelection?: boolean; retryTarget?: ReleaseTarget;
};
export interface ReleaseTarget {
  origin: string; project: string; projectId: number; pipelineId: number; jobId: number; name: string; sha: string; ref: string;
  newAfterMerge?: true;
}
export type ReleaseState = 'unsubmitted' | 'claim-pending' | 'tracking' | 'success' | 'failed' | 'needs-permission' | 'unknown' | 'expired';
export interface ReleaseReceipt {
  taskId: string; runId: string; stageRunId: string; target: ReleaseTarget; state: ReleaseState;
  condition: StageCondition;
  status?: string; detail: string; url: string; nextCheckAt: number | null; deadlineAt: number;
}

const active = new Set(['pending','running','preparing','waiting_for_resource','scheduled','canceling','waiting_for_callback']);
const terminal = new Set(['success','failed','canceled','skipped']);
const shaPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const jobNamePattern = /^[^\p{Cc}\p{Cf}]{1,120}$/u;
const projectPattern = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)+[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
export const releaseUrl = (target: ReleaseTarget) => `${target.origin}/${target.project}/-/jobs/${target.jobId}`;
export const releaseJobPath = (target: ReleaseTarget) => `/api/v4/projects/${target.projectId}/jobs/${target.jobId}`;
export const releaseKey = (target: ReleaseTarget) =>
  JSON.stringify([target.origin, target.projectId, target.pipelineId, target.jobId]);

export function exactMergeReference(text: string): StageCondition | null {
  try {
    const url = new URL(text);
    const match = /^\/(.+)\/-\/merge_requests\/([1-9][0-9]*)$/.exec(url.pathname);
    if (!match || !gitLabObservationOrigin(url.origin) || url.username || url.password || url.search || url.hash ||
      !projectPattern.test(match[1]!) || !positive(Number(match[2]))) return null;
    return { kind: 'gitlab-merge', sourceOrigin: url.origin, project: match[1]!, number: Number(match[2]) };
  } catch { return null; }
}

export function releaseJobName(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim() !== value || !jobNamePattern.test(value)) {
    throw new AppError('gitlab-job-name', '请选择原聊天已授权的确切 GitLab 作业名称。');
  }
  return value;
}

export function hasReleaseJobReference(text: string, name: string, otherNames: string[] = []): boolean {
  const spans = (label: string) => {
    const matches: [number, number][] = [];
    const unicode = /[^\x00-\x7f]/u.test(label);
    for (let start = text.indexOf(label); start >= 0; start = text.indexOf(label, start + 1)) {
      const end = start + label.length, before = text.slice(0, start), after = text.slice(end);
      if (/[\w/@%+#:-]$|\w\.$/u.test(before) || /^[\w/@%+#:-]|^\.\w/u.test(after) ||
        unicode && (/[\p{L}\p{M}\p{N}]$/u.test(before) || /^[\p{L}\p{M}\p{N}]/u.test(after))) continue;
      matches.push([start, end]);
    }
    return matches;
  };
  const references = spans(name);
  if (!references.length) return false;
  const longer = otherNames.filter(other => other.length > name.length && other.includes(name)).flatMap(spans);
  return references.some(([start, end]) => !longer.some(([left, right]) => left <= start && end <= right));
}

export function mergeReferences(prose:string):StageCondition[] {
  return [...prose.matchAll(/https:\/\/[^\s<>()，。]+/gu)].flatMap(match=>{
    const reference=exactMergeReference(match[0].replace(/[.,;:!?]+$/u,''));
    return reference?[reference]:[];
  });
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const good = (reply: GitLabReply) => reply.code >= 200 && reply.code < 300;
const pending = (detail: string): StageObservation => ({ state: 'pending', detail });
const unavailable = (detail: string): StageObservation => ({ state: 'unavailable', detail });

function declaredEnvironments(reply: GitLabReply): Map<string,string> {
  const result=new Map<string,string>();
  const lint=object(reply.data);
  // Without fully resolved immutable deployment evidence, leave the final
  // selection to the owner. Job and stage names alone convey no write scope.
  if(!good(reply)||lint.valid!==true||typeof lint.merged_yaml!=='string'||
    !Array.isArray(lint.includes)||lint.includes.length)return result;
  try {
    const config=object(parse(lint.merged_yaml,{maxAliasCount:0}));
    if(config.include!==undefined)return result;
    for(const [name,definition] of Object.entries(config)) {
      const job=object(definition), environment=object(job.environment);
      if(job.extends!==undefined||job.parallel!==undefined||
        environment.action!==undefined&&environment.action!=='start')continue;
      const target=typeof job.environment==='string'?job.environment:environment.name;
      if(typeof target==='string'&&/^[^\p{Cc}\p{Cf}$]{1,120}$/u.test(target))result.set(name,target);
    }
  }catch{/* Unverifiable configuration can still be corroborated by the owner's exact job choice. */}
  return result;
}

function missing(reply: GitLabReply, label: string): StageObservation {
  if (reply.code === 0 || reply.code === 429 || reply.code >= 500) {
    return { state: 'transient', detail: `GitLab 暂时无法读取${label}。` };
  }
  return unavailable(reply.code === -1
    ? `没有此 GitLab 实例的可信读取能力。请由宿主负责人恢复相同实例的 GitLab 只读配置或 glab 登录。`
    : `GitLab 无法读取${label}（HTTP ${reply.code}）。请由项目负责人核对该对象及当前读取身份的权限。`);
}

export async function discoverRelease(
  condition: StageCondition, plan: ReleasePlan, read: GitLabRequest, signal: AbortSignal,
): Promise<StageObservation> {
  signal=AbortSignal.any([signal,AbortSignal.timeout(20_000)]);
  const { sourceOrigin: origin, project, number: iid } = condition;
  const mrUrl = `${origin}/${project}/-/merge_requests/${iid}`;
  const request = await read(`/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${iid}`, signal);
  if (!good(request)) return missing(request, `合并请求 !${iid}`);
  const mr = object(request.data);
  if (mr.iid !== iid || mr.web_url !== mrUrl || !positive(mr.project_id) || mr.target_project_id !== mr.project_id) {
    return unavailable(`GitLab 未返回同一实例、项目和 IID 的合并请求 !${iid}。`);
  }
  if (mr.state === 'opened' || mr.state === 'locked') {
    return { ...pending(`等待 ${project} !${iid} 合并。`), stateLabel: String(mr.state), releaseMergeOpen: true };
  }
  if (mr.state !== 'merged') return { state: 'unsatisfied', detail: `GitLab 合并请求 !${iid} 状态为 ${String(mr.state)}。` };
  const sha = mr.merge_commit_sha ?? mr.squash_commit_sha, ref = mr.target_branch, projectId = mr.project_id;
  if (plan.retryTarget) {
    const target = plan.retryTarget;
    if(target.origin!==origin||target.project!==project||target.projectId!==projectId||target.sha!==sha||target.ref!==ref) {
      return unavailable(`合并请求 !${iid} 的当前归属或提交与原作业 #${target.jobId} 不匹配。`);
    }
    const checked = await read(releaseJobPath(target), signal);
    if (!good(checked)) return missing(checked, `先前的发布作业 #${target.jobId}`);
    const status = exactJobStatus(checked.data, target);
    if (!status) return unavailable(`无法重新核对流水线 #${target.pipelineId} 中原发布作业 #${target.jobId} 的确切身份。`);
    if (plan.requiresSelection) return releaseChoiceObservation(target.pipelineId, [target], new Map(), false);
    return { state: 'satisfied', stateLabel: status, detail: `已核对原发布作业 #${target.jobId}（${status}）。`,
      url: releaseUrl(target), releaseJob: target };
  }
  if (typeof sha !== 'string' || !shaPattern.test(sha) || typeof ref !== 'string' || !ref || ref.length > 255) {
    return unavailable(`合并请求 !${iid} 缺少确切合并提交或目标分支，无法核对该次发布流水线。`);
  }
  const base = `/api/v4/projects/${projectId}`;
  const filters = new URLSearchParams({ sha, ref, source: 'push', per_page: '100' });
  const pipelines = await read(`${base}/pipelines?${filters}`, signal);
  if (!good(pipelines)) return missing(pipelines, `合并请求 !${iid} 对应的流水线`);
  if (!Array.isArray(pipelines.data) || pipelines.data.length >= 100) {
    return unavailable('无法完整核对合并提交的 GitLab 流水线。');
  }
  if (pipelines.data.length === 0) return pending(`等待合并提交 ${sha.slice(0,12)} 的目标分支流水线。`);
  const [pipeline] = pipelines.data;
  const { id: pipelineId } = object(pipeline);
  if (pipelines.data.length !== 1 || !positive(pipelineId) || pipeline.sha !== sha || pipeline.ref !== ref ||
    (pipeline.project_id !== undefined && pipeline.project_id !== projectId) ||
    (pipeline.source !== undefined && pipeline.source !== 'push') ||
    pipeline.web_url !== `${origin}/${project}/-/pipelines/${pipelineId}`) {
    return unavailable(`无法唯一确定合并提交 ${sha.slice(0,12)} 在分支 ${ref} 上的发布流水线。请由项目负责人核对该提交的流水线。`);
  }
  const jobs:Record<string,unknown>[]=[];
  for(let page=1;page<=10;page++) {
    const response=await read(`${base}/pipelines/${pipelineId}/jobs?include_retried=true&per_page=100${page>1?'&page='+page:''}`,signal);
    if (!good(response)) return missing(response, `流水线 #${pipelineId} 的作业`);
    if (!Array.isArray(response.data) || response.data.length>100 || page===10&&response.data.length===100) {
      return unavailable(`无法完整核对流水线 #${pipelineId} 的作业列表。请由项目负责人核对对应的发布作业。`);
    }
    jobs.push(...response.data.map(object));
    if(response.data.length<100)break;
  }
  if (plan.jobName && plan.source && !plan.requiresSelection &&
    !hasReleaseJobReference(plan.source.text, plan.jobName, jobs.map(job => job.name).filter(name => typeof name === 'string'))) {
    return { state: 'unsatisfied', detail: '请在原聊天提供确切的 GitLab 作业名称，或选择当前已展示的作业。' };
  }
  const deployments=plan.jobName?new Map<string,string>():declaredEnvironments(
    await read(`${base}/ci/lint?content_ref=${sha}`,signal));
  const mergedAt=typeof mr.merged_at==='string'?Date.parse(mr.merged_at):NaN;
  const pipelineCreatedAt=typeof pipeline.created_at==='string'?Date.parse(pipeline.created_at):NaN;
  const possible=jobs.filter(job=>typeof job.name==='string'&&jobNamePattern.test(job.name)&&
    (plan.jobName?job.name===plan.jobName:deployments.has(job.name)||job.status==='manual'));
  const proven=plan.jobName?possible:possible.filter(job=>deployments.has(String(job.name)));
  const candidates=proven.length?proven:possible;
  if(!candidates.length) {
    if(!jobs.length)return pending(`等待流水线 #${pipelineId} 创建发布作业。`);
    return {state:'unsatisfied',detail:`流水线 #${pipelineId} 缺少与当前范围匹配的手动作业。可提供确切作业名称供核对。`};
  }
  if(new Set(candidates.map(job=>job.name)).size!==candidates.length) {
    return unavailable(`流水线 #${pipelineId} 有同名或重试作业，无法唯一核对本次发布。`);
  }
  const verified:{target:ReleaseTarget;status:string}[]=[];
  for(const job of candidates.slice(0,10)) {
    if(!positive(job.id)||typeof job.name!=='string')return unavailable(`流水线 #${pipelineId} 的作业身份无效。`);
    const jobCreatedAt=typeof job.created_at==='string'?Date.parse(job.created_at):NaN;
    const target:ReleaseTarget={origin,project,projectId,pipelineId,jobId:job.id,name:job.name,sha,ref,
      ...(pipelineCreatedAt>=mergedAt&&jobCreatedAt>=pipelineCreatedAt?{newAfterMerge:true}:{})};
    const status=exactJobStatus(job,target);
    if(!status)return unavailable(`GitLab 未返回流水线 #${pipelineId} 中作业 #${job.id} 的匹配身份。`);
    verified.push({target,status});
  }
  if(candidates.length!==1||!proven.length||plan.requiresSelection||plan.requiresJobName&&!plan.jobName) {
    return releaseChoiceObservation(pipelineId, verified.map(item => item.target), deployments, candidates.length > verified.length);
  }
  const {target,status}=verified[0]!;
  if(status==='created')return pending(`等待发布作业 #${target.jobId} 进入可确认状态。`);
  return { state: 'satisfied', stateLabel: status, detail: `已核对 ${project} !${iid} 的发布作业 #${target.jobId}（${status}）。`,
    url: releaseUrl(target), releaseJob: target };
}

function releaseChoiceObservation(pipelineId: number, targets: ReleaseTarget[], deployments: ReadonlyMap<string, string>, more: boolean): StageObservation {
  const labels = targets.map(({name}) => deployments.has(name) ? `${name}（${deployments.get(name)}）` : name);
  return { state: 'unsatisfied', releaseChoices: targets,
    detail: `流水线 #${pipelineId} 的作业选项 · ${labels.join('、')}。${more ? ' 也可以提供其他确切作业名称。' : ''}` };
}

export function exactJobStatus(data: unknown, target: ReleaseTarget): string | undefined {
  const job = object(data), pipeline = object(job.pipeline), status = job.status;
  if (job.id !== target.jobId || job.name !== target.name || pipeline.id !== target.pipelineId ||
    pipeline.project_id !== target.projectId || pipeline.sha !== target.sha || pipeline.ref !== target.ref ||
    job.web_url !== releaseUrl(target) || typeof status !== 'string' ||
    !(status === 'manual' || status === 'created' || active.has(status) || terminal.has(status))) return;
  return status;
}

export function releaseReadback(receipt: ReleaseReceipt, response: GitLabReply, submitted = false, now = Date.now()): ReleaseReceipt {
  const status = exactJobStatus(response.data, receipt.target);
  const subject = `GitLab ${receipt.target.project} 流水线 #${receipt.target.pipelineId} 作业 #${receipt.target.jobId}`;
  const observed = (state: ReleaseState, detail: string, poll = false): ReleaseReceipt => ({
    ...receipt, state, detail: `${subject} ${detail}`, ...(status ? { status } : {}),
    nextCheckAt: poll ? Math.min(now + RELEASE_CHECK_MS, receipt.deadlineAt) : null,
  });
  if (submitted && [401,403].includes(response.code)) {
    return observed('needs-permission', `的正式入口拒绝了 Worker 身份（HTTP ${response.code}）。请由有权运行该作业的项目负责人核对该身份及受保护环境权限。`);
  }
  if (status && terminal.has(status)) return observed(status === 'success' ? 'success' : 'failed', `状态为 ${status}。`);
  if (now >= receipt.deadlineAt) {
    return observed('expired', `已到核对期限，最后可确认状态为 ${status ?? receipt.status ?? '未知'}。请提供该作业当前状态或恢复相同对象的读取权限。`);
  }
  if (status && active.has(status)) return observed('tracking', `已开始，状态为 ${status}。`, true);
  if (receipt.state === 'unsubmitted') {
    return status === 'manual' ? observed('unsubmitted', '处于 manual，正式入口尚未认领。')
      : observed('unsubmitted', '尚未提交。等待可信读取恢复并核对这个作业。', true);
  }
  return observed('unknown', status === 'manual'
    ? '仍显示 manual，无法确认为尚未提交。将只读核对这个作业。'
    : response.code === -1 || [401,403,404].includes(response.code)
      ? '的状态暂不可读取。请由项目负责人恢复对此作业的读取权限。'
      : '的回执暂未确认。将只读核对这个作业。', true);
}
