import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'framer-motion';
import { cn, spring, useAppStore } from '@aura/core';
import { Badge, Button, Icon, IconButton, Input, Menu, type IconName } from '@aura/ui';
import { centralAgentClient, type EditorContext } from '../../ai/centralAgentClient';
import { useAgentConversations, type AgentChatMessage } from '../../ai/useAgentConversations';
import { useWorkspace } from '../../data/useWorkspace';
import { AiMarkdown } from '../../ai/AiMarkdown';
import { EmptyState as EmptyScreen } from '../../components/EmptyState';
import { AgentPhaseStrip, phaseForResult, phaseFromEvents } from '../../components/agent/AgentPhaseStrip';
import { ApprovalGate } from '../missions/ApprovalGate';
import { useEditorStore } from '../../editor/editorStore';
import { extractSelection, surroundingLines } from '../../editor/useAiAction';

/**
 * AI Workspace — every project's own Central Agent conversation surface.
 * There is NO global chat: the workspace is scoped to the currently open
 * project, shows THAT project's threads, and works through the Central
 * Agent (intent → plan → approval → Fabric execution → verification →
 * evidence). Token-level answers stream as `answer.token` frames;
 * governed work parks on approval and executes server-side.
 *
 * Thread persistence stays in the existing per-project conversation
 * store; each thread's agent session id rides in message metadata.
 * This surface contains ZERO references to the legacy `/stream` chat
 * pipeline (Home quick-chat keeps that path; see AskAuraChatbox).
 */

const SUGGESTIONS = [
  'Explain the architecture of this project.',
  'Find why the login system is failing.',
  'Review this project for security problems.',
  'Create tests for the payment module and run them.',
];

