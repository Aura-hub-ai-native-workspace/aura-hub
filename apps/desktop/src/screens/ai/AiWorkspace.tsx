import { useEffect, useState, type KeyboardEvent } from 'react';
import { motion } from 'framer-motion';
import { cn, spring, useAppStore } from '@aura/core';
import { Button, Icon, IconButton, Menu } from '@aura/ui';
import { useConversations, type ChatMessage } from '../../ai/useConversations';
import { useWorkspaceConversations } from '../../ai/useAgentConversations';
import { useWorkspace } from '../../data/useWorkspace';
import { AiMarkdown } from '../../ai/AiMarkdown';
import { EmptyState as EmptyScreen } from '../../components/EmptyState';

/**
 * AI Workspace — every project's own Ask AURA advisor.
 * There is NO execution here: this surface is conversational advice
 * over the project's context (files, structure, history, docs) through
 * the existing `/stream` generation pipeline and the existing
 * per-project conversation store. It cannot plan, approve, delegate to
 * workers, or change anything — the same configured provider answers,
 * but with advisory authority only.
 *
 * Governed work lives in the Workspace (`WorkspaceScreen` +
 * `useWorkspaceConversations` + the Central Agent). The bridge between
 * the two is explicit and user-driven: each answer carries a
 * "Send to Workspace" action that offers an objective the Workspace
 * shows as a banner. Nothing is sent, planned, or executed until the
 * user presses Start there.
 *
 * `needs-clarification`, plan reviews, approval gates and outcome enums
 * belong to the execution pipeline and never appear on this screen. A
 * question here gets an answer, not a lifecycle.
 */

const SUGGESTIONS = [
  'Explain the architecture of this project.',
  'What problems do you see in the current architecture?',
  'How should we improve the authentication system?',
  'Suggest how to test the payment module.',
];

