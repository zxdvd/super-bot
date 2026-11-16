/** Pure durable-prefix verifier: never infers external convergence from a new host. */
import {AppError,type Run,type RunInput,type RunTurn} from './model.ts';
export interface RunEvent {seq:number;type:string;surfaceOp?:unknown;data:any}
export function verifyRunTurn(run:Run,input:RunInput,proof:RunTurn,events:readonly RunEvent[]):string[] {
  const refuse=(note:string):never=>{throw new AppError('run-proof',note);};
  if(proof.turn===null||proof.startSeq===null||proof.inputSeq===null||proof.endSeq===null||proof.quiet!==1)refuse('缺少原执行进程记录的轮次归属或后台收敛证据，保留占用；不会重投。');
  if(proof.runId!==run.id||input.id!==run.inputId||!(proof.startSeq!<proof.inputSeq!&&proof.inputSeq!<proof.endSeq!))refuse('Run 证据身份或坐标顺序无效。');
  if(events.some((e,i)=>e.seq!==i))refuse('持久会话日志不是完整连续前缀，请人工核对。');
  const start=events[proof.startSeq!],entered=events[proof.inputSeq!],end=events[proof.endSeq!];
  if(start?.type!=='turn/start'||start.data.turn!==proof.turn)refuse('持久轮次开始与 Run 归属不符。');
  const source=entered?.data.source;
  if(entered?.type!=='user/message'||entered.surfaceOp!=='append'||entered.data.id!==input.messageId||source?.kind!=='super-bot'||source.runId!==run.id||source.inputId!==run.inputId||source.taskId!==run.taskId||source.generation!==run.generation||source.taskRevision!==run.taskRevision)refuse('持久自动输入身份与 Run 不符，不能补结算。');
  if(end?.type!=='turn/end'||end.data.turn!==proof.turn||end.data.reason.kind!==proof.endKind)refuse('缺少匹配且持久保存的自动轮次结束事件，保留占用。');
  if(events.slice(proof.startSeq!+1,proof.endSeq!).some(e=>e.type==='turn/start'||e.type==='turn/end'))refuse('自动输入和结束事件不属于同一轮次。');
  if(events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='super-bot'&&e.data.source.runId===run.id).length!==1)refuse('自动输入存在重复或不明确的持久身份。');
  if(proof.endKind!=='completed'&&!(run.state==='cancelling'&&proof.endKind==='aborted'))refuse('自动轮次非正常结束，请核对；没有补成功。');
  return events.slice(proof.endSeq!+1).filter(e=>e.type==='user/message'&&e.data.source?.kind==='user'&&'rpcId' in e.data.source).map(e=>e.data.id);
}
