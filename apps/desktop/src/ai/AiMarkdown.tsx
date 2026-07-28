import { Fragment, type ReactNode } from 'react';
import { CodeBlock } from './CodeBlock';

/**
 * AiMarkdown — a safe, dependency-free markdown renderer for AI answers.
 * Headings, bold, inline code, links, blockquotes, lists, and fenced code
 * (rendered via the highlighted CodeBlock). Parses to React elements — no
 * dangerous HTML.
 */

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const rx = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = rx.exec(text))) {
    if (m.index > last) parts.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    const t = m[0];
    if (t.startsWith('**')) parts.push(<strong key={k++} className="font-semibold text-text">{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) parts.push(<code key={k++} className="rounded bg-surface-active px-1.5 py-0.5 font-mono text-[12.5px] text-accent">{t.slice(1, -1)}</code>);
    else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(t)!;
      parts.push(<span key={k++} className="text-accent underline decoration-accent/30">{mm[1]}</span>);
    }
    last = m.index + t.length;
  }
  if (last < text.length) parts.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return parts;
}

export function AiMarkdown({ source }: { source: string }) {
  const lines = source.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(<CodeBlock key={key++} code={buf.join('\n')} lang={lang} />);
      continue;
    }
    if (line.startsWith('### ')) out.push(<h3 key={key++} className="mt-4 mb-1.5 text-[14px] font-semibold text-text">{inline(line.slice(4))}</h3>);
    else if (line.startsWith('## ')) out.push(<h2 key={key++} className="mt-5 mb-2 text-[15.5px] font-semibold text-text">{inline(line.slice(3))}</h2>);
    else if (line.startsWith('# ')) out.push(<h1 key={key++} className="mb-2 text-[18px] font-semibold tracking-[-0.01em] text-text">{inline(line.slice(2))}</h1>);
    else if (line.startsWith('> ')) out.push(<blockquote key={key++} className="my-2 border-l-2 border-accent/40 pl-3 text-[13.5px] italic text-text-muted">{inline(line.slice(2))}</blockquote>);
    else if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      out.push(<ul key={key++} className="my-2 space-y-1">{items.map((it, j) => <li key={j} className="flex gap-2 text-[13.5px] leading-relaxed text-text"><span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-text-subtle" />{inline(it)}</li>)}</ul>);
      continue;
    } else if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''));
      out.push(<ol key={key++} className="my-2 list-decimal space-y-1 pl-5">{items.map((it, j) => <li key={j} className="text-[13.5px] leading-relaxed text-text marker:text-text-subtle">{inline(it)}</li>)}</ol>);
      continue;
    } else if (line.trim() === '') out.push(<div key={key++} className="h-2" />);
    else out.push(<p key={key++} className="my-1.5 text-[13.5px] leading-relaxed text-text">{inline(line)}</p>);
    i++;
  }
  return <div className="selectable">{out}</div>;
}
