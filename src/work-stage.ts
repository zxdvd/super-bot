import { AppError, requiredText } from './model.ts';

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
  observation?: StageObservation & { at: number };
  reason?: string;
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

export const STAGE_CONDITION_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['gitlab-merge', 'gitlab-pipeline'] },
    sourceOrigin: { type: 'string', description: 'Exact HTTPS origin of the known GitLab source, compared with the host configuration.' },
    project: { type: 'string', description: 'Exact GitLab namespace/project or numeric Project ID.' },
    number: { type: 'integer', minimum: 1, description: 'Merge request IID or exact pipeline ID.' },
  },
  required: ['kind', 'sourceOrigin', 'project', 'number'],
  additionalProperties: false,
} as const;

export function readStageCondition(value: unknown): StageCondition | undefined {
  if (value === undefined) return undefined;
  const raw = value as Partial<StageCondition> | null;
  if (typeof value !== 'object' || !raw || Array.isArray(raw) ||
    Object.keys(raw).some(key => !['kind', 'sourceOrigin', 'project', 'number'].includes(key)) ||
    (raw.kind !== 'gitlab-merge' && raw.kind !== 'gitlab-pipeline') ||
    typeof raw.number !== 'number' || !Number.isSafeInteger(raw.number) || raw.number < 1) {
    throw new AppError('stage-condition', '请指定 GitLab 项目和确切的合并请求 IID 或流水线 ID。');
  }
  const project = requiredText(raw.project, 'GitLab 项目', 256);
  if (!/^(?:[1-9]\d*|(?:[\w-][\w.-]*\/)+[\w-][\w.-]*)$/u.test(project)) {
    throw new AppError('stage-condition', '请填写 GitLab 项目路径或项目数字 ID。');
  }
  const sourceOrigin = gitLabObservationOrigin(typeof raw.sourceOrigin === 'string' ? raw.sourceOrigin : undefined);
  if (!sourceOrigin) throw new AppError('stage-condition', '请填写对象所在 GitLab 实例的明确 HTTPS 来源。');
  return { kind: raw.kind, sourceOrigin, project, number: raw.number };
}

export function gitLabObservationOrigin(value?: string): string | null {
  try {
    const url = new URL(value ?? '');
    if (url.protocol === 'https:' && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash) return url.origin;
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

export const STAGE_GUIDANCE = `Use stage reports for concrete milestone evidence while the same task has outstanding acceptance work. In detail, stage is a settled Worker checkpoint. Use advance_stage with taskId, current expectedRowVersion, stage.runId, and one concrete nextStep only after verifying that it follows the original owner authorization and acceptance criteria. Use the same Task and Worker. This consumes no corrective rework allowance. Do not use it to repeat a failed check or write, expand permission, or treat a milestone as final delivery. When current facts show a necessary dependency, include condition for the exact GitLab merge request IID or exact pipeline ID. Set condition.sourceOrigin based on the known evidence for that object and compare it with detail.stageObserver.origin. Never substitute the configured source for an unknown or different source. The host checks only the matching configured source and dispatches the saved next step after a matching observation. If no observer is configured, saving the exact condition records the unavailable capability. If the result says blocked, explain the actual obstacle and who can resolve it. If the dependency source is unknown or unsupported or the next step requires permission, use block_stage with runId and a specific note. Keep an unchanged pending condition quiet. Only after an explicit owner request to retry observing an unavailable condition call advance_stage again with the identical condition and nextStep. A failed business check or failed external condition is a blocker. Only the overall deliverable enters normal review.`;