function relTime(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** Nearest user turn at or above index `i` — the question an answer advises on. */
function nearestQuestion(messages: ChatMessage[], i: number): string {
  for (let k = i; k >= 0; k--) {
    if (messages[k].role === 'user') return messages[k].content;
  }
  return '';
}

export function AiWorkspace() {
  const setNav = useAppStore((s) => s.setNav);
  const openId = useWorkspace((s) => s.openId);
  const project = useWorkspace((s) => s.projects.find((p) => p.id === s.openId));
  const conv = useConversations();

  // The advisory store is always scoped to the open project.
  useEffect(() => { void conv.loadForProject(openId); }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps

  const streaming = conv.phase !== 'idle';

  /** Offer an answer's question as an explicit Workspace objective. Nothing executes. */
  const sendToWorkspace = (userText: string, assistantText: string) => {
    if (!project) return;
    useWorkspaceConversations.getState().offerHandoff({
      text: `Task from Ask AURA (project "${project.name}"):\n\nQuestion: ${userText}\n\nSuggestion: ${assistantText.slice(0, 800)}`,
      sourceProjectId: openId,
      sourceProjectName: project.name,
      offeredAt: new Date().toISOString(),
    });
    setNav('workspace');
  };

  if (!openId || !project) {
    return (
      <div className="grid h-full place-items-center p-10">
        <EmptyScreen
          icon="spark"
          title="Open a project to talk to its advisor"
          description="Ask AURA advises on one project at a time. Open a project, then choose Ask AURA."
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
              <h1 className="truncate text-[18px] font-semibold tracking-[-0.01em] text-text">Ask AURA</h1>
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-0.5 text-[11px] font-medium text-accent">
                <span className="h-1.5 w-1.5 rounded-full bg-accent aura-live" />
                Project advisor
              </span>
            </div>
            <p className="mt-0.5 truncate text-[12px] text-text-muted">Talk to AURA about {project.name} — explanations, analysis and suggestions. Execution happens in the Workspace.</p>
            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-text-subtle" data-testid="chat-scope" title="Project Ask AURA — this thread belongs to this project only and is never shared with the Workspace or other projects">
              <span className="inline-flex items-center rounded-full border border-line bg-surface px-2 py-0.5 font-medium uppercase tracking-wider">Ask AURA · {project.name} only</span>
            </p>
          </div>
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
          <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
            <div className="mx-auto max-w-3xl">
              {conv.messages.length === 0 ? (
                <EmptyState onPick={(t) => void conv.send(t)} disabled={streaming} project={project.name} />
              ) : (
                <div className="space-y-6">
                  {conv.messages.map((m, i) => (
                    <MessageView
                      key={m.id}
                      message={m}
                      /* The question this answer advises on: nearest user turn above. */
                      question={nearestQuestion(conv.messages, i)}
                      isLast={i === conv.messages.length - 1}
                      canRegenerate={!streaming}
                      onRegenerate={() => void conv.regenerate()}
                      onSendToWorkspace={sendToWorkspace}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
          <Composer streaming={streaming} onSend={(t) => void conv.send(t)} onStop={conv.stop} />
        </div>

        <aside className="hidden min-h-0 overflow-y-auto border-l border-line bg-surface/40 xl:block">
          <ContextPanel projectName={project.name} />
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
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Project conversations</span>
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
        <h2 className="text-[20px] font-semibold text-text">Ask AURA about {project}</h2>
        <p className="mx-auto mt-2 max-w-md text-[13.5px] text-text-muted">Your project advisor: explanations, analysis, tradeoffs and suggested next steps. It advises — it never executes.</p>
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
function MessageView({ message, question, isLast, canRegenerate, onRegenerate, onSendToWorkspace }: {
  message: ChatMessage;
  question: string;
  isLast: boolean;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onSendToWorkspace: (userText: string, assistantText: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  if (message.role === 'user') {
    return (
      <div className="flex justify-end" data-testid="ask-message" data-role="user">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[13.5px] leading-relaxed text-white shadow-sm">{message.content}</div>
      </div>
    );
  }

  const thinking = message.status === 'streaming' && message.content.length === 0;
  const copy = async () => { try { await navigator.clipboard.writeText(message.content); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* noop */ } };

  return (
    <div className="flex gap-3" data-testid="ask-message" data-role="assistant">
      <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent-50 text-accent dark:bg-accent/15"><Icon name="spark" size={16} /></div>
      <div className="min-w-0 flex-1">
        {thinking ? (
          <ThinkingState />
        ) : message.status === 'error' ? (
          <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-[13px] text-danger">
            <div className="flex items-center gap-2 font-medium"><Icon name="close" size={14} /> Request failed</div>
            <div className="mt-1 text-[12.5px] text-danger/80">{message.error?.message ?? 'The request failed.'}</div>
            {canRegenerate && <button onClick={onRegenerate} className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-danger hover:underline"><Icon name="activity" size={13} /> Try again</button>}
          </div>
        ) : (
          <>
            <AiMarkdown source={message.content} />
            {message.status === 'streaming' && <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-accent align-middle" />}
          </>
        )}

        {message.status === 'done' && (
          <div className="mt-3 border-t border-line pt-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-text-subtle">
              <button
                onClick={() => onSendToWorkspace(question, message.content)}
                title="Offer this as an explicit objective to the Workspace. Nothing executes until you start it there."
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:text-text hover:bg-surface-hover"
              >
                <Icon name="arrow-right" size={12} /> Send to Workspace
              </button>
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

function ThinkingState() {
  return (
    <div className="inline-flex flex-col gap-1.5">
      <div className="inline-flex items-center gap-2 text-[13px] text-text-muted">
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => <motion.span key={i} className="h-1.5 w-1.5 rounded-full bg-accent" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }} />)}
        </span>
        Thinking…
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
            data-testid="ask-composer"
            placeholder="Ask AURA about this project…"
            className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13.5px] text-text outline-none placeholder:text-text-subtle"
          />
          {streaming ? (
            <Button size="sm" variant="secondary" icon="close" onClick={onStop}>Stop</Button>
          ) : (
            <Button size="sm" icon="arrow-right" disabled={!text.trim()} onClick={submit}>Send</Button>
          )}
        </div>
        <div className="mt-1.5 px-1 text-[10.5px] text-text-subtle">Enter to send · Shift+Enter for a new line · advice only, nothing is executed</div>
      </div>
    </div>
  );
}

/* ── Side panel: what this surface is ────────────────────────────── */
function ContextPanel({ projectName }: { projectName: string }) {
  return (
    <div className="divide-y divide-line">
      <Section title="Project context" icon="folder">
        <p className="text-[12px] leading-relaxed text-text-muted">
          Ask AURA reads {projectName} — its files, structure and history — and answers from that context.
          This thread belongs to this project only.
        </p>
      </Section>
      <Section title="What Ask AURA does" icon="spark">
        <ul className="space-y-1.5 text-[12px] text-text-muted">
          <li>Explains architecture and tradeoffs</li>
          <li>Analyzes problems and suggests fixes</li>
          <li>Recommends next steps</li>
        </ul>
      </Section>
      <Section title="What it never does" icon="shield">
        <ul className="space-y-1.5 text-[12px] text-text-muted">
          <li>No plans, workers or execution</li>
          <li>No file changes, no commands</li>
          <li>No approvals — nothing to approve</li>
        </ul>
        <p className="mt-2 text-[12px] leading-relaxed text-text-muted">
          To act on advice, use <strong className="text-text">Send to Workspace</strong> under any answer.
          Execution — with plans, approvals and evidence — happens there.
        </p>
      </Section>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: 'folder' | 'spark' | 'shield'; children: React.ReactNode }) {
  return (
    <section className="px-4 py-4">
      <div className="mb-3 flex items-center gap-2 text-text-muted"><Icon name={icon} size={14} /><h4 className="text-[11px] font-semibold uppercase tracking-wider">{title}</h4></div>
      {children}
    </section>
  );
}

export default AiWorkspace;
