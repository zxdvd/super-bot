/** DSH role configuration; explicit full access is a trusted local deployment choice. */
import type {Agent,ModelSelection} from '@deepseek-ai/dsh-agent';
import {setSandboxMode} from '@deepseek-ai/dsh-sandbox-policy';

export interface RuntimeOptions {
  fullAccess?:boolean;
  workspace?:string;
  managerModel?:ModelSelection;
  workerModel?:ModelSelection;
}
export function configureRole(agent:Agent,role:'manager'|'worker',options:RuntimeOptions):void {
  const model=role==='manager'?options.managerModel:options.workerModel;
  if(model)agent.model.select(model);
  if(options.fullAccess)setSandboxMode(agent.session,'danger-full-access');
}
