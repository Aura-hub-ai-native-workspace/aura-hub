import { useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Badge, Button, Card, Dialog, Icon, IconButton, Input, Menu, useToast } from '@aura/ui';
import { aiClient, type AuthorityEnvelope, type WorkflowRunSummary, type WorkflowSummary } from '../../ai/aiClient';
import { useWorkflows } from '../../data/useWorkflows';
import { RUN_STATE_LABEL, RUN_STATE_TONE, relTime } from './runs';
import { envelopeSummary } from './PermissionEnvelope';
import { EmptyState } from '../../components/EmptyState';

/**
 * Workflow Library — every workflow the user has created, persisted
 * locally. Create, rename, duplicate, delete, import, export, favorite,
 * categories, recents and search — plus the real starter templates.
 */
export function WorkflowLibrary() {
  const wf = useWorkflows();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<WorkflowSummary | null>(null);
  const [renameText, setRenameText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const categories = useMemo(() => [...new Set(wf.list.map((w) => w.category))].sort(), [wf.list]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return wf.list
      .filter((w) => (cat ? w.category === cat : true))
      .filter((w) => (needle ? `${w.name} ${w.description} ${w.category}`.toLowerCase().includes(needle) : true))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt.localeCompare(a.updatedAt));
  }, [wf.list, q, cat]);

  const createBlank = async () => {
    const created = await wf.create({ name: 'Untitled workflow' });
    if (created) await wf.open(created.id);
  };

  const fromTemplate = async (id: string) => {
    const created = await wf.create({ template: id });
    if (created) await wf.open(created.id);
  };

  const exportOne = async (w: WorkflowSummary) => {
    const def = await aiClient.getWorkflow(w.id).catch(() => null);
    if (!def) return;
    const blob = new Blob([JSON.stringify(def, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${w.name.replace(/[^\w-]+/g, '-').toLowerCase()}.aura-workflow.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onImportFile = async (f: File) => {
    const res = await wf.importDef(await f.text());
    toast.push(res.ok ? { title: 'Workflow imported', tone: 'positive' } : { title: 'Import failed', description: res.error, tone: 'critical' });
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportFile(f); e.target.value = ''; }} />

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-subtle">Automation</div>
          <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-text">Workflows</h1>
          <p className="mt-1 max-w-xl text-[13px] text-text-muted">AI-native engineering automations that orchestrate your project's real intelligence — engines, memory and inference, node by node.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" icon="doc" onClick={() => fileRef.current?.click()}>Import</Button>
          <Button icon="plus" onClick={() => void createBlank()}>New workflow</Button>
        </div>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Input icon="search" placeholder="Search workflows…" value={q} onChange={(e) => setQ(e.target.value)} className="w-72" />
        <button onClick={() => setCat(null)} className={`rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors ${cat === null ? 'bg-accent text-white' : 'bg-surface-active text-text-muted hover:text-text'}`}>All</button>
        {categories.map((c) => (
          <button key={c} onClick={() => setCat(cat === c ? null : c)} className={`rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors ${cat === c ? 'bg-accent text-white' : 'bg-surface-active text-text-muted hover:text-text'}`}>{c}</button>
        ))}
      </div>

      {wf.list.length === 0 && wf.loaded && (
        <div className="mb-8">
          <EmptyState icon="workflows" title="No workflows yet" description="Start from a real template below, or build one on a blank canvas." />
        </div>
      )}

      {filtered.length > 0 && (
        <div className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((w, i) => (
            <motion.div key={w.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.03, 0.2) }}>
              <Card className="group relative cursor-pointer transition-shadow hover:shadow-lg" padding="md">
                <div onClick={() => void wf.open(w.id)}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent"><Icon name="workflows" size={17} /></span>
                      <div>
                        <h3 className="text-[13.5px] font-semibold text-text">{w.name}</h3>
                        <div className="text-[11px] text-text-subtle">{w.nodeCount} nodes · {new Date(w.updatedAt).toLocaleDateString()}</div>
                      </div>
                    </div>
                  </div>
                  {w.description && <p className="mt-2.5 line-clamp-2 text-[12px] leading-relaxed text-text-muted">{w.description}</p>}
                  <CardState envelope={wf.envelopes[w.id]} runs={wf.runs[w.id]} />
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">{w.category}</Badge>
                    {w.favorite && <Badge tone="info">favorite</Badge>}
                  </div>
                </div>
                <div className="absolute right-3 top-3 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                  <IconButton icon="pin" label={w.favorite ? 'Unfavorite' : 'Favorite'} size="sm" className={w.favorite ? 'text-accent' : ''} onClick={() => void wf.patchMeta(w.id, { favorite: !w.favorite })} />
                  <Menu
                    align="end"
                    trigger={<IconButton icon="more" label="Workflow actions" size="sm" />}
                    items={[
                      { id: 'rename', label: 'Rename', icon: 'note', onSelect: () => { setRenaming(w); setRenameText(w.name); } },
                      { id: 'duplicate', label: 'Duplicate', icon: 'plus', onSelect: () => void wf.duplicate(w.id) },
                      { id: 'export', label: 'Export JSON', icon: 'doc', onSelect: () => void exportOne(w) },
                      'separator',
                      { id: 'delete', label: 'Delete', icon: 'close', tone: 'danger', onSelect: () => void wf.remove(w.id) },
                    ]}
                  />
                </div>
              </Card>
            </motion.div>
          ))}
        </div>
      )}

      <div className="mb-3 flex items-center gap-2">
        <Icon name="spark" size={14} className="text-accent" />
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-text-muted">Starter templates</h2>
        <span className="text-[11.5px] text-text-subtle">— real automations over your open project</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {wf.templates.map((t) => (
          <button key={t.id} onClick={() => void fromTemplate(t.id)} className="rounded-2xl border border-line bg-surface p-4 text-left transition-all hover:border-accent/40 hover:shadow-md">
            <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-surface-active text-text-muted"><Icon name="workflows" size={15} /></div>
            <div className="text-[12.5px] font-semibold text-text">{t.name}</div>
            <div className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-text-subtle">{t.description}</div>
            <div className="mt-2 text-[10.5px] text-text-subtle">{t.category} · {t.nodeCount} nodes</div>
          </button>
        ))}
      </div>

      <Dialog open={Boolean(renaming)} onClose={() => setRenaming(null)} title="Rename workflow" size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
            <Button onClick={() => { if (renaming && renameText.trim()) void wf.patchMeta(renaming.id, { name: renameText.trim() }); setRenaming(null); }}>Rename</Button>
          </div>
        }>
        <Input value={renameText} onChange={(e) => setRenameText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && renaming && renameText.trim()) { void wf.patchMeta(renaming.id, { name: renameText.trim() }); setRenaming(null); } }} autoFocus />
      </Dialog>
    </div>
  );
}

