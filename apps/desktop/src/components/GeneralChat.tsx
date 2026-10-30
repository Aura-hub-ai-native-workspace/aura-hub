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
import { useAppStore } from '@aura/core';
import { Button, Icon } from '@aura/ui';
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

export function GeneralChat({ isOpen, onClose, initialMessage }: { isOpen: boolean; onClose: () => void; initialMessage?: string }) {
  const { turns, phase, sessionId, recent, modelStatus, agentUp, load, open, newChat, send, stop, stopRequesting } = useGeneralChat();
  const [input, setInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const openProject = useAppStore((s) => s.openProject);
  const sidebarExpanded = useAppStore((s) => s.sidebarExpanded);
  const refreshProjects = useWorkspace((s) => s.refresh);

  // A message typed on Home starts a fresh conversation; otherwise the latest one is restored.
  useEffect(() => {
    if (!isOpen) return;
    const first = initialMessage?.trim();
    void load().then(() => {
      if (!first) return;
      newChat();
      void send(first);
    });
  }, [isOpen, load, initialMessage, newChat, send]);
  useEffect(() => {
    if (!isOpen) return;
    const t = setTimeout(() => inputRef.current?.focus(), 120);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !creating) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
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

  if (!isOpen) return null;

  // A full page inside the shell, like any chat app: the sidebar and top bar stay, the chat fills the rest.
  return createPortal(
    <motion.div
      role="region" aria-label="Chat" data-testid="general-chat"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}
      className="fixed inset-y-0 right-0 z-[60] flex flex-col bg-canvas"
      style={{ left: sidebarExpanded ? 260 : 52 }}
    >
      <div className="flex shrink-0 items-center justify-between px-5 py-3">
        <button onClick={creating ? undefined : onClose} className="inline-flex items-center gap-1.5 text-[13px] text-text-muted transition-colors hover:text-text">
          <Icon name="chevron-right" size={14} className="rotate-180" />
          Home
        </button>
        <div className="flex items-center gap-1">
          {recent.length > 0 && (
            <div className="relative">
              <Button size="sm" variant="ghost" onClick={() => setShowRecent((v) => !v)}>Earlier</Button>
              {showRecent && (
                <div className="absolute right-0 top-9 z-20 max-h-72 w-72 overflow-y-auto rounded-2xl bg-surface p-1.5">
                  {recent.map((c) => (
                    <button key={c.sessionId} onClick={() => { setShowRecent(false); void open(c.sessionId); }}
                      className={`block w-full rounded-xl px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-surface-hover ${c.sessionId === sessionId ? 'bg-surface-active' : ''}`}>
                      <span className="line-clamp-1 font-medium text-text">{c.title}</span>
                      <span className="text-[11px] text-text-subtle">
                        {c.turns} turn{c.turns === 1 ? '' : 's'}{c.adoptedBy ? ' · became a project' : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <Button size="sm" variant="ghost" onClick={() => { newChat(); inputRef.current?.focus(); }} disabled={phase !== 'idle'}>New chat</Button>
        </div>
      </div>

      <ModelNotice status={modelStatus} />
      {agentUp === false && <p className="px-5 pb-2 text-center text-[12.5px] text-attention">AURA is not reachable right now.</p>}

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto px-5">
        <div className="mx-auto flex max-w-[760px] flex-col gap-8 pb-8 pt-4">
          {turns.map((t) => <Turn key={t.id} turn={t} />)}
          {turns.length === 0 && (
            <div className="pt-[10vh]">
              <h2 className="text-[34px] font-medium tracking-[-0.025em] text-text">What are you thinking of building?</h2>
              <p className="mt-2 text-[15px] text-text-muted">Start anywhere. A half-formed idea is fine, and every answer is researched.</p>
              <div className="mt-8 flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => submit(s)}
                    className="rounded-full bg-surface px-4 py-2 text-[13px] text-text-muted transition-colors hover:bg-surface-active hover:text-text">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-5 pb-5 pt-2">
        <div className="mx-auto max-w-[760px]">
          <AnimatePresence initial={false}>
            {canCreate && phase === 'idle' && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                className="mb-3 flex items-center justify-between gap-3 overflow-hidden rounded-3xl bg-surface px-5 py-3">
                <span className="text-[13px] text-text-muted">This is taking shape. Ready to turn it into a project?</span>
                <Button size="sm" variant="primary" icon="folder" data-testid="create-new-project" onClick={() => setCreating(true)}>Create New Project</Button>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="flex items-end gap-3 rounded-[28px] bg-surface p-3 pl-5 transition-colors focus-within:bg-surface-hover">
            <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} rows={1}
              aria-label="Your message" placeholder="Describe your idea or ask anything…"
              className="max-h-48 min-h-[28px] flex-1 resize-none self-center bg-transparent py-1 text-[15px] text-text outline-none placeholder:text-text-subtle" />
            {phase === 'working'
              ? (
                <button type="button" aria-label={last?.status === 'stopping' ? 'Stopping' : 'Stop'} onClick={() => void stop()} disabled={stopRequesting}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-text text-canvas transition-opacity disabled:opacity-40">
                  <Icon name="close" size={16} />
                </button>
              )
              : (
                <button type="button" aria-label="Send" disabled={!input.trim()} onClick={() => submit()}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-text text-canvas transition-[opacity,transform] enabled:hover:scale-105 enabled:active:scale-95 disabled:opacity-25">
                  <Icon name="arrow-right" size={18} />
                </button>
              )}
          </div>
          <div className="mt-2 text-center text-[11.5px] text-text-subtle">Enter to send · Shift Enter for a new line</div>
        </div>
      </div>
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} sessionId={sessionId} idea={idea} onCreated={(id) => void created(id)} />
    </motion.div>,
    document.body,
  );
}

export function Turn({ turn }: { turn: GeneralTurn }) {
  const consulted = turn.research?.allSources ?? turn.live.sources;
  const working = turn.status === 'streaming' || turn.status === 'stopping';
  const shownText = working ? turn.live.answer : turn.answer;
  return (
    <div className="space-y-3" data-testid="general-turn">
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-3xl bg-surface-active px-5 py-3 text-[15px] leading-relaxed text-text">{turn.question}</div>
      </div>
      <div className="flex gap-3">
        <div className="min-w-0 flex-1 space-y-2.5">
          <StepTrace steps={turn.live.steps} working={working} />

          {turn.status === 'error' ? (
            <div data-testid="general-error" className="rounded-2xl rounded-tl-md border border-critical/30 bg-critical/5 px-4 py-2.5 text-[13px] text-critical">{turn.error}</div>
          ) : (
            <div data-testid="general-answer" className="text-[15px] leading-relaxed">
              {shownText
                ? <AiMarkdown source={linkCitations(shownText, turn.sources)} />
                : turn.status === 'cancelled' ? <span className="text-[12.5px] text-text-subtle">Stopped.</span>
                  : <span className="text-[12.5px] text-text-subtle">…</span>}
              {turn.status === 'cancelled' && shownText && <div className="mt-1.5 text-[11px] text-text-subtle">Stopped before the answer finished.</div>}
            </div>
          )}
          {turn.stopNote && (
            <div role="status" data-testid="general-stop-note" className="text-[11.5px] text-text-muted">{turn.stopNote}</div>
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
    <div className="relative z-10 shrink-0 space-y-1.5 px-5 py-2 sm:px-6" data-testid="model-notice-area">
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
