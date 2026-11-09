/** Super Bot styles. Colours resolve to DSH --dsw-alias-* tokens so the panel follows the host theme;
 * the fallbacks keep the previous palette when a token is missing. */
const tokens = `
.sb{
  --sb-muted:var(--dsw-alias-label-secondary,#7a8581);
  --sb-caption:var(--dsw-alias-label-tertiary,#7a8581);
  --sb-line:var(--dsw-alias-border-l2,#87908d35);
  --sb-soft:var(--dsw-alias-bg-layer-1,#87908d0c);
  --sb-raised:var(--dsw-alias-bg-layer-2,#87908d12);
  --sb-hover:var(--dsw-alias-interactive-bg-hover,#87908d18);
  --sb-accent:var(--dsw-alias-state-business-primary,#328375);
  --sb-link:var(--dsw-alias-link,var(--sb-accent));
  --sb-primary:var(--dsw-alias-button-primary-fill,#328375);
  --sb-primary-hover:var(--dsw-alias-button-primary-hover,#276b5f);
  --sb-on-primary:var(--dsw-alias-label-primary-foreground,#fff);
  --sb-warn:var(--dsw-alias-state-warn-primary,#c68347);
  --sb-error:var(--dsw-alias-state-error-primary,#c46d6d);
  --sb-success:var(--dsw-alias-state-success-primary,#328375);
}`;

const base = `
.sb{height:100%;overflow:auto;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px}
.sb *{box-sizing:border-box}
.sb button,.sb input,.sb textarea,.sb select{font:inherit}
.sb button{cursor:pointer;border:1px solid var(--sb-line);background:transparent;color:inherit;border-radius:8px;padding:8px 13px;
  transition:background .15s}
.sb button:hover:not(:disabled){background:var(--sb-hover)}
.sb button:disabled{opacity:.4;cursor:not-allowed}
.sb button:focus-visible,.sb input:focus,.sb textarea:focus,.sb select:focus{outline:2px solid var(--sb-accent);outline-offset:2px}
.sb button.primary{background:var(--sb-primary);color:var(--sb-on-primary);border-color:var(--sb-primary)}
.sb button.primary:hover:not(:disabled){background:var(--sb-primary-hover)}
.sb button.small{padding:3px 8px;font-size:12px;border-radius:6px}
.sb button.inline{margin-left:8px}
.sb select,.sb input,.sb textarea{border:1px solid var(--sb-line);color:inherit;background:var(--sb-soft);border-radius:8px;
  padding:9px 11px;min-width:0}
.sb textarea{resize:vertical;min-height:80px;line-height:1.7;width:100%}
.sb input{width:100%}
.sb select{min-width:150px}
.sb select option{color:#223831;background:#f6f8f7}
.sb a{color:var(--sb-link)}
.sb code{font-size:12px;padding:1px 5px;border-radius:5px;background:var(--sb-raised);overflow-wrap:anywhere}
.sb .muted{color:var(--sb-muted)}
.sb .hint{font-size:12px}
.sb .caption{font-size:11px;color:var(--sb-caption)}
.sb .wrap{overflow-wrap:anywhere}
.sb .spacer{flex:1}
`;

const layout = `
.sb-wrap{max-width:1240px;margin:auto;padding:30px 34px 50px}
.sb-header{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:26px}
.sb-title{display:flex;align-items:center;gap:12px}
.sb h1{font-size:25px;letter-spacing:-.7px;font-weight:650;margin:0}
.sb h2{font-size:20px;font-weight:620;margin:0 0 7px}
.sb .eyebrow{font-size:11px;letter-spacing:1.8px;text-transform:uppercase;color:var(--sb-muted);margin-bottom:7px}
.sb .connection{display:flex;align-items:center;gap:7px;font-size:12px;white-space:nowrap}
.sb .dot{height:7px;width:7px;border-radius:50%;background:var(--sb-success)}
.sb .dot.offline{background:var(--sb-warn)}
.sb .notice{padding:12px 15px;border:1px solid color-mix(in srgb,var(--sb-warn) 40%,transparent);
  background:color-mix(in srgb,var(--sb-warn) 7%,transparent);border-radius:10px;line-height:1.7;margin-bottom:18px;
  display:flex;justify-content:space-between;align-items:center;gap:15px}
.sb .notice p{margin:4px 0 0}
.sb .error{border-color:color-mix(in srgb,var(--sb-error) 45%,transparent);background:color-mix(in srgb,var(--sb-error) 5%,transparent);
  color:var(--sb-error)}
.sb .toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:18px 0}
.sb .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}
.sb .bot-intro{padding:20px 0;border-top:1px solid var(--sb-line)}
.sb .bot-intro p{overflow-wrap:anywhere;margin:0;color:var(--sb-muted);line-height:1.7;white-space:pre-wrap}
.sb .stats{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}
.sb .stats button.active{border-color:var(--sb-accent);color:var(--sb-accent);background:color-mix(in srgb,var(--sb-accent) 5%,transparent)}
.sb .stats strong{margin-left:12px}
.sb .grid{display:grid;grid-template-columns:minmax(260px,1fr) minmax(300px,.95fr);gap:20px;align-items:start}
`;

