import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Attention, Bot, NewTask, Task, TaskPage, WorkspaceStatus } from '../model.ts';
import { styles } from './styles.ts';

export interface WorkspaceApi {
  call<T>(action: string, payload?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  openSession(id: string): void;
}
type Detail = { task: Task; attentions: Attention[]; events: { id: number; kind: string; createdAt: number }[] };
const labels: Record<Task['status'],string> = { unscheduled:'待安排', 'needs-input':'等你补充', paused:'已暂停', manual:'人工接管', completed:'已完成', cancelled:'已取消', review:'待验收' };
const eventLabels: Record<string,string> = { 'task.created':'创建任务', 'task.revised':'更新目标与验收条件', 'task.control':'更新管理方式' };
const time = (value:number) => new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});

function BotForm({ submit, cancel, busy }: { submit:(data:Record<string,unknown>)=>Promise<boolean>; cancel:()=>void; busy:boolean }) {
  const [name,setName]=useState(''); const [instructions,setInstructions]=useState('');
  const request=useRef(crypto.randomUUID());
  const [validation,setValidation]=useState('');
  function changed(){request.current=crypto.randomUUID();setValidation('');}
  async function save(e:FormEvent){e.preventDefault();if(!name.trim()||!instructions.trim()){setValidation('请填写名称和职责，不能只填空格。');return;}await submit({requestId:request.current,name,instructions});}
  return <form className="form" onSubmit={save}><h2>创建你的 Bot</h2><p className="muted">给它一项清楚、长期的职责。</p>
    <label htmlFor="sb-bot-name">名称</label><input id="sb-bot-name" autoFocus required maxLength={80} placeholder="例如：开发 Bot" value={name} onChange={e=>{changed();setName(e.target.value);}}/>
    <label htmlFor="sb-bot-instructions">职责与边界</label><textarea id="sb-bot-instructions" required maxLength={10000} placeholder="负责哪些工作，什么事情需要先问你？" value={instructions} onChange={e=>{changed();setInstructions(e.target.value);}}/>
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
    <label htmlFor="sb-task-goal">要完成什么</label><textarea id="sb-task-goal" autoFocus required maxLength={10000} value={goal} onChange={e=>{changed();setGoal(e.target.value);}} placeholder="描述一个可以独立验收的目标"/>
    <label htmlFor="sb-task-scope">范围与限制</label><textarea id="sb-task-scope" maxLength={10000} value={scope} onChange={e=>{changed();setScope(e.target.value);}} placeholder="允许修改什么？哪些内容需要保留？"/>
    <label htmlFor="sb-task-acceptance">怎样算完成</label><textarea id="sb-task-acceptance" maxLength={10000} value={acceptance} onChange={e=>{changed();setAcceptance(e.target.value);}} placeholder="期望看到的成果和验证结果"/>
    <p className="muted" style={{fontSize:12}}>范围或验收条件可以稍后补充；补全前任务不会派发。</p>
    {!task&&<label className="check"><input type="checkbox" checked={autoReview} onChange={e=>{changed();setAutoReview(e.target.checked);}}/>允许 Bot 最终验收这个低风险任务</label>}
    {validation&&<p className="notice error" role="alert">{validation}</p>}
    <div className="actions"><button className="primary" disabled={busy}>{busy?'保存中…':task?'保存修改':'创建任务'}</button><button type="button" disabled={busy} onClick={cancel}>取消</button></div>
  </form>;
}

