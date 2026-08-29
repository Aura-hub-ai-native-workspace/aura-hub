import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { popVariants, scrimVariants, useAppStore } from '@aura/core';
import { Badge, Button, Icon, IconButton } from '@aura/ui';
import { AiMarkdown } from '../ai/AiMarkdown';
import { useWorkspace } from '../data/useWorkspace';
import {
  aiClient, contextUnavailable,
  type ContextFreshness, type ContextView,
} from '../ai/aiClient';

/**
 * AskAuraChatbox — the dashboard's "Ask AURA".
 * ------------------------------------------------------------------
 * Answers come from the real AI service (`POST /stream`), grounded in
 * the open project's context. There are no canned replies: if the
 * service cannot answer, the failure is shown as the failure it is.
 *
 * This component gathers NO repository context of its own. Grounding is
 * the Context Fabric's job — the service assembles it server-side for
 * the mounted project, and this surface only *reports* which project and
 * how fresh that understanding is, so the user can see what an answer
 * rests on.
 *
 * It uses the one `aiClient`. There is no second AI client.
 */

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** A transport/service failure, rendered as an error rather than an answer. */
  failed?: boolean;
}

const SUGGESTIONS = [
  'Explain this project',
  'What changed recently?',
  'Describe the architecture',
  'What is this repository for?',
];

const FRESHNESS_LABEL: Record<ContextFreshness, { label: string; tone: 'positive' | 'attention' | 'neutral' }> = {
  fresh: { label: 'Context fresh', tone: 'positive' },
  stale: { label: 'Context stale', tone: 'attention' },
  unknown: { label: 'Context unknown', tone: 'neutral' },
};

let chatId = 0;
const nextId = () => `ask-aura-${++chatId}`;

