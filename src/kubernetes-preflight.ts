import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access, realpath, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute, join} from 'node:path';
import {promisify} from 'node:util';
import {AppError} from './model.ts';
import type {ClusterProbe, ProbeResult} from './read-only-recovery.ts';

const call=promisify(execFile);
const identity=/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,159}$/;
const dnsName=/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const verbs=['get','list','watch','create','update','patch','delete'];
const resources=['deployments.apps','pods','persistentvolumeclaims','configmaps','serviceaccounts','jobs.batch'];
const unavailable=(message:string):ProbeResult=>({status:'unavailable',message});

export function parseClusterProbe(value:unknown):ClusterProbe {
  if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).some(key=>!['kind','context','namespace','name','verb','resource'].includes(key))) {
    throw new AppError('invalid-preflight','请提供结构化 Kubernetes 只读查询。');
  }
  const {kind,context,namespace,name,verb,resource}=value as Record<string,unknown>;
  if((kind!=='permission'&&kind!=='deployment-state'&&kind!=='volume-state')||
    typeof context!=='string'||!identity.test(context)||typeof namespace!=='string'||namespace.length>63||!dnsName.test(namespace)||
    typeof name!=='string'||!(name===''&&kind==='permission'||dnsName.test(name))||
    kind==='permission'&&(typeof verb!=='string'||!verbs.includes(verb)||typeof resource!=='string'||!resources.includes(resource))||
    kind!=='permission'&&(verb!==undefined||resource!==undefined)) {
    throw new AppError('invalid-preflight','请提供明确的 kubectl context、namespace、目标，以及受支持的只读查询。');
  }
  return {kind,context,namespace,name,...(kind==='permission'?{verb:verb as string,resource:resource as string}:{})};
}

async function executable() {
  for(const dir of (process.env.PATH??'').split(':')) {
    if(!isAbsolute(dir))continue;
    try{
      const file=await realpath(join(dir,'kubectl'));
      const info=await stat(file);
      if(!info.isFile())continue;
      await access(file,constants.X_OK);
      return {file,identity:[file,info.dev,info.ino,info.size,info.mtimeMs]};
    }catch{/* Try the next absolute PATH entry. */}
  }
  throw new AppError('kubectl-missing','当前宿主未找到 kubectl。');
}

async function kubectl(file:string,args:readonly string[],signal:AbortSignal,config?:string) {
  signal.throwIfAborted();
  const invocation=call(file,[...args],{signal,timeout:5500,maxBuffer:384*1024,killSignal:'SIGKILL',env:{...process.env,KUBECTL_KUBERC:'false'}});
  if(config) {
    invocation.child.stdin?.on('error',()=>{});
    invocation.child.stdin?.end(config);
  }
  try{return {...await invocation,code:0};}
  catch(error){
    const failure=error as {code?:number;stdout?:string;stderr?:string};
    return {code:failure.code,stdout:failure.stdout??'',stderr:failure.stderr??''};
  }
}