function relTime(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** Optional active-editor snapshot. Project-level first: undefined when
 *  no file is open, and the server treats it as bounded untrusted data. */
function activeEditorContext(): EditorContext | undefined {
  try {
    const { activePath, openFiles } = useEditorStore.getState();
    const file = activePath ? openFiles[activePath] : undefined;
    if (!file || !file.content) return undefined;
    return {
      filePath: file.path,
      language: file.language,
      cursor: { line: file.cursor.line, column: file.cursor.column },
      selection: file.selection ?? undefined,
      selectedCode: extractSelection(file.content, file.selection),
      surrounding: surroundingLines(file.content, file.selection),
      action: 'ask',
    };
  } catch {
    return undefined;
  }
}

export function AiWorkspace() {
  const setNav = useAppStore((s) => s.setNav);
  const openId = useWorkspace((s) => s.openId);
  const project = useWorkspace((s) => s.projects.find((p) => p.id === s.openId));
  const conv = useAgentConversations();
  const [dev, setDev] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The conversation store is always scoped to the open project.
  useEffect(() => { void conv.loadForProject(openId, project?.path ?? null); }, [openId, project?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [conv.messages, conv.phase]);

  const streaming = conv.phase !== 'idle';
  const agentDown = conv.agentUp === false;

  if (!openId || !project) {
    return (
      <div className="grid h-full place-items-center p-10">
        <EmptyScreen
          icon="spark"
          title="Open a project to talk to its brain"
          description="AURA has no global chat. Each project has its own conversations. Open a project, then choose Ask AURA."
          action={<Button icon="home" onClick={() => setNav('home')}>Go to Home</Button>}
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
              <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium', conv.agentUp ? 'bg-positive/10 text-positive' : 'bg-attention/12 text-attention')}>
                <span className={cn('h-1.5 w-1.5 rounded-full', conv.agentUp ? 'bg-positive aura-live' : 'bg-attention')} />
                {conv.agentUp ? 'Agent connected' : conv.agentUp === false ? 'Agent unavailable' : 'Connecting…'}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[12px] text-text-muted">Central Agent · project work with plans, approvals and evidence</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button onClick={() => setDev((d) => !d)} className={cn('inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors', dev ? 'bg-accent-50 text-accent-700 dark:bg-accent/15 dark:text-accent-200' : 'text-text-muted hover:bg-surface-hover hover:text-text')}>
            <Icon name="cpu" size={14} /> Developer
          </button>
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
              {agentDown && conv.messages.length === 0 ? (
                <div role="alert" className="rounded-xl border border-danger/25 bg-danger/5 px-4 py-3 text-[13px] text-danger">
                  Central Agent service is not reachable right now. Start AURA's backend and reload this view — no request has been sent.
                </div>
              ) : conv.messages.length === 0 ? (
                <EmptyState onPick={(t) => void conv.send(t, { editorContext: activeEditorContext() })} disabled={streaming} project={project.name} />
              ) : (
                <div className="space-y-6">
                  {conv.messages.map((m, i) => (
                    <MessageView
                      key={m.id}
                      message={m}
                      isLast={i === conv.messages.length - 1}
                      working={streaming}
                      canRegenerate={!streaming}
                      onRegenerate={() => void conv.regenerate()}
                      onAnswer={(t) => void conv.answer(t)}
                      onDecide={(granted) => void conv.decide(m.id, granted)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
          <Composer streaming={streaming} onSend={(t) => void conv.send(t, { editorContext: activeEditorContext() })} onStop={conv.stop} />
        </div>

        <aside className="hidden min-h-0 overflow-y-auto border-l border-line bg-surface/40 xl:block">
          <SidePanel message={[...conv.messages].reverse().find((m) => m.role === 'assistant')} dev={dev} />
        </aside>
      </div>
    </div>
  );
}

/* ── Conversations rail (project-scoped) ─────────────────────────── */
function ConversationsRail({ conversations, activeId, onSelect, onNew, onRename, onRemove }: {
  conversations: { id: string; title: string; messageCount: number; updatedAt: string }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, t: string) => void;
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
        <h2 className="text-[20px] font-semibold text-text">Ask AURA to work on {project}</h2>
        <p className="mx-auto mt-2 max-w-md text-[13.5px] text-text-muted">The Central Agent understands the project, plans the work, and performs governed changes with verification and evidence.</p>
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
function MessageView({ message, isLast, working, canRegenerate, onRegenerate, onAnswer, onDecide }: {
  message: AgentChatMessage;
  isLast: boolean;
  working: boolean;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onAnswer: (text: string) => void;
  onDecide: (granted: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [answerText, setAnswerText] = useState('');
  const [deciding, setDeciding] = useState(false);
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[13.5px] leading-relaxed text-white shadow-sm">{message.content}</div>
      </div>
    );
  }

  const agent = message.agent;
  const thinking = message.status === 'streaming' && message.content.length === 0;
  const copy = async () => { try { await navigator.clipboard.writeText(message.content); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* noop */ } };
  const lifecycle = agent?.outcome
    ? phaseForResult(agent.outcome)
    : agent && agent.events.length > 0
      ? phaseFromEvents(agent.events)
      : message.status === 'streaming' ? ('intent' as const) : ('idle' as const);

  return (
    <div className="flex gap-3">
      <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent-50 text-accent dark:bg-accent/15"><Icon name="spark" size={16} /></div>
      <div className="min-w-0 flex-1">
        {(message.status === 'streaming' || agent) && (
          <div className="mb-2"><AgentPhaseStrip current={lifecycle} outcome={agent?.outcome ?? undefined} /></div>
        )}
        {thinking ? (
          <ThinkingState label={agent?.progress[agent.progress.length - 1] ?? 'Working'} />
        ) : message.status === 'cancelled' ? (
          <div className="rounded-xl border border-line bg-surface px-4 py-3 text-[13px] text-text-muted">
            Cancelled — the run was stopped and did not continue in the background.
            {isLast && canRegenerate && <button onClick={onRegenerate} className="ml-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline"><Icon name="activity" size={13} /> Retry</button>}
          </div>
        ) : message.status === 'error' ? (
          <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-[13px] text-danger">
            <div className="flex items-center gap-2 font-medium"><Icon name="close" size={14} /> Request failed</div>
            <div className="mt-1 text-[12.5px] text-danger/80">{message.error}</div>
            {canRegenerate && <button onClick={onRegenerate} className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-danger hover:underline"><Icon name="activity" size={13} /> Try again</button>}
          </div>
        ) : (
          <>
            {agent?.outcome && agent.outcome !== 'completed' && (
              <div className="mb-1.5"><Badge tone={agent.outcome === 'awaiting-approval' || agent.outcome === 'needs-clarification' ? 'attention' : agent.outcome === 'failed' || agent.outcome === 'denied' || agent.outcome === 'timeout' ? 'critical' : 'neutral'}>{agent.outcome}</Badge></div>
            )}
            <AiMarkdown source={message.content} />
            {message.status === 'streaming' && <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-accent align-middle" />}
          </>
        )}

        {message.status === 'done' && agent?.needsInput && (
          <form
            className="mt-3 flex max-w-lg items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); const t = answerText.trim(); if (t) { setAnswerText(''); onAnswer(t); } }}
          >
            <Input
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              placeholder="Answer the question above…"
              aria-label="Your clarifying answer"
              className="h-9 flex-1"
            />
            <Button type="submit" size="sm" disabled={!answerText.trim() || working}>Reply</Button>
          </form>
        )}

        {message.status === 'done' && agent?.plan && agent.plan.steps.length > 0 && (
          <ol className="mb-3 mt-3 space-y-1.5 border-y border-line py-3" aria-label="What AURA plans to do">
            {agent.plan.steps.map((s, i) => (
              <li key={s.id} className="flex items-center gap-2 text-[13px] text-text-muted">
                <span className="text-text-subtle">{i + 1}.</span>
                <span className="min-w-0 truncate">{s.action}</span>
                {s.capability && (
                  <code className="rounded bg-surface-active px-1.5 py-0.5 text-[11px] text-text-subtle">{s.capability}</code>
                )}
                <span className="ml-auto shrink-0 text-[11px] uppercase tracking-wide text-text-subtle">{s.risk}</span>
              </li>
            ))}
          </ol>
        )}

        {message.status === 'done' && agent?.approvalId && (
          <AgentApprovalGate
            approvalId={agent.approvalId}
            busy={deciding}
            onDecide={(granted) => { setDeciding(true); onDecide(granted); }}
          />
        )}

        {message.status === 'done' && (agent?.performed.length || agent?.verified.length || agent?.evidenceSummary) ? (
          <div className="mt-3 border-t border-line pt-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-text-subtle">
              {agent.performed.length > 0 && <span className="inline-flex items-center gap-1"><Icon name="activity" size={12} /> {agent.performed.length} performed</span>}
              {agent.verified.length > 0 && <span className="inline-flex items-center gap-1"><Icon name="check" size={12} /> {agent.verified.length} verified</span>}
              {agent.evidenceSummary && <span className="inline-flex items-center gap-1"><Icon name="shield" size={12} /> {agent.evidenceSummary}</span>}
              <div className="ml-auto flex items-center gap-1">
                <button onClick={copy} className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors', copied ? 'text-positive' : 'hover:text-text hover:bg-surface-hover')}><Icon name={copied ? 'check' : 'doc'} size={12} /> {copied ? 'Copied' : 'Copy'}</button>
                {isLast && canRegenerate && <button onClick={onRegenerate} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:text-text hover:bg-surface-hover"><Icon name="activity" size={12} /> Regenerate</button>}
              </div>
            </div>
          </div>
        ) : message.status === 'done' && (
          <div className="mt-3 border-t border-line pt-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-text-subtle">
              <div className="ml-auto flex items-center gap-1">
                <button onClick={copy} className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors', copied ? 'text-positive' : 'hover:text-text hover:bg-surface-hover')}><Icon name={copied ? 'check' : 'doc'} size={12} /> {copied ? 'Copied' : 'Copy'}</button>
                {isLast && canRegenerate && <button onClick={onRegenerate} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:text-text hover:bg-surface-hover"><Icon name="activity" size={12} /> Regenerate</button>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The EXISTING ApprovalGate fed the agent ledger's real request. */
function AgentApprovalGate({ approvalId, busy, onDecide }: { approvalId: string; busy: boolean; onDecide: (granted: boolean) => void }) {
  type GateRequest = Parameters<typeof ApprovalGate>[0]['request'];
  const [request, setRequest] = useState<GateRequest | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    centralAgentClient.pendingApprovals()
      .then((list) => {
        if (!alive) return;
        setRequest((list.approvals.find((a) => a.id === approvalId) as unknown as GateRequest) ?? null);
      })
      .catch(() => { if (alive) setRequest(null); });
    return () => { alive = false; };
  }, [approvalId]);
  if (request) return <ApprovalGate request={request} busy={busy} onDecide={(_id, granted) => onDecide(granted)} />;
  if (request === null) {
    return (
      <p role="status" className="mt-3 text-[12.5px] text-text-subtle">
        Loading authorization details… If this persists, the approval list could not be read.
      </p>
    );
  }
  return (
    <p role="alert" className="mt-3 text-[12.5px] text-attention">
      The parked approval was not found in the pending list — it may already be decided elsewhere. Start a new request to continue.
    </p>
  );
}

function ThinkingState({ label }: { label: string }) {
  return (
    <div className="inline-flex flex-col gap-1.5">
      <div className="inline-flex items-center gap-2 text-[13px] text-text-muted">
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => <motion.span key={i} className="h-1.5 w-1.5 rounded-full bg-accent" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }} />)}
        </span>
        {label}
      </div>
    </div>
  );
}

/* ── Composer ────────────────────────────────────────────────────── */
function Composer({ streaming, onSend, onStop }: { streaming: boolean; onSend: (t: string) => void; onStop: () => void }) {
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
            placeholder="Tell AURA what to do with this project…"
            className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13.5px] text-text outline-none placeholder:text-text-subtle"
          />
          {streaming ? (
            <Button size="sm" variant="secondary" icon="close" onClick={onStop}>Stop</Button>
          ) : (
            <Button size="sm" icon="arrow-right" disabled={!text.trim()} onClick={submit}>Send</Button>
          )}
        </div>
        <div className="mt-1.5 px-1 text-[10.5px] text-text-subtle">Enter to send · Shift+Enter for a new line · governed work asks for approval first</div>
      </div>
    </div>
  );
}

/* ── Side panel: agent session ───────────────────────────────────── */
function SidePanel({ message, dev }: { message?: AgentChatMessage; dev: boolean }) {
  const agent = message?.agent;
  return (
    <div className="divide-y divide-line">
      <Section title="Agent session" icon="spark">
        {!agent?.sessionId ? (
          <Empty>Send a request to open a Central Agent session for this thread.</Empty>
        ) : (
          <div className="space-y-2.5 font-mono text-[11px]">
            <Kv k="session" v={agent.sessionId} />
            {agent.outcome && <Kv k="outcome" v={agent.outcome} />}
            {agent.performed.length > 0 && <Kv k="performed" v={agent.performed.join(', ')} />}
            {agent.verified.length > 0 && <Kv k="verified" v={agent.verified.join(', ')} />}
            {agent.evidenceSummary && <Kv k="evidence" v={agent.evidenceSummary} />}
            {agent.events.length > 0 && <Kv k="events" v={String(agent.events.length)} />}
          </div>
        )}
      </Section>

      {agent?.plan && agent.plan.steps.length > 0 && (
        <Section title="Plan" icon="note">
          <div className="space-y-1.5">
            {agent.plan.steps.map((s, i) => (
              <div key={s.id} className="text-[11.5px] text-text-muted">
                <span className="text-text-subtle">{i + 1}. </span>{s.action}
                <div className="mt-0.5 font-mono text-[10.5px] text-text-subtle">
                  {s.capability ? `${s.capability} · ` : ''}{s.risk} · {s.reversible ? 'reversible' : 'irreversible'}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {dev && (
        <Section title="Debug" icon="cpu">
          {!agent ? <Empty>No agent activity on this message yet.</Empty> : (
            <div className="space-y-2.5 font-mono text-[11px]">
              <Kv k="session" v={agent.sessionId ?? '—'} />
              <Kv k="request" v={agent.requestId ?? '—'} />
              <Kv k="outcome" v={agent.outcome ?? '—'} />
              <Kv k="approval" v={agent.approvalId ?? '—'} />
              <Kv k="run" v={agent.runId ?? '—'} />
              {agent.events.length > 0 && (
                <><Label>lifecycle</Label>
                  {agent.events.slice(-12).map((e, i) => <div key={i} className="truncate text-text-subtle" title={e}>{e}</div>)}
                </>
              )}
            </div>
          )}
        </Section>
      )}
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
function Kv({ k, v }: { k: string; v: string }) {
  return <div className="flex gap-2"><span className="w-16 shrink-0 text-text-subtle">{k}</span><span className="min-w-0 flex-1 break-words text-text-muted">{v}</span></div>;
}
