import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { materialPrompt } from './materials.ts';
import type { Binding, Run, RunInput, Task, TaskBotContext, WorkerPriorInput } from './model.ts';
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
    };
  }
}

const CODE_DELIVERY = `For code work, after reading the applicable project instructions and before editing, record the opening Git HEAD and relevant staged, unstaged, and untracked changes. Keep the baseline scoped to the files you expect to touch. Preserve existing work, including changes in files you edit. If Git or the baseline is unavailable, state what you could verify.
In ready, use summary for what changed and checks for commands actually run, their outcomes, and what remains unverified. Make the opening HEAD, relevant existing changes, and this run's attributable diff visible in the summary or a concise attachment. Compare with the opening state, including for files you both found dirty and edited. Treat the full diff against HEAD as worktree context. If you cannot attribute a change, say so. Attach a scoped diff when useful and include actual changed source where available. For any relevant host, identify a matching native load receipt for this result and build, or say that loading there is unverified. Only reload when authorized.
For ordinary non-code work, keep the report brief and use the checks and files relevant to that task.\nIn any ready report, explicitly list links to deliverables you actually produced and want the user to open, with a distinct display name and an actual URL for each. Keep reference links distinct. A local-only change without a submitted review has no MR or CR link. Include file evidence and checks even when a document is the only deliverable.`;

export function workerStandingPrompt(task:Task,binding:Binding,context:TaskBotContext,fullAccess:boolean):string {
  const convention = context.workConvention;
  const conventionPrompt = convention
    ? `\nWork convention recorded for this task (${convention.source}). Follow it within the current task scope and authorization:\n${convention.text}`
    : '';
  const permissions = fullAccess
    ? 'This Worker uses the native Full Access preset. Use native tools including shell to implement and test the requested work. Keep work scoped to this task. Do not modify unrelated projects or credentials. Change host configuration only when this task explicitly authorizes that change. Report actual changed source files and test results.'
    : 'Use only read/write/edit in this directory, always with absolute file_path values. Do not change working directories. Worker 完整权限未开启：当前 fullAccess: false。Shell and external CLI tools are unavailable in files mode; report this limitation, never ask for a tool channel. To enable them, set fullAccess: true in the Super Bot config of the active profile cordis.patch.yml and reload when idle.';
  return [
    `Bot configuration revision: ${task.botConfigRevision}`,
    `Bot responsibility: ${context.instructions}${materialPrompt(context.materials)}${conventionPrompt}`,
    `Goal: ${task.goal}`,
    `Authorized scope: ${task.scope}`,
    `Acceptance criteria: ${task.acceptance}`,
    `Working directory: ${workdirSummary(binding.cwd,binding.workdir)}. Work only inside it; do not change other checkouts or directories.`,
    'If task inputs conflict, follow the higher input order within the authorized scope.',
    permissions,
    CODE_DELIVERY,
    'Use super_bot_report(progress) at meaningful checkpoints, such as written changes or a focused failing or passing test. State what was actually observed. For reloads, report a matching host receipt when available. Use waiting to ask a necessary question. For ready provide files and checks explaining every acceptance criterion. Never claim the task is accepted; the user decides.',
  ].join('\n');
}

const runHeader = (id:string) => `You are executing a NEW attempt of one Super Bot task.\nCurrent run: ${id}.`;

function previousInputText(input:WorkerPriorInput):string {
  return `Restored task input order: ${input.order}.\nPreviously received task input (${input.kind}): ${input.content}`;
}

type WorkerPromptPlan = {mode:'full'|'delta';carried:readonly WorkerPriorInput[];inputOrder:number};

export function createWorkerRunMessage(
  run:Run,input:RunInput,standing:string,{mode,carried,inputOrder}:WorkerPromptPlan,recovery?:{note:string|null},
):UserMessage {
  const sections = [runHeader(run.id)];
  if (mode === 'full') sections.push(standing);
  sections.push(...carried.map(previousInputText));
  if (recovery) {
    sections.push('The user confirmed recovery and requested this new attempt. Check the current files and the prior blocker before proceeding within the same authorized scope.');
    if (recovery.note) sections.push(`Prior recovery reason: ${recovery.note}`);
  }
  if (input.kind === 'answer' || input.kind === 'rework') {
    sections.push(`Task input order: ${inputOrder}.`);
    sections.push(`Additional user input (${input.kind}): ${input.content}`);
    sections.push('Continue from the current state and apply this input within the existing authorized scope. Use waiting if the input requires clarification or exceeds that scope.');
  } else {
    sections.push('Continue from the current verified state within the existing authorized scope.');
  }
  sections.push('Reports from previous attempts do not complete this run. Re-check current facts and perform the authorized work. Submit a fresh super_bot_report for this run.');
  return createUserMessage({
    source:{kind:'super-bot',taskId:run.taskId,runId:run.id,inputId:run.inputId,taskRevision:run.taskRevision,
      generation:run.generation,bindingId:run.bindingId,promptMode:mode,
      ...(carried.length?{carriedInputIds:carried.map(prior=>prior.id)}:{})},
    content:[{type:'text',text:sections.join('\n\n')}],
  });
}

