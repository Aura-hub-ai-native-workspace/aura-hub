import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { popVariants, scrimVariants } from '@aura/core';
import { Button, Icon, IconButton } from '@aura/ui';
import { AiMarkdown } from '../ai/AiMarkdown';

/**
 * AskAuraChatbox — the dashboard's "Ask AURA" quick chat.
 * ------------------------------------------------------------------
 * A large, frontend-only chat modal. Everything here is local mock
 * behaviour: typing indicator, streaming answers and canned replies —
 * the backend and its APIs are never touched.
 */

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

const SUGGESTIONS = [
  'What can you do?',
  'How do I add a project?',
  'Explain the AURA Hub architecture',
  'Tips for the frontend',
];

const GREETING = 'Hi! I\'m AURA. How can I help you?';

const MOCK_ANSWERS: { match: RegExp; answer: string }[] = [
  {
    match: /^(hi|hello|hey|yo|good (morning|afternoon|evening))/i,
    answer: `Hello! It's good to hear from you. Here's a quick tour of what I can help with:

- **Projects** — add a real folder, index it, and ask me about its code.
- **Environment** — navigation, shortcuts, panels and settings.
- **Frontend** — structure, theming and UI patterns in this app.

Go ahead and ask me anything.`,
  },
  {
    match: /what can you do|help|capabil|features|about you/i,
    answer: `I can help you get the most out of AURA Hub:

- **Answer questions** about your projects and this environment.
- **Explain code** — structure, entry points, architecture.
- **Point you to the right tool** — command bar, settings, editor.

For deep, project-grounded answers, open a project and use the full **AI Workspace** — it retrieves context from the project's code, system graph and memory.

> This quick chat is a lightweight preview with local responses.`,
  },
  {
    match: /add.*project|new project|import/i,
    answer: `Adding a project is easy:

1. Click **Add Project** on the dashboard.
2. Enter the absolute path of a real folder (in the packaged app, a native folder picker fills it for you).
3. AURA profiles it and starts indexing — languages, frameworks, dependencies and system graph.

After that the project appears under **Continue working**, and you can ask project-specific questions in the AI Workspace.`,
  },
  {
    match: /architect|structure|stack|monorepo|how.*built|works/i,
    answer: `AURA Hub is a **monorepo** with a workspace-based architecture:

- **apps/desktop** — the React + Vite + Tauri shell that renders everything you see.
- **packages/ui** — the shared design system (buttons, cards, icons, dialogs).
- **packages/core** — shared state, motion presets and theming tokens.

The shell is organized around screens, a sidebar, a right context panel, and project-scoped workspaces. Intelligence is kept deliberately separate from the environment chrome.`,
  },
  {
    match: /frontend|design|theme|ui|style|colors|look/i,
    answer: `The frontend is built with **React + Tailwind CSS**, using a semantic theme layer:

- **Dark theme** — deep canvas with layered surfaces.
- **Blue/cyan accents** — glow, rounded corners and soft spring motion.
- **Design tokens** — colors swap in global.css per theme; no hard-coded palette.

Everything is responsive: the sidebar collapses on narrow viewports, and dialogs adapt to small screens.`,
  },
  {
    match: /backend|api|server|database|endpoint/i,
    answer: `AURA Hub's backend concerns (AI provider, indexing, persistence) live outside the shell. This quick chat is **frontend-only** — it answers locally without calling any backend service.

For real backend-grounded answers:

1. Open a project from the dashboard.
2. Use **Ask AURA** there (or the AI Workspace nav).
3. Answers stream from the AI service, grounded in that project's code.`,
  },
];

const FALLBACK =
  `Good question. For a precise answer grounded in real data, open a project and use the **AI Workspace** — it retrieves context from the project's code, system graph and memory.

In the meantime, you can also try the **Command Bar** (\u2318K) to run any action, or ask me about one of these topics:

- What can you do?
- How do I add a project?
- Explain the AURA Hub architecture
- Tips for the frontend`;

let chatId = 0;
const nextId = () => `ask-aura-${++chatId}`;

function mockAnswer(question: string): string {
  const hit = MOCK_ANSWERS.find((m) => m.match.test(question));
  return hit ? hit.answer : FALLBACK;
}

export function AskAuraChatbox({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const seeded = useRef(false);
  const sending = useRef(false);
  const timers = useRef<number[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

  // Stop any pending mock work on unmount.
  useEffect(() => clearTimers, []);

  const send = (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || sending.current) return;
    sending.current = true;
    setInput('');
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', content: text }]);

    setTyping(true);
    const answer = mockAnswer(text);
    timers.current.push(
      window.setTimeout(() => {
        setTyping(false);
        sending.current = false;
        const id = nextId();
        setMessages((prev) => [...prev, { id, role: 'assistant', content: '' }]);
        let i = 0;
        const step = () => {
          i += 2 + Math.floor(Math.random() * 3);
          setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: answer.slice(0, i) } : m)));
          if (i < answer.length) timers.current.push(window.setTimeout(step, 14));
        };
        step();
      }, 550 + Math.random() * 550),
    );
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
                      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-line bg-surface-hover/60 px-4 py-2.5">
                        {m.content ? (
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
