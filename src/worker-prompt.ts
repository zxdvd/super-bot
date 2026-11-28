import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { isNativeOwner } from './dsh-chat-events.ts';
import { materialPrompt } from './materials.ts';
import type {
  Binding,
  RecoveryWorkContext,
  Run,
  RunInput,
  Task,
  TaskBotContext,
  WorkerPriorInput,
  WorkerSupplement,
} from './model.ts';
import { workdirSummary } from './workdir.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'super-bot': {
      kind: 'super-bot';
      taskId: string;
      runId: string;
      inputId: string;
      taskRevision: number;
      generation: number;
      // Earlier persisted inputs have only the native run coordinates above.
      bindingId?: string;
      promptMode?: 'full' | 'delta';
      carriedInputIds?: string[];
      carriedSupplementIds?: string[];
      ownerDirectionIds?: string[];
    };
  }
}

const CODE_DELIVERY = [
  [
    `For code work, after reading the applicable project instructions and before editing, record the opening Git HEAD and relevant staged, unstaged, and untracked changes.`,
    `Keep the baseline scoped to the files you expect to touch.`,
    `Preserve existing work, including changes in files you edit.`,
    `If Git or the baseline is unavailable, state what you could verify.`,
  ].join(' '),
  `When preparing a change for review, assess whether reviewers can use it now. Keep pending merge checks in the report and preserve a reviewable change’s review status.`,
  [
    `In ready, use summary for what changed and checks for commands actually run, their outcomes, and what remains unverified.`,
    `Make the opening HEAD, relevant existing changes, and this run's attributable diff visible in the summary or a concise attachment.`,
    `Compare with the opening state, including for files you both found dirty and edited.`,
    `Treat the full diff against HEAD as worktree context.`,
    `If you cannot attribute a change, say so.`,
    `Attach a scoped diff when useful and include actual changed source where available.`,
    `For any relevant host, identify a matching native load receipt for this result and build, or say that loading there is unverified.`,
    `Only reload when authorized.`,
  ].join(' '),
  `For ordinary non-code work, keep the report brief and use the checks and files relevant to that task.`,
  [
    `In super_bot_report ready, register each actual external deliverable in links as a distinct display name mapped to its full HTTP(S) URL.`,
    `Register each URL once and use its display name in summary and checks.`,
    `When one deliverable is the user's main next action, set primaryLink to its exact registered display name.`,
    `Keep references in the report.`,
    `If a requested openable deliverable is missing, explain what is missing and why.`,
    `Omit links for local-only work.`,
    `Include file evidence and checks even when a document is the only deliverable.`,
  ].join(' '),
].join('\n');

export function workerStandingPrompt(
  task: Task,
  binding: Binding,
  context: TaskBotContext,
  fullAccess: boolean,
): string {
  const convention = context.workConvention;
  const conventionPrompt = convention
    ? `\nWork convention recorded for this task (${convention.source}). Follow it within the current task scope and authorization:\n${convention.text}`
    : '';
  const permissions = fullAccess
    ? [
        `This Worker uses the native Full Access preset.`,
        `Use super_bot_query with kind git-working-tree-status for the opening Git HEAD and working tree status and later status checks.`,
        `It provides a verified read receipt; report if it cannot read the worktree.`,
        `Use native tools including shell to implement and test the requested work.`,
        `Keep work scoped to this task.`,
        `Do not modify unrelated projects or credentials.`,
        `Change host configuration only when this task explicitly authorizes that change.`,
        `Report actual changed source files and test results.`,
      ].join(' ')
    : [
        `Use only read/write/edit in this directory, always with absolute file_path values.`,
        `Do not change working directories.`,
        `Worker 完整权限未开启：当前 fullAccess: false。Shell and external CLI tools are unavailable in files mode; report this limitation, never ask for a tool channel.`,
        `To enable them, set fullAccess: true in the Super Bot config of the active profile cordis.patch.yml and reload when idle.`,
      ].join(' ');
  return [
    `Bot configuration revision: ${task.botConfigRevision}`,
    `Bot responsibility: ${context.instructions}${materialPrompt(context.materials)}${conventionPrompt}`,
    `Goal: ${task.goal}`,
    `Authorized scope: ${task.scope}`,
    `Acceptance criteria: ${task.acceptance}`,
    `Working directory: ${workdirSummary(binding.cwd, binding.workdir)}. Work only inside it; do not change other checkouts or directories.`,
    'If task inputs conflict, follow the higher input order within the authorized scope.',
    permissions,
    CODE_DELIVERY,
    [
      `Use stage with a distinct stage name, a stable evidenceRef, and checks when you verified a new milestone but the overall goals are incomplete.`,
      `Include actual evidence and the outstanding condition and authorized next step in summary.`,
      `For GitLab waits, include the exact project and merge request IID or pipeline ID in the report.`,
      `Do not wait in shell, treat acceptance failure as ready, or resubmit a prior milestone.`,
      `Use blocked or failed for a business check that did not pass and waiting for a specific owner decision.`,
    ].join(' '),
    'Use super_bot_report(progress) at meaningful checkpoints, such as written changes or a focused failing or passing test. State what was actually observed. For reloads, report a matching host receipt when available. Use waiting to ask a necessary question. For ready provide files and checks explaining every acceptance criterion. Never claim the task is accepted; the user decides.',
  ].join('\n');
}

