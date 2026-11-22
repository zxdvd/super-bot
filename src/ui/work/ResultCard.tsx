/** The current result: summary, evidence downloads, and accept or rework controls. */
import { resultHeading } from './format.ts';
import { ReplyForm } from './forms.tsx';
import type { Detail } from './types.ts';
import type { WorkspaceState } from './useWorkspace.ts';

const fileUrl = (resultId: string, index: number) => `/api/super-bot-file?resultId=${encodeURIComponent(resultId)}&index=${index}`;
export const deliveryLabels = {
  'awaiting-review': '原聊天交付 · 等待 Bot 检查成果',
  pending: '原聊天交付 · 等待可核对的回复',
  uncertain: '原聊天交付 · 需核对送达情况',
  delivered: '原聊天交付 · 已确认成果链接',
  handled: '原聊天交付 · 交付通知已由用户处理',
};

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
  return <details><summary>完整报告与验证记录</summary>
    <p className="full-text">{summary}</p><p className="full-text">{checks}</p>
  </details>;
}

export function ResultCard({ w, detail }: { w: WorkspaceState; detail: Detail }) {
  const { task } = detail, result = detail.result;
  if (!result) return null;
  return <div className="attention-box result">
    <h3>{resultHeading(task)}</h3><p className="clamp">{result.summary}</p>
    {detail.chatDelivery && <p className="muted">
      {deliveryLabels[detail.chatDelivery.state]}{detail.chatDelivery.reason && `。${detail.chatDelivery.reason}`}
    </p>}
    <ResultReport summary={result.summary} checks={result.checks}/>
    <ul>{result.evidence.map((file, index) => <li key={file.path} className="wrap">
      <a href={fileUrl(result.id, index)} download>{file.path.split('/').pop()}</a> <span className="muted">（{file.bytes} 字节）</span>
      <details><summary>文件路径</summary>{file.path}</details>
    </li>)}</ul>
    {task.lifecycle === 'completed' ? <p>{result.humanAcceptedAt ? '已由你接受。' : '已由 Bot 按授权接受。'}</p>
      : task.lifecycle === 'review' ? <Review w={w} detail={detail}/>
        : <p className="muted">这份结果尚不可验收；请查看当前任务状态。</p>}
  </div>;
}
