import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolCallId } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-permission-presets';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-user-approval';
import { WORKER_QUERY_TOOL } from '../git-status-query.ts';
import { gitLabReader, glabGitLab } from '../gitlab-client.ts';
import {
  exactJobStatus,
  GITLAB_PLAY_TOOL,
  releaseJobPath,
  releaseReadback,
  type ReleaseTarget,
} from '../gitlab-release.ts';
import { AppError, type Run, type WorkReport } from '../model.ts';
import { verifyRunTurn } from '../run-proof.ts';
import type { RuntimeOptions } from '../runtime.ts';
import type { Store } from '../store.ts';
import { readRunEvents } from './run-events.ts';

export interface GitLabReleaseScope {
  run: Run;
  assertCurrent(confirmedPreset?: string): void;
  recordStage(callId: ToolCallId, report: WorkReport & { kind: 'stage' }): void;
}

export function registerGitLabReleaseTool(
  ctx: Context,
  store: Store,
  options: Pick<RuntimeOptions, 'gitLabObserverOrigin'>,
  bindWorker: (agent: Agent, signal: AbortSignal) => GitLabReleaseScope | undefined,
): void {
  ctx.effect(() =>
    ctx.tools.register(
      {
        name: GITLAB_PLAY_TOOL,
        description:
          'Execute the one already authorized GitLab manual job for this run, or follow the same job by readback. Host verifies the saved target and reports the actual outcome. No arguments.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args, exec) => {
          const agent = exec.agent;
          const scope =
            agent &&
            args &&
            typeof args === 'object' &&
            !Array.isArray(args) &&
            !Object.keys(args).length
              ? bindWorker(agent, exec.signal)
              : undefined;
          if (!agent || !scope)
            throw new AppError(
              'gitlab-release-scope',
              '没有与本轮 Worker 绑定的正式 GitLab 作业授权。',
            );
          let confirmedPreset: string | undefined;
          const authorize = () => scope.assertCurrent(confirmedPreset);
          authorize();
          const receipt = await runGitLabRelease(
            ctx,
            store,
            options,
            agent,
            scope.run,
            exec.signal,
            authorize,
            async (target) => {
              const preset = ctx.permissionPresets.current(agent.session);
              if (preset === 'custom') return false;
              const permission = ctx.permissionPresets.resolve(preset);
              if (permission.approval !== 'ask') {
                if (permission.sandbox !== 'danger-full-access' || preset === 'auto') return false;
                confirmedPreset = preset;
                return true;
              }
              const approval = ctx.get?.('approval');
              const outcome = await approval?.request({
                agent,
                signal: exec.signal,
                callId: exec.callId,
                toolName: GITLAB_PLAY_TOOL,
                reason: `允许当前 Worker 启动 ${target.project} 流水线 #${target.pipelineId} 的作业 #${target.jobId}？`,
              });
              if (outcome !== 'allowed-once') return false;
              confirmedPreset = preset;
              return true;
            },
          );
          authorize();
          scope.recordStage(exec.callId, {
            kind: 'stage',
            stage: 'GitLab 正式作业',
            summary: receipt.detail,
            evidenceRef: receipt.url,
            checks: `GitLab 流水线 #${receipt.target.pipelineId}，作业 #${receipt.target.jobId}，${receipt.state}`,
          });
          exec.concludeTurn();
          return receipt;
        },
      },
      {
        when: ({ agent }) =>
          store
            .heldRuns()
            .some((run) => run.sessionId === agent.id && !!store.gitLabReleaseForRun(run)),
      },
    ),
  );
}

