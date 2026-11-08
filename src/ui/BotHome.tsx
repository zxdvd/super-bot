import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Bot } from '../model.ts';
import { Workspace, type WorkspaceApi } from './Workspace.tsx';
import { styles } from './styles.ts';
import { readTaskLink } from './work-navigation.ts';

/** Native DSH owns the conversation, composer, model choice and history. */
export function BotHome({api}:{api:WorkspaceApi}) {
  const [bots,setBots]=useState<Bot[]>([]),[loading,setLoading]=useState(true);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[work,setWork]=useState<{botId:string;taskId?:string}|null>(null);
  const [creating,setCreating]=useState(false),[name,setName]=useState(''),[instructions,setInstructions]=useState('');
  const request=useRef(crypto.randomUUID()),alive=useRef(true),locked=useRef(false);
  useEffect(()=>{alive.current=true;const controller=new AbortController();
    api.call<Bot[]>('bot.list',{},controller.signal).then(value=>{if(!controller.signal.aborted)setBots(value);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>{alive.current=false;controller.abort();};
  },[api,work===null]);
  useEffect(()=>{
    let controller:AbortController|undefined;
    const navigate=()=>{
      controller?.abort();controller=new AbortController();const signal=controller.signal;
      const taskId=location.hash.match(/^#super-bot-task=([a-f0-9-]{36})$/)?.[1];if(!taskId)return;
      const navigation=api.beginNavigation();
      readTaskLink(api,taskId,signal,navigation).then(task=>{if(task)setWork({botId:task.botId,taskId:task.id});}).catch(e=>{if(!signal.aborted&&!navigation.aborted)setError(e.message);});
    };
    navigate();window.addEventListener('hashchange',navigate);return()=>{controller?.abort();window.removeEventListener('hashchange',navigate);};
  },[api]);
  async function chat(bot:Bot) {
    if(locked.current)return;locked.current=true;setBusy(true);setError('');
    try{await api.openBot(bot.id);}catch(e){if(alive.current)setError(e instanceof Error?e.message:'暂时无法打开对话，请重试。');}
    finally{locked.current=false;if(alive.current)setBusy(false);}
  }
  async function create(event:FormEvent) {
    event.preventDefault();if(locked.current||!name.trim())return;locked.current=true;setBusy(true);setError('');
    const navigation=api.beginNavigation();
    try {
      const bot=await api.call<Bot>('bot.create',{requestId:request.current,name:name.trim(),instructions:instructions.trim()||'你是我的长期助手。自然地与我交流，理解我的目标，必要时澄清，主动安排已授权的工作，并回来交付结果。'});
      // Keep the saved Bot visible even if opening its conversation fails.
      if(alive.current){setBots(current=>[...current.filter(item=>item.id!==bot.id),bot]);setCreating(false);setName('');setInstructions('');request.current=crypto.randomUUID();}
      await api.openBot(bot.id,navigation);
    }catch(e){if(alive.current)setError(e instanceof Error?e.message:'暂时无法创建，请重试。');}
    finally{locked.current=false;if(alive.current)setBusy(false);}
  }
  if(work!==null)return <div style={{height:'100%',display:'flex',flexDirection:'column'}}><div className="sb" style={{height:'auto',flexShrink:0,padding:12}}><style>{styles}</style><button onClick={()=>{api.beginNavigation();history.replaceState(null,'',location.pathname+location.search);window.dispatchEvent(new Event('hashchange'));setWork(null);}}>← 我的 Bot</button> <button onClick={()=>void api.openBot(work.botId).catch(e=>setError(e.message))}>返回这个 Bot 聊天 →</button>{error&&<p role="alert">{error}</p>}</div><div style={{flex:1,minHeight:0}}><Workspace api={api} key={work.taskId??work.botId} initialBotId={work.botId} initialTaskId={work.taskId}/></div></div>;
  return <div className="sb"><style>{styles}</style><main className="sb-wrap" style={{maxWidth:820}}>
    <header className="sb-header"><div><div className="eyebrow">Super Bot</div><h1>你想一起做点什么？</h1><p className="muted">和 Bot 聊聊，把事情交给它，完成后它会回来告诉你。</p></div>{bots.length>0&&<button disabled={busy} onClick={()=>setCreating(true)}>新建 Bot</button>}</header>
    {error&&<p role="alert" className="notice error">{error}</p>}
    {loading?<p className="muted">正在读取你的 Bot…</p>:<>
      {bots.map(bot=><article key={bot.id} style={{display:'flex',gap:12,alignItems:'center',borderBottom:'1px solid var(--sb-line)',padding:'18px 0'}}>
        <button disabled={busy} style={{flex:1,textAlign:'left',padding:18}} onClick={()=>void chat(bot)}><strong style={{fontSize:18}}>{bot.name}</strong><div className="muted" style={{marginTop:8}}>继续聊天 →</div></button>
        <button disabled={busy} onClick={()=>{api.beginNavigation();setWork({botId:bot.id});}}>工作与设置</button>
      </article>)}
      {(creating||bots.length===0)&&<form className="form" onSubmit={create} style={{marginTop:28}}><h2>{bots.length?'新建 Bot':'创建你的第一个 Bot'}</h2>
        <label htmlFor="sb-home-name">给它起个名字</label><input id="sb-home-name" autoFocus required maxLength={80} disabled={busy} value={name} placeholder="例如：小帮手" onChange={e=>{setName(e.target.value);request.current=crypto.randomUUID();}}/>
        <label htmlFor="sb-home-role">希望它怎么帮你？（可选）</label><textarea id="sb-home-role" maxLength={10000} disabled={busy} value={instructions} placeholder="也可以在聊天时慢慢告诉它" onChange={e=>{setInstructions(e.target.value);request.current=crypto.randomUUID();}}/>
        <div className="actions"><button className="primary" disabled={busy||!name.trim()}>{busy?'正在打开…':'创建并聊天'}</button>{bots.length>0&&<button type="button" disabled={busy} onClick={()=>setCreating(false)}>取消</button>}</div>
      </form>}
      {busy&&<p role="status" className="muted">正在打开对话…</p>}
    </>}
  </main></div>;
}