const runHeader = (id: string) =>
  `You are executing a NEW attempt of one Super Bot task.\nCurrent run: ${id}.`;

function previousInputText(input: WorkerPriorInput): string {
  const earlier = input.priorDirections
    ?.map((text) => `Previously received owner direction:\n${text}`)
    .join('\n\n');
  return `Restored task input order: ${input.order}.\n${earlier ? `${earlier}\n\n` : ''}Previously received task input (${input.kind}): ${input.content}`;
}
const inputLabel = (kind: string) =>
  kind === 'stage' ? 'Authorized stage continuation' : 'Additional user input';

const supplementText = (supplement: WorkerSupplement) =>
  `Prior user message from the Worker chat (within the existing task scope):\n${supplement.text}`;

function restoredInputs(
  inputs: readonly WorkerPriorInput[],
  supplements: readonly WorkerSupplement[],
): string[] {
  return [
    ...inputs.map((input) => ({ at: input.createdAt ?? 0, text: previousInputText(input) })),
    ...supplements.map((input) => ({ at: input.createdAt, text: supplementText(input) })),
  ]
    .sort((left, right) => left.at - right.at)
    .map(({ text }) => text);
}

type WorkerPromptPlan = {
  mode: 'full' | 'delta';
  carried: readonly WorkerPriorInput[];
  supplements?: readonly WorkerSupplement[];
  inputOrder: number;
};

