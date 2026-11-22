/** The current result: summary, evidence downloads, and accept or rework controls. */
import type { ReloadReceipt, Result } from '../../model.ts';
import { resultFileUrl } from '../../work-links.ts';
import { resultHeading, time } from './format.ts';
import { ReplyForm } from './forms.tsx';
import type { Detail } from './types.ts';
import type { WorkspaceState } from './useWorkspace.ts';
import { ResultDeliveryCheck } from './SystemIssues.tsx';

function Review({ w, detail }: { w: WorkspaceState; detail: Detail }) {
  const { task } = detail, result = detail.result!;
  const reject = (text: string, requestId: string) => w.mutate('result.reject', {
    requestId, id: task.id, expectedRowVersion: task.rowVersion, resultId: result.id, text,
  });
  return <>
    <p className="muted">
      检查文件后点上方“接受成果”；接受前会重新核对内容是否改变。{task.controlMode === 'paused' && '当前暂停的是自动管理，你仍可检查并接受成果。'}
    </p>
    <details className="rework"><summary>要求返工</summary>
      <ReplyForm key={result.id} label="返工要求" busy={w.locked} submit={reject}/>
    </details>
  </>;
}

export function ResultReport({ summary, checks }: { summary: string; checks: string }) {
  return <details><summary>完整 Worker 报告</summary>
    <p className="full-text">{summary}</p>
    {checks && <><p className="muted">Worker 自述的检查与未验证项</p><p className="full-text">{checks}</p></>}
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
  return <ul>{result.evidence.map((file, index) => <li key={file.path} className="wrap">
    <a href={resultFileUrl(result.id, index, sessionId)}>{file.path.split('/').pop()}</a>{' '}
    <span className="muted">（{file.bytes} 字节）</span>
    <details><summary>文件路径</summary>{file.path}</details>
  </li>)}</ul>;
}

export function ResultCard({ w, detail, onReturn }: { w: WorkspaceState; detail: Detail; onReturn?: () => void }) {
  const { task, result } = detail;
  if (!result) return null;
  const receipt = detail.progress?.reload;
  const matchingReceipt = receipt?.resultId === result.id ? receipt : undefined;
  return <div className="attention-box result">
    <h3>{resultHeading(task)}</h3><p className="clamp">{result.summary}</p>
    <ResultDeliveryCheck w={w} result={result} status={detail.chatDelivery} onReturn={onReturn}/>
    <ResultReport summary={result.summary} checks={result.checks}/>
    <ResultFiles result={result} sessionId={w.sessionId}/>
    {(matchingReceipt || detail.reloadEligible) && <ResultLoadReceipt host="本端宿主" resultId={result.id} receipt={matchingReceipt}/>}
    {task.lifecycle === 'completed' ? <p>{result.humanAcceptedAt ? '已由你接受。' : '已由 Bot 按授权接受。'}</p>
      : task.lifecycle === 'review' ? <Review w={w} detail={detail}/>
        : <p className="muted">这份结果尚不可验收；请查看当前任务状态。</p>}
  </div>;
}
