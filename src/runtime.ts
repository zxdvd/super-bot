/** DSH role configuration; native full access is the default; files isolation is explicit opt-in. */
import type {Context} from '@deepseek-ai/cordis';
import type {Agent,ModelSelection} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-permission-presets';

export interface RuntimeOptions {
  fullAccess?:boolean;
  workspace?:string;
  managerModel?:ModelSelection;
  workerModel?:ModelSelection;
}
export function fullAccessEnabled(options:RuntimeOptions):boolean { return options.fullAccess!==false; }

export function configureRole(ctx:Context,agent:Agent,role:'manager'|'worker',options:RuntimeOptions):void {
  const model=role==='manager'?options.managerModel:options.workerModel;
  if(model)agent.model.select(model);
  if(fullAccessEnabled(options))ctx.permissionPresets.set(agent.session,'danger-full-access');
}