export function AskAuraChatbox({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [context, setContext] = useState<ContextView | null>(null);

  const openId = useWorkspace((s) => s.openId);
  const setNav = useAppStore((s) => s.setNav);

  const sending = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* Which project an answer would be grounded in, and how current that
     understanding is. Read-only — opening this chat never mounts or
     indexes anything. */
  useEffect(() => {
    if (!isOpen || !openId) { setContext(null); return; }
    let cancelled = false;
    void aiClient.contextView(openId)
      .then((res) => { if (!cancelled) setContext(contextUnavailable(res) ? null : res); })
      .catch(() => { if (!cancelled) setContext(null); });
    return () => { cancelled = true; };
  }, [isOpen, openId]);

  // Escape to close + body scroll lock (same behaviour as <Dialog>).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  // Focus the composer whenever the chatbox opens.
  useEffect(() => {
    if (!isOpen) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 120);
    return () => window.clearTimeout(t);
  }, [isOpen]);

  // Keep the thread scrolled to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streaming, isOpen]);

  // A closed chat must not keep a stream open against the service.
  useEffect(() => {
    if (isOpen) return;
    abort.current?.abort();
    abort.current = null;
    sending.current = false;
    setStreaming(false);
  }, [isOpen]);

  useEffect(() => () => abort.current?.abort(), []);

  const send = useCallback((raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || sending.current || !openId) return;

    sending.current = true;
    setInput('');
    setStreaming(true);

    const replyId = nextId();
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: text },
      { id: replyId, role: 'assistant', content: '' },
    ]);

    const write = (fn: (m: ChatMsg) => ChatMsg) =>
      setMessages((prev) => prev.map((m) => (m.id === replyId ? fn(m) : m)));

    const ac = new AbortController();
    abort.current = ac;

    void aiClient.stream(
      text,
      {
        onToken: (t) => write((m) => ({ ...m, content: m.content + t })),
        onDone: () => { sending.current = false; setStreaming(false); },
        onError: (e) => {
          sending.current = false;
          setStreaming(false);
          // The real reason, verbatim. Never a canned recovery answer.
          write((m) => ({
            ...m,
            failed: true,
            content: m.content || e.message || 'The AURA service could not answer.',
          }));
        },
      },
      ac.signal,
      { projectId: openId },
    );
  }, [input, openId]);

  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const freshness = context ? FRESHNESS_LABEL[context.freshness] : null;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] grid place-items-center p-0 sm:p-6">
          <motion.div
            variants={scrimVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            onClick={onClose}
            className="absolute inset-0 bg-scrim backdrop-blur-sm"
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Ask AURA"
            variants={popVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="relative flex h-full w-full flex-col overflow-hidden rounded-none border-line bg-surface shadow-[0_24px_90px_-20px_rgba(92,134,255,0.45)] sm:h-[86vh] sm:max-h-[780px] sm:max-w-3xl sm:rounded-3xl sm:border"
          >
            {/* Ambient glow, top-right, same language as the Home hero. */}
            <div className="pointer-events-none absolute -right-20 -top-28 h-72 w-72 rounded-full bg-accent/15 blur-3xl" />

            {/* Header */}
            <div className="relative z-10 flex shrink-0 items-center justify-between gap-4 border-b border-line bg-surface/60 px-5 py-4 backdrop-blur-sm sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-accent-50 text-accent shadow-[0_0_24px_-6px] shadow-accent dark:bg-accent/15">
                  <Icon name="spark" size={20} strokeWidth={1.6} />
                </span>
                <div className="min-w-0">
                  <h2 className="text-[15.5px] font-semibold tracking-[-0.01em] text-text">Ask AURA</h2>
                  {/* What an answer would be grounded in. Stated, not implied. */}
                  <p className="mt-0.5 truncate text-[11px] text-text-muted">
                    {context ? `Grounded in ${context.project.name}` : openId ? 'Reading context…' : 'No project open'}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {freshness && <Badge tone={freshness.tone} dot>{freshness.label}</Badge>}
                <IconButton icon="close" label="Close chat" size="sm" onClick={onClose} />
              </div>
            </div>

            {/* Thread */}
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
              <div className="mx-auto flex max-w-2xl flex-col gap-4">
                {messages.map((m) =>
                  m.role === 'user' ? (
                    <div key={m.id} className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[13.5px] leading-relaxed text-white shadow-[0_8px_24px_-10px] shadow-accent">
                        {m.content}
                      </div>
                    </div>
                  ) : (
                    <div key={m.id} className="flex gap-3">
                      <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent-50 text-accent dark:bg-accent/15">
                        <Icon name="spark" size={15} />
                      </div>
                      <div
                        className={
                          m.failed
                            ? 'min-w-0 flex-1 rounded-2xl rounded-tl-md border border-critical/40 bg-critical/10 px-4 py-2.5 text-[13px] text-critical'
                            : 'min-w-0 flex-1 rounded-2xl rounded-tl-md border border-line bg-surface-hover/60 px-4 py-2.5'
                        }
                      >
                        {m.failed ? (
                          m.content
                        ) : m.content ? (
                          <AiMarkdown source={m.content} />
                        ) : (
                          <div className="flex h-6 items-center gap-1.5">
                            {[0, 1, 2].map((i) => (
                              <motion.span
                                key={i}
                                className="h-1.5 w-1.5 rounded-full bg-accent"
                                animate={{ opacity: [0.25, 1, 0.25], y: [0, -3, 0] }}
                                transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.16 }}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ),
                )}

                {/* No project open: say so and point at the fix. Ask AURA is
                    grounded in a project — answering without one would mean
                    inventing the subject. */}
                {messages.length === 0 && !openId && (
                  <div className="rounded-2xl border border-dashed border-line px-4 py-6 text-center">
                    <Icon name="folder" size={22} className="mx-auto text-text-subtle" />
                    <p className="mt-2 text-[13px] font-medium text-text">No project is open</p>
                    <p className="mx-auto mt-1 max-w-sm text-[12px] leading-relaxed text-text-muted">
                      AURA answers from a project's real code, architecture and history. Open one and
                      its context becomes the ground for every answer here.
                    </p>
                    <Button size="sm" variant="secondary" className="mt-3" onClick={() => { onClose(); setNav('home'); }}>
                      Choose a project
                    </Button>
                  </div>
                )}

                {messages.length === 0 && openId && (
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        onClick={() => send(s)}
                        className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-left text-[12.5px] text-text-muted transition-all hover:border-line-strong hover:text-text"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Composer */}
            <div className="relative z-10 shrink-0 border-t border-line bg-surface/60 px-5 py-4 backdrop-blur-sm sm:px-6">
              <div className="mx-auto max-w-2xl">
                <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-2 shadow-[0_0_0_0] transition-shadow focus-within:border-accent focus-within:shadow-[0_0_24px_-8px] focus-within:shadow-accent/50">
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKey}
                    rows={1}
                    disabled={!openId}
                    placeholder={openId ? 'Ask about this project…' : 'Open a project to ask AURA'}
                    className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13.5px] text-text outline-none placeholder:text-text-subtle disabled:cursor-not-allowed"
                  />
                  <Button size="sm" icon="arrow-right" disabled={!input.trim() || streaming || !openId} onClick={() => send()}>
                    Send
                  </Button>
                </div>
                <div className="mt-1.5 px-1 text-[10.5px] text-text-subtle">
                  Enter to send · Shift+Enter for a new line
                  {context?.contextVersion !== null && context !== null && ` · context v${context.contextVersion}`}
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
