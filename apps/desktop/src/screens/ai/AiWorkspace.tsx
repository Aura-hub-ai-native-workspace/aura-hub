import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'framer-motion';
import { cn, spring, useAppStore } from '@aura/core';
import { Badge, Button, Icon, IconButton, Menu, type IconName } from '@aura/ui';
import { aiClient, type HealthResult, type InspectResult, type ConversationSummary } from '../../ai/aiClient';
import { useConversations, type ChatMessage } from '../../ai/useConversations';
import { useWorkspace } from '../../data/useWorkspace';
import { AiMarkdown } from '../../ai/AiMarkdown';
import { EmptyState as EmptyScreen } from '../../components/EmptyState';

/**
 * AI Workspace — every project's own intelligent conversation surface.
 * There is NO global chat: the workspace is scoped to the currently open
 * project, shows THAT project's conversations, and streams answers
 * grounded in its code, system graph, memory and conversation history.
 */

const SUGGESTIONS = [
  'What is this project?',
  'How is this project structured?',
  'What are the main entry points?',
  'Explain the architecture of this project.',
];

function relTime(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export function AiWorkspace() {
  const setNav = useAppStore((s) => s.setNav);
  const openId = useWorkspace((s) => s.openId);
  const project = useWorkspace((s) => s.projects.find((p) => p.id === s.openId));
  const conv = useConversations();
  const [dev, setDev] = useState(false);
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [model, setModel] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // The conversation store is always scoped to the open project.
  useEffect(() => { void conv.loadForProject(openId); }, [openId, conv]);

  useEffect(() => {
    let alive = true;
    aiClient.health().then((h) => alive && setHealth(h)).catch(() => alive && setHealth(null));
    aiClient.getSettings().then((s) => alive && setModel(s.settings.model)).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [conv.messages, conv.phase]);

  const lastMeta = useMemo(() => [...conv.messages].reverse().find((m) => m.role === 'assistant' && m.meta)?.meta, [conv.messages]);
  const connected = health?.health.ok && health?.key.configured;
  const streaming = conv.phase !== 'idle';

  useMemo(() => {
    const asst = conv.messages.filter((m) => m.role === 'assistant');
    console.log(`[AiWorkspace] render  totalMsgs=${conv.messages.length}  assistants=${asst.length}  ids=${asst.map(m => m.id.slice(0,12)).join(',')}  statuses=${asst.map(m => m.status).join(',')}`);
  }, [conv.messages]);

  if (!openId || !project) {
    return (
      <div className="grid h-full place-items-center p-10">
        <EmptyScreen
          icon="spark"
          title="Open a project to talk to its brain"
          description="AURA has no global chat. Each project has its own conversations, memory and knowledge. Open a project, then Ask AURA."
          action={<Button icon="projects" onClick={() => setNav('projects')}>Go to Projects</Button>}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-line bg-surface/40 px-8 py-4 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-2xl text-white" style={{ background: project.color }}><Icon name={(project.icon as 'folder') || 'folder'} size={17} /></span>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="truncate text-[18px] font-semibold tracking-[-0.01em] text-text">{project.name}</h1>
              <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium', connected ? 'bg-positive/10 text-positive' : 'bg-attention/12 text-attention')}>
                <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'bg-positive aura-live' : 'bg-attention')} />
                {connected ? 'Connected' : health ? (health.key.configured ? 'Provider offline' : 'No API key') : 'Connecting…'}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[12px] text-text-muted">Grounded in this project · {model || 'No provider configured'} · memory + conversation aware</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button onClick={() => setDev((d) => !d)} className={cn('inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors', dev ? 'bg-accent-50 text-accent-700 dark:bg-accent/15 dark:text-accent-200' : 'text-text-muted hover:bg-surface-hover hover:text-text')}>
            <Icon name="cpu" size={14} /> Developer
          </button>
          {!health?.key.configured && <Button size="sm" variant="secondary" icon="settings" onClick={() => setNav('settings')}>Configure AI</Button>}
        </div>
      </div>

      {/* Body: conversations rail + thread + context */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[248px_1fr] xl:grid-cols-[248px_1fr_340px]">
        <ConversationsRail
          conversations={conv.conversations}
          activeId={conv.activeId}
          onSelect={(id) => void conv.select(id)}
          onNew={() => void conv.newConversation()}
          onRename={(id, t) => void conv.rename(id, t)}
          onRemove={(id) => void conv.remove(id)}
        />

        <div className="flex min-h-0 flex-col border-l border-line">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
            <div className="mx-auto max-w-3xl">
              {conv.messages.length === 0 ? (
                <EmptyState onPick={(t) => void conv.send(t)} disabled={!connected} project={project.name} />
              ) : (
                <div className="space-y-6">
                  {conv.messages.map((m, i) => (
                    <MessageView key={m.id} message={m} phase={conv.phase} isLast={i === conv.messages.length - 1} onRegenerate={() => void conv.regenerate()} canRegenerate={!streaming} />
                  ))}
                </div>
              )}
            </div>
          </div>
          <Composer streaming={streaming} disabled={!connected} onSend={(t) => void conv.send(t)} onStop={conv.stop} />
        </div>

        <aside className="hidden min-h-0 overflow-y-auto border-l border-line bg-surface/40 xl:block">
          <SidePanel meta={lastMeta} dev={dev} lastAssistant={[...conv.messages].reverse().find((m) => m.role === 'assistant')} />
        </aside>
      </div>
    </div>
  );
}

/* ── Conversations rail (project-scoped) ─────────────────────────── */
function ConversationsRail({ conversations, activeId, onSelect, onNew, onRename, onRemove }: {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="hidden min-h-0 flex-col bg-surface/30 lg:flex">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Conversations</span>
        <IconButton icon="plus" label="New conversation" size="sm" onClick={onNew} />
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {conversations.length === 0 ? (
          <button onClick={onNew} className="mt-2 flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-line px-3 py-6 text-center text-text-subtle transition-colors hover:border-accent hover:text-accent">
            <Icon name="spark" size={18} />
            <span className="text-[12px] font-medium">New conversation</span>
          </button>
        ) : conversations.map((c) => (
          <div key={c.id} className={cn('group flex items-center gap-1 rounded-xl px-2.5 py-2 transition-colors', activeId === c.id ? 'bg-surface shadow-sm' : 'hover:bg-surface-hover')}>
            <button onClick={() => onSelect(c.id)} className="min-w-0 flex-1 text-left">
              <div className="flex items-center gap-2">
                <Icon name="spark" size={13} className={activeId === c.id ? 'text-accent' : 'text-text-subtle'} />
                <span className="truncate text-[12.5px] font-medium text-text">{c.title}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 pl-5 text-[10.5px] text-text-subtle">
                <span>{c.messageCount} msg</span><span>·</span><span>{relTime(c.updatedAt)}</span>
              </div>
            </button>
            <Menu
              align="end"
              trigger={<IconButton icon="more" label="Conversation actions" size="sm" className="opacity-0 group-hover:opacity-100" />}
              items={[
                { id: 'rename', label: 'Rename', icon: 'note', onSelect: () => { const t = window.prompt('Rename conversation', c.title); if (t && t.trim()) onRename(c.id, t.trim()); } },
                { id: 'delete', label: 'Delete', icon: 'close', tone: 'danger', onSelect: () => { if (window.confirm('Delete this conversation?')) onRemove(c.id); } },
              ]}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Empty state ─────────────────────────────────────────────────── */
function EmptyState({ onPick, disabled, project }: { onPick: (t: string) => void; disabled: boolean; project: string }) {
  return (
    <div className="grid min-h-[46vh] place-items-center text-center">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring.gentle} className="max-w-lg">
        <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-3xl border border-line bg-surface text-accent shadow-sm">
          <Icon name="spark" size={28} strokeWidth={1.5} />
        </div>
        <h2 className="text-[20px] font-semibold text-text">Ask about {project}</h2>
        <p className="mx-auto mt-2 max-w-md text-[13.5px] text-text-muted">Answers are grounded in this project's real code, system graph, memory and this conversation's history.</p>
        <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} disabled={disabled} onClick={() => onPick(s)} className="rounded-xl border border-line bg-surface px-3.5 py-3 text-left text-[12.5px] text-text-muted transition-all hover:border-line-strong hover:text-text disabled:opacity-50">
              {s}
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );
}

/* ── Message ─────────────────────────────────────────────────────── */
function MessageView({ message, phase, isLast, onRegenerate, canRegenerate }: { message: ChatMessage; phase: string; isLast: boolean; onRegenerate: () => void; canRegenerate: boolean }) {
  const [copied, setCopied] = useState(false);
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[13.5px] leading-relaxed text-white shadow-sm">{message.content}</div>
      </div>
    );
  }

  const thinking = message.status === 'streaming' && message.content.length === 0;
  const copy = async () => { try { await navigator.clipboard.writeText(message.content); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* noop */ } };

  return (
    <div className="flex gap-3">
      <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent-50 text-accent dark:bg-accent/15"><Icon name="spark" size={16} /></div>
      <div className="min-w-0 flex-1">
        {thinking ? (
          <ThinkingState phase={phase} meta={message.meta} />
        ) : message.status === 'error' ? (
          <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-[13px] text-danger">
            <div className="flex items-center gap-2 font-medium"><Icon name="close" size={14} /> {errorTitle(message.error?.type)}</div>
            <div className="mt-1 text-[12.5px] text-danger/80">{message.error?.message}</div>
            {canRegenerate && <button onClick={onRegenerate} className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-danger hover:underline"><Icon name="activity" size={13} /> Try again</button>}
          </div>
        ) : (
          <>
            <AiMarkdown source={message.content} />
            {message.status === 'streaming' && <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-accent align-middle" />}
          </>
        )}

        {message.status === 'done' && message.done && (() => {
          const d = message.done;
          const u = d.usage;
          const hasStats = (message.meta?.engines?.length ?? 0) > 0 || d.latencyMs != null || d.provider != null || u != null;
          const citations = d.citations ?? [];
          return (
          <div className="mt-3 border-t border-line pt-2.5">
            {hasStats && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-text-subtle">
              {(message.meta?.engines ?? []).map((e) => <Badge key={e} tone="info">{e} KE</Badge>)}
              {u && <span className="inline-flex items-center gap-1"><Icon name="cpu" size={12} /> {u.totalTokens} tok</span>}
              {d.latencyMs != null && <span className="inline-flex items-center gap-1"><Icon name="activity" size={12} /> {d.latencyMs}ms</span>}
              {d.provider != null && <span className="inline-flex items-center gap-1"><Icon name="spark" size={12} /> {d.provider}</span>}
              <div className="ml-auto flex items-center gap-1">
                <button onClick={copy} className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors', copied ? 'text-positive' : 'hover:text-text hover:bg-surface-hover')}><Icon name={copied ? 'check' : 'doc'} size={12} /> {copied ? 'Copied' : 'Copy'}</button>
                {isLast && canRegenerate && <button onClick={onRegenerate} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:text-text hover:bg-surface-hover"><Icon name="activity" size={12} /> Regenerate</button>}
              </div>
            </div>
            )}
            {citations.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {citations.slice(0, 8).map((c) => (
                  <span key={c.sourceId} className="inline-flex items-center gap-1 rounded-md bg-surface-active px-2 py-0.5 text-[10.5px] text-text-muted" title={c.ref}><Icon name="link" size={11} /> {c.title}</span>
                ))}
              </div>
            )}
          </div>
          );
        })()}
      </div>
    </div>
  );
}

function ThinkingState({ phase, meta }: { phase: string; meta?: InspectResult }) {
  const label = phase === 'retrieving' ? 'Retrieving context' : 'Generating';
  return (
    <div className="inline-flex flex-col gap-1.5">
      <div className="inline-flex items-center gap-2 text-[13px] text-text-muted">
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => <motion.span key={i} className="h-1.5 w-1.5 rounded-full bg-accent" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }} />)}
        </span>
        {label}
        {meta && phase === 'retrieving' && meta.engines.length > 0 && <span className="text-text-subtle">via {meta.engines.join(' + ')}</span>}
      </div>
      {meta && (
        <div className="text-[11px] text-text-subtle">
          {meta.coding.files.length > 0 && <span>{meta.coding.files.length} files · {meta.coding.chunks} chunks · </span>}
          {meta.fullstack.paths.length > 0 && <span>{meta.fullstack.paths.length} relationships · </span>}
          {meta.memory.items.length > 0 && <span>{meta.memory.items.length} memory · </span>}
          {meta.contextTokens} ctx tokens
        </div>
      )}
    </div>
  );
}

