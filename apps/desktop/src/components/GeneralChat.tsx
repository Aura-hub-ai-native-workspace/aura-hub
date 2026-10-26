/**
 * GeneralChat — "Start Building": explore an idea with AURA.
 * ------------------------------------------------------------------
 * A conversation with no project yet. Every question is researched on the
 * web and answered by AURA's reasoning model with what this conversation has
 * already settled in mind. While it works, the rows you see are the pipeline's
 * real events (what it understood, what it read, what it searched, which model
 * it asked); the answer streams as the model writes it; citations are links to
 * real sources, and an answer built without research says so.
 *
 * Nothing here runs or changes anything. When the conversation has produced a
 * goal and at least one requirement or decision, a Create New Project action
 * appears — offered, never forced; it still needs a name and a click.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { popVariants, scrimVariants, useAppStore } from '@aura/core';
import { Button, Icon, IconButton } from '@aura/ui';
import { AiMarkdown } from '../ai/AiMarkdown';
import { linkCitations } from '../ai/chatEvents';
import { useGeneralChat, type GeneralTurn } from '../ai/useGeneralChat';
import type { ModelStatus } from '../ai/centralAgentClient';
import { useWorkspace } from '../data/useWorkspace';
import { NewProjectDialog } from './NewProjectDialog';
import { RecordedNotes, ResearchNotice, SourceList, StepTrace } from './ChatEvidence';

const SUGGESTIONS = [
  'I want to build a habit tracker that works offline',
  'What makes a developer tool stand out from its competitors?',
  'Compare local-first sync approaches for a small desktop app',
  'Is this idea feasible for one person in a month?',
];

export function GeneralChat({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { turns, phase, sessionId, recent, modelStatus, agentUp, load, open, newChat, send, stop } = useGeneralChat();
  const [input, setInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const openProject = useAppStore((s) => s.openProject);
  const refreshProjects = useWorkspace((s) => s.refresh);

  useEffect(() => { if (isOpen) void load(); }, [isOpen, load]);
  useEffect(() => {
    if (!isOpen) return;
    const t = setTimeout(() => inputRef.current?.focus(), 120);
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !creating) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); document.body.style.overflow = ''; window.removeEventListener('keydown', onKey); };
  }, [isOpen, onClose, creating]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [turns, isOpen]);

  const last = turns[turns.length - 1];
  const canCreate = last?.status === 'done' && last.nextActions.includes('create-project');
  // The idea is the first thing said in this conversation.
  const idea = turns[0]?.question ?? '';

  const submit = (text?: string) => {
    const t = (text ?? input).trim();
    if (!t || phase !== 'idle') return;
    setInput('');
    void send(t);
  };
  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  const created = async (projectId: string) => {
    setCreating(false);
    onClose();
    await refreshProjects();
    // Make it the active project; the app's active-project sync is the one
    // thing that mounts it (so there is a single open, and the service's
    // first-open answer reaches the project view, which plays the opening
    // animation and then its Let's Chat).
    openProject(projectId);
  };

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] grid place-items-center p-0 sm:p-6">
          <motion.div variants={scrimVariants} initial="initial" animate="animate" exit="exit" onClick={creating ? undefined : onClose}
            className="absolute inset-0 bg-scrim backdrop-blur-sm" />
          <motion.div
            role="dialog" aria-modal="true" aria-label="Start Building" data-testid="general-chat"
            variants={popVariants} initial="initial" animate="animate" exit="exit"
            className="relative flex h-full w-full flex-col overflow-hidden rounded-none border-line bg-surface shadow-[0_24px_90px_-20px_rgba(92,134,255,0.45)] sm:h-[90vh] sm:max-h-[860px] sm:max-w-3xl sm:rounded-3xl sm:border"
          >
            <div className="pointer-events-none absolute -right-20 -top-28 h-72 w-72 rounded-full bg-accent/15 blur-3xl" />

            <div className="relative z-10 flex shrink-0 items-center justify-between gap-4 border-b border-line bg-surface/60 px-5 py-3.5 backdrop-blur-sm sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-accent-50 text-accent dark:bg-accent/15">
                  <Icon name="spark" size={20} strokeWidth={1.6} />
                </span>
                <div className="min-w-0">
                  <h2 className="text-[15.5px] font-semibold tracking-[-0.01em] text-text">Start Building</h2>
                  <p className="text-[11.5px] text-text-muted">
                    {agentUp === false ? 'AURA is not reachable' : 'Explore an idea. Every answer is researched. Nothing here changes any files.'}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {recent.length > 0 && (
                  <div className="relative">
                    <Button size="sm" variant="ghost" icon="clipboard" onClick={() => setShowRecent((v) => !v)}>Earlier</Button>
                    {showRecent && (
                      <div className="absolute right-0 top-9 z-20 max-h-72 w-72 overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-xl">
                        {recent.map((c) => (
                          <button key={c.sessionId} onClick={() => { setShowRecent(false); void open(c.sessionId); }}
                            className={`block w-full rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors hover:bg-surface-hover ${c.sessionId === sessionId ? 'bg-surface-active' : ''}`}>
                            <span className="line-clamp-1 font-medium text-text">{c.title}</span>
                            <span className="text-[10.5px] text-text-subtle">
                              {c.turns} turn{c.turns === 1 ? '' : 's'}{c.adoptedBy ? ` · became a project` : ''}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <Button size="sm" variant="ghost" icon="plus" onClick={() => { newChat(); inputRef.current?.focus(); }} disabled={phase !== 'idle'}>New</Button>
                <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
              </div>
            </div>

            <ModelNotice status={modelStatus} />

            <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
              <div className="mx-auto flex max-w-2xl flex-col gap-5">
                {turns.map((t) => <Turn key={t.id} turn={t} />)}
                {turns.length === 0 && (
                  <div className="mt-2">
                    <p className="mb-3 text-[13px] text-text-muted">What are you thinking of building? Start anywhere — a half-formed idea is fine.</p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {SUGGESTIONS.map((s) => (
                        <button key={s} onClick={() => submit(s)}
                          className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-left text-[12.5px] text-text-muted transition-all hover:border-line-strong hover:text-text">
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="relative z-10 shrink-0 border-t border-line bg-surface/60 px-5 py-3.5 backdrop-blur-sm sm:px-6">
              <div className="mx-auto max-w-2xl">
                <AnimatePresence initial={false}>
                  {canCreate && phase === 'idle' && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                      className="mb-3 flex items-center justify-between gap-3 overflow-hidden rounded-2xl border border-accent/30 bg-accent/5 px-4 py-2.5">
                      <span className="text-[12.5px] text-text-muted">This is taking shape. Ready to turn it into a project?</span>
                      <Button size="sm" variant="primary" icon="folder" data-testid="create-new-project" onClick={() => setCreating(true)}>Create New Project</Button>
                    </motion.div>
                  )}
                </AnimatePresence>
                <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-2 transition-shadow focus-within:border-accent focus-within:shadow-[0_0_24px_-8px] focus-within:shadow-accent/50">
                  <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} rows={1}
                    aria-label="Your message" placeholder="Describe your idea or ask anything…"
                    className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13.5px] text-text outline-none placeholder:text-text-subtle" />
                  {phase === 'working'
                    ? <Button size="sm" variant="secondary" icon="close" onClick={stop}>Stop</Button>
                    : <Button size="sm" icon="arrow-right" disabled={!input.trim()} onClick={() => submit()}>Send</Button>}
                </div>
                <div className="mt-1.5 px-1 text-[10.5px] text-text-subtle">Enter to send · Shift+Enter for a new line</div>
              </div>
            </div>
          </motion.div>
          <NewProjectDialog open={creating} onClose={() => setCreating(false)} sessionId={sessionId} idea={idea} onCreated={(id) => void created(id)} />
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function Turn({ turn }: { turn: GeneralTurn }) {
  const consulted = turn.research?.allSources ?? turn.live.sources;
  const working = turn.status === 'streaming';
  const shownText = turn.status === 'streaming' ? turn.live.answer : turn.answer;
  return (
    <div className="space-y-3" data-testid="general-turn">
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[13.5px] leading-relaxed text-white shadow-[0_8px_24px_-10px] shadow-accent">{turn.question}</div>
      </div>
      <div className="flex gap-3">
        <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent-50 text-accent dark:bg-accent/15"><Icon name="spark" size={15} /></div>
        <div className="min-w-0 flex-1 space-y-2.5">
          <StepTrace steps={turn.live.steps} working={working} />

          {turn.status === 'error' ? (
            <div data-testid="general-error" className="rounded-2xl rounded-tl-md border border-critical/30 bg-critical/5 px-4 py-2.5 text-[13px] text-critical">{turn.error}</div>
          ) : (
            <div data-testid="general-answer" className="rounded-2xl rounded-tl-md border border-line bg-surface-hover/60 px-4 py-2.5">
              {shownText
                ? <AiMarkdown source={linkCitations(shownText, turn.sources)} />
                : turn.status === 'cancelled' ? <span className="text-[12.5px] text-text-subtle">Stopped.</span>
                  : <span className="text-[12.5px] text-text-subtle">…</span>}
              {turn.status === 'cancelled' && shownText && <div className="mt-1.5 text-[11px] text-text-subtle">Stopped before the answer finished.</div>}
            </div>
          )}

          {turn.status === 'done' && <ResearchNotice research={turn.research} />}
          <SourceList cited={turn.sources} consulted={consulted} />
          <RecordedNotes recorded={turn.recorded} />
          {turn.model?.model && turn.status === 'done' && (
            <div className="text-[10.5px] text-text-subtle">Answered by {turn.model.model}</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The optional local-model suggestion, and the one thing that blocks answers. */
