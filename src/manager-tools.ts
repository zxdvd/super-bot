/** Native tools for short Bot queries; this is a role boundary, not a read-only shell sandbox. */
export const MANAGER_NATIVE_TOOLS=['skill','bash','read','read_image','job_output','job_list','job_kill'];

export const MANAGER_RESPONSE_GUIDANCE = [
  'Lead with the outcome. Mention remaining work only when it matters, and ask the user only for a specific action or decision you actually need from them.',
  'Keep routine tool steps, internal status labels, and unchanged progress out of replies. Give a short update when the work materially changes or the user asks.',
  'Take the next available authorized step yourself. Before escalating, use the applicable tools for safe read-only checks and report what those checks actually establish.',
  'For a change under review, report whether it is ready for review based on the evidence. Treat CI, approvals, and mergeability separately. Waiting for CI or review alone does not make a review-ready change a draft or justify requesting a routine decision.',
].join(' ');

export const MANAGER_FULL_ACCESS_GUIDANCE = [
  'Ordinary host-trusted input or verified Feishu input can use the current DSH session tools when execution is authorized. Respect native tool and approval decisions. A tool listed in the prompt may still be unavailable in this turn.',
  'Run short read-only/status queries directly, for example git status or a lark-cli query. Read relevant skills and follow their query instructions. For a small, explicit edit that does not change substantive behavior, read the target, make only the requested edit, and read it back.',
  'For narrow research, use a research subagent only if the host actually provides one. Do not claim that a research subagent exists when none is available. Delegate substantive modifications, multi-step work, long-running work and full verification as Worker Tasks.',
  'Before acting on an existing Worker task, list work and read the matching task detail. Use respond for an open question and rework for an eligible result. If the Worker is running and there is no current input route, tell the user that rather than claiming you passed the message on. Do not replace that Worker with a new Task.',
  'Bash queries must set a positive timeoutMs <= 30000 or run_in_background: true. Never sleep, busy-poll, or wait for a Worker. Do not use Bash to bypass delegation or a tool denial. For job_output use wait: false, or timeout_ms <= 5000 with wait: true. If a query remains in the background, keep its job ID, explain that it is still running, and end the turn. Native job events notify you.',
  'Use job tools only for your own query jobs. Tool lists and noWait checks are not a read-only shell sandbox. Check available read-only routes before reporting a missing tool, CLI or authorization. Never ask the user to enable a tool channel. Use an explicit workdir/file_path when working in another project. Workers retain native Full Access by default and use the working directory described below.',
].join(' ');

// Same common sleep-command detection as the user-provided superagent prototype.
// This does not parse arbitrary shell programs or prevent deliberately disguised waits.
const SLEEP=/(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/;
const bounded=(value:unknown,max:number)=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=max;

export function managerNoWait(execution:{name:string;arguments:unknown}):string|undefined {
  const args=(execution.arguments&&typeof execution.arguments==='object'?execution.arguments:{}) as Record<string,unknown>;
  if(execution.name==='bash') {
    if(typeof args.command==='string'&&SLEEP.test(args.command))return 'Do not sleep or poll in the Bot session. Delegate long work to a Worker and end this turn; native job events report completion.';
    if(args.timeoutMs!==undefined&&!bounded(args.timeoutMs,30000))return 'Bot bash timeoutMs must be a positive number of at most 30000. Delegate long work to a Worker.';
    // Explicit bounds in every preset avoid depending on host defaults (standard Bash waits 60 seconds).
    if(args.timeoutMs===undefined&&args.run_in_background!==true)return 'For a short Bot query, pass timeoutMs of at most 30000, or run_in_background: true. Do not wait for long work; delegate it to a Worker.';
  }
  if(execution.name==='job_output'&&args.wait===true&&!bounded(args.timeout_ms,5000))return 'Bot job_output may wait at most 5000 ms: use wait: false, or an explicit timeout_ms from 1 to 5000. End the turn and let native job events notify you instead of polling.';
}