/* ── Composer ────────────────────────────────────────────────────── */
function Composer({ streaming, disabled, onSend, onStop }: { streaming: boolean; disabled: boolean; onSend: (t: string) => void; onStop: () => void }) {
  const [text, setText] = useState('');
  const submit = () => { if (!streaming && text.trim()) { onSend(text); setText(''); } };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } };
  return (
    <div className="shrink-0 border-t border-line bg-surface/60 px-8 py-4 backdrop-blur-sm">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            placeholder={disabled ? 'Configure AI in Settings to begin…' : 'Ask about this project…'}
            className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13.5px] text-text outline-none placeholder:text-text-subtle"
          />
          {streaming ? (
            <Button size="sm" variant="secondary" icon="close" onClick={onStop}>Stop</Button>
          ) : (
            <Button size="sm" icon="arrow-right" disabled={disabled || !text.trim()} onClick={submit}>Send</Button>
          )}
        </div>
        <div className="mt-1.5 px-1 text-[10.5px] text-text-subtle">Enter to send · Shift+Enter for a new line · this conversation belongs only to this project</div>
      </div>
    </div>
  );
}

/* ── Side panel: context + debug ─────────────────────────────────── */
function SidePanel({ meta, dev, lastAssistant }: { meta?: InspectResult; dev: boolean; lastAssistant?: ChatMessage }) {
  return (
    <div className="divide-y divide-line">
      <Section title="Context sources" icon="knowledge">
        {!meta ? (
          <Empty>Ask a question to see the retrieved context.</Empty>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">{meta.engines.length ? meta.engines.map((e) => <Badge key={e} tone="info" dot>{e}</Badge>) : <Badge tone="neutral">no retrieval</Badge>}</div>
            {meta.coding.files.length > 0 && (
              <div>
                <Label>Retrieved files ({meta.coding.chunks} chunks)</Label>
                <div className="mt-1 space-y-1">{meta.coding.files.map((f) => <div key={f} className="flex items-center gap-2 text-[11.5px] text-text-muted"><Icon name="doc" size={12} className="text-accent" /><span className="truncate font-mono">{f}</span></div>)}</div>
              </div>
            )}
            {meta.fullstack.paths.length > 0 && (
              <div>
                <Label>Relationships</Label>
                <div className="mt-1 space-y-1">{meta.fullstack.paths.map((p, i) => <div key={i} className="truncate font-mono text-[10.5px] text-text-muted" title={p}>{p}</div>)}</div>
              </div>
            )}
            {meta.memory.items.length > 0 && (
              <div>
                <Label>Memory recalled</Label>
                <div className="mt-1 space-y-1">{meta.memory.items.map((it) => <div key={it.id} className="flex items-center gap-2 text-[11.5px] text-text-muted"><Icon name="memory" size={12} className="text-attention" /><span className="truncate">{it.kind}: {it.title}</span></div>)}</div>
              </div>
            )}
            <div className="flex items-center gap-2 border-t border-line pt-2 text-[11px] text-text-subtle"><Icon name="cpu" size={12} /> {meta.contextTokens} context tokens</div>
          </div>
        )}
      </Section>

      {dev && (
        <Section title="Debug" icon="cpu">
          {!meta ? <Empty>Developer trace appears after a query.</Empty> : <DebugView meta={meta} done={lastAssistant?.done} />}
        </Section>
      )}
    </div>
  );
}

