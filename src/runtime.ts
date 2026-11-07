/** DSH role configuration; explicit full access is a trusted local deployment choice. */
import type {Context} from '@deepseek-ai/cordis';
import type {Agent,ModelSelection} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-permission-presets';

export interface RuntimeOptions {
  fullAccess?:boolean;
  workspace?:string;
  managerModel?:ModelSelection;
  workerModel?:ModelSelection;
}
export function configureRole(ctx:Context,agent:Agent,role:'manager'|'worker',options:RuntimeOptions):void {
  const model=role==='manager'?options.managerModel:options.workerModel;
  if(model)agent.model.select(model);
  if(options.fullAccess)ctx.permissionPresets.set(agent.session,'danger-full-access');
}
