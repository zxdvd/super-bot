import { AppError, requiredText, type ChatSource } from './model.ts';
import type { ReleaseTarget } from './gitlab-release.ts';

/** Narrow condition contracts. Each provider supplies the readback, never a command from the model. */
export type StageCondition = {
  kind: 'gitlab-merge' | 'gitlab-pipeline';
  sourceOrigin: string;
  project: string;
  number: number;
};

export type StageObservation = {
  state: 'pending' | 'satisfied' | 'unsatisfied' | 'unavailable' | 'transient';
  detail: string;
  stateLabel?: string;
  url?: string;
  releaseJob?: ReleaseTarget;
  releaseChoices?: ReleaseTarget[];
  releaseMergeOpen?: true;
};

export interface WorkStage {
  runId: string;
  name: string;
  evidenceRef: string;
  summary: string;
  checks: string;
  state: 'awaiting-decision' | 'waiting' | 'ready' | 'dispatched' | 'blocked' | 'superseded';
  nextStep?: string;
  dispatchedRunId?: string;
  condition?: StageCondition;
  observation?: Omit<StageObservation, 'releaseChoices'> & {
    at: number;
    releaseChoices?: ReleaseTarget[] | string[];
  };
  reason?: string;
  deadlineAt?: number;
  expired?: boolean;
  planVersion?: number;
  planSource?: ChatSource;
  releaseOpenedAt?: number;
  at: number;
}

export type DueStage = {
  runId: string;
  taskId: string;
  rowVersion: number;
  checkAt: number;
  condition: StageCondition;
  origin: string;
};

export type StageFollowUp = 'append' | 'replace' | 'revoke';

export const STAGE_WAIT_MS = 24 * 60 * 60 * 1000;
export const STAGE_OBSERVE_MS = 30_000;

export function stageReadyKey(stage: Pick<WorkStage, 'runId' | 'planVersion'>): string {
  return `stage-ready:${stage.runId}${stage.planVersion === undefined ? '' : `:${stage.planVersion}`}`;
}

export const STAGE_CONDITION_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['gitlab-merge', 'gitlab-pipeline'] },
    sourceOrigin: {
      type: 'string',
      description:
        'Exact HTTPS origin of the known GitLab source, compared with the host configuration.',
    },
    project: {
      type: 'string',
      description: 'Exact GitLab namespace/project or numeric Project ID.',
    },
    number: { type: 'integer', minimum: 1, description: 'Merge request IID or exact pipeline ID.' },
  },
  required: ['kind', 'sourceOrigin', 'project', 'number'],
  additionalProperties: false,
} as const;

export function readStageCondition(value: unknown): StageCondition | undefined {
  if (value === undefined) return undefined;
  const raw = value as Partial<StageCondition> | null;
  if (
    typeof value !== 'object' ||
    !raw ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !['kind', 'sourceOrigin', 'project', 'number'].includes(key)) ||
    (raw.kind !== 'gitlab-merge' && raw.kind !== 'gitlab-pipeline') ||
    typeof raw.number !== 'number' ||
    !Number.isSafeInteger(raw.number) ||
    raw.number < 1
  ) {
    throw new AppError('stage-condition', '请指定 GitLab 项目和确切的合并请求 IID 或流水线 ID。');
  }
  const project = requiredText(raw.project, 'GitLab 项目', 256);
  if (!/^(?:[1-9]\d*|(?:[\w-][\w.-]*\/)+[\w-][\w.-]*)$/u.test(project)) {
    throw new AppError('stage-condition', '请填写 GitLab 项目路径或项目数字 ID。');
  }
  const sourceOrigin = gitLabObservationOrigin(
    typeof raw.sourceOrigin === 'string' ? raw.sourceOrigin : undefined,
  );
  if (!sourceOrigin)
    throw new AppError('stage-condition', '请填写对象所在 GitLab 实例的明确 HTTPS 来源。');
  return { kind: raw.kind, sourceOrigin, project, number: raw.number };
}

export function gitLabObservationOrigin(value?: string): string | null {
  try {
    const url = new URL(value ?? '');
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    )
      return url.origin;
  } catch {
    // Treat an invalid host configuration as unavailable.
  }
  return null;
}

export function stageConditionText(condition: StageCondition): string {
  return condition.kind === 'gitlab-merge'
    ? `GitLab ${condition.project} !${condition.number} 已合并`
    : `GitLab ${condition.project} 流水线 #${condition.number} 成功`;
}

export const STAGE_GUIDANCE = [
  `Use stage reports for concrete milestone evidence while the same task has outstanding acceptance work.`,
  `In detail, stage is a settled Worker checkpoint.`,
  `Use advance_stage with taskId, current expectedRowVersion, stage.runId, and one concrete nextStep within the original owner authorization and acceptance criteria.`,
  `Use the same Task and Worker.`,
  `This consumes no corrective rework allowance.`,
  `Only the overall deliverable enters normal review.`,

  `When current facts show a necessary dependency, save its exact GitLab object and sourceOrigin from known evidence.`,
  `The host tracks the exact object independently of model turns until the persisted deadline, including when the trusted reader is temporarily unavailable.`,
  `Explain the actual wait or blocker and who can resolve it.`,
  `Use block_stage only while stage.state is awaiting-decision, if the dependency identity is unknown or the next step needs permission.`,

  `When an owner wants to hold a stage after a plan was already saved, use pause.`,
  `Use continue with stageFollowUp:replace or stageFollowUp:revoke only when the owner actually changes or withdraws the saved step.`,
  `Keep an unchanged wait quiet.`,
  `For an explicit owner addition that leaves the plan intact, use continue with stageFollowUp:append, the current owner text and continuationMode.`,
  `The new note accompanies the saved step, even when the note itself requests a read-only check.`,
  `If the owner narrows the whole task, changes the execution direction or withdraws the planned step, use continue with stageFollowUp:replace or stageFollowUp:revoke.`,
  `For a replacement with a new precise prerequisite, use advance_stage with stageFollowUp:replace and the complete current owner message in userInstruction.`,

  `Explicit owner requests may retry the same expired wait using advance_stage with its unchanged step and condition.`,
  `A failed business check or external condition needs a new owner decision.`,
  `Do not use advance_stage to repeat a write or expand permission.`,
].join(' ');
