import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { popVariants, scrimVariants, useAppStore } from '@aura/core';
import { Button, Icon, IconButton } from '@aura/ui';
import { AiMarkdown } from '../ai/AiMarkdown';
import { aiClient } from '../ai/aiClient';

/**
 * AskAuraChatbox — the dashboard's "Ask AURA" quick chat.
 * ------------------------------------------------------------------
 * Answers come from the REAL AURA service. This modal used to reply from
 * a table of regex-matched canned answers (`MOCK_ANSWERS`) and, in its own
 * words, "the backend and its APIs are never touched" — so it confidently
 * described the project without ever having looked at it, which is the
 * one failure mode AURA cannot afford.
 *
 * It now streams from the existing `/stream` endpoint through the existing
 * `aiClient`. Nothing about the UI changed, and no second AI client was
 * introduced: the retrieval, repository intelligence and context assembly
 * all happen service-side, exactly as they do for the project's own Ask
 * AURA surface.
 *
 * Context is NOT gathered here. The chatbox passes the canonical
 * `activeProjectId` as scope and the service composes everything else —
 * the Context Fabric seam (`composeContextView`/`renderContextContract`)
 * stays the one place project context is assembled.
 */

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Rendered as an error notice rather than as an answer. */
  error?: boolean;
}

const SUGGESTIONS = [
  'What can you do?',
  'How do I add a project?',
  'Explain the AURA Hub architecture',
  'Tips for the frontend',
];

const GREETING = 'Hi! I\'m AURA. How can I help you?';

let chatId = 0;
const nextId = () => `ask-aura-${++chatId}`;


export function AskAuraChatbox({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const seeded = useRef(false);
  const sending = useRef(false);
  const timers = useRef<number[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** In-flight request, so closing the chat stops the stream. */
  const abortRef = useRef<AbortController | null>(null);

  /* The canonical project, used ONLY as scope for the request. Reading it
     here is a read of the one authority — the chatbox holds no project
     pointer of its own. */
  const activeProjectId = useAppStore((s) => s.activeProjectId);

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  // Seed the greeting once, the first time the chatbox opens.
  useEffect(() => {
    if (!isOpen || seeded.current) return;
    seeded.current = true;
    const id = nextId();
    setMessages([{ id, role: 'assistant', content: '' }]);
    setTyping(true);
    let i = 0;
    const step = () => {
      i += 2 + Math.floor(Math.random() * 3);
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: GREETING.slice(0, i) } : m)));
      if (i < GREETING.length) timers.current.push(window.setTimeout(step, 12));
      else setTyping(false);
    };
    timers.current.push(window.setTimeout(step, 350));
  }, [isOpen]);

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
    timers.current.push(window.setTimeout(() => inputRef.current?.focus(), 120));
  }, [isOpen]);

  // Keep the thread scrolled to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, typing, isOpen]);

  // Stop pending UI timers and any in-flight request on unmount.
  useEffect(() => () => { clearTimers(); abortRef.current?.abort(); }, []);

  // Closing the chat cancels a stream in progress rather than letting it
  // run on invisibly against the provider.
  useEffect(() => {
    if (isOpen) return;
    abortRef.current?.abort();
    abortRef.current = null;
    sending.current = false;
    setTyping(false);
  }, [isOpen]);

  /**
   * Ask the real service.
   *
   * Tokens are appended as they arrive, so what the user watches is the
   * model's actual output rather than a typewriter replaying a fixed
   * string. Failures — no provider, service down, an invalid model — are
   * shown as the service words them; the chatbox never substitutes a
   * cheerful answer for an error, which is what the mock did by design.
   */
  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || sending.current) return;
    sending.current = true;
    setInput('');
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', content: text }]);
    setTyping(true);

    const id = nextId();
    let opened = false;
    /** Create the assistant bubble on first token, so the typing dots show until then. */
    const openBubble = () => {
      if (opened) return;
      opened = true;
      setTyping(false);
      setMessages((prev) => [...prev, { id, role: 'assistant', content: '' }]);
    };

    const controller = new AbortController();
    abortRef.current = controller;

    await aiClient.stream(
      text,
      {
        onToken: (t) => {
          openBubble();
          setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: m.content + t } : m)));
        },
        onError: (e) => {
          setTyping(false);
          setMessages((prev) => {
            const rest = opened ? prev.filter((m) => m.id !== id || m.content.length > 0) : prev;
            return [...rest, { id: nextId(), role: 'assistant', content: e.message, error: true }];
          });
        },
      },
      controller.signal,
      // Scope only. Everything else — retrieval, repository intelligence,
      // context assembly — is the service's job, and stays there.
      activeProjectId ? { projectId: activeProjectId } : undefined,
    );

    setTyping(false);
    sending.current = false;
    abortRef.current = null;
  };

  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

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
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full rounded-full bg-positive aura-live" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-positive" />
                    </span>
                    <span className="text-[11px] font-medium text-text-muted">Online</span>
                  </div>
                </div>
              </div>
              <IconButton icon="close" label="Close chat" size="sm" onClick={onClose} />
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
                        data-testid={m.error ? 'ask-aura-error' : 'ask-aura-answer'}
                        className={
                          m.error
                            // A failure is shown AS a failure. The mock's worst
                            // habit was answering confidently regardless.
                            ? 'min-w-0 flex-1 rounded-2xl rounded-tl-md border border-critical/30 bg-critical/5 px-4 py-2.5 text-[13px] text-critical'
                            : 'min-w-0 flex-1 rounded-2xl rounded-tl-md border border-line bg-surface-hover/60 px-4 py-2.5'
                        }
                      >
                        {m.error ? (
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

                {typing && messages.length > 0 && messages[messages.length - 1].role === 'user' && (
                  <div className="flex gap-3">
                    <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent-50 text-accent dark:bg-accent/15">
                      <Icon name="spark" size={15} />
                    </div>
                    <div className="inline-flex items-center gap-2 rounded-2xl rounded-tl-md border border-line bg-surface-hover/60 px-4 py-3">
                      <span className="flex gap-1">
                        {[0, 1, 2].map((i) => (
                          <motion.span
                            key={i}
                            className="h-1.5 w-1.5 rounded-full bg-accent"
                            animate={{ opacity: [0.25, 1, 0.25], y: [0, -3, 0] }}
                            transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.16 }}
                          />
                        ))}
                      </span>
                      <span className="text-[12.5px] text-text-muted">AURA is thinking…</span>
                    </div>
                  </div>
                )}

                {messages.length === 0 && (
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
                    placeholder="Ask AURA anything..."
                    className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13.5px] text-text outline-none placeholder:text-text-subtle"
                  />
                  <Button size="sm" icon="arrow-right" disabled={!input.trim() || typing} onClick={() => send()}>
                    Send
                  </Button>
                </div>
                <div className="mt-1.5 px-1 text-[10.5px] text-text-subtle">Enter to send · Shift+Enter for a new line · local preview responses</div>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
