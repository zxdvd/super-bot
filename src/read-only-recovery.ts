import {isAbsolute, resolve} from 'node:path';
import {containedPath} from './evidence.ts';
import type {RunEvent} from './run-proof.ts';

export type ReadProbe = {kind:'file'; path:string; offset?:number; limit?:number};
export type ClusterProbe = {
  kind:'permission'|'deployment-state'|'volume-state';
  context:string; namespace:string; name:string;
  verb?:string; resource?:string;
};
export type RecoveryProbe = ReadProbe|ClusterProbe;
export type ProbeResult = {
  status:'readable'|'allowed'|'denied'|'present'|'missing'|'unavailable';
  message:string;
  observed?:{uid:string; ready:boolean};
};
export type ProbeEvidence = {
  probe:RecoveryProbe; callId:string; callSeq:number; resultSeq:number; auth?:string;
};
export type RecoveryCheck = {
  managerId:string;
  rowVersion:number;
  evidence:ProbeEvidence;
  resolution?:ProbeResult;
  effectUncertain?:boolean;
};
export type PriorTools = {
  files:{evidence:ProbeEvidence;known?:ProbeResult}[];
  clusters:{callId:string;callSeq:number;resultSeq:number}[];
  potentialEffects:{tool:string;callSeq:number;result:'reported-success'|'reported-error'|'missing'}[];
  incomplete:boolean;
};

function asReadProbe(raw:string,cwd:string):ReadProbe|null {
  try {
    const args=JSON.parse(raw);
    if(!args||Array.isArray(args)||Object.keys(args).some(key=>!['file_path','offset','limit'].includes(key)))return null;
    if(typeof args.file_path!=='string'||!isAbsolute(args.file_path)||args.file_path.length>2000)return null;
    const path=containedPath(cwd,args.file_path),{offset,limit}=args;
    if(path!==resolve(args.file_path)||
      offset!==undefined&&(!Number.isSafeInteger(offset)||offset<1)||
      limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1||limit>2000))return null;
    return {kind:'file',path,...(offset!==undefined?{offset}:{}),...(limit!==undefined?{limit}:{})};
  }catch{return null;}
}

/** Only durable calls in the exact verified Worker turn count as evidence. */
export function inspectPriorTools(events:readonly RunEvent[],cwd:string,turn:number,startSeq:number,endSeq:number):PriorTools {
  const eventsInTurn=events.slice(startSeq+1,endSeq);
  const checks:PriorTools={files:[],clusters:[],potentialEffects:[],incomplete:false};
  const results=new Map<string,RunEvent[]>();
  const latestFiles=new Map<string,PriorTools['files'][number]|null>();
  const callIds=new Set<string>();
  for(const event of eventsInTurn) {
    if(event.type!=='tool/result')continue;
    if(event.data.turn!==turn||typeof event.data.message?.toolCallId!=='string'){checks.incomplete=true;continue;}
    const callId=event.data.message.toolCallId;
    results.set(callId,[...(results.get(callId)??[]),event]);
  }
  for(const call of eventsInTurn) {
    if(call.type!=='tool/call')continue;
    const {callId,name,arguments:args}=call.data;
    if(call.data.turn!==turn||typeof callId!=='string'||typeof name!=='string'||callIds.has(callId)){checks.incomplete=true;continue;}
    callIds.add(callId);
    const matches=results.get(callId);
    const result=matches?.length===1&&matches[0]!.seq>call.seq&&matches[0]!.data.step===call.data.step?matches[0]:undefined;
    if(!result)checks.incomplete=true;
    if(name==='super_bot_report')continue;
    if(name==='read') {
      const probe=asReadProbe(args,cwd);
      if(probe&&result) {
        // Offset's default is stable. An omitted line limit retains native semantics.
        const key=JSON.stringify([probe.path,probe.offset??1,probe.limit??null]);
        const reason=result.data.error?.reason??result.data.message.content?.find((part:{type:string})=>part.type==='text')?.text;
        const code=result.data.error?.code;
        const missing=code==='FS_NOT_FOUND'||typeof reason==='string'&&
          /\b(?:ENOENT|file not found|no such file(?: or directory)?|file does not exist|path does not exist)\b|^cannot read .+: not found$/i.test(reason)&&
          !/\b(?:EACCES|EPERM|permission denied|approval|refused|outside)\b/i.test(reason);
        const evidence={probe,callId,callSeq:call.seq,resultSeq:result.seq};
        const known:ProbeResult|undefined=code==='FS_PERMISSION_DENIED'?
          {status:'denied',message:'原生 Worker 在上一轮缺少对该文件路径的读取权限。'}:undefined;
        latestFiles.set(key,result.data.message.isError===true&&(missing||known)?
          {evidence,...(known?{known}:{})}:null);
      }
      continue;
    }
    if(name==='super_bot_preflight'&&result) {
      checks.clusters.push({callId,callSeq:call.seq,resultSeq:result.seq});
      continue;
    }
    checks.potentialEffects.push({tool:name,callSeq:call.seq,result:result?
      result.data.message.isError?'reported-error':'reported-success':'missing'});
  }
  if([...results.keys()].some(id=>!callIds.has(id)))checks.incomplete=true;
  checks.files=[...latestFiles.values()].flatMap(check=>check?[check]:[]);
  return checks;
}