export function createWorkerRunMessage(
  run: Run,
  input: RunInput,
  standing: string,
  { mode, carried, supplements = [], inputOrder }: WorkerPromptPlan,
  recovery?: { note: string | null },
  context?: RecoveryWorkContext & { outputDirectory?: string },
): UserMessage {
  const sections = [runHeader(run.id)];
  if (mode === 'full') sections.push(standing);
  sections.push(...restoredInputs(carried, supplements));
  if (recovery) {
    sections.push(
      'The user confirmed recovery and requested this new attempt. Check the current files and the prior blocker before proceeding within the same authorized scope.',
    );
    if (recovery.note) sections.push(`Prior recovery reason: ${recovery.note}`);
  }
  if (context) {
    const { priorDirections, priorDirection, directionIds, effectUncertain, ...facts } = context;
    sections.push(
      `Earlier attempt and observed facts (use as evidence): ${JSON.stringify(effectUncertain ? { ...facts, effectUncertain } : facts)}`,
    );
    if (priorDirections)
      sections.push(...priorDirections.map(({ text }) => `Retained owner direction:\n${text}`));
    else if (priorDirection) sections.push(`Retained owner direction:\n${priorDirection}`);
    sections.push(
      [
        `Continue the current assignment from all applicable owner directions in order and the verified state.`,
        `Retain the substantive directions and limits when the latest message only confirms proceeding or selects this task.`,
        `Treat the standing goal as background for this attempt.`,
        `Read prior reports and receipts as evidence.`,
        `Preserve observed effects and uncertainty.`,
        `If a resource was created but is unready, report both facts.`,
        `Use waiting for a specific decision or permission the owner must supply.`,
        `Report a blocked external dependency with the responsible party or condition.`,
      ].join(' '),
    );
    if (context.priorRelease)
      sections.push(
        'The host tracks the recorded release job. Leave submission and retry to its formal release action; continue the other owner directions.',
      );
    if (context.lateJobs)
      sections.push(
        [
          `The old attempt ended before these background Job results were consumed.`,
          `Use the saved progress, original native Job result messages and current files as evidence.`,
          `Prior external effects remain unverified.`,
          `Preserve the materials already collected.`,
          `Continue only with reading existing regular files and writing the requested report under ${context.outputDirectory}.`,
          `Do not repeat background work, modify existing inputs, perform an external action or claim an unverified external effect succeeded.`,
          `If the task specifically needs an external action or unavailable evidence, report the remaining business requirement and the exact missing evidence.`,
        ].join(' '),
      );
    else
      sections.push(
        context.mode === 'read-only'
          ? 'Use only the read-only tools available for this continuation and report the actual observations.'
          : 'Perform the current owner directions within the standing scope. Use earlier work as context. If the same external action may already have run, check that exact target and track the original action. Leave that action pending if its effect is unknown. Continue independent authorized work.',
      );
  }
  if (
    input.kind === 'answer' ||
    input.kind === 'rework' ||
    input.kind === 'continuation' ||
    input.kind === 'stage'
  ) {
    sections.push(`Task input order: ${inputOrder}.`);
    sections.push(`${inputLabel(input.kind)} (${input.kind}): ${input.content}`);
    sections.push(
      input.kind === 'stage'
        ? 'Perform only the recorded next step within the existing scope. Preserve earlier results and observed effects. Do not repeat completed work or broaden authorization. Recheck relevant facts before acting.'
        : 'Continue from the current state and apply this input within the existing authorized scope. Where directions conflict, apply the latest user instruction. Use waiting if the input requires clarification or exceeds that scope.',
    );
  } else {
    sections.push('Continue from the current verified state within the existing authorized scope.');
  }
  sections.push(
    'Reports from previous attempts do not complete this run. Re-check current facts and perform the authorized work. Submit a fresh super_bot_report for this run.',
  );
  return createUserMessage({
    source: {
      kind: 'super-bot',
      taskId: run.taskId,
      runId: run.id,
      inputId: run.inputId,
      taskRevision: run.taskRevision,
      generation: run.generation,
      bindingId: run.bindingId,
      promptMode: mode,
      ...(context?.directionIds?.length ? { ownerDirectionIds: context.directionIds } : {}),
      ...(carried.length ? { carriedInputIds: carried.map((prior) => prior.id) } : {}),
      ...(supplements.length ? { carriedSupplementIds: supplements.map(({ id }) => id) } : {}),
    },
    content: [{ type: 'text', text: sections.join('\n\n') }],
  });
}

type WorkerSource = Extract<UserMessage['source'], { kind: 'super-bot' }>;
function matchesBinding(source: WorkerSource, run: Run): boolean {
  return (
    source.taskId === run.taskId &&
    source.taskRevision === run.taskRevision &&
    source.bindingId === run.bindingId &&
    source.generation === run.generation
  );
}

function hasStandingContext(
  messages: ReturnType<Session['deriveMessages']>,
  run: Run,
  standing: string,
): boolean {
  return messages.some((message) => {
    const source = message.source;
    return (
      message.role === 'user' &&
      source.kind === 'super-bot' &&
      source.promptMode === 'full' &&
      matchesBinding(source, run) &&
      message.content[0]?.type === 'text' &&
      message.content[0].text.startsWith(`${runHeader(source.runId)}\n\n${standing}\n\n`)
    );
  });
}

function hasPreviousInput(
  messages: ReturnType<Session['deriveMessages']>,
  run: Run,
  previous: WorkerPriorInput,
): boolean {
  return messages.some((message) => {
    const source = message.source;
    if (message.role !== 'user' || source.kind !== 'super-bot' || !matchesBinding(source, run))
      return false;
    const block = message.content[0];
    if (block?.type !== 'text') return false;
    return (
      (message.id === previous.messageId &&
        source.inputId === previous.id &&
        block.text.includes(
          `\n\n${inputLabel(previous.kind)} (${previous.kind}): ${previous.content}\n\n`,
        )) ||
      (source.carriedInputIds?.includes(previous.id) &&
        block.text.includes(`\n\n${previousInputText(previous)}\n\n`))
    );
  });
}

