/** The current result: summary, evidence, and accept or rework controls. */
import { useState } from 'react';
import { deliveryArtifactUrl } from '../../delivery-artifacts.ts';
import type { ReloadReceipt, Result } from '../../model.ts';
import { resultFileUrl } from '../../work-links.ts';
import { canReviewResult, resultHeading, time } from './format.ts';
import { ReplyForm } from './forms.tsx';
import type { Detail, VisibleResult } from './types.ts';
import type { WorkspaceState } from './useWorkspace.ts';
import { ResultDeliveryCheck } from './SystemIssues.tsx';
import { ResultFilePreview } from './ResultFilePreview.tsx';
import { WorkMarkdown } from './WorkMarkdown.tsx';

function Review({ w, detail }: { w: WorkspaceState; detail: Detail }) {
  const { task } = detail, result = detail.result!;
  const reject = (text: string, requestId: string) => w.mutate('result.reject', {
    requestId, id: task.id, expectedRowVersion: task.rowVersion, resultId: result.id, text,
  });
  return <>
    <p className="muted">
      接受前会重新核对文件是否改变。{task.controlMode === 'paused' && '当前暂停的是自动管理，你仍可检查并接受成果。'}
    </p>
    <details className="rework"><summary>要求返工</summary>
      <ReplyForm key={result.id} label="返工要求" busy={w.locked} submit={reject}/>
    </details>
  </>;
}

export function AcceptResult({ w, detail }: { w: WorkspaceState; detail: Detail }) {
  const { task, result } = detail;
  if (!result || !canReviewResult(task)) return null;
  return <button className="primary" disabled={w.locked} onClick={() => w.mutate('result.accept', {
    requestId: `accept:${result.id}:${task.rowVersion}`, id: task.id, expectedRowVersion: task.rowVersion, resultId: result.id,
  })}>接受成果</button>;
}

export function PendingResultReview({ w, detail, onReturn }: { w: WorkspaceState; detail: Detail; onReturn?: () => void }) {
  const { result, task } = detail;
  if (!result || task.lifecycle !== 'review') return null;
  return <details className="advanced">
    <summary>新成果待验收</summary>
    <ResultDeliveryCheck w={w} result={result} status={detail.chatDelivery} onReturn={onReturn}/>
    <ResultReport summary={result.summary} checks={result.checks}/>
    <ResultFiles result={result} sessionId={w.sessionId}/>
    {canReviewResult(task) && <div className="actions"><AcceptResult w={w} detail={detail}/></div>}
    <Review w={w} detail={detail}/>
  </details>;
}

type ResultSummaryFields = Pick<VisibleResult, 'summary' | 'deliveryText' | 'links'>;
export function ResultSummary({ result }: { result: ResultSummaryFields }) {
  const text = result.deliveryText ?? result.summary;
  const className = result.deliveryText ? 'clamp' : 'clamp prose-preview';
  const urls = Object.values(result.links ?? {});
  if (!urls.length && result.deliveryText === undefined) return <p className={className}>{text}</p>;
  return <div className={className}><WorkMarkdown text={text} omitLinks={urls}/></div>;
}

export function ResultLinks({ links }: { links?: VisibleResult['links'] }) {
  const entries = Object.entries(links ?? {}).filter(([, url]) => deliveryArtifactUrl(url));
  if (!entries.length) return null;
  return <div className="delivery-links" role="group" aria-label="交付物">
    <strong>交付物</strong>
    <ul role="list">{entries.map(([name, url]) => <li key={name}>
      <a href={url} target="_blank" rel="noopener noreferrer">{name}<span aria-hidden> ↗</span></a>
    </li>)}</ul>
  </div>;
}

export function ResultReport({ summary, checks }: { summary: string; checks: string }) {
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

export function ResultCard({ w, detail, onReturn, exact = false }: {
  w: WorkspaceState; detail: Detail; onReturn?: () => void; exact?: boolean;
}) {
  const { task, deliveredResult } = detail;
  const result: VisibleResult | null | undefined = exact ? detail.linkedResult : deliveredResult ?? detail.result;
  if (!result) return null;
  const current = detail.result?.id === result.id;
  const reworking = deliveredResult?.id === result.id && task.lifecycle !== 'cancelled'
    && (!current || task.lifecycle === 'open');
  const receipt = detail.progress?.reload;
  const matchingReceipt = receipt?.resultId === result.id ? receipt : undefined;
  return <div className="attention-box result">
    <h3>{reworking ? '交付 · 返工中' : resultHeading(task)}</h3>
    <ResultSummary result={result}/>
    <ResultLinks links={result.links}/>
    {current && !reworking && <ResultDeliveryCheck w={w} result={result}
      status={exact ? detail.linkedChatDelivery ?? detail.chatDelivery : detail.chatDelivery} onReturn={onReturn}/>}
    <ResultReport summary={result.summary} checks={result.checks}/>
    <ResultFiles result={result} sessionId={w.sessionId}/>
    {(matchingReceipt || current && detail.reloadEligible)
      && <ResultLoadReceipt host="本端宿主" resultId={result.id} receipt={matchingReceipt}/>}
    {current && !reworking && (task.lifecycle === 'completed'
      ? <p>{result.humanAcceptedAt ? '已由你接受。' : '已由 Bot 按授权接受。'}</p>
      : task.lifecycle === 'review' ? <Review w={w} detail={detail}/>
        : <p className="muted">这份结果尚不可验收，请查看当前任务状态。</p>)}
  </div>;
}