export function ModelNotice({ status }: { status: ModelStatus | null }) {
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem('aura.localModelNotice') === '1'; } catch { return false; } });
  if (!status) return null;
  const dismiss = () => { setDismissed(true); try { localStorage.setItem('aura.localModelNotice', '1'); } catch { /* per-viewer convenience */ } };
  const rec = status.recommendation;
  return (
    <div className="relative z-10 shrink-0 space-y-1.5 border-b border-line px-5 py-2 sm:px-6" data-testid="model-notice-area">
      {!status.laya.configured && (
        <div data-testid="no-model" className="flex items-start gap-2 text-[11.5px] text-attention">
          <Icon name="shield" size={12} className="mt-0.5 shrink-0" />
          <span>
            {status.laya.settings?.configured && !status.laya.settings.callable && status.laya.note
              ? status.laya.note
              : 'No reasoning model is configured, so AURA can show what its research finds but cannot write answers. Connect a provider in Settings.'}
          </span>
        </div>
      )}
      {status.laya.configured && !status.laya.usable && (
        <div data-testid="model-unusable" className="flex items-start gap-2 text-[11.5px] text-attention">
          <Icon name="shield" size={12} className="mt-0.5 shrink-0" />
          <span>{status.laya.note || 'A reasoning model is configured, but AURA cannot reach it right now.'}</span>
        </div>
      )}
      {rec && !dismissed && (
        <div data-testid="local-model-notice" className="rounded-xl border border-line bg-surface-hover/50 px-3 py-2 text-[11.5px] text-text-muted">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              {rec.needsConfiguration ? (
                <p>{rec.note}</p>
              ) : (
                <>
                  <p><span className="font-medium text-text">Optional:</span> a small local model ({rec.model.replace('qwen3.5:2b', 'Qwen3.5 2B')}) can help with lightweight coding, classification and compressing context — offline. AURA works fully without it.</p>
                  {rec.limitations && <p className="text-text-subtle">{rec.limitations}</p>}
                  {rec.compatible && rec.command ? (
                    <p>To add it later: <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-[11px] text-text">{rec.command}</code> (about {rec.approxDownloadMB} MB; AURA never downloads it on its own).</p>
                  ) : (rec.problems?.length ? <p className="text-text-subtle">Not suggested on this machine: {rec.problems.join(' ')}</p> : null)}
                </>
              )}
            </div>
            <button onClick={dismiss} aria-label="Dismiss" className="shrink-0 text-text-subtle transition-colors hover:text-text"><Icon name="close" size={12} /></button>
          </div>
        </div>
      )}
    </div>
  );
}