function DebugView({ meta, done }: { meta: InspectResult; done?: ChatMessage['done'] }) {
  return (
    <div className="space-y-2.5 font-mono text-[11px]">
      <Kv k="project" v={meta.projectId ?? '—'} />
      <Kv k="intent" v={`${meta.intent} (${meta.intentConfidence.toFixed(2)})`} />
      <Kv k="enhanced" v={meta.enhancedPrompt} clamp />
      <Kv k="engines" v={meta.engines.join(', ') || '—'} />
      <Kv k="files" v={String(meta.coding.files.length)} />
      <Kv k="chunks" v={String(meta.coding.chunks)} />
      <Kv k="fs paths" v={String(meta.fullstack.paths.length)} />
      <Kv k="memory" v={String(meta.memory.items.length)} />
      <Kv k="ctx tokens" v={String(meta.contextTokens)} />
      {done && <>
        <div className="border-t border-line pt-2" />
        {done.provider != null && <Kv k="provider" v={done.provider} />}
        {done.engineId != null && <Kv k="engine" v={done.engineId} />}
        {done.usage && <Kv k="tokens" v={`p${done.usage.promptTokens} c${done.usage.completionTokens} = ${done.usage.totalTokens}`} />}
        {done.latencyMs != null && <Kv k="latency" v={`${done.latencyMs}ms`} />}
        {done.finishReason != null && <Kv k="finish" v={done.finishReason} />}
        {done.trace && done.trace.length > 0 && <><Label>trace</Label>
        {done.trace.map((s, i) => <div key={i} className="flex justify-between text-text-subtle"><span>{s.stage}</span><span>{s.durationMs}ms</span></div>)}</>}
      </>}
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: IconName; children: React.ReactNode }) {
  return (
    <section className="px-4 py-4">
      <div className="mb-3 flex items-center gap-2 text-text-muted"><Icon name={icon} size={14} /><h4 className="text-[11px] font-semibold uppercase tracking-wider">{title}</h4></div>
      {children}
    </section>
  );
}
const Label = ({ children }: { children: React.ReactNode }) => <div className="text-[10px] font-semibold uppercase tracking-wider text-text-subtle">{children}</div>;
const Empty = ({ children }: { children: React.ReactNode }) => <div className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[11.5px] text-text-subtle">{children}</div>;
function Kv({ k, v, clamp }: { k: string; v: string; clamp?: boolean }) {
  return <div className="flex gap-2"><span className="w-16 shrink-0 text-text-subtle">{k}</span><span className={cn('min-w-0 flex-1 text-text-muted', clamp && 'line-clamp-2')}>{v}</span></div>;
}

function errorTitle(type?: string): string {
  switch (type) {
    case 'auth': return 'Authentication failed';
    case 'rate_limit': return 'Rate limited';
    case 'timeout': return 'Request timed out';
    case 'network': return 'Cannot reach provider';
    case 'server': return 'Provider error';
    default: return 'Something went wrong';
  }
}
