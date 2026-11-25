/** The current result: summary, evidence, and accept or rework controls. */
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { deliveryArtifactUrl, orderedDeliveryLinks } from '../../delivery-artifacts.ts';
import type { ReloadReceipt, Result, Task } from '../../model.ts';
import { resultFileUrl } from '../../work-links.ts';
import { canReviewResult, resultHeading, time } from './format.ts';
import { ReplyForm } from './forms.tsx';
import type { Detail, VisibleResult } from './types.ts';
import type { WorkspaceState } from './useWorkspace.ts';
import { ResultDeliveryCheck } from './SystemIssues.tsx';
import { ResultFilePreview } from './ResultFilePreview.tsx';
import { WorkMarkdown } from './WorkMarkdown.tsx';

function Review({ w, task, result }: { w: WorkspaceState; task: Task; result: Result }) {
  const accept = () => w.mutate('result.accept', {
    requestId: `accept:${result.id}:${task.rowVersion}`, id: task.id, expectedRowVersion: task.rowVersion, resultId: result.id,
  });
  const reject = (text: string, requestId: string) => w.mutate('result.reject', {
    requestId, id: task.id, expectedRowVersion: task.rowVersion, resultId: result.id, text,
  });
  return <>
    <p className="muted">
      接受前会重新核对文件是否改变。{task.controlMode === 'paused' && '当前暂停的是自动管理，你仍可检查并接受成果。'}
    </p>
    <div className="actions result-actions">
      {canReviewResult(task) && <button className="primary" disabled={w.locked} onClick={accept}>接受成果</button>}
      <details className="rework"><summary>要求返工</summary>
        <ReplyForm key={result.id} label="返工要求" busy={w.locked} submit={reject}/>
      </details>
    </div>
  </>;
}

function DeliveryDescription({ text, omitLinks }: { text: string; omitLinks: string[] }) {
  const id = useId(), viewport = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false), [expanded, setExpanded] = useState(false);
  const clipped = overflowing && !expanded;
  useLayoutEffect(() => {
    const element = viewport.current!, content = element.firstElementChild!;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      setOverflowing(content.getBoundingClientRect().height > 3 * lineHeight + 0.5);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [text]);
  return <>
    <div id={id} ref={viewport} className="delivery-description" data-clipped={clipped || undefined} onFocus={event => {
      if (clipped && event.target.getBoundingClientRect().bottom > event.currentTarget.getBoundingClientRect().bottom) {
        setExpanded(true);
      }
    }}><WorkMarkdown text={text} omitLinks={omitLinks}/></div>
    {overflowing && <button type="button" className="small delivery-toggle" aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded(!expanded)}>{expanded ? '收起交付说明' : '展开交付说明'}</button>}
  </>;
}

type ResultSummaryFields = Pick<VisibleResult, 'id' | 'summary' | 'deliveryText' | 'links'>;
export function ResultSummary({ result }: { result: ResultSummaryFields }) {
  const urls = Object.values(result.links ?? {});
  if (result.deliveryText !== undefined) return <DeliveryDescription key={result.id} text={result.deliveryText} omitLinks={urls}/>;
  if (!urls.length) return <p className="clamp prose-preview">{result.summary}</p>;
  return <div className="clamp prose-preview"><WorkMarkdown text={result.summary} omitLinks={urls}/></div>;
}

export function ResultLinks({ links, primaryLink }: { links?: VisibleResult['links']; primaryLink?: string }) {
  const entries = orderedDeliveryLinks(links ?? {}, primaryLink).filter(([, url]) => deliveryArtifactUrl(url));
  if (!entries.length) return null;
  return <div className="delivery-links" role="group" aria-label="交付物">
    <strong>交付物</strong>
    <ul role="list">{entries.map(([name, url]) => <li key={name}>
      <a href={url} target="_blank" rel="noopener noreferrer">{name}<span aria-hidden> ↗</span></a>
    </li>)}</ul>
  </div>;
}

