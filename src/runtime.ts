/** DSH role configuration; native full access is the default; files isolation is explicit opt-in. */
import type {Context} from '@deepseek-ai/cordis';
import type {Agent,ModelSelection} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-permission-presets';
import type {WorkdirConfig} from './workdir.ts';

export interface RuntimeOptions extends WorkdirConfig {
  fullAccess?:boolean;
  managerModel?:ModelSelection;
  workerModel?:ModelSelection;
  /** Global unconverged Worker runs (default 2). */
  maxRunningTasks?:number;
  /** Automatic Bot wakes per Bot per rolling hour (default 20). */
  managerWakesPerHour?:number;
  /** Bots woken at the same time (default 2). */
  managerConcurrentWakes?:number;
  /** Hard limit for one automatic Bot turn, in minutes (default 5). */
  managerTurnMinutes?:number;
}
const positive=(value:unknown,fallback:number)=>typeof value==='number'&&Number.isInteger(value)&&value>0?value:fallback;
export function runtimeLimits(options:RuntimeOptions) {
  return {maxRunningTasks:positive(options.maxRunningTasks,2),managerWakesPerHour:positive(options.managerWakesPerHour,20),managerConcurrentWakes:positive(options.managerConcurrentWakes,2),managerTurnMinutes:positive(options.managerTurnMinutes,5)};
}
export function fullAccessEnabled(options:RuntimeOptions):boolean { return options.fullAccess!==false; }

export function configureRole(ctx:Context,agent:Agent,role:'manager'|'worker',options:RuntimeOptions):void {
  const model=role==='manager'?options.managerModel:options.workerModel;
  if(model)agent.model.select(model);
  if(fullAccessEnabled(options))ctx.permissionPresets.set(agent.session,'danger-full-access');
}
