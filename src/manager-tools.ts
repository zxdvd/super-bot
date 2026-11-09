/** Native tools for short Bot queries; this is a role boundary, not a read-only shell sandbox. */
export const MANAGER_NATIVE_TOOLS=['skill','bash','read','read_image','job_output','job_list','job_kill'];

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