function hasSupplement(
  messages: ReturnType<Session['deriveMessages']>,
  run: Run,
  supplement: WorkerSupplement,
): boolean {
  return messages.some((message) => {
    if (message.role !== 'user') return false;
    if (
      run.sessionId === supplement.sessionId &&
      message.id === supplement.messageId &&
      isNativeOwner(message)
    )
      return true;
    const source = message.source;
    const block = message.content[0];
    return (
      source.kind === 'super-bot' &&
      source.taskId === run.taskId &&
      source.taskRevision === run.taskRevision &&
      !!source.carriedSupplementIds?.includes(supplement.id) &&
      block?.type === 'text' &&
      block.text.includes(`\n\n${supplementText(supplement)}\n\n`)
    );
  });
}

function canRefreshWorkerContext(agent: Agent): boolean {
  if (typeof agent.session?.deriveMessages !== 'function') return false;
  try {
    const prompt = agent.ctx.systemPrompt;
    return typeof prompt?.context === 'function' && typeof prompt.refreshContext === 'function';
  } catch {
    // A Cordis scope without the native service may throw on property access.
    return false;
  }
}

export function workerPromptPlan(
  agent: Agent,
  run: Run,
  standing: string,
  previous: readonly WorkerPriorInput[] = [],
  supplements: readonly WorkerSupplement[] = [],
): WorkerPromptPlan {
  const inputOrder = previous.length + 1;
  if (canRefreshWorkerContext(agent) && agent.session.id === run.sessionId) {
    try {
      const messages = agent.session.deriveMessages();
      const carried = previous.filter((prior) => !hasPreviousInput(messages, run, prior));
      const mode = hasStandingContext(messages, run, standing) ? 'delta' : 'full';
      const retained = supplements.filter(
        (supplement) => !hasSupplement(messages, run, supplement),
      );
      return { mode, carried, inputOrder, ...(retained.length ? { supplements: retained } : {}) };
    } catch {
      // A missing or unreadable native projection is no proof of continuity.
    }
  }
  return {
    mode: 'full',
    carried: previous,
    inputOrder,
    ...(supplements.length ? { supplements } : {}),
  };
}

export function registerWorkerContext(
  agent: Agent,
  run: Run,
  standing: string,
  message: UserMessage,
  previous: readonly WorkerPriorInput[],
  entered: () => boolean,
  authorized: () => boolean,
  supplements: () => readonly WorkerSupplement[] = () => [],
): () => void {
  if (
    message.source.kind !== 'super-bot' ||
    !message.source.promptMode ||
    !canRefreshWorkerContext(agent)
  )
    return () => {};
  const block = message.content[0];
  if (block?.type !== 'text') return () => {};
  return agent.ctx.systemPrompt.context({
    name: 'super-bot-worker-task',
    order: 9000,
    interpolate: false,
    required: true,
    text: ({ agent: subject, signal }) => {
      if (subject !== agent || signal?.aborted || !authorized()) return '';
      const wasEntered = entered();
      const messages = agent.session.deriveMessages();
      const inputVisible = messages.some(
        (candidate) =>
          candidate.id === message.id &&
          candidate.role === 'user' &&
          candidate.source.kind === 'super-bot' &&
          candidate.content[0]?.type === 'text' &&
          candidate.content[0].text === block.text,
      );
      // The original input is about to enter this request or is restored below if it was shadowed.
      if (!inputVisible) messages.push(message);
      const missing = [];
      if (!hasStandingContext(messages, run, standing)) missing.push(standing);
      missing.push(
        ...restoredInputs(
          previous.filter((prior) => !hasPreviousInput(messages, run, prior)),
          supplements().filter((supplement) => !hasSupplement(messages, run, supplement)),
        ),
      );
      if (wasEntered && !inputVisible) missing.push(block.text);
      return missing.join('\n\n');
    },
  });
}