export function Workspace({ api }: { api:WorkspaceApi }) {
  const [status,setStatus]=useState<WorkspaceStatus>(); const [bots,setBots]=useState<Bot[]>([]);
  const [botId,setBotId]=useState(''); const [page,setPage]=useState<TaskPage>(); const [selected,setSelected]=useState('');
  const [detail,setDetail]=useState<Detail>(); const [query,setQuery]=useState(''); const [filter,setFilter]=useState(''); const [offset,setOffset]=useState(0);
  const [online,setOnline]=useState(false);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const [form,setForm]=useState<'bot'|'task'|'edit'|null>(null); const [refresh,setRefresh]=useState(0); const [synced,setSynced]=useState(0);
  useEffect(()=>{
    const controller=new AbortController(); let timer:ReturnType<typeof setTimeout>; let failures=0;
    async function pull(){
      if(document.visibilityState==='hidden'){timer=setTimeout(pull,5000);return;}
      try {
        const [s, b, p, d]=await Promise.all([
          api.call<WorkspaceStatus>('status',{},controller.signal), api.call<Bot[]>('bot.list',{},controller.signal),
          botId?api.call<TaskPage>('task.list',{botId,q:query,lifecycle:filter,offset,limit:25},controller.signal):undefined,
          selected?api.call<Detail>('task.detail',{id:selected},controller.signal):undefined,
        ]);
        if(controller.signal.aborted)return;
        setStatus(s);setBots(b);setPage(p);setDetail(d);setOnline(true);setLoading(false);setSynced(Date.now());failures=0;
        if(!botId&&b.length)setBotId(b[0].id);
      } catch(e){if(controller.signal.aborted)return;setOnline(false);setLoading(false);setError(e instanceof Error?e.message:'无法连接宿主。');failures++;}
      timer=setTimeout(pull,Math.min(30000,5000*2**failures));
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
  function pickBot(id:string){setBotId(id);setPage(undefined);setSelected('');setDetail(undefined);setOffset(0);setFilter('');setQuery('');setForm(null);}
  return <div className="sb"><style>{styles}</style><div className="sb-wrap">
    <header className="sb-header"><div><div className="eyebrow">BOT WORKSPACE</div><h1>Super Bot</h1></div><div className="connection"><span className={`dot ${online?'':'offline'}`}/>{loading?'连接中…':online?'宿主在线':'宿主离线'}{synced>0&&<span className="muted">· {time(synced)}</span>}</div></header>
    {error&&<div className="notice error" role="alert"><span>{error}</span><button onClick={()=>{setError('');setRefresh(n=>n+1);}}>刷新状态</button></div>}
    {!online&&!loading&&<div className="notice">当前显示上次同步的快照。重新连接前，操作暂不可用。</div>}
    {loading?<div className="empty">正在读取工作台…</div>:<>
      {bots.length>0&&<div className="toolbar"><select aria-label="选择 Bot" value={botId} onChange={e=>pickBot(e.target.value)}>{bots.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select><button disabled={!online||busy} onClick={()=>setForm(form==='bot'?null:'bot')}>＋ 新 Bot</button><span className="spacer"/><button className="primary" disabled={!online||busy||!bot} onClick={()=>setForm(form==='task'?null:'task')}>＋ 新任务</button></div>}
      {form==='bot'&&<BotForm busy={busy||!online} cancel={()=>{setForm(null);setError('');}} submit={data=>mutate<Bot>('bot.create',data,b=>{pickBot(b.id);setForm(null);})}/>}
      {bots.length===0&&form!=='bot'&&<div className="welcome"><h2>先认识你的第一位 Bot</h2><p className="muted" style={{lineHeight:1.8}}>定义长期职责，再把具体目标交给它。任务与成果会保存在这里。</p><ul><li>不同 Bot，各自负责自己的工作</li><li>任务有明确目标、范围和验收条件</li><li>需要你回答或验收时，集中呈现</li></ul><button className="primary" disabled={!online} onClick={()=>setForm('bot')}>创建第一个 Bot</button></div>}
      {bot&&<>
        <div className="bot-intro"><h2>{bot.name}</h2><p>{bot.instructions}</p></div>
        <div className="notice"><span>任务账本已可用。自动执行正在接入，当前创建的任务会保存为待安排。</span></div>
        {(form==='task'||(form==='edit'&&detail))&&<TaskForm key={form==='edit'?detail!.task.id:'new'} task={form==='edit'?detail!.task:undefined} busy={busy||!online} cancel={()=>{setForm(null);setError('');}} submit={data=>mutate<Task>(form==='edit'?'task.revise':'task.create',form==='edit'?{...data,id:detail!.task.id,expectedRowVersion:detail!.task.rowVersion}:{...data,botId},t=>{setSelected(t.id);setForm(null);setOffset(0);setFilter('');setQuery('');})}/>}
        <div className="stats">{([['','全部','all'],['open','未完成','open'],['review','待验收','review'],['completed','已完成','completed'],['cancelled','已取消','cancelled']] as const).map(([value,label,key])=><button key={key} className={filter===value?'active':''} onClick={()=>{setFilter(value);setOffset(0);setSelected('');setDetail(undefined);setForm(null);}}>{label}<strong>{page?.counts[key]??'—'}</strong></button>)}</div>
        <div className="grid"><section className="card" aria-label="任务列表"><div className="card-head"><input aria-label="搜索任务" placeholder="搜索任务目标…" value={query} onChange={e=>{setQuery(e.target.value);setOffset(0);setSelected('');setDetail(undefined);setForm(null);}}/></div>
          {!page?<div className="empty">读取任务…</div>:page.items.length===0?<div className="empty"><h2>{query||filter?'没有匹配的任务':'还没有任务'}</h2><p>{query||filter?'调整关键词或状态筛选。':'把一个具体目标放进来，先写清怎样算完成。'}</p>{!query&&!filter&&<button disabled={!online} onClick={()=>setForm('task')}>新建任务</button>}</div>:page.items.map(t=><button key={t.id} className={`task ${selected===t.id?'selected':''}`} aria-pressed={selected===t.id} onClick={()=>{setSelected(t.id);setForm(null);}}><div className="task-top"><span className="task-goal">{t.goal}</span><span className={`badge ${t.status==='needs-input'?'attention':''}`}>{labels[t.status]}</span></div><div className="task-meta"><span>{t.reviewPolicy==='human'?'由你最终验收':'Bot 可最终验收'}</span><span>{time(t.updatedAt)}</span></div></button>)}
          {page&&<footer className="pagination"><span>{page.total} 项任务</span><div><button disabled={offset===0} onClick={()=>{setOffset(Math.max(0,offset-25));setSelected('');setDetail(undefined);}}>上一页</button> <button disabled={offset+25>=page.total} onClick={()=>{setOffset(offset+25);setSelected('');setDetail(undefined);}}>下一页</button></div></footer>}
        </section>
        <section className="card" aria-label="任务详情">{!detail?<div className="empty"><h2>任务的来龙去脉</h2><p>选择任务，查看范围、验收条件、待办和关键事件。</p></div>:<div className="card-body"><p className="detail-goal">{detail.task.goal}</p><span className={`badge ${detail.task.status==='needs-input'?'attention':''}`}>{labels[detail.task.status]}</span>
          {detail.attentions.filter(a=>a.state==='open').map(a=><div className="attention-box" key={a.id}><strong>需要你补充</strong><br/>{a.question}</div>)}
          <dl><dt>任务范围</dt><dd>{detail.task.scope||'尚未填写'}</dd><dt>验收条件</dt><dd>{detail.task.acceptance||'尚未填写'}</dd><dt>最终验收</dt><dd>{detail.task.reviewPolicy==='human'?'由你确认':'已授权 Bot 验收'}</dd></dl>
          <div className="actions"><button disabled={!online||busy} onClick={()=>setForm('edit')}>修改任务</button><button disabled={!online||busy} onClick={()=>mutate('task.control',{requestId:crypto.randomUUID(),id:detail.task.id,expectedRowVersion:detail.task.rowVersion,mode:detail.task.controlMode==='auto'?'paused':'auto'})}>{detail.task.controlMode==='auto'?'暂停自动管理':'恢复自动管理'}</button></div>
          <dl><dt>关键事件</dt><dd>{detail.events.map(e=><div className="event" key={e.id}>{time(e.createdAt)} · {eventLabels[e.kind]??e.kind}</div>)}</dd></dl><div className="muted" style={{fontSize:11}}>目标版本 {detail.task.taskRevision} · 修改 {detail.task.rowVersion}</div>
        </div>}</section></div>
      </>}
    </>}
    <footer className="foot">{status&&<>DSH {status.runtime} · 本地 SQLite / {status.journalMode.toUpperCase()} · </>}关闭面板不删除任务。<button style={{padding:'2px 6px',fontSize:11,marginLeft:8}} disabled={!online||busy} onClick={()=>mutate<{sessionId:string}>('create-probe-session',{},v=>api.openSession(v.sessionId))}>验证原生会话入口</button></footer>
  </div></div>;
}
