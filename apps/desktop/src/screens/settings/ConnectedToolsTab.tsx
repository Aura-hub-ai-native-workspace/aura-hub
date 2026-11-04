import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@aura/core';
import { Badge, Button, Card, CardHeader, Dialog, Icon, Input } from '@aura/ui';
import { PageContainer } from '../PageContainer';
import {
  environmentClient,
  type InstallResponse,
  type InventoryCounts,
  type InventoryEntry,
  type InventorySource,
  type RecommendedItem,
} from '../../environment/environmentClient';
import { KIND_FILTERS, installPrompt, installResultLine } from '../../environment/connectedTools';

const PAGE = 100;

/**
 * Connected tools — what is on this machine, and what is worth adding.
 * Installed lists everything AURA can detect (applications, CLI tools,
 * runtimes, packages), from every package source the operating system has.
 * Recommended lists popular AI agent tools and developer tools.
 */
export function ConnectedToolsTab() {
  const [view, setView] = useState<'installed' | 'recommended'>('installed');
  return (
    <PageContainer title="Connected tools" subtitle="Everything installed on this machine, and the tools worth adding.">
      <div className="mb-5 flex gap-1 rounded-xl border border-line bg-surface/50 p-1 sm:w-fit" role="tablist" aria-label="Connected tools">
        {(['installed', 'recommended'] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={cn('rounded-lg px-4 py-1.5 text-[13px] font-medium capitalize transition-colors', view === v ? 'bg-accent/10 text-text' : 'text-text-muted hover:text-text')}
          >
            {v}
          </button>
        ))}
      </div>
      {view === 'installed' ? <InstalledList /> : <RecommendedList />}
    </PageContainer>
  );
}

/* ── Installed ───────────────────────────────────────────────────── */

function InstalledList() {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filter, setFilter] = useState(KIND_FILTERS[0].key);
  const [items, setItems] = useState<InventoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<InventoryCounts | null>(null);
  const [sources, setSources] = useState<InventorySource[]>([]);
  const [collectedAt, setCollectedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async (opts: { refresh?: boolean; append?: boolean; offset?: number }) => {
    const ticket = ++latest.current;
    setLoading(true);
    const kinds = KIND_FILTERS.find((f) => f.key === filter)?.kinds;
    const outcome = await environmentClient.inventory({
      refresh: opts.refresh,
      offset: opts.offset ?? 0,
      limit: PAGE,
      kinds,
      query: debounced || undefined,
    });
    if (ticket !== latest.current) return; // a newer request superseded this one
    setLoading(false);
    if (!outcome.ok) {
      setError(outcome.reason);
      return;
    }
    const r = outcome.response;
    setError(null);
    setItems((prev) => (opts.append ? [...prev, ...r.items.filter((i) => !prev.some((p) => p.id === i.id))] : r.items));
    setTotal(r.total);
    setCounts(r.counts);
    setSources(r.sources);
    setCollectedAt(r.collectedAt);
  }, [debounced, filter]);

  useEffect(() => { void load({}); }, [load]);

  const failed = sources.filter((s) => s.error);
  const read = sources.filter((s) => s.available && !s.error).length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-[220px] flex-1">
          <Input placeholder="Search installed software…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search installed software" />
        </div>
        <Button variant="secondary" icon="refresh" onClick={() => void load({ refresh: true })} loading={loading}>Re-scan</Button>
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Filter by kind">
        {KIND_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            className={cn('rounded-full border px-3 py-1 text-[12px] font-medium transition-colors', filter === f.key ? 'border-accent bg-accent/10 text-text' : 'border-line text-text-muted hover:text-text')}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-2.5 text-[12.5px] text-danger">{error}</div>}

      <Card>
        <CardHeader
          title={`${total.toLocaleString()} found`}
          subtitle={counts ? `${counts.applications} applications · ${counts.cli} CLI tools · ${counts.runtimes} runtimes · ${counts.packages + counts.libraries} packages` : undefined}
        />
        {items.length === 0 && !loading ? (
          <p className="mt-4 text-[13px] text-text-muted">{debounced ? 'Nothing matches that search.' : 'Nothing detected yet.'}</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {items.map((i) => <InstalledRow key={i.id} item={i} />)}
          </ul>
        )}
        {loading && <p className="mt-3 text-[12px] text-text-subtle">Reading the machine…</p>}
        {items.length < total && !loading && (
          <Button variant="secondary" className="mt-4" onClick={() => void load({ append: true, offset: items.length })}>
            Load more ({(total - items.length).toLocaleString()} left)
          </Button>
        )}
      </Card>

      <p className="mt-3 text-[11.5px] text-text-subtle">
        {read} package source{read === 1 ? '' : 's'} read{collectedAt ? ` · ${new Date(collectedAt).toLocaleString()}` : ''}.
        {failed.length > 0 && ` Could not read: ${failed.map((s) => s.name).join(', ')}.`}
      </p>
    </div>
  );
}