export async function prepareClusterProbe(probe:ClusterProbe,signal:AbortSignal,expectedAuth?:string,beforeIdentity?:()=>void) {
  const bin=await executable();
  const snapshot=await kubectl(bin.file,['config','view','--raw','--flatten','--minify',
    '--context',probe.context,'-o','json'],signal);
  if(snapshot.code!==0)throw new AppError('kubeconfig-unavailable','无法读取原 context 的 Kubernetes 配置。');
  let config: any;
  try{config=JSON.parse(snapshot.stdout);}catch{throw new AppError('kubeconfig-unavailable','无法核对原 context 的 Kubernetes 配置。');}
  const context=config.contexts?.[0],cluster=config.clusters?.[0],user=config.users?.[0];
  const credentials=user?.user;
  if(config['current-context']!==probe.context||config.contexts?.length!==1||config.clusters?.length!==1||config.users?.length!==1||
    context?.name!==probe.context||context.context.cluster!==cluster?.name||context.context.user!==user?.name||
    typeof cluster?.cluster?.server!=='string'||!cluster.cluster.server.startsWith('https://')||
    !Object.keys(cluster.cluster).every(key=>['server','certificate-authority-data','tls-server-name'].includes(key))||
    !credentials||!Object.keys(credentials).every(key=>['token','client-certificate-data','client-key-data'].includes(key))||
    !(credentials.token||credentials['client-certificate-data']&&credentials['client-key-data'])) {
    throw new AppError('kubeconfig-unproven','原 Kubernetes context 未提供可固定核对的身份凭据。');
  }
  const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const route=hash([bin.identity,config,process.env.HTTPS_PROXY,process.env.https_proxy,process.env.NO_PROXY,process.env.no_proxy]);
  const changed=()=>new AppError('kube-identity-changed','共享身份或 Kubernetes 配置已改变，需要核对当前授权。');
  if(expectedAuth&&expectedAuth.split(':')[0]!==route)throw changed();
  const args=['--kubeconfig=/dev/stdin','--context',probe.context,'--namespace',probe.namespace,
    '--request-timeout=4s','--cache-dir=/dev/null'];
  const invoke=(command:string[])=>kubectl(bin.file,[...args,...command],signal,snapshot.stdout);
  beforeIdentity?.();
  const identityResult=await invoke(['auth','whoami','-o','json']);
  let principal: {username?:unknown;uid?:unknown;groups?:unknown;extra?:unknown}|undefined;
  try{if(identityResult.code===0)principal=JSON.parse(identityResult.stdout)?.status?.userInfo;}catch{/* Unverified identity. */}
  if(typeof principal?.username!=='string'||!identity.test(principal.username)||principal.username==='system:anonymous') {
    throw new AppError('kube-identity-unproven','Kubernetes API 未确认当前 context 的实际共享身份。');
  }
  const auth=`${route}:${hash(principal)}`;
  if(expectedAuth&&auth!==expectedAuth)throw changed();
  return {
    auth,
    async check():Promise<ProbeResult> {
      if(probe.kind==='permission') {
        const target=probe.name?`${probe.resource}/${probe.name}`:probe.resource!;
        const result=await invoke(['auth','can-i',probe.verb!,target]);
        const answer=result.stdout.trim();
        if(result.code===0&&answer==='yes')return {status:'allowed',message:`共享身份 ${principal.username} 可以在 ${probe.namespace} 执行 ${probe.verb} ${target}。`};
        if(result.code===1&&/^no(?: - [^\r\n]+)?$/.test(answer)&&!result.stderr.trim())return {status:'denied',message:`共享身份 ${principal.username} 缺少 ${probe.namespace} 中的 ${probe.verb} ${target} 权限。`};
        return unavailable('Kubernetes API 未确认所请求的权限。');
      }
      const resource=probe.kind==='deployment-state'?'deployments.apps':'persistentvolumeclaims';
      const result=await invoke(['get',resource,probe.name,'-o','json','--ignore-not-found=true']);
      if(result.code===0&&!result.stdout.trim())return {status:'missing',message:`${probe.namespace}/${probe.name} 当前不存在。`};
      if(result.code!==0)return unavailable('Kubernetes API 未确认所请求资源的状态。');
      try {
        const value=JSON.parse(result.stdout),metadata=value.metadata;
        const kind=probe.kind==='deployment-state'?'Deployment':'PersistentVolumeClaim';
        if(value.kind!==kind||metadata.name!==probe.name||metadata.namespace!==probe.namespace||
          typeof metadata.uid!=='string'||!identity.test(metadata.uid))return unavailable('Kubernetes 回执与原查询资源不匹配。');
        const ready=kind==='Deployment'?Number.isSafeInteger(metadata.generation)&&
          Number.isSafeInteger(value.status?.observedGeneration)&&value.status.observedGeneration>=metadata.generation&&
          Number.isSafeInteger(value.spec?.replicas)&&value.spec.replicas>0&&value.status?.replicas===value.spec.replicas&&
          value.status?.updatedReplicas===value.spec.replicas&&value.status?.availableReplicas===value.spec.replicas&&
          value.status?.readyReplicas===value.spec.replicas:
          value.status?.phase==='Bound';
        const containers:unknown=probe.kind==='deployment-state'?value.spec?.template?.spec?.containers:undefined;
        const deploymentImages=Array.isArray(containers)?containers.slice(0,20).flatMap(container=>
          typeof container?.name==='string'&&container.name.length<=63&&dnsName.test(container.name)&&
          typeof container.image==='string'&&/^[A-Za-z0-9._/@:+-]{1,350}$/.test(container.image)
            ?[{container:container.name as string,image:container.image as string}]:[]):[];
        const images=deploymentImages.length?` 部署规格镜像 ${deploymentImages.map(item=>`${item.container}=${item.image}`).join('、')}。`:'';
        return {status:'present',message:`${probe.namespace}/${probe.name} 已存在，当前${ready?'已就绪':'未就绪'}。${images}`,
          observed:{uid:metadata.uid,ready,...(deploymentImages.length?{deploymentImages}:{})}};
      }catch{return unavailable('Kubernetes 资源回执无法验证。');}
    },
  };
}
