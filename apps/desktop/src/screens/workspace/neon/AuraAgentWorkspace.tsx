import { useEffect, useRef, useState } from 'react';
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
import type { Handoff } from '../../../ai/aiClient';
import { ApprovalGate } from '../../missions/ApprovalGate';
import type { ApprovalRequest } from '../../../ai/fabricClient';
import type { ProjectRecord } from '../../../ai/aiClient';

const TONE_CLASS: Record<OutcomeTone, string> = {
  neutral: 'border-[rgba(125,146,255,0.3)] bg-[rgba(13,19,38,0.7)] text-text-muted',
  attention: 'border-[rgba(255,181,71,0.4)] bg-[rgba(255,181,71,0.09)] text-neon-warning',
  danger: 'border-[rgba(255,93,122,0.42)] bg-[rgba(255,93,122,0.09)] text-neon-danger',
};

const SUGGESTIONS = [
  'What can you do?',
  'Review this project for issues.',
  'Show me the git status.',
  'Run the tests and tell me what fails.',
];

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

function HandoffInbox({
  handoffs,
  onAccept,
}: {
  handoffs: Handoff[];
  onAccept: (h: Handoff) => void;
}) {
  const offered = handoffs.filter((h) => h.status === 'created');
  if (!offered.length) return null;
  return (
    <div className="space-y-2" data-testid="handoff-panel">
      {offered.map((h) => (
        <div
          key={h.id}
          data-testid="handoff-card"
          className="rounded-xl border border-[rgba(255,181,71,0.4)] bg-[rgba(255,181,71,0.07)] px-4 py-3"
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider text-neon-warning">
            Task received from Project Ask AURA
          </p>
          <p className="mt-1 text-[13.5px] leading-relaxed text-text">{h.title}</p>
          {h.notes && (
            <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-text-muted">{h.notes}</p>
          )}
          <div className="mt-2.5 flex items-center justify-between gap-3">
            <span className="text-[11px] text-text-subtle">
              Source: Ask AURA · {h.sourceMessageIds.length} message(s)
            </span>
            <button
              type="button"
              data-testid="handoff-accept"
              onClick={() => onAccept(h)}
              className="neon-focus rounded-lg bg-gradient-to-br from-neon-blue to-neon-violet px-3 py-1.5 text-[12px] font-medium text-white shadow-glow-blue transition-opacity hover:opacity-90"
            >
              Start execution
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function StageCard({
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
      <div className="flex shrink-0 flex-col items-center">
        <span className="mt-0.5 grid h-7 w-7 place-items-center rounded-lg border border-[rgba(122,92,255,0.45)] bg-[rgba(122,92,255,0.14)] text-[#c9bcff]">
          <Icon name="spark" size={14} />
        </span>
      </div>
      <div className="min-w-0 flex-1 pb-1">
        <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-text-subtle">
          AURA
        </p>
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
              <div className="rounded-xl border border-[rgba(125,146,255,0.2)] bg-[rgba(13,19,38,0.6)] px-4 py-3 text-[13.5px] leading-relaxed text-text">
                <AiMarkdown source={message.content} />
              </div>
            ) : streaming ? (
              <div className="rounded-xl border border-[rgba(32,211,255,0.28)] bg-[rgba(13,19,38,0.6)] px-4 py-3">
                <span className="inline-block h-4 w-2 animate-pulse rounded-sm bg-neon-cyan align-middle" />
              </div>
            ) : null}

            {note && (
              <p
                data-testid="outcome-note"
                className={cn('mt-2 rounded-xl border px-3.5 py-2 text-[12.5px]', TONE_CLASS[note.tone])}
              >
                {note.text}
              </p>
            )}

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

function ActiveStageCard({ activity }: { activity: AgentActivity }) {
  if (!activity.phase) return null;
  const tools = activity.tools.length ? `using ${joinNames(activity.tools)}` : null;
  const workers = Object.keys(activity.workers);
  const workerLabel = workers.length > 0 ? ` · ${workers[0]}` : '';

  return (
    <div className="flex gap-3" data-testid="agent-activity" role="status">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-[rgba(32,211,255,0.45)] bg-[rgba(32,211,255,0.1)] text-neon-cyan">
        <span
          aria-hidden
          className={cn(
            'h-2 w-2 rounded-full',
            activity.awaitingApproval ? 'bg-neon-warning' : 'bg-neon-cyan aura-breathe',
          )}
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-neon-cyan">
          {activity.phase}{workerLabel}
        </p>
        {tools && <p className="text-[12px] text-text-muted">{tools}</p>}
      </div>
    </div>
  );
}

export function AuraAgentWorkspace({
  messages,
  activity,
  busy,
  agentUp,
  approvals,
  deciding,
  onSend,
  onRegenerate,
  onDecide,
  handoffs,
  onAcceptHandoff,
  projects,
  projectId,
  onSelectProject,
}: {
  messages: AgentChatMessage[];
  activity: AgentActivity;
  busy: boolean;
  agentUp: boolean | null;
  approvals: Record<string, ApprovalRequest | null>;
  deciding: boolean;
  /** Used by idle-state suggestion chips. */
  onSend: (text: string) => void;
  onRegenerate: () => void;
  onDecide: (messageId: string, granted: boolean, reason?: string) => void;
  handoffs: Handoff[];
  onAcceptHandoff: (h: Handoff) => void;
  projects: ProjectRecord[];
  projectId: string | null;
  onSelectProject: (id: string | null) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const empty = messages.length === 0 && !handoffs.some((h) => h.status === 'created');

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, activity.phase]);

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const canRegenerate = !busy && lastAssistant && lastAssistant.status !== 'streaming';

  return (
    <section aria-label="AURA Agent Workspace" className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-3 border-b border-[rgba(125,146,255,0.22)] px-6 py-3.5">
        <span className="min-w-0 flex-1">
          <h2
            className="truncate text-[15px] font-semibold tracking-[-0.01em] text-text"
            data-testid="workspace-chat-title"
          >
            AURA Agent Workspace
          </h2>
          <p className="truncate text-[11.5px] text-text-subtle">
            Thinking. Collaborating. Building.
          </p>
        </span>

        {projects.length > 0 && (
          <label className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-text-subtle">
            <Icon name="folder" size={12} />
            <select
              value={projectId ?? ''}
              onChange={(e) => onSelectProject(e.target.value || null)}
              data-testid="hub-project"
              className="neon-focus rounded-md border border-[rgba(125,146,255,0.3)] bg-transparent px-2 py-1 text-[11.5px] text-text outline-none"
            >
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {agentUp === false && (
          <span
            role="alert"
            data-testid="agent-offline"
            className="shrink-0 rounded-full border border-[rgba(255,181,71,0.42)] bg-[rgba(255,181,71,0.1)] px-2.5 py-1 text-[11px] text-neon-warning"
          >
            AURA offline
          </span>
        )}
      </header>

      {/* Execution timeline */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
            <span className="grid h-16 w-16 place-items-center rounded-2xl border border-[rgba(122,92,255,0.45)] bg-[rgba(122,92,255,0.14)] text-[#c9bcff]">
              <Icon name="spark" size={30} />
            </span>
            <div>
              <p className="text-[16px] font-semibold text-text">Ready to execute.</p>
              <p className="mt-1 text-[12.5px] text-text-muted">
                Type a task in the composer — AURA plans, executes and verifies.
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
          <div className="space-y-4">
            <HandoffInbox handoffs={handoffs} onAccept={onAcceptHandoff} />

            {/* Timeline spine */}
            <div className="relative">
              {messages.length > 1 && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute bottom-0 left-3.5 top-8 w-px bg-[rgba(125,146,255,0.15)]"
                />
              )}
              <div className="space-y-5">
                {messages.map((m) => (
                  <StageCard
                    key={m.id}
                    message={m}
                    approval={m.agent?.approvalId ? approvals[m.agent.approvalId] ?? null : undefined}
                    deciding={deciding}
                    onDecide={(granted, reason) => onDecide(m.id, granted, reason)}
                  />
                ))}
                {busy && <ActiveStageCard activity={activity} />}
              </div>
            </div>
          </div>
        )}
      </div>

      {canRegenerate && (
        <div className="shrink-0 border-t border-[rgba(125,146,255,0.22)] px-6 py-2">
          <button
            type="button"
            onClick={onRegenerate}
            data-testid="agent-regenerate"
            className="neon-focus inline-flex items-center gap-1.5 px-1 text-[11px] text-text-subtle transition-colors hover:text-text-muted"
          >
            <Icon name="refresh" size={11} />
            Try again
          </button>
        </div>
      )}
    </section>
  );
}