function InstalledRow({ item }: { item: InventoryEntry }) {
  return (
    <li className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-text">{item.displayName || item.name}</span>
          {item.version && <span className="font-mono text-[11.5px] text-text-muted">{item.version}</span>}
          <Badge tone="neutral">{item.kind}</Badge>
          {item.verified && <Badge tone="positive" dot>Verified</Badge>}
        </div>
        <p className="truncate font-mono text-[11px] text-text-subtle">
          {[item.packageManager ?? item.origin, item.installLocation ?? item.executablePath].filter(Boolean).join(' · ')}
        </p>
      </div>
    </li>
  );
}

/* ── Recommended ─────────────────────────────────────────────────── */

type Prompt = { item: RecommendedItem; stage: 'loading' | 'confirm' | 'running' | 'done'; preview?: InstallResponse; result?: { ok: boolean; text: string }; error?: string };

function RecommendedList() {
  const [items, setItems] = useState<RecommendedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);

  const load = useCallback(async () => {
    const out = await environmentClient.recommended();
    if (out.ok) { setItems(out.items); setError(null); } else setError(out.reason);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const begin = async (item: RecommendedItem) => {
    setPrompt({ item, stage: 'loading' });
    try {
      const preview = await environmentClient.installPreview(item.id);
      setPrompt({ item, stage: 'confirm', preview });
    } catch (e) {
      setPrompt({ item, stage: 'done', error: e instanceof Error ? e.message : String(e) });
    }
  };

  const confirm = async () => {
    if (!prompt) return;
    setPrompt({ ...prompt, stage: 'running' });
    try {
      const result = await environmentClient.install(prompt.item.id);
      setPrompt({ item: prompt.item, stage: 'done', result: installResultLine(result) });
      void load();
    } catch (e) {
      setPrompt({ item: prompt.item, stage: 'done', error: e instanceof Error ? e.message : String(e) });
    }
  };

  if (error) return <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-2.5 text-[12.5px] text-danger">{error}</div>;
  if (!items) return <p className="text-[13px] text-text-muted">Checking this machine…</p>;

  const groups: { key: 'agent' | 'dev'; title: string; subtitle: string }[] = [
    { key: 'agent', title: 'AI agents & runtimes', subtitle: 'Agentic coding tools and local model runtimes AURA can work with.' },
    { key: 'dev', title: 'Developer tools', subtitle: 'Popular tools most projects rely on.' },
  ];
  const confirmView = prompt?.stage === 'confirm' && prompt.preview ? installPrompt(prompt.preview) : null;

  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <Card key={g.key}>
          <CardHeader title={g.title} subtitle={g.subtitle} />
          <ul className="mt-3 divide-y divide-line">
            {items.filter((i) => i.group === g.key).map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13.5px] font-medium text-text">{i.name}</span>
                    {i.installed ? <Badge tone="positive" dot>Installed{i.version ? ` · ${i.version}` : ''}</Badge> : <Badge tone="neutral">Not installed</Badge>}
                  </div>
                  <p className="text-[12px] text-text-muted">{i.why}</p>
                </div>
                {!i.installed && (i.installable
                  ? <Button size="sm" icon="plus" onClick={() => void begin(i)}>Install</Button>
                  : <a className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline" href={i.homepage} target="_blank" rel="noreferrer"><Icon name="link" size={13} />Get</a>)}
              </li>
            ))}
          </ul>
        </Card>
      ))}

      <Dialog
        open={prompt !== null}
        onClose={() => prompt?.stage !== 'running' && setPrompt(null)}
        title={prompt ? `Install ${prompt.item.name}` : ''}
        size="sm"
        footer={prompt?.stage === 'confirm' ? (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPrompt(null)}>Cancel</Button>
            {confirmView?.canRun && <Button icon="check" onClick={() => void confirm()}>Install</Button>}
          </div>
        ) : prompt?.stage === 'done' ? <div className="flex justify-end"><Button onClick={() => setPrompt(null)}>Close</Button></div> : undefined}
      >
        {prompt?.stage === 'loading' && <p className="text-[13px] text-text-muted">Working out what this would run…</p>}
        {prompt?.stage === 'confirm' && (confirmView ? (
          <div className="space-y-3">
            <p className="text-[12.5px] text-text-muted">{confirmView.note}</p>
            <pre className="overflow-x-auto rounded-xl border border-line bg-surface-active/50 px-3 py-2.5 font-mono text-[12px] text-text">{confirmView.command}</pre>
          </div>
        ) : <p className="text-[13px] text-text-muted">{prompt.preview?.detail ?? 'AURA has no verified way to install this.'}</p>)}
        {prompt?.stage === 'running' && <p className="text-[13px] text-text-muted">Installing and then checking it is really there…</p>}
        {prompt?.stage === 'done' && (
          <p className={cn('text-[13px]', prompt.error || !prompt.result?.ok ? 'text-danger' : 'text-positive')}>{prompt.error ?? prompt.result?.text}</p>
        )}
      </Dialog>
    </div>
  );
}
