import { useState, type ReactNode } from 'react';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';

/**
 * CodeBlock — mono code with a language tag, copy button and a light,
 * dependency-free highlighter (comments / strings / keywords / numbers).
 * Colors come from the design tokens, so it reads correctly in both themes.
 */

const KEYWORDS =
  'const|let|var|function|return|if|else|for|while|class|interface|type|import|export|from|as|async|await|new|extends|implements|public|private|protected|readonly|void|null|undefined|true|false|this|def|fn|struct|impl|pub|use|match|enum|package|func|go|select|case|switch|default|try|catch|finally|throw';
const TOKEN = new RegExp(
  `(\\/\\/[^\\n]*|#[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|\\b(${KEYWORDS})\\b|\\b(\\d+(?:\\.\\d+)?)\\b`,
  'g',
);

function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const cls = m[1] ? 'italic text-text-subtle' : m[2] ? 'text-positive' : m[3] ? 'text-accent' : 'text-attention';
    out.push(<span key={k++} className={cls}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard unavailable */ }
  };
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-line bg-surface-active/40">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="text-[10.5px] font-medium uppercase tracking-wider text-text-subtle">{lang || 'code'}</span>
        <button onClick={copy} className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] transition-colors', copied ? 'text-positive' : 'text-text-subtle hover:text-text hover:bg-surface-hover')}>
          <Icon name={copied ? 'check' : 'doc'} size={12} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="selectable overflow-x-auto p-3.5 font-mono text-[12.5px] leading-relaxed text-text">
        <code>{highlight(code)}</code>
      </pre>
    </div>
  );
}
