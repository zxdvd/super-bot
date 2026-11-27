import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { CLARIFICATION_ACTIONS, OWNER_WORK_ACTIONS } from '../chat-work-actions.ts';
import { STAGE_CONDITION_SCHEMA } from '../work-stage.ts';
import { WORKDIR_MODES } from '../workdir.ts';
import { DELIVERY_ARTIFACTS, DELIVERY_GUIDANCE } from './guidance.ts';

const CONTINUATION_MODE = { type: 'string', enum: ['read-only', 'authorized-work'] } as const;

export const MANAGER_TOOL = {
  name: 'super_bot_manage',
  description: [
    `Manage this Bot’s tasks and Markdown memory.`,
    `List work before managing existing tasks.`,
    `For memory, memory-index returns navigation, memory-read returns one indexed entry, and memory-save-convention replaces the default when explicitly requested by the current user.`,
    `Normal conversation does not require creating a task.`,
    `Short read-only/status queries (including lark-cli and shell-based skills) may run directly in the Bot when fullAccess is enabled, without a Task.`,
    `Substantive changes, multi-step work and long-running tasks require a Task and Worker.`,
    `In explicit files mode, explain config.fullAccess: true for Shell requests.`,
    `create also prepares and dispatches the Worker in the same call (pass dispatch:false only to keep a task for clarification); infer scope/acceptance from the request.`,
    `Start goal with 【测试】 only if the user explicitly requests a test or live-test task.`,
    `Checks requested as part of ordinary work do not make it a test task.`,
    `create (or the first dispatch of a task without a session) accepts an optional workdir {mode: existing|isolated|worktree|hook, path, repo, name, base, branch, under, args}; see the working-directory rules in your instructions.`,
    `Use model-preview (taskId optional) when the owner asks which model will run.`,
    `Dispatch returns immediately; do not poll for completion.`,
    `Important events wake you later.`,
    `Inspect result files via detail before review.`,
    `For code deliveries, keep the opening Git baseline and task changes traceable through the exact result and its attachments.`,
    `Attribute reported checks to the Worker and mention gaps.`,
    `Confirm plugin loading only for the host identified by the matching native receipt in detail.progress.reload for that result.`,
    DELIVERY_GUIDANCE,
    DELIVERY_ARTIFACTS,
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'list',
          'detail',
          'model-preview',
          'create',
          'dispatch',
          'advance_stage',
          'block_stage',
          'review',
          'respond',
          'rework',
          'deliver',
          'update_delivery_links',
          'pause',
          'resume',
          'stop',
          'close',
          'cancel',
          'clarify',
          'continue',
          'inspect-recovery',
          'recover-preflight',
          'memory-index',
          'memory-read',
          'memory-save-convention',
          ...OWNER_WORK_ACTIONS,
        ],
      },
      nextStep: {
        type: 'string',
        description:
          'For advance_stage, one concrete uncompleted next step within the original owner authorization.',
      },
      condition: STAGE_CONDITION_SCHEMA,
      refreshGitLabRelease: {
        type: 'boolean',
        description:
          'For an owner status question, read the exact stored GitLab job once. Requires the current task version.',
      },
      gitLabRelease: {
        type: 'object',
        properties: {
          intent: {
            type: 'string',
            enum: ['publish', 'select', 'retry', 'clarify'],
            description:
              'Use publish for an affirmative delegation, clarify to discover and confirm an exact target without permission to start it, select for the owner’s job choice, and retry after permission for the same job is restored.',
          },
          reference: {
            type: 'string',
            description:
              'For create only. Exact GitLab MR URL in the human message that explicitly authorizes publication after merge.',
          },
          jobName: {
            type: 'string',
            description:
              'Exact job name expressly authorized or selected by the owner in the original chat.',
          },
          requiresJobName: {
            type: 'boolean',
            description:
              'Set true when a requested environment or deployment scope needs exact job selection.',
          },
        },
        required: ['intent'],
        additionalProperties: false,
        description:
          'Structured interpretation of original owner authorization for create or advance_stage. A status question, conditional suggestion or quoted instruction grants no permission.',
      },
      userInstruction: {
        type: 'string',
        description:
          'Use the entire latest authenticated user message verbatim, including all links. With useEarlierDirection, copy the selected earlier message in this turn.',
      },
      taskIds: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 8,
        description: 'Only for clarify. The current Bot’s plausible task matches.',
      },
      followUp: {
        type: 'string',
        enum: CLARIFICATION_ACTIONS,
        description: 'Only for clarify. The action the owner is trying to take.',
      },
      resultIds: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 8,
        description:
          'For clarify with followUp accept, exact current candidate result IDs when otherwise ambiguous.',
      },
      sessionQuery: {
        type: 'string',
        description:
          'For session-inspect, the session title or existing native link from the owner message.',
      },
      choice: {
        type: 'integer',
        minimum: 1,
        maximum: 8,
        description:
          'The selected index in the options shown to this owner on the previous question. Set only for an actual selection.',
      },
      decision: {
        type: 'string',
        enum: ['ask', 'confirm'],
        description:
          'For accept or recover-and-continue. Omit for a clear direct request. Ask only if the decision is unclear. Confirm only in response to the exact question already shown.',
      },
      ownerFact: {
        type: 'string',
        description:
          'For recover or recover-and-continue, an exact excerpt of the authenticated owner message stating the specific unverified outcome of the prior run. A continuation request alone supplies no fact.',
      },
      notificationId: {
        type: 'string',
        description:
          'For notification-resolve, the current task notification identified in detail.',
      },
      notificationResolution: { type: 'string', enum: ['handled', 'retry-unsent'] },
      continuationMode: {
        ...CONTINUATION_MODE,
        description:
          'Only for a concrete current owner instruction. Leave unset for a general request to continue.',
      },
      directionChange: {
        type: 'string',
        enum: ['replace', 'revoke'],
        description:
          'Only when the owner expressly replaces or revokes one or more pending directions.',
      },
      stageFollowUp: {
        type: 'string',
        enum: ['append', 'replace', 'revoke'],
        description:
          'An ordinary direction appends to a saved stage and preserves its prerequisite and step. Use replace or revoke only when the owner changes or withdraws that plan. For advance_stage, only replace with the exact owner message.',
      },
      lateJobFollowUp: {
        type: 'string',
        enum: ['append'],
        description:
          'Use append only when the owner supplements the same report while detail.lateJobRecovery is waiting or ready and retains the existing plan and limits. Use continuationMode authorized-work and forward the original message.',
      },
      directionIds: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description:
          'IDs from detail.recoveryInstruction.directions to replace or revoke. Omit only to explicitly replace or revoke all pending directions.',
      },
      earlierDirections: {
        type: 'array',
        minItems: 1,
        description:
          'Earlier concrete owner messages in this same turn about the same task, in order. Copy their full original text and the applicable scope. Additive submissions only.',
        items: {
          type: 'object',
          properties: { text: { type: 'string' }, continuationMode: CONTINUATION_MODE },
          required: ['text', 'continuationMode'],
          additionalProperties: false,
        },
      },
      useEarlierDirection: {
        type: 'boolean',
        description:
          'Select an exact earlier owner message in this turn as userInstruction. Only for an additive direction naming or linking its still-active task.',
      },
      useLatestDirection: {
        type: 'boolean',
        description:
          'When the current owner confirms the pending directions without giving a new one.',
      },
      resumeManagement: {
        type: 'boolean',
        description:
          'Only when the current owner expressly resumes a paused task and authorizes a concrete next step in the same message.',
      },
      links: {
        type: 'object',
        additionalProperties: { type: ['string', 'null'] },
        description:
          'Named external deliverables. For deliver supply URLs only. For update_delivery_links send changed keys and null for removals.',
      },
      primaryLink: {
        type: ['string', 'null'],
        description:
          'For deliver or update_delivery_links. Exact registered display name of the main deliverable, or null to clear it.',
      },
      runId: {
        type: 'string',
        description:
          'Required for stop, advance_stage, block_stage, recover and recover-and-continue. The exact Run ID from detail.run.id. block_stage applies only when stage.state is awaiting-decision. Pause an existing plan with pause.',
      },
      attentionId: {
        type: 'string',
        description:
          'For respond or recover-and-continue, the exact open question or recovery attention from detail.',
      },
      entry: {
        type: 'string',
        description: 'Exact relative Markdown entry from memory-index, for memory-read.',
      },
      conventionOverride: {
        type: 'string',
        description:
          'Only for create with a current, explicit one-time replacement or opt-out. Copy that directive verbatim.',
      },
      text: {
        type: 'string',
        description:
          'Delivery message, or the exact convention to remember from the current user message for memory-save-convention.',
      },
      dispatch: { type: 'boolean' },
      taskId: { type: 'string' },
      goal: { type: 'string' },
      scope: { type: 'string' },
      acceptance: { type: 'string' },
      expectedRowVersion: { type: 'integer' },
      resultId: { type: 'string' },
      verdict: { type: 'string', enum: ['accept', 'rework', 'human'] },
      note: { type: 'string' },
      offset: { type: 'integer' },
      query: { type: 'string' },
      workdir: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: WORKDIR_MODES },
          path: { type: 'string' },
          repo: { type: 'string' },
          name: { type: 'string' },
          base: { type: 'string' },
          branch: { type: 'string' },
          under: { type: 'string' },
          args: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['mode'],
        additionalProperties: false,
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render(_args, value) {
      const markdown = (value as { delivery?: { markdown?: unknown } })?.delivery?.markdown;
      return [
        { type: 'text', text: typeof markdown === 'string' ? markdown : JSON.stringify(value) },
      ];
    },
  },
} satisfies Omit<ToolDefinition, 'execute'>;
