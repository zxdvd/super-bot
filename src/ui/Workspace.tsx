import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Attention, Binding, Bot, Task, TaskPage, WorkspaceStatus,Run,RunInput,Result,ManagerBinding } from '../model.ts';
import { styles } from './styles.ts';
import type { BackupInfo } from '../backups.ts';

export interface WorkspaceApi {
  call<T>(action: string, payload?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  openSession(id: string): void;
}
type Detail = { task: Task; binding: Binding | null;bindingHistory:Binding[];run:Run|null;input:RunInput|null;result:Result|null; attentions: Attention[]; events: { id: number; kind: string; data:string; createdAt: number }[] };
const labels: Record<Task['status'],string> = { unscheduled:'待安排', 'needs-input':'等你补充', approval:'原生审批待处理', paused:'已暂停', manual:'人工接管', completed:'已完成', cancelled:'已取消', review:'待验收',queued:'待投递',running:'执行中',stopping:'正在停止',recovery:'待核对' };
const eventLabels: Record<string,string> = { 'task.created':'创建任务', 'task.revised':'更新目标与验收条件', 'task.control':'更新管理方式', 'session.preparing':'准备执行会话', 'session.ready':'执行会话已关联', 'session.recovery':'会话创建待核对','run.queued':'已接收执行请求','input.entered':'任务输入已进入模型上下文','work.report':'收到工作报告','run.settled':'执行已收敛','run.recovery':'执行需要核对','result.accepted':'用户接受成果','native.intervention':'原生会话人工介入','run.stop-requested':'已请求停止','run.cancelled':'已核对停止','attention.answered':'回答已保存','result.rejected':'返工要求已保存','run.recovery-confirmed':'用户完成恢复核对','manager.reviewed':'Bot 检查成果','task.cancelled':'用户取消任务','session.detached':'解除执行会话关联','work.report-stale':'保留已失效报告的审计','approval.asked':'原生工具请求审批','approval.decided':'原生审批已有结果' };
function eventTitle(event:{kind:string;data:string}):string {
  if(event.kind==='approval.decided')try {
    const outcome=JSON.parse(event.data).outcome as string;
    return ({'allowed-once':'原生审批：仅允许本次',rejected:'原生审批：已拒绝',cancelled:'原生审批：已撤回',unavailable:'原生审批：当前无可用处理入口'} as Record<string,string>)[outcome]??eventLabels[event.kind]!;
  }catch{/* Older audit entries may not contain detail. */}
  return eventLabels[event.kind]??event.kind;
}
const time = (value:number) => new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
function rememberedBot():string {try{return localStorage.getItem('super-bot:bot')??'';}catch{return '';}}
function rememberBot(id:string):void {try{localStorage.setItem('super-bot:bot',id);}catch{/* Browser storage is optional. */}}
type SavedView={botId:string;selected:string;query:string;filter:string;offset:number};
function rememberedView():SavedView|undefined {
  try {
    const value=JSON.parse(sessionStorage.getItem('super-bot:view')??'null') as SavedView|null;
    if(value&&typeof value.botId==='string'&&typeof value.selected==='string'&&typeof value.query==='string'&&value.query.length<=200&&['','open','review','completed','cancelled'].includes(value.filter)&&Number.isSafeInteger(value.offset)&&value.offset>=0)return value;
  }catch{/* Browser storage is optional. */}
}

function BotForm({ submit, cancel, busy }: { submit:(data:Record<string,unknown>)=>Promise<boolean>; cancel:()=>void; busy:boolean }) {
  const [name,setName]=useState(''); const [instructions,setInstructions]=useState('');
  const request=useRef(crypto.randomUUID());
  const [validation,setValidation]=useState('');
  function changed(){request.current=crypto.randomUUID();setValidation('');}
  async function save(e:FormEvent){e.preventDefault();if(!name.trim()||!instructions.trim()){setValidation('请填写名称和职责，不能只填空格。');return;}await submit({requestId:request.current,name,instructions});}
  return <form className="form" onSubmit={save}><h2>创建你的 Bot</h2><p className="muted">给它一项清楚、长期的职责。</p>
    <label htmlFor="sb-bot-name">名称</label><input disabled={busy} id="sb-bot-name" autoFocus required maxLength={80} placeholder="例如：开发 Bot" value={name} onChange={e=>{changed();setName(e.target.value);}}/>
    <label htmlFor="sb-bot-instructions">职责与边界</label><textarea disabled={busy} id="sb-bot-instructions" required maxLength={10000} placeholder="负责哪些工作，什么事情需要先问你？" value={instructions} onChange={e=>{changed();setInstructions(e.target.value);}}/>
    {validation&&<p className="notice error" role="alert">{validation}</p>}
    <div className="actions"><button className="primary" disabled={busy}>{busy?'保存中…':'创建 Bot'}</button><button type="button" disabled={busy} onClick={cancel}>取消</button></div>
  </form>;
}

function TaskForm({ task, submit, cancel, busy }: { task?:Task; submit:(data:Record<string,unknown>)=>Promise<boolean>; cancel:()=>void; busy:boolean }) {
  const [goal,setGoal]=useState(task?.goal??''); const [scope,setScope]=useState(task?.scope??'');
  const [acceptance,setAcceptance]=useState(task?.acceptance??''); const [autoReview,setAutoReview]=useState(task?.reviewPolicy==='bot');
  const request=useRef(crypto.randomUUID());
  const [validation,setValidation]=useState('');
  function changed(){request.current=crypto.randomUUID();setValidation('');}
  async function save(e:FormEvent){e.preventDefault();if(!goal.trim()){setValidation('请填写任务目标，不能只填空格。');return;}await submit({requestId:request.current,goal,scope,acceptance,reviewPolicy:autoReview?'bot':'human'});}
  return <form className="form" onSubmit={save}><h2>{task?'修改任务':'新任务'}</h2>
    <label htmlFor="sb-task-goal">要完成什么</label><textarea disabled={busy} id="sb-task-goal" autoFocus required maxLength={10000} value={goal} onChange={e=>{changed();setGoal(e.target.value);}} placeholder="描述一个可以独立验收的目标"/>
    <label htmlFor="sb-task-scope">范围与限制</label><textarea disabled={busy} id="sb-task-scope" maxLength={10000} value={scope} onChange={e=>{changed();setScope(e.target.value);}} placeholder="允许修改什么？哪些内容需要保留？"/>
    <label htmlFor="sb-task-acceptance">怎样算完成</label><textarea disabled={busy} id="sb-task-acceptance" maxLength={10000} value={acceptance} onChange={e=>{changed();setAcceptance(e.target.value);}} placeholder="期望看到的成果和验证结果"/>
    <p className="muted" style={{fontSize:12}}>范围或验收条件可以稍后补充；补全前任务不会派发。</p>
    {!task&&<label className="check"><input disabled={busy} type="checkbox" checked={autoReview} onChange={e=>{changed();setAutoReview(e.target.checked);}}/>允许 Bot 最终验收这个低风险任务</label>}
    {validation&&<p className="notice error" role="alert">{validation}</p>}
    <div className="actions"><button className="primary" disabled={busy}>{busy?'保存中…':task?'保存修改':'创建任务'}</button><button type="button" disabled={busy} onClick={cancel}>取消</button></div>
  </form>;
}

function ReplyForm({label,busy,submit}:{label:string;busy:boolean;submit:(text:string,requestId:string)=>Promise<boolean>}) {
  const [text,setText]=useState('');const request=useRef(crypto.randomUUID());
  return <form className="form" onSubmit={e=>{e.preventDefault();if(text.trim())void submit(text,request.current);}}><label>{label}<textarea disabled={busy} required maxLength={10000} value={text} onChange={e=>{setText(e.target.value);request.current=crypto.randomUUID();}}/></label><button disabled={busy||!text.trim()}>保存{label}</button><p className="muted" style={{fontSize:12}}>保存后点击“开始执行”投递。暂停期间会保留输入。</p></form>;
}
function RecoveryPanel({busy,confirm}:{busy:boolean;confirm:()=>void}) {
  const [checked,setChecked]=useState(false);
  return <div className="attention-box"><p>请打开原生会话，检查文件与可能的外部效果。确认后会释放本次占用，任务保持暂停，不会重放旧输入。</p><label className="check"><input disabled={busy} type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/>我已检查，确认可以结束本次尝试</label><button disabled={busy||!checked} onClick={confirm}>完成核对</button></div>;
}
function ConfirmAction({label,explanation,disabled,submit}:{label:string;explanation:string;disabled:boolean;submit:()=>Promise<boolean>}) {
  const [confirming,setConfirming]=useState(false);
  return confirming?<div className="attention-box"><p>{explanation}</p><div className="actions"><button disabled={disabled} onClick={()=>void submit().then(ok=>{if(ok)setConfirming(false);})}>确认{label}</button><button disabled={disabled} onClick={()=>setConfirming(false)}>返回</button></div></div>:<button disabled={disabled} onClick={()=>setConfirming(true)}>{label}</button>;
}

export function Workspace({ api }: { api:WorkspaceApi }) {
  const preferredBot=useRef(rememberedBot());
  const savedView=useRef(rememberedView());const pendingSelection=useRef('');
  const [managerInfo,setManagerInfo]=useState<{binding:ManagerBinding|null;pending:number;uncertain:number;hourlyWakes:number}>();
  const [backupInfo,setBackupInfo]=useState<BackupInfo>();
  const [status,setStatus]=useState<WorkspaceStatus>(); const [bots,setBots]=useState<Bot[]>([]);
  const [botId,setBotId]=useState(''); const [page,setPage]=useState<TaskPage>(); const [selected,setSelected]=useState('');
  const [detail,setDetail]=useState<Detail>(); const [query,setQuery]=useState(''); const [filter,setFilter]=useState(''); const [offset,setOffset]=useState(0);
  const [online,setOnline]=useState(false);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [connectionError,setConnectionError]=useState('');const [busy,setBusy]=useState(false);
  const [form,setForm]=useState<'bot'|'task'|'edit'|null>(null); const [refresh,setRefresh]=useState(0); const [synced,setSynced]=useState(0);
  useEffect(()=>{if(botId)try{sessionStorage.setItem('super-bot:view',JSON.stringify({botId,selected,query,filter,offset}));}catch{/* Browser storage is optional. */}},[botId,selected,query,filter,offset]);
  useEffect(()=>{
    const controller=new AbortController(); let timer:ReturnType<typeof setTimeout>; let failures=0;
    async function pull(){
      let cadence=5000;
      if(document.visibilityState==='hidden'){timer=setTimeout(pull,5000);return;}
      try {
        const [s, b, p, d, m]=await Promise.all([
          api.call<WorkspaceStatus>('status',{},controller.signal), api.call<Bot[]>('bot.list',{},controller.signal),
          botId?api.call<TaskPage>('task.list',{botId,q:query,lifecycle:filter,offset,limit:25},controller.signal):undefined,
          selected?api.call<Detail>('task.detail',{id:selected},controller.signal):undefined,
          botId?api.call<typeof managerInfo>('manager.status',{botId},controller.signal):undefined,
        ]);
        if(controller.signal.aborted)return;
        setStatus(s);setBots(b);setPage(p);setManagerInfo(m);setConnectionError('');
        if(p&&pendingSelection.current){if(p.items.some(t=>t.id===pendingSelection.current))setSelected(pendingSelection.current);pendingSelection.current='';}
        if(p?.items.some(t=>['queued','running','stopping','approval'].includes(t.status)))cadence=1000;
        if(selected&&p&&!p.items.some(t=>t.id===selected)){setSelected('');setDetail(undefined);setForm(null);}else setDetail(d);setOnline(true);setLoading(false);setSynced(Date.now());failures=0;
        if(!botId&&b.length){const id=b.some(bot=>bot.id===preferredBot.current)?preferredBot.current:b[0].id;setBotId(id);rememberBot(id);if(savedView.current?.botId===id){setQuery(savedView.current.query);setFilter(savedView.current.filter);setOffset(savedView.current.offset);pendingSelection.current=savedView.current.selected;}savedView.current=undefined;}
      } catch(e){if(controller.signal.aborted)return;setOnline(false);setLoading(false);setConnectionError('暂时无法读取宿主状态，将自动重试。');failures++;}
      timer=setTimeout(pull,Math.min(30000,cadence*2**failures));
    }
    pull();return()=>{controller.abort();clearTimeout(timer);};
  },[api,botId,selected,query,filter,offset,refresh]);
  const bot=bots.find(b=>b.id===botId);
  async function mutate<T>(action:string,payload:Record<string,unknown>,done?:(value:T)=>void):Promise<boolean>{
    if(!online||busy)return false;setBusy(true);setError('');
    try{const result=await api.call<T>(action,payload);done?.(result);setRefresh(n=>n+1);return true;}
    catch(e){setError(e instanceof Error?e.message:'操作未完成，请核对后重试。');setRefresh(n=>n+1);return false;}
    finally{setBusy(false);}
  }
  function pickBot(id:string){preferredBot.current=id;rememberBot(id);setBotId(id);setManagerInfo(undefined);setPage(undefined);setSelected('');setDetail(undefined);setOffset(0);setFilter('');setQuery('');setForm(null);}
  return <div className="sb"><style>{styles}</style><div className="sb-wrap">
    <header className="sb-header"><div><div className="eyebrow">BOT WORKSPACE</div><h1>Super Bot</h1></div><div className="connection"><span className={`dot ${online?'':'offline'}`}/>{loading?'连接中…':online?'宿主在线':'宿主离线'}{synced>0&&<span className="muted">· {time(synced)}</span>}</div></header>
    {(error||connectionError)&&<div className="notice error" role="alert"><span>{error||connectionError}</span><button onClick={()=>{setError('');setConnectionError('');setRefresh(n=>n+1);}}>刷新状态</button></div>}
    {backupInfo&&<div className="notice"><div><strong>账本备份已保存</strong><p style={{overflowWrap:'anywhere'}}>{backupInfo.path}</p><p className="muted">{backupInfo.scope}</p></div><button onClick={()=>setBackupInfo(undefined)}>关闭</button></div>}
    {!online&&!loading&&<div className="notice">{synced?'当前显示上次同步的快照。':'尚未读取到工作台数据。'}重新连接前，操作暂不可用。</div>}
    {loading?<div className="empty">正在读取工作台…</div>:<>
      {bots.length>0&&<div className="toolbar"><select aria-label="选择 Bot" disabled={busy} value={botId} onChange={e=>pickBot(e.target.value)}>{bots.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select><button disabled={!online||busy} onClick={()=>setForm(form==='bot'?null:'bot')}>＋ 新 Bot</button><span className="spacer"/><button className="primary" disabled={!online||busy||!bot} onClick={()=>setForm(form==='task'?null:'task')}>＋ 新任务</button></div>}
      {form==='bot'&&<BotForm busy={busy||!online} cancel={()=>{setForm(null);setError('');}} submit={data=>mutate<Bot>('bot.create',data,b=>{pickBot(b.id);setForm(null);})}/>}
      {online&&bots.length===0&&form!=='bot'&&<div className="welcome"><h2>先认识你的第一位 Bot</h2><p className="muted" style={{lineHeight:1.8}}>定义长期职责，再把具体目标交给它。任务与成果会保存在这里。</p><ul><li>不同 Bot，各自负责自己的工作</li><li>任务有明确目标、范围和验收条件</li><li>需要你回答或验收时，集中呈现</li></ul><button className="primary" disabled={!online} onClick={()=>setForm('bot')}>创建第一个 Bot</button></div>}
      {bot&&<>
        <div className="bot-intro"><h2>{bot.name}</h2><p>{bot.instructions}</p><button disabled={!online||busy} onClick={()=>bot.managerSessionId?api.openSession(bot.managerSessionId):mutate<{sessionId:string}>('manager.prepare',{requestId:crypto.randomUUID(),botId:bot.id},value=>api.openSession(value.sessionId))}>{bot.managerSessionId?'打开 Bot 管理对话':'启用 Bot 管理对话'}</button><p className="muted" style={{fontSize:12}}>在管理对话选择模型后，Bot 会读取账本并安排完整、未暂停的任务。默认仍由你最终验收。</p>{managerInfo?.binding?.state==='ready'&&<details><summary className="muted">管理会话设置</summary><p className="muted">更换会创建新对话，并从账本恢复工作。旧对话和任务均保留。</p><button disabled={!online||busy} onClick={()=>mutate<{sessionId:string}>('manager.replace',{requestId:`replace:${managerInfo.binding!.id}`,botId:bot.id,expectedGeneration:managerInfo.binding!.generation},value=>api.openSession(value.sessionId))}>更换管理会话</button><p className="muted">待处理通知 {managerInfo.pending} · 本小时自动唤醒 {managerInfo.hourlyWakes}/20</p>{managerInfo.uncertain>0&&<p>有 {managerInfo.uncertain} 条通知送达待核对，请在管理对话读取最新账本。</p>}{managerInfo.hourlyWakes>=20&&<p>本小时自动管理额度已用完；队列保留，仍可在管理对话手动处理。</p>}</details>}</div>
        <div className="notice"><span>当前支持专用目录内的文件任务。准备会话并选择模型后，可手动开始执行；成果默认由你验收。</span></div>
        {(form==='task'||(form==='edit'&&detail))&&<TaskForm key={form==='edit'?detail!.task.id:'new'} task={form==='edit'?detail!.task:undefined} busy={busy||!online} cancel={()=>{setForm(null);setError('');}} submit={data=>mutate<Task>(form==='edit'?'task.revise':'task.create',form==='edit'?{...data,id:detail!.task.id,expectedRowVersion:detail!.task.rowVersion}:{...data,botId},t=>{setSelected(t.id);setForm(null);setOffset(0);setFilter('');setQuery('');})}/>}
        <div className="stats">{([['','全部','all'],['open','未完成','open'],['review','待验收','review'],['completed','已完成','completed'],['cancelled','已取消','cancelled']] as const).map(([value,label,key])=><button key={key} className={filter===value?'active':''} disabled={!online||busy} onClick={()=>{setFilter(value);setOffset(0);setSelected('');setDetail(undefined);setForm(null);}}>{label}<strong>{page?.counts[key]??'—'}</strong></button>)}</div>
        <div className="grid"><section className="card" aria-label="任务列表"><div className="card-head"><input disabled={busy} aria-label="搜索任务" placeholder="搜索任务目标…" value={query} onChange={e=>{setQuery(e.target.value);setOffset(0);setSelected('');setDetail(undefined);setForm(null);}}/></div>
          {!page?<div className="empty">读取任务…</div>:page.items.length===0?<div className="empty"><h2>{query||filter?'没有匹配的任务':'还没有任务'}</h2><p>{query||filter?'调整关键词或状态筛选。':'把一个具体目标放进来，先写清怎样算完成。'}</p>{!query&&!filter&&<button disabled={!online} onClick={()=>setForm('task')}>新建任务</button>}</div>:page.items.map(t=><button key={t.id} className={`task ${selected===t.id?'selected':''}`} aria-pressed={selected===t.id} disabled={busy} onClick={()=>{setSelected(t.id);setDetail(undefined);setForm(null);}}><div className="task-top"><span className="task-goal">{t.goal}</span><span className={`badge ${t.status==='needs-input'?'attention':''}`}>{labels[t.status]}</span></div><div className="task-meta"><span>{t.reviewPolicy==='human'?'由你最终验收':'Bot 可最终验收'}</span><span>{time(t.updatedAt)}</span></div></button>)}
          {page&&<footer className="pagination"><span>{page.total} 项任务 · {page.total?offset+1:0}–{Math.min(offset+page.items.length,page.total)} · 第 {Math.floor(offset/25)+1}/{Math.max(1,Math.ceil(page.total/25))} 页</span><div><button disabled={!online||busy||offset===0} onClick={()=>{setOffset(Math.max(0,offset-25));setSelected('');setDetail(undefined);}}>上一页</button> <button disabled={!online||busy||offset+25>=page.total} onClick={()=>{setOffset(offset+25);setSelected('');setDetail(undefined);}}>下一页</button></div></footer>}
        </section>
        <section className="card" aria-label="任务详情">{!detail?<div className="empty"><h2>任务的来龙去脉</h2><p>选择任务，查看范围、验收条件、待办和关键事件。</p></div>:<div className="card-body"><p className="detail-goal">{detail.task.goal}</p><span className={`badge ${detail.task.status==='needs-input'?'attention':''}`}>{labels[detail.task.status]}</span>
          {detail.attentions.filter(a=>a.state==='open'||a.state==='responding').map(a=><div className="attention-box" key={a.id}><strong>{a.kind==='recovery'?'需要核对':a.kind==='review'?'请验收成果':a.kind==='approval'?'请处理原生审批':'需要你补充'}</strong><br/>{a.question}{a.kind==='approval'&&detail.binding?.sessionId&&<p><button disabled={!online||busy} onClick={()=>api.openSession(detail.binding!.sessionId!)}>打开会话处理审批</button></p>}{a.state==='responding'?<p>回答已保存，等待投递和进入上下文。</p>:a.kind==='input'&&detail.binding&&<ReplyForm key={a.id} label="回答" busy={!online||busy} submit={(text,requestId)=>mutate('attention.respond',{requestId,attentionId:a.id,expectedRowVersion:detail.task.rowVersion,text})}/>}</div>)}
          <dl><dt>任务范围</dt><dd>{detail.task.scope||'尚未填写'}</dd><dt>验收条件</dt><dd>{detail.task.acceptance||'尚未填写'}</dd><dt>最终验收</dt><dd>{detail.task.reviewPolicy==='human'?'由你确认':'已授权 Bot 验收'}</dd></dl>
          <div className="actions"><button disabled={!online||busy||!!detail.binding||detail.task.lifecycle!=='open'} onClick={()=>setForm('edit')}>修改任务</button><button disabled={!online||busy||['completed','cancelled'].includes(detail.task.lifecycle)} onClick={()=>mutate('task.control',{requestId:crypto.randomUUID(),id:detail.task.id,expectedRowVersion:detail.task.rowVersion,mode:detail.task.controlMode==='auto'?'paused':'auto'})}>{detail.task.controlMode==='auto'?'暂停自动管理':'恢复自动管理'}</button></div>
          {['open','review'].includes(detail.task.lifecycle)&&<details><summary className="muted">不再需要这个任务？</summary><ConfirmAction key={`cancel:${detail.task.id}:${detail.task.rowVersion}`} label="取消任务" explanation="结束这个任务，未送出的回答与返工要求不再执行。会话、成果和文件保留；取消不会接受成果。执行中或待核对时，请先停止并完成核对。" disabled={!online||busy||['running','queued','stopping','recovery','approval'].includes(detail.task.status)} submit={()=>mutate('task.cancel',{requestId:`cancel:${detail.task.id}:${detail.task.rowVersion}`,id:detail.task.id,expectedRowVersion:detail.task.rowVersion})}/></details>}
          {detail.run&&['running','queued','cancelling'].includes(detail.run.state)&&<div className="actions"><button disabled={!online||busy||detail.run.state==='cancelling'} onClick={()=>mutate('task.stop',{requestId:`stop:${detail.run!.id}:${detail.task.rowVersion}`,id:detail.task.id,expectedRowVersion:detail.task.rowVersion})}>{detail.run.state==='cancelling'?'正在核对停止…':'停止当前执行'}</button><span className="muted">停止后任务保留；不会清空你的原生输入。</span></div>}
          <div className="session-box"><h3>执行会话</h3>
            {!detail.binding?<><p className="muted">为这个任务创建专用工作目录和原生会话。准备会话不会调用模型。</p><button disabled={!online||busy||detail.task.status==='needs-input'||detail.task.lifecycle!=='open'} onClick={()=>mutate('session.prepare',{requestId:`prepare:${detail.task.id}:${detail.task.rowVersion}`,id:detail.task.id,expectedRowVersion:detail.task.rowVersion})}>准备执行会话</button></>:<>
              <p className="muted" style={{overflowWrap:'anywhere'}}>{detail.binding.cwd}</p>
              {detail.binding.state==='ready'?<><button onClick={()=>api.openSession(detail.binding!.sessionId!)}>打开任务会话</button> <button className="primary" disabled={!online||busy||detail.task.status!=='unscheduled'} onClick={()=>mutate('task.dispatch',{requestId:`dispatch:${detail.task.id}:${detail.task.rowVersion}`,id:detail.task.id,expectedRowVersion:detail.task.rowVersion})}>开始执行</button><p className="muted" style={{fontSize:12}}>首次执行前，请在任务会话选择模型。会话关联后暂锁定目标，避免执行版本不一致。</p></>:<><p>会话创建需要核对。</p><button disabled={!online||busy} onClick={()=>mutate('session.reconcile',{id:detail.binding!.id})}>核对会话</button></>}
            </>}
            {detail.binding?.state==='ready'&&detail.task.lifecycle==='open'&&<details><summary className="muted">调整执行会话</summary><ConfirmAction key={`detach:${detail.task.id}:${detail.task.rowVersion}`} label="解除会话关联" explanation="任务将暂停，未送出的回答与返工要求失效；原会话和文件保留。之后可以修改目标，再准备全新会话与目录，不会自动读取旧对话。" disabled={!online||busy||['running','queued','stopping','recovery','approval'].includes(detail.task.status)} submit={()=>mutate('session.detach',{requestId:`detach:${detail.task.id}:${detail.task.rowVersion}`,id:detail.task.id,expectedRowVersion:detail.task.rowVersion})}/></details>}
            {detail.bindingHistory.length>0&&<details><summary className="muted">历史执行会话（{detail.bindingHistory.length}）</summary>{detail.bindingHistory.filter(binding=>binding.sessionId).map(binding=><p key={binding.id}><button onClick={()=>api.openSession(binding.sessionId!)}>打开第 {binding.generation} 个会话</button><span className="muted"> · 目标版本 {binding.taskRevision}</span></p>)}</details>}
          </div>
          {detail.task.status==='recovery'&&(!detail.run||detail.run.finishedAt!==null)&&<RecoveryPanel key={detail.task.id} busy={!online||busy} confirm={()=>mutate('run.recover',{requestId:`recover:${detail.task.id}:${detail.task.rowVersion}`,id:detail.task.id,expectedRowVersion:detail.task.rowVersion,acknowledged:true})}/>}
          {detail.input&&<p className="muted">任务输入：{({accepted:'已接收',enqueued:'已投递',entered:'已进入上下文',unknown:'送达状态待核对',discarded:'已撤回'} as Record<string,string>)[detail.input.state]??detail.input.state}</p>}
          {detail.result&&<div className="attention-box"><h3>候选成果</h3><p>{detail.result.summary}</p><p style={{whiteSpace:'pre-wrap'}}>{detail.result.checks}</p><ul>{detail.result.evidence.map(file=><li key={file.path} style={{overflowWrap:'anywhere'}}>{file.path} <span className="muted">（{file.bytes} 字节）</span></li>)}</ul>
            {detail.task.lifecycle==='completed'?<p>{detail.result.humanAcceptedAt?'已由你接受。':'已由 Bot 按授权接受。'}</p>:detail.task.lifecycle==='review'?<><p className="muted">请在任务会话检查文件。接受前会重新核对内容是否改变。</p><button className="primary" disabled={!online||busy||detail.task.lifecycle!=='review'} onClick={()=>mutate('result.accept',{requestId:`accept:${detail.result!.id}:${detail.task.rowVersion}`,id:detail.task.id,expectedRowVersion:detail.task.rowVersion,resultId:detail.result!.id})}>接受此成果并完成任务</button><ReplyForm key={detail.result.id} label="返工要求" busy={!online||busy} submit={(text,requestId)=>mutate('result.reject',{requestId,id:detail.task.id,expectedRowVersion:detail.task.rowVersion,resultId:detail.result!.id,text})}/></>:<p className="muted">这份结果尚不可验收；请查看当前任务状态。</p>}
          </div>}
          <dl><dt>关键事件</dt><dd>{detail.events.map(e=><div className="event" key={e.id}>{time(e.createdAt)} · {eventTitle(e)}</div>)}</dd></dl><div className="muted" style={{fontSize:11}}>目标版本 {detail.task.taskRevision} · 修改 {detail.task.rowVersion}</div>
        </div>}</section></div>
      </>}
    </>}
    <footer className="foot">{status&&<>DSH {status.runtime} · 本地 SQLite / {status.journalMode.toUpperCase()} · </>}关闭面板不删除任务。<button style={{marginLeft:8}} disabled={!online||busy} onClick={()=>mutate<BackupInfo>('backup.create',{requestId:crypto.randomUUID()},setBackupInfo)}>备份账本</button></footer>
  </div></div>;
}
