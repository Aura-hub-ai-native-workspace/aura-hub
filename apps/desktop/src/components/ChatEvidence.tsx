/**
 * ChatEvidence — the parts of a chat answer that show what it stands on.
 * Shared by general chat and project Let's Chat so both tell the same truth:
 * the real steps taken, the sources cited (and consulted but not cited), what
 * happened when web research could not run, and what AURA wrote down.
 */
import { useState } from 'react';
import { Badge, Button, Icon } from '@aura/ui';
import { centralAgentClient, type ChatResearch, type ChatSource } from '../ai/centralAgentClient';
import type { ChatStep } from '../ai/chatEvents';

const HOST = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

export function StepTrace({ steps, working }: { steps: ChatStep[]; working: boolean }) {
  if (!working && steps.length === 0) return null;
  return (
    <ol className="space-y-1" aria-label="What AURA did for this answer">
      {steps.map((s) => (
        <li key={s.key} className={`flex items-start gap-2 text-[11.5px] ${s.tone === 'warn' ? 'text-attention' : 'text-text-muted'}`}>
          <Icon name={s.tone === 'warn' ? 'shield' : s.tone === 'ok' ? 'check' : 'dot'} size={11} className="mt-[3px] shrink-0" />
          <span>{s.label}{s.detail ? <span className="text-text-subtle"> — {s.detail}</span> : null}</span>
        </li>
      ))}
      {working && steps.length === 0 && <li className="text-[11.5px] text-text-subtle">Working…</li>}
    </ol>
  );
}

/**
 * Where a person tells AURA which search gateway to use. The address is tested
 * with one real query and saved only if it answers like a search gateway; AURA
 * ships none and suggests none.
 */
export function SearchGatewayForm() {
  const [url, setUrl] = useState('');
  const [state, setState] = useState<{ phase: 'idle' | 'testing' | 'saved' | 'failed'; message?: string }>({ phase: 'idle' });
  const test = async () => {
    setState({ phase: 'testing' });
    try {
      const out = await centralAgentClient.saveResearchEndpoint(url.trim());
      setState(out.saved ? { phase: 'saved', message: `Saved. The gateway answered with ${out.results ?? 0} result(s) for a test query. Ask again to search.` }
        : { phase: 'failed', message: out.reason || 'The address could not be used.' });
    } catch (e) {
      setState({ phase: 'failed', message: (e as Error).message });
    }
  };
  return (
    <div data-testid="search-gateway-form" className="mt-1.5 space-y-1">
      <div className="flex items-center gap-1.5">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Search gateway address (SearXNG-compatible)"
          aria-label="Search gateway address"
          className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-2 py-1 text-[11.5px] text-text outline-none placeholder:text-text-subtle focus:border-accent"
        />
        <Button size="sm" variant="secondary" loading={state.phase === 'testing'} disabled={!url.trim() || state.phase === 'testing'} onClick={() => void test()}>
          Test and save
        </Button>
      </div>
      {state.message && <div role="status" className={`text-[11px] ${state.phase === 'saved' ? 'text-positive' : 'text-attention'}`}>{state.message}</div>}
    </div>
  );
}

export function ResearchNotice({ research }: { research: ChatResearch | null | undefined }) {
  if (!research || research.status === 'ok' || research.status === 'skipped') return null;
  const empty = research.status === 'empty';
  return (
    <div data-testid="research-unavailable" className="flex items-start gap-2 rounded-xl border border-attention/30 bg-attention/5 px-3 py-2 text-[11.5px] text-text-muted">
      <Icon name="shield" size={12} className="mt-0.5 shrink-0 text-attention" />
      <div className="min-w-0 flex-1">
        <span>
          {empty ? 'The web search found nothing for this question, so this answer is not backed by sources.'
            : 'Web research was not available for this answer, so it is not backed by sources and may be out of date.'}
          {research.detail && !empty ? ` (${research.detail})` : ''}
        </span>
        {research.kind === 'not-configured' && <SearchGatewayForm />}
      </div>
    </div>
  );
}

export function SourceList({ cited, consulted }: { cited: ChatSource[]; consulted?: ChatSource[] }) {
  if (cited.length === 0 && (consulted ?? []).length > 0) {
    // The search returned real sources but the answer did not cite any. Show
    // what was consulted, and say plainly that the answer does not cite them.
    return (
      <div data-testid="sources-consulted" className="space-y-1.5">
        <div className="text-[10.5px] font-medium uppercase tracking-wide text-text-subtle">Sources consulted — not cited in this answer</div>
        <ul className="space-y-0.5 text-[11px] text-text-subtle">
          {(consulted ?? []).map((s) => <li key={s.id}><a className="hover:text-text" href={s.url} target="_blank" rel="noreferrer noopener" title={s.url}>{s.title || HOST(s.url)}</a> <span>· {HOST(s.url)}</span></li>)}
        </ul>
      </div>
    );
  }
  if (cited.length === 0) return null;
  const ids = new Set(cited.map((s) => s.id));
  const others = (consulted ?? []).filter((s) => !ids.has(s.id));
  return (
    <div data-testid="sources" className="space-y-1.5">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-text-subtle">Sources cited</div>
      <div className="flex flex-wrap gap-1.5">
        {cited.map((s) => (
          <a key={s.id} href={s.url} target="_blank" rel="noreferrer noopener" title={s.url}
            className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 text-[11px] text-text-muted transition-colors hover:border-line-strong hover:text-text">
            <span className="grid h-4 w-4 place-items-center rounded bg-accent/15 text-[9.5px] font-semibold text-accent">{s.id}</span>
            <span className="truncate">{s.title || HOST(s.url)}</span>
            <span className="text-text-subtle">{HOST(s.url)}</span>
          </a>
        ))}
      </div>
      {others.length > 0 && (
        <details className="text-[11px] text-text-subtle">
          <summary className="cursor-pointer">{others.length} more consulted, not cited</summary>
          <ul className="mt-1 space-y-0.5">
            {others.map((s) => <li key={s.id}><a className="hover:text-text" href={s.url} target="_blank" rel="noreferrer noopener">{s.title || HOST(s.url)}</a> <span>· {HOST(s.url)}</span></li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

export function RecordedNotes({ recorded }: { recorded: { kind: string; title: string }[] | undefined }) {
  if (!recorded || recorded.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="recorded">
      <span className="text-[10.5px] text-text-subtle">AURA noted:</span>
      {recorded.map((r, i) => <Badge key={i} tone="neutral">{r.kind}: {r.title.length > 48 ? `${r.title.slice(0, 48)}…` : r.title}</Badge>)}
    </div>
  );
}