const parts = `
.sb .card{border:1px solid var(--sb-line);border-radius:13px;overflow:hidden;background:var(--sb-soft)}
.sb .card-head{padding:15px 18px;border-bottom:1px solid var(--sb-line);display:flex;align-items:center;gap:8px}
.sb .card-body{padding:19px}
.sb .task{border:0;border-radius:0;width:100%;padding:15px 18px;text-align:left;display:block;border-bottom:1px solid var(--sb-line)}
.sb .task:last-child{border-bottom:0}
.sb .task.selected{background:color-mix(in srgb,var(--sb-accent) 6%,transparent);box-shadow:inset 3px 0 var(--sb-accent)}
.sb .task-top{display:flex;align-items:start;justify-content:space-between;gap:12px}
.sb .task-goal{font-weight:550;line-height:1.6;overflow-wrap:anywhere;min-width:0;flex:1;display:-webkit-box;
  -webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.sb .task-meta{display:flex;gap:12px;font-size:11px;color:var(--sb-muted);margin-top:9px}
.sb .task-top .badge{flex-shrink:0}
.sb .badge{padding:3px 7px;border-radius:5px;background:var(--sb-raised);color:var(--sb-muted);font-size:11px;white-space:nowrap;
  display:inline-block}
.sb .badge.attention{color:var(--sb-warn);background:color-mix(in srgb,var(--sb-warn) 9%,transparent)}
.sb .badge.success{color:var(--sb-success);background:color-mix(in srgb,var(--sb-success) 9%,transparent)}
.sb .badge.danger{color:var(--sb-error);background:color-mix(in srgb,var(--sb-error) 9%,transparent)}
.sb .badge.info{color:var(--sb-accent);background:color-mix(in srgb,var(--sb-accent) 9%,transparent)}
.sb .empty{padding:45px 24px;text-align:center}
.sb .empty p{color:var(--sb-muted);line-height:1.8;margin:10px auto 20px;max-width:400px}
.sb .welcome{max-width:620px;margin:60px auto;border:1px solid var(--sb-line);border-radius:16px;padding:40px}
.sb .welcome h2{font-size:25px}
.sb .welcome p{line-height:1.8}
.sb .welcome ul{padding-left:18px;color:var(--sb-muted);line-height:2}
.sb .form{padding:22px;border:1px solid var(--sb-line);border-radius:13px;margin-bottom:22px;background:var(--sb-soft)}
.sb .form label{display:block;font-size:12px;color:var(--sb-muted);margin:14px 0 7px}
.sb .form label.check{display:flex;align-items:center;gap:8px}
.sb .check input{width:auto}
.sb .detail-goal{font-size:18px;line-height:1.6;overflow-wrap:anywhere;margin:0 0 14px}
.sb dl{margin:20px 0}
.sb dt{font-size:11px;color:var(--sb-muted);margin-top:17px;margin-bottom:6px}
.sb dd{margin:0;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
.sb .attention-box{border-left:3px solid var(--sb-warn);background:color-mix(in srgb,var(--sb-warn) 6%,transparent);padding:11px 13px;
  line-height:1.7;margin:12px 0}
.sb .attention-box.result{border-left-color:var(--sb-accent);background:color-mix(in srgb,var(--sb-accent) 5%,transparent)}
.sb .sb-section{margin:16px 0;padding:12px 14px;border:1px solid var(--sb-line);border-radius:10px;background:var(--sb-raised)}
.sb .sb-section>header{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.sb .sb-section h3{margin:0;font-size:13px;font-weight:600}
.sb .sb-section p{margin:6px 0;line-height:1.7}
.sb .path{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sb .pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;font-size:12px;
  color:var(--sb-muted)}
.sb .foot{margin-top:24px;font-size:11px;color:var(--sb-muted);line-height:1.8}
.sb .event{font-size:12px;line-height:1.8;color:var(--sb-muted)}
.sb .clamp{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;overflow-wrap:anywhere}
.sb .full-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8}
.sb details>summary{cursor:pointer;line-height:1.8;overflow-wrap:anywhere}
.sb .advanced{margin:12px 0;padding:8px 0;border-top:1px solid var(--sb-line)}
.sb .work-group h3{margin:0;padding:10px 18px;font-size:12px;border-bottom:1px solid var(--sb-line);background:var(--sb-soft)}
.sb .work-group h3 .muted{font-weight:400}
.sb .back-chat{margin-bottom:12px}
.sb .sb-header>div,.sb .card-body,.sb .attention-box{min-width:0;overflow-wrap:anywhere}
.sb .pagination,.sb .task-meta{flex-wrap:wrap}
.sb .bot-row{display:flex;gap:12px;align-items:center;border-bottom:1px solid var(--sb-line);padding:18px 0}
.sb .bot-open{flex:1;text-align:left;padding:18px}
.sb .bot-open strong{font-size:18px}
.sb .bot-open .muted{margin-top:8px}
`;

const compact = `
.sb-compact .sb-wrap{padding:16px 12px 28px}
.sb-compact .sb-header{display:block;margin-bottom:14px}
.sb-compact h1{font-size:19px;overflow-wrap:anywhere}
.sb-compact .connection{margin-top:8px;flex-wrap:wrap;white-space:normal}
.sb-compact .grid.has-selection .task-list,.sb-compact .grid:not(.has-selection) .task-detail{display:none}
.sb-compact .grid{grid-template-columns:minmax(0,1fr);gap:14px}
.sb-compact .stats{gap:5px}
.sb-compact .stats button{padding:6px 8px;font-size:12px}
.sb-compact .stats strong{margin-left:5px}
.sb-compact .task-top{display:block}
.sb-compact .task-top .badge{margin-top:6px}
.sb-compact .form{padding:12px}
.sb-compact .card-body{padding:14px}
.sb-compact .notice{display:block}
.sb-compact button{max-width:100%;white-space:normal;overflow-wrap:anywhere}
@media(max-width:900px){
  .sb-wrap{padding:22px 18px}
  .sb .grid{grid-template-columns:1fr}
  .sb .welcome{margin:25px auto;padding:25px}
  .sb-header{align-items:flex-start}
  .sb .connection{font-size:11px}
}
`;

export const styles = tokens + base + layout + parts + compact;
