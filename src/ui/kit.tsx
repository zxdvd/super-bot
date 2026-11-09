/** Small presentational pieces shared by Super Bot views; colours come from DSH alias tokens in styles.ts. */
import { useState, type ReactNode } from 'react';

export type Tone = 'neutral' | 'attention' | 'success' | 'danger' | 'info';

export function Tag({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={tone === 'neutral' ? 'badge' : `badge ${tone}`}>{children}</span>;
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="muted hint">{children}</p>;
}

export function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return <section className="sb-section">
    <header><h3>{title}</h3>{aside}</header>
    {children}
  </section>;
}

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = () => void navigator.clipboard?.writeText(text).then(() => {
    setDone(true); setTimeout(() => setDone(false), 1500);
  }, () => setDone(false));
  return <button type="button" className="small" onClick={copy}>{done ? '已复制' : label}</button>;
}

/** Two-step button for actions that discard or remove something. */
export function ConfirmAction({ label, explanation, disabled, submit }: {
  label: string; explanation: string; disabled: boolean; submit: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) return <button disabled={disabled} onClick={() => setConfirming(true)}>{label}</button>;
  return <div className="attention-box">
    <p>{explanation}</p>
    <div className="actions">
      <button disabled={disabled} onClick={() => void submit().then(ok => { if (ok) setConfirming(false); })}>确认{label}</button>
      <button disabled={disabled} onClick={() => setConfirming(false)}>返回</button>
    </div>
  </div>;
}
