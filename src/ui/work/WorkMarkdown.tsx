import { Fragment, type ReactNode } from 'react';
import { Lexer, type MarkedToken, type Token } from 'marked';
import { RESULT_FILE_PATH } from '../../work-links.ts';

function referenceUrl(href: string): string | undefined {
  // Prose has no document base. Artifact actions use their own scoped controls.
  const text = href.replaceAll('&amp;', '&');
  if (!/^https?:\/\//i.test(text)) return;
  try {
    const url = new URL(text);
    if (!url.username && !url.password && url.pathname !== RESULT_FILE_PATH) return url.href;
  } catch { /* Malformed links keep their labels. */ }
}

function renderTokens(tokens: Token[], omitLinks?: ReadonlySet<string>): ReactNode[] {
  const render = (children: Token[]) => renderTokens(children, omitLinks);
  return (tokens as MarkedToken[]).map((token, key) => {
    switch (token.type) {
      case 'space':
      case 'def': return null;
      case 'paragraph': return <p key={key}>{render(token.tokens)}</p>;
      case 'strong': return <strong key={key}>{render(token.tokens)}</strong>;
      case 'em': return <em key={key}>{render(token.tokens)}</em>;
      case 'codespan': return <code key={key}>{token.text}</code>;
      case 'code': return <pre key={key}><code>{token.text}</code></pre>;
      case 'br': return <br key={key}/>;
      case 'blockquote': return <blockquote key={key}>{render(token.tokens)}</blockquote>;
      case 'list': {
        const items = token.items.map((item, index) => <li key={index}>{render(item.tokens)}</li>);
        return token.ordered ? <ol key={key} start={Number(token.start)}>{items}</ol> : <ul key={key}>{items}</ul>;
      }
      case 'link': {
        const href = referenceUrl(token.href), label = render(token.tokens);
        if (href && omitLinks?.has(href)) return token.text === token.href ? null : <Fragment key={key}>{label}</Fragment>;
        return href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer">{label}</a>
          : <Fragment key={key}>{label}</Fragment>;
      }
      case 'text': return token.tokens ? <Fragment key={key}>{render(token.tokens)}</Fragment> : token.text;
      case 'escape': return token.text;
      // HTML, images and other unsupported syntax stay inert as React text.
      default: return token.raw;
    }
  });
}

export function WorkMarkdown({ text, omitLinks }: { text: string; omitLinks?: string[] }) {
  let content: ReactNode = text;
  try {
    const omitted = omitLinks && new Set(omitLinks.map(referenceUrl).filter(href => href !== undefined));
    content = renderTokens(Lexer.lex(text, { gfm: false }), omitted);
  }
  catch { /* Keep the field readable when Markdown cannot be parsed. */ }
  return <div className="work-markdown">{content}</div>;
}
