import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import { AiMarkdown } from '../../../ai/AiMarkdown';
import {
  failureText,
  joinNames,
  outcomeNote,
  type OutcomeTone,
} from '../../../ai/agentNarration';
import type { AgentActivity, AgentChatMessage } from '../../../ai/useAgentConversations';
import { ApprovalGate } from '../../missions/ApprovalGate';
import type { ApprovalRequest } from '../../../ai/fabricClient';

/**
 * ConversationPane — the workspace IS the conversation.
 *
 * This pane replaced a run console: an objective header, a state pill,
 * a timeline of actor rows carrying task ids and lifecycle words, and a
 * result card printing the outcome enum. All of it was true, and none
 * of it was an answer. Saying "Hi" produced a plan review.
 *
 * What is on screen now is the thing the user said and the thing AURA
 * said back. Orchestration still happens and is still observable, but
 * it appears as one quiet line — "Working · using Git and OpenCode" —
 * and only while it is actually happening. The detail did not move
 * somewhere prettier; it stopped being the headline.
 *
 * Honesty rules this component enforces:
 *   • No task ids, run ids, session ids, event names or outcome enums
 *     reach the transcript. Everything technical is translated by
 *     `agentNarration`, which returns nothing when it has no honest
 *     translation rather than inventing one.
 *   • A failed, denied, timed-out or blocked turn says so in its own
 *     words. Nothing is rendered as complete unless the backend said
 *     `completed`.
 *   • The tool line lists only capabilities the backend reported.
 *   • Approvals reuse the existing `ApprovalGate` against the existing
 *     ledger. This pane never decides anything itself.
 */

const TONE_CLASS: Record<OutcomeTone, string> = {
  neutral: 'border-[rgba(125,146,255,0.3)] bg-[rgba(13,19,38,0.7)] text-text-muted',
  attention: 'border-[rgba(255,181,71,0.4)] bg-[rgba(255,181,71,0.09)] text-neon-warning',
  danger: 'border-[rgba(255,93,122,0.42)] bg-[rgba(255,93,122,0.09)] text-neon-danger',
};

const SUGGESTIONS = [
  'What can you do?',
  'Explain what this project does.',
  'Show me the git status.',
  'Review this project for security problems.',
];

/**
 * The quiet line that says what AURA is doing, while it is doing it.
 *
 * `phase` alone decides whether this renders. The tool list deliberately
 * outlives the turn — it is the record of what ran, and the finished
 * answer shows it in its own `ToolTrace` — so keying visibility off the
 * tools too would leave "using Git", under a breathing dot, sitting
 * above the composer long after Git stopped being used.
 */
function ActivityLine({ activity }: { activity: AgentActivity }) {
  if (!activity.phase) return null;
  const tools = activity.tools.length ? `using ${joinNames(activity.tools)}` : null;
  return (
    <p
      data-testid="agent-activity"
      role="status"
      className="flex items-center gap-2 px-1 text-[11.5px] text-text-subtle"
    >
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          activity.awaitingApproval ? 'bg-neon-warning' : 'bg-neon-cyan aura-breathe',
        )}
      />
      <span className="min-w-0 truncate">
        {[activity.phase, tools].filter(Boolean).join(' · ')}
      </span>
    </p>
  );
}

