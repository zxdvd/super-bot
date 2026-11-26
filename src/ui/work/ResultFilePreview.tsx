import { useEffect, useState } from 'react';

export function ResultFilePreview({
  href,
  showDownload = false,
}: {
  href: string;
  showDownload?: boolean;
}) {
  const [result, setResult] = useState<{ text: string; status: number }>();
  useEffect(() => {
    const controller = new AbortController(),
      { signal } = controller;
    void (async () => {
      const response = await fetch(href + '&preview=1', { signal, redirect: 'error' });
      if (!response.headers.get('Content-Type')?.startsWith('text/plain')) throw new Error();
      const text = await response.text();
      if (!signal.aborted) setResult({ status: response.status, text });
    })().catch(() => {
      if (!signal.aborted) setResult({ status: 0, text: '无法预览成果文件。' });
    });
    return () => controller.abort();
  }, [href]);
  if (!result) return <p role="status">正在读取成果文件…</p>;
  return (
    <>
      {showDownload && (result.status === 200 || result.status === 415) && <a href={href}>下载</a>}
      {result.status === 200 ? (
        <pre
          role="region"
          aria-label="成果文件内容"
          style={{ maxHeight: '60vh', overflow: 'auto', whiteSpace: 'pre-wrap' }}
        >
          {result.text}
        </pre>
      ) : (
        <p role="alert">{result.text}</p>
      )}
    </>
  );
}