/**
 * CardState — the two things that decide whether you trust a workflow
 * enough to open it: what it is permitted to do, and whether it last
 * worked.
 *
 * Both come from the service — the authority envelope it computes, and
 * the runs it persisted. While either is still loading the strip renders
 * nothing rather than a placeholder that could be read as an answer.
 */
function CardState({ envelope, runs }: { envelope?: AuthorityEnvelope; runs?: WorkflowRunSummary[] }) {
  const last = runs?.[0] ?? null;
  if (!envelope && !last) return null;
  const perms = envelope ? envelopeSummary(envelope) : null;
  const tone = (t: string) => (t === 'critical' ? 'text-danger' : t === 'attention' ? 'text-attention' : 'text-text-muted');

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]">
      {perms && (
        <span className="flex items-center gap-1">
          <Icon name="shield" size={11} className={tone(perms.tone)} />
          <span className={tone(perms.tone)}>{perms.text}</span>
        </span>
      )}
      {envelope?.offlineCapable && <span className="text-text-subtle">· offline-capable</span>}
      {last && (
        <span className="ml-auto flex items-center gap-1">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              RUN_STATE_TONE[last.state] === 'positive' ? 'bg-positive'
                : RUN_STATE_TONE[last.state] === 'critical' ? 'bg-danger'
                : RUN_STATE_TONE[last.state] === 'attention' ? 'bg-attention'
                : 'bg-text-subtle'
            }`}
          />
          <span className="text-text-subtle">
            {RUN_STATE_LABEL[last.state].toLowerCase()} · {relTime(last.createdAt)}
          </span>
        </span>
      )}
    </div>
  );
}