type WorkerSource = Extract<UserMessage['source'],{kind:'super-bot'}>;
function matchesBinding(source:WorkerSource,run:Run):boolean {
  return source.taskId === run.taskId && source.taskRevision === run.taskRevision
    && source.bindingId === run.bindingId && source.generation === run.generation;
}

function hasStandingContext(messages:ReturnType<Session['deriveMessages']>,run:Run,standing:string):boolean {
  return messages.some(message=>{
    const source = message.source;
    return message.role === 'user' && source.kind === 'super-bot' && source.promptMode === 'full'
      && matchesBinding(source,run) && message.content[0]?.type === 'text'
      && message.content[0].text.startsWith(`${runHeader(source.runId)}\n\n${standing}\n\n`);
  });
}

function hasPreviousInput(messages:ReturnType<Session['deriveMessages']>,run:Run,previous:WorkerPriorInput):boolean {
  return messages.some(message=>{
    const source = message.source;
    if (message.role !== 'user' || source.kind !== 'super-bot' || !matchesBinding(source,run)) return false;
    const block = message.content[0];
    if (block?.type !== 'text') return false;
    return (message.id === previous.messageId && source.inputId === previous.id
      && block.text.includes(`\n\nAdditional user input (${previous.kind}): ${previous.content}\n\n`))
      || (source.carriedInputIds?.includes(previous.id) && block.text.includes(`\n\n${previousInputText(previous)}\n\n`));
  });
}

function canRefreshWorkerContext(agent:Agent):boolean {
  if (typeof agent.session?.deriveMessages !== 'function') return false;
  try {
    const prompt = agent.ctx.systemPrompt;
    return typeof prompt?.context === 'function' && typeof prompt.refreshContext === 'function';
  } catch {
    // A Cordis scope without the native service may throw on property access.
    return false;
  }
}

export function workerPromptPlan(agent:Agent,run:Run,standing:string,previous:readonly WorkerPriorInput[]=[]):WorkerPromptPlan {
  const inputOrder = previous.length+1;
  if (canRefreshWorkerContext(agent) && agent.session.id === run.sessionId) {
    try {
      const messages = agent.session.deriveMessages();
      const carried = previous.filter(prior=>!hasPreviousInput(messages,run,prior));
      const mode = hasStandingContext(messages,run,standing) ? 'delta' : 'full';
      return { mode, carried, inputOrder };
    } catch {
      // A missing or unreadable native projection is no proof of continuity.
    }
  }
  return { mode:'full', carried:previous, inputOrder };
}

export function registerWorkerContext(
  agent:Agent,run:Run,standing:string,message:UserMessage,previous:readonly WorkerPriorInput[],entered:()=>boolean,authorized:()=>boolean,
):()=>void {
  if (message.source.kind !== 'super-bot' || !message.source.promptMode || !canRefreshWorkerContext(agent)) return ()=>{};
  const block = message.content[0];
  if (block?.type !== 'text') return ()=>{};
  return agent.ctx.systemPrompt.context({
    name:'super-bot-worker-task',
    order:9000,
    interpolate:false,
    required:true,
    text:({agent:subject,signal})=>{
      if (subject !== agent || signal?.aborted || !authorized()) return '';
      const wasEntered = entered();
      const messages = agent.session.deriveMessages();
      const inputVisible = messages.some(candidate=>candidate.id===message.id
        && candidate.role==='user' && candidate.source.kind==='super-bot'
        && candidate.content[0]?.type==='text' && candidate.content[0].text===block.text);
      // The original input is about to enter this request or is restored below if it was shadowed.
      if (!inputVisible) messages.push(message);
      const missing = [];
      if (!hasStandingContext(messages,run,standing)) missing.push(standing);
      for (const prior of previous) {
        if (!hasPreviousInput(messages,run,prior)) missing.push(previousInputText(prior));
      }
      if (wasEntered && !inputVisible) missing.push(block.text);
      return missing.join('\n\n');
    },
  });
}