/** What a finished turn used, kept beside the answer rather than above it. */
function ToolTrace({ tools }: { tools: string[] }) {
  const [open, setOpen] = useState(false);
  if (tools.length === 0) return null;
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="tool-trace-toggle"
        className="neon-focus inline-flex items-center gap-1.5 rounded-md text-[11px] text-text-subtle transition-colors hover:text-text-muted"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
        Used {joinNames(tools)}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 border-l border-[rgba(125,146,255,0.22)] pl-3">
          {tools.map((t) => (
            <li key={t} className="text-[11px] text-text-muted">
              {t}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MessageRow({
  message,
  approval,
  onDecide,
  deciding,
}: {
  message: AgentChatMessage;
  approval: ApprovalRequest | null | undefined;
  onDecide: (granted: boolean, reason?: string) => void;
  deciding: boolean;
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end" data-testid="chat-message" data-role="user">
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-[rgba(122,92,255,0.4)] bg-[rgba(122,92,255,0.16)] px-4 py-2.5 text-[13.5px] leading-relaxed text-text">
          {message.content}
        </div>
      </div>
    );
  }

  const note = outcomeNote(message.agent?.outcome);
  const streaming = message.status === 'streaming';
  const tools = message.agent?.tools ?? [];

  return (
    <div className="flex gap-3" data-testid="chat-message" data-role="assistant">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-[rgba(122,92,255,0.45)] bg-[rgba(122,92,255,0.14)] text-[#c9bcff]">
        <Icon name="spark" size={14} />
      </span>
      <div className="min-w-0 flex-1">
        {message.status === 'error' ? (
          <p
            role="alert"
            data-testid="chat-error"
            className="rounded-xl border border-[rgba(255,93,122,0.42)] bg-[rgba(255,93,122,0.09)] px-3.5 py-2.5 text-[13px] text-neon-danger"
          >
            {failureText(message.error)}
          </p>
        ) : message.status === 'cancelled' ? (
          <p className="text-[13px] text-text-subtle">Stopped.</p>
        ) : (
          <>
            {message.content ? (
              <div className="text-[13.5px] leading-relaxed text-text">
                <AiMarkdown source={message.content} />
              </div>
            ) : streaming ? (
              <span className="inline-block h-4 w-2 animate-pulse rounded-sm bg-neon-cyan align-middle" />
            ) : null}

            {note && (
              <p
                data-testid="outcome-note"
                className={cn('mt-2 rounded-xl border px-3.5 py-2 text-[12.5px]', TONE_CLASS[note.tone])}
              >
                {note.text}
              </p>
            )}

            {/* The existing gate, against the existing ledger. */}
            {message.agent?.approvalId && approval && (
              <ApprovalGate
                request={approval}
                busy={deciding}
                onDecide={(_id, granted, reason) => onDecide(granted, reason)}
              />
            )}
            {message.agent?.approvalId && approval === null && (
              <p className="mt-2 text-[12px] text-text-subtle">
                Loading the authorization details…
              </p>
            )}

            {!streaming && <ToolTrace tools={tools} />}
          </>
        )}
      </div>
    </div>
  );
}

export function ConversationPane({
  messages,
  activity,
  busy,
  agentUp,
  approvals,
  deciding,
  onSend,
  onStop,
  onRegenerate,
  onDecide,
  projectName,
}: {
  messages: AgentChatMessage[];
  activity: AgentActivity;
  busy: boolean;
  /** Liveness of the agent service itself. Null while unknown. */
  agentUp: boolean | null;
  /** approvalId → the pending request, null while still loading. */
  approvals: Record<string, ApprovalRequest | null>;
  deciding: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onRegenerate: () => void;
  onDecide: (messageId: string, granted: boolean, reason?: string) => void;
  /** Shown only so the user knows what AURA is working on. */
  projectName: string | null;
}) {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const empty = messages.length === 0;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, activity.phase]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setText('');
    onSend(trimmed);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const canRegenerate = !busy && lastAssistant && lastAssistant.status !== 'streaming';

  return (
    <section aria-label="Conversation with AURA" className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-[rgba(125,146,255,0.22)] px-6 py-3.5">
        <span className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-text">AURA</h2>
          <p className="truncate text-[11.5px] text-text-subtle">
            {projectName ? `Working in ${projectName}` : 'Ask anything, or tell me what to build'}
          </p>
        </span>
        {agentUp === false && (
          <span
            role="alert"
            data-testid="agent-offline"
            className="shrink-0 rounded-full border border-[rgba(255,181,71,0.42)] bg-[rgba(255,181,71,0.1)] px-2.5 py-1 text-[11px] text-neon-warning"
          >
            AURA is not running
          </span>
        )}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl border border-[rgba(122,92,255,0.45)] bg-[rgba(122,92,255,0.14)] text-[#c9bcff]">
              <Icon name="spark" size={26} />
            </span>
            <div>
              <p className="text-[16px] font-semibold text-text">How can I help?</p>
              <p className="mt-1 text-[12.5px] text-text-muted">
                I can answer questions, or use the tools you have connected to do real work.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onSend(s)}
                  data-testid="chat-suggestion"
                  className="neon-focus rounded-xl border border-[rgba(125,146,255,0.28)] bg-[rgba(13,19,38,0.7)] px-3 py-1.5 text-[12px] text-text-muted transition-colors hover:border-[rgba(32,211,255,0.45)] hover:text-text"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <MessageRow
              key={m.id}
              message={m}
              approval={m.agent?.approvalId ? approvals[m.agent.approvalId] ?? null : undefined}
              deciding={deciding}
              onDecide={(granted, reason) => onDecide(m.id, granted, reason)}
            />
          ))
        )}
      </div>

      <div className="shrink-0 space-y-2 border-t border-[rgba(125,146,255,0.22)] px-6 py-3.5">
        <ActivityLine activity={activity} />
        <div
          className={cn(
            'relative rounded-2xl border bg-[rgba(13,19,38,0.85)] p-3 transition-colors',
            busy
              ? 'border-[rgba(32,211,255,0.35)]'
              : 'border-[rgba(125,146,255,0.32)] focus-within:border-[rgba(125,146,255,0.6)]',
          )}
        >
          <label htmlFor="aura-composer" className="sr-only">
            Message AURA
          </label>
          <textarea
            id="aura-composer"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            data-testid="agent-composer"
            placeholder="Message AURA…"
            className="neon-focus w-full resize-none bg-transparent pr-12 text-[13.5px] leading-relaxed text-text outline-none placeholder:text-text-subtle"
          />
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              data-testid="agent-stop"
              aria-label="Stop"
              className="neon-focus absolute bottom-3 right-3 grid h-9 w-9 place-items-center rounded-xl border border-[rgba(125,146,255,0.4)] text-text-muted transition-colors hover:text-text"
            >
              <Icon name="minimize" size={15} />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!text.trim()}
              data-testid="agent-submit"
              aria-label="Send to AURA"
              className="neon-focus absolute bottom-3 right-3 grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-neon-blue to-neon-violet text-white shadow-glow-blue transition-opacity disabled:opacity-40"
            >
              <Icon name="arrow-right" size={16} />
            </button>
          )}
        </div>
        {canRegenerate && (
          <button
            type="button"
            onClick={onRegenerate}
            data-testid="agent-regenerate"
            className="neon-focus inline-flex items-center gap-1.5 px-1 text-[11px] text-text-subtle transition-colors hover:text-text-muted"
          >
            <Icon name="refresh" size={11} />
            Try again
          </button>
        )}
      </div>
    </section>
  );
}
