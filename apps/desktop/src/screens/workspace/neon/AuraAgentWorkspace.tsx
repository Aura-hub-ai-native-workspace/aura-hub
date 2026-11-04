import type { ReactNode } from 'react';
import { Icon } from '@aura/ui';
import type { AgentChatMessage } from '../../../ai/useAgentConversations';
import type { Handoff } from '../../../ai/aiClient';
import { buildGroupTimeline, statusLine } from '../../../ai/groupTimeline';
import type { AgentEventFrame } from '../../../ai/centralAgentClient';
import { GroupChat } from './GroupChat';

/** One member of the group: an AI agent, with what it is doing right now. */
export interface GroupMember {
  id: string;
  name: string;
  /** working: running a step now. ready: connected and idle. idle: not connected. */
  tone: 'working' | 'ready' | 'idle';
}

const TONE_DOT: Record<GroupMember['tone'], string> = {
  working: 'bg-neon-warning animate-pulse',
  ready: 'bg-neon-success',
  idle: 'bg-text-subtle',
};

function GroupHeader({ title, members, railOpen, onToggleRail, agentUp }: {
  title: string;
  members: GroupMember[];
  railOpen: boolean;
  onToggleRail: () => void;
  agentUp: boolean | null;
}) {
  const live = members.filter((m) => m.tone !== 'idle');
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-[rgba(152, 152, 152,0.22)] px-5 py-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-line bg-surface text-text-muted" aria-hidden>
        <Icon name="spark" size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-text" data-testid="workspace-chat-title">
          {title}
        </h2>
        <p className="truncate text-[11.5px] text-text-subtle" data-testid="group-members-line">
          AURA (admin){live.length > 0 ? ` · ${live.map((m) => m.name).join(', ')}` : ' · no agents connected yet'}
        </p>
      </span>
      <ul className="hidden items-center -space-x-1.5 sm:flex" aria-label="Members">
        {members.slice(0, 6).map((m) => (
          <li key={m.id} title={`${m.name} · ${m.tone === 'working' ? 'working' : m.tone === 'ready' ? 'ready' : 'not connected'}`}
            className="relative grid h-8 w-8 place-items-center rounded-full border border-line bg-surface text-[11px] font-semibold text-text-muted">
            {m.name.slice(0, 1).toUpperCase()}
            <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-surface ${TONE_DOT[m.tone]}`} />
          </li>
        ))}
      </ul>
      {agentUp === false && (
        <span role="alert" data-testid="agent-offline"
          className="shrink-0 rounded-full border border-[rgba(255,181,71,0.42)] bg-[rgba(255,181,71,0.1)] px-2.5 py-1 text-[11px] text-neon-warning">
          AURA offline
        </span>
      )}
      <button type="button" onClick={onToggleRail} aria-pressed={railOpen} data-testid="rail-toggle"
        className="neon-focus shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-[11.5px] text-text-muted transition-colors hover:text-text">
        {railOpen ? 'Hide members & tools' : 'Members & tools'}
      </button>
    </header>
  );
}

const SUGGESTIONS = [
  'What can you do?',
  'Review this project for issues.',
  'Show me the git status.',
  'Run the tests and tell me what fails.',
];

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
            Task received from Let's Chat
          </p>
          <p className="mt-1 text-[13.5px] leading-relaxed text-text">{h.title}</p>
          {h.notes && (
            <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-text-muted">{h.notes}</p>
          )}
          <div className="mt-2.5 flex items-center justify-between gap-3">
            <span className="text-[11px] text-text-subtle">
              Source: Let's Chat · {h.sourceMessageIds.length} message(s)
            </span>
            <button
              type="button"
              data-testid="handoff-accept"
              onClick={() => onAccept(h)}
              className="neon-focus rounded-lg bg-gradient-to-br from-neon-blue to-neon-violet px-3 py-1.5 text-[12px] font-medium text-on-accent shadow-glow-blue transition-opacity hover:opacity-90"
            >
              Start execution
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function AuraAgentWorkspace({
  messages,
  frames,
  busy,
  agentUp,
  onSend,
  onRegenerate,
  handoffs,
  onAcceptHandoff,
  groupTitle,
  members,
  railOpen,
  onToggleRail,
  composer,
}: {
  messages: AgentChatMessage[];
  frames: AgentEventFrame[];
  busy: boolean;
  agentUp: boolean | null;
  /** Used by idle-state suggestion chips. */
  onSend: (text: string) => void;
  onRegenerate: () => void;
  handoffs: Handoff[];
  onAcceptHandoff: (h: Handoff) => void;
  groupTitle: string;
  members: GroupMember[];
  railOpen: boolean;
  onToggleRail: () => void;
  /** The message box, pinned under the conversation. */
  composer: ReactNode;
}) {
  const empty = messages.length === 0 && !handoffs.some((h) => h.status === 'created');
  const timeline = buildGroupTimeline(messages, frames);

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const canRegenerate = !busy && lastAssistant && lastAssistant.status !== 'streaming';

  return (
    <section aria-label="AURA Agent Workspace" className="flex min-h-0 flex-1 flex-col">
      <GroupHeader title={groupTitle} members={members} railOpen={railOpen} onToggleRail={onToggleRail} agentUp={agentUp} />

      {/* Execution timeline */}
      {empty ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
            <span className="grid h-16 w-16 place-items-center rounded-2xl border border-[rgba(119, 119, 119,0.45)] bg-[rgba(119, 119, 119,0.14)] text-[#c7c7c7]">
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
                  className="neon-focus rounded-xl border border-[rgba(152, 152, 152,0.28)] bg-[rgba(19, 19, 19,0.7)] px-3 py-1.5 text-[12px] text-text-muted transition-colors hover:border-[rgba(162, 162, 162,0.45)] hover:text-text"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <HandoffInbox handoffs={handoffs} onAccept={onAcceptHandoff} />
          <GroupChat items={timeline} streaming={busy} status={statusLine(timeline, busy)} />
        </div>
      )}

      {canRegenerate && (
        <div className="shrink-0 border-t border-[rgba(152, 152, 152,0.22)] px-6 py-2">
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
      <div className="shrink-0" data-testid="chat-composer">{composer}</div>
    </section>
  );
}