async function priorRunsAllowSubmission(
  ctx: Context,
  store: Store,
  agent: Agent,
  run: Run,
): Promise<boolean> {
  const release = store.gitLabReleaseForRun(run);
  if (!release) return false;
  try {
    const events = await readRunEvents(ctx, run, agent.session);
    const here = store.runTurn(run.id);
    if (here?.startSeq == null) return false;
    const history = store
      .taskRuns(run.taskId)
      .filter((item) => item.id !== run.id && item.taskRevision === run.taskRevision);
    for (const previous of history) {
      if (previous.sessionId !== run.sessionId || previous.bindingId !== run.bindingId)
        return false;
      const proof = store.runTurn(previous.id);
      if (!proof || proof.startSeq == null || proof.endSeq == null || proof.endSeq >= here.startSeq)
        return false;
      if (
        verifyRunTurn(
          previous,
          store.getRunInput(previous.id),
          proof,
          events.slice(0, here.startSeq),
          true,
        ).length
      )
        return false;
      if (
        release.target.newAfterMerge &&
        release.stage.releaseOpenedAt !== undefined &&
        previous.finishedAt !== null &&
        previous.finishedAt <= release.stage.releaseOpenedAt
      )
        continue;
      const segment = events.slice(proof.startSeq + 1, proof.endSeq);
      if (
        segment.some(
          (event) =>
            event.type === 'job/registered' ||
            event.type === 'working-directory/change' ||
            (event.type === 'user/message' &&
              event.seq !== proof.inputSeq &&
              !['runtime-context', 'time-context', 'skill-catalog'].includes(
                event.data.source?.kind,
              )),
        )
      )
        return false;
      const calls = segment.filter((event) => event.type === 'tool/call');
      const results = segment.filter((event) => event.type === 'tool/result');
      if (calls.length !== results.length) return false;
      for (const call of calls) {
        const matches = results.filter(
          (result) =>
            result.seq > call.seq &&
            result.data.step === call.data.step &&
            result.data.message?.toolCallId === call.data.callId,
        );
        if (matches.length !== 1) return false;
        const { name } = call.data;
        if (['super_bot_report', 'read', 'write', 'edit', WORKER_QUERY_TOOL].includes(name))
          continue;
        const formal =
          name === GITLAB_PLAY_TOOL &&
          release.plan.retryTarget &&
          store.gitLabReleaseForRun(previous);
        const receipt = formal && store.gitLabReleaseReceipt(formal.stage.runId);
        if (receipt && ['unsubmitted', 'needs-permission'].includes(receipt.state)) continue;
        return false;
      }
    }
    return history.some((item) => item.id === release.stage.runId);
  } catch {
    return false;
  }
}
async function runGitLabRelease(
  ctx: Context,
  store: Store,
  options: Pick<RuntimeOptions, 'gitLabObserverOrigin'>,
  agent: Agent,
  run: Run,
  signal: AbortSignal,
  authorize: () => void,
  permitted: (target: ReleaseTarget) => Promise<boolean>,
) {
  let receipt = store.beginGitLabRelease(run.id);
  const path = releaseJobPath(receipt.target);
  const reader = await gitLabReader(receipt.target.origin, options.gitLabObserverOrigin, signal);
  const response = await reader(path, signal);
  authorize();
  let outcome = releaseReadback(receipt, response);
  if (outcome.state !== 'unsubmitted' || outcome.nextCheckAt !== null)
    return store.recordGitLabRelease(receipt, outcome, true);
  if (!(await priorRunsAllowSubmission(ctx, store, agent, run))) {
    authorize();
    outcome = releaseReadback({ ...receipt, state: 'unknown' }, response);
    return store.recordGitLabRelease(
      receipt,
      {
        ...outcome,
        detail: `无法排除旧轮中可能影响 ${receipt.target.project} 发布作业 #${receipt.target.jobId} 的外部操作。将只读跟踪原作业。`,
      },
      true,
    );
  }
  authorize();
  const writer = await glabGitLab(receipt.target.origin, signal);
  const missing = (detail: string) =>
    store.recordGitLabRelease(receipt, { ...receipt, state: 'needs-permission', detail }, true);
  if (!writer)
    return missing(
      `当前 Worker 缺少 ${receipt.target.origin} 的同实例 glab 登录，无法运行作业 #${receipt.target.jobId}。请由有权运行该作业的人恢复本机 Worker 登录。`,
    );
  if (!(await permitted(receipt.target))) {
    return missing(
      `当前 Worker 的原生权限或审批未允许启动作业 #${receipt.target.jobId}。请在原生审批入口处理这个作业。`,
    );
  }
  const lastRead = await writer(path, signal);
  authorize();
  if ([401, 403, 404].includes(lastRead.code))
    return missing(
      `GitLab 无法以 Worker 身份访问作业 #${receipt.target.jobId}（HTTP ${lastRead.code}）。请由项目负责人核对访问权限。`,
    );
  if (exactJobStatus(lastRead.data, receipt.target) !== 'manual') {
    return store.recordGitLabRelease(receipt, releaseReadback(receipt, lastRead), true);
  }
  if (!store.claimGitLabRelease(run.id)) {
    receipt = store.gitLabReleaseReceipt(receipt.stageRunId) ?? receipt;
    return store.recordGitLabRelease(
      receipt,
      releaseReadback({ ...receipt, state: 'unknown' }, lastRead),
      true,
    );
  }
  receipt = store.gitLabReleaseReceipt(receipt.stageRunId)!;
  const submitted = await writer(path + '/play', signal, 'POST');
  const result = releaseReadback(receipt, submitted, true);
  if (
    result.state === 'unknown' &&
    submitted.code >= 200 &&
    submitted.code < 300 &&
    !signal.aborted
  ) {
    // The play endpoint may omit the pipeline coordinates. Use its exact
    // job GET representation rather than inferring status from the write.
    const readback = await reader(path, signal);
    return store.recordGitLabRelease(receipt, releaseReadback(receipt, readback), true);
  }
  return store.recordGitLabRelease(receipt, result, true, true);
}
