/** The current result: summary, evidence downloads, and accept or rework controls. */
import { resultHeading } from './format.ts';
import { ReplyForm } from './forms.tsx';
import type { Detail } from './types.ts';
import type { WorkspaceState } from './useWorkspace.ts';

const fileUrl = (resultId: string, index: number) => `/api/super-bot-file?resultId=${encodeURIComponent(resultId)}&index=${index}`;

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

export function ResultCard({ w, detail }: { w: WorkspaceState; detail: Detail }) {
  const { task } = detail, result = detail.result;
  if (!result) return null;
  return <div className="attention-box result">
    <h3>{resultHeading(task)}</h3><p className="clamp">{result.summary}</p>
    <details><summary>完整报告与验证记录</summary>
      <p className="full-text">{result.summary}</p><p className="full-text">{result.checks}</p>
    </details>
    <ul>{result.evidence.map((file, index) => <li key={file.path} className="wrap">
      <a href={fileUrl(result.id, index)} download>{file.path.split('/').pop()}</a> <span className="muted">（{file.bytes} 字节）</span>
      <details><summary>文件路径</summary>{file.path}</details>
    </li>)}</ul>
    {task.lifecycle === 'completed' ? <p>{result.humanAcceptedAt ? '已由你接受。' : '已由 Bot 按授权接受。'}</p>
      : task.lifecycle === 'review' ? <Review w={w} detail={detail}/>
        : <p className="muted">这份结果尚不可验收；请查看当前任务状态。</p>}
  </div>;
}