export function ResultReport({ summary, checks }: { summary: string; checks?: string }) {
  return <details className="prose-details"><summary>完整 Worker 报告</summary>
    <WorkMarkdown text={summary}/>
    {checks && <><p className="muted">Worker 自述的检查与未验证项</p><WorkMarkdown text={checks}/></>}
  </details>;
}

export function ResultLoadReceipt({ host, resultId, receipt }: {
  host: string; resultId: string; receipt?: Pick<ReloadReceipt, 'at' | 'build'> & Partial<ReloadReceipt>;
}) {
  return <details>
    <summary>{host} · {receipt ? `原生回执已确认插件热载 · ${time(receipt.at)}` : '暂无匹配的原生热载回执'}</summary>
    <p className="wrap">成果 ID {resultId}</p>
    {receipt && <p className="wrap">构建 {receipt.build}</p>}
    {receipt?.from && <p className="wrap">宿主 PID {receipt.pid} · 实例 {receipt.from} → {receipt.to}</p>}
  </details>;
}

export function ResultFiles({ result, sessionId }: { result: Result; sessionId?: string }) {
  const [preview, setPreview] = useState<string>();
  return <ul>{result.evidence.map((file, index) => {
    const href = resultFileUrl(result.id, index, sessionId), expanded = preview === href;
    return <li key={file.path} className="wrap">
      <button type="button" className="small" aria-expanded={expanded} onClick={() => setPreview(expanded ? undefined : href)}>
        {file.path.split('/').pop()}
      </button>{' '}
      <span className="muted">（{file.bytes} 字节）</span> <a href={href}>下载</a>
      {expanded && <ResultFilePreview key={href} href={href}/>}
      <details><summary>文件路径</summary>{file.path}</details>
    </li>;
  })}</ul>;
}

export function ResultCard({ w, detail, onReturn, view = 'delivery' }: {
  w: WorkspaceState; detail: Detail; onReturn?: () => void; view?: 'delivery' | 'exact' | 'pending-review';
}) {
  const { task, deliveredResult } = detail;
  const pending = view === 'pending-review';
  const result: VisibleResult | null | undefined = view === 'exact' ? detail.linkedResult
    : pending ? detail.result : deliveredResult ?? detail.result;
  if (!result || (pending && task.lifecycle !== 'review')) return null;
  const current = detail.result?.id === result.id;
  const reworking = deliveredResult?.id === result.id && task.lifecycle !== 'cancelled'
    && (!current || task.lifecycle === 'open');
  const reviewing = current && !reworking && task.lifecycle === 'review';
  const receipt = detail.progress?.reload;
  const matchingReceipt = receipt?.resultId === result.id ? receipt : undefined;
  const content = <>
    <ResultSummary result={result}/>
    <ResultLinks links={result.links} primaryLink={result.primaryLink}/>
    <ResultFiles result={result} sessionId={w.sessionId}/>
    {reviewing && result.checks && <div className="result-checks">
      <strong>Worker 自述的检查与未验证项</strong>
      <WorkMarkdown text={result.checks}/>
    </div>}
    {reviewing && !detail.closeRequest && <Review w={w} task={task} result={result}/>}
    {current && !reworking && <ResultDeliveryCheck w={w} result={result}
      status={view === 'exact' ? detail.linkedChatDelivery ?? detail.chatDelivery : detail.chatDelivery} onReturn={onReturn}/>}
    <ResultReport summary={result.summary} checks={reviewing ? undefined : result.checks}/>
    {(matchingReceipt || current && detail.reloadEligible)
      && <ResultLoadReceipt host="本端宿主" resultId={result.id} receipt={matchingReceipt}/>}
    {current && !reworking && !reviewing && (task.lifecycle === 'completed'
      ? <p>{result.humanAcceptedAt ? '已由你接受。' : '已由 Bot 按授权接受。'}</p>
      : <p className="muted">这份结果尚不可验收，请查看当前任务状态。</p>)}
  </>;
  if (pending) return <details className="advanced"><summary>新成果待验收</summary>{content}</details>;
  return <div className="attention-box result">
    <h3>{reworking ? '交付 · 返工中' : resultHeading(task)}</h3>
    {content}
  </div>;
}
