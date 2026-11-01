import { useEffect, useRef } from 'react';
import { cn } from '@aura/core';
import { AiMarkdown } from '../../../ai/AiMarkdown';
import { isWorking, type TaskCard, type TimelineItem } from '../../../ai/groupTimeline';

/**
 * The Workspace as a group chat. The CEO (AURA's central agent) is the
 * admin, each worker agent is a member. You are on the right; everyone else
 * is on the left. A worker's card shows the brief it was given and its live
 * terminal lines as they arrive.
 */
export function GroupChat({ items, streaming, status }: {
  items: TimelineItem[];
  streaming: boolean;
  /** One human line that says what is happening right now. */
  status: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const last = items[items.length - 1];
  const lastLines = last?.kind === 'task' ? last.lines.length : 0;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [items.length, lastLines]);

  const working = isWorking(items);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5" data-testid="group-chat">
        {items.map((item) => <GroupItem key={item.id} item={item} />)}
      </div>
      {(streaming || working) && (
        <div role="status" data-testid="group-status" className="flex shrink-0 items-center gap-2 border-t border-line px-5 py-2 text-[12px] text-text-muted">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden />
          <span className="truncate">{status}</span>
        </div>
      )}
    </div>
  );
}

function GroupItem({ item }: { item: TimelineItem }) {
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end" data-testid="chat-message" data-role="user">
        <div className="max-w-[78%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent/15 px-4 py-2.5 text-[13.5px] text-text">
          {item.text}
        </div>
      </div>
    );
  }
  if (item.kind === 'status') {
    return <p className="text-center text-[11.5px] text-text-subtle">{item.text}</p>;
  }
  if (item.kind === 'ceo') {
    return (
      <div className="flex max-w-[86%] gap-2.5" data-testid="chat-message" data-role="assistant">
        <Avatar label="CEO" />
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-[11.5px] font-medium text-text-muted">AURA · CEO</p>
          <div className="rounded-2xl rounded-bl-md border border-line bg-surface/60 px-4 py-2.5 text-[13.5px] text-text">
            {item.status === 'error'
              ? <p className="text-danger">{item.error ?? 'The CEO could not finish this request.'}</p>
              : item.text
                ? <AiMarkdown source={item.text} />
                : <p className="text-text-muted">…</p>}
          </div>
        </div>
      </div>
    );
  }
  return <TaskBubble card={item} />;
}

/** States that mean the worker did not finish its work. */
const FAILED_STATES = new Set(['failed', 'denied', 'timeout', 'blocked', 'cancelled']);

/** Steps AURA runs itself (not coding agents), by what they do. */
const STEP_LABELS: Record<string, string> = {
  'web.research': 'Web search',
  'filesystem.write': 'File write',
  'filesystem.read': 'File read',
  'git.status': 'Git status',
  'git.diff': 'Git diff',
};

function TaskBubble({ card }: { card: TaskCard }) {
  const isAgent = card.capability === null || card.capability === 'agent.delegate';
  const worker = card.worker ?? (isAgent ? 'Worker' : (STEP_LABELS[card.capability ?? ''] ?? card.capability ?? 'Step'));
  const failed = FAILED_STATES.has(card.state);
  const done = card.state === 'done' || card.state === 'verified';
  const label = failed ? 'Failed' : done ? 'Done' : card.state === 'running' ? 'Working' : card.state === 'unverified' ? 'Not verified' : card.state;
  const terminal = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (terminal.current) terminal.current.scrollTop = terminal.current.scrollHeight;
  }, [card.lines.length]);

  return (
    <div className="flex max-w-[92%] gap-2.5" data-testid="task-card" data-state={card.state}>
      <Avatar label={worker.slice(0, 2).toUpperCase()} />
      <div className="min-w-0 flex-1 rounded-2xl rounded-bl-md border border-line bg-surface/40">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <span className="text-[12.5px] font-medium text-text">{worker}</span>
          <span className={cn('rounded-full px-2 py-0.5 text-[10.5px]',
            failed ? 'bg-danger/15 text-danger' : done ? 'bg-positive/15 text-positive' : 'bg-accent/10 text-text-muted')}>
            {label}
          </span>
        </div>
        {card.brief && (
          <details open className="border-b border-line px-4 py-2">
            <summary className="cursor-pointer text-[11.5px] text-text-muted">{isAgent ? `Prompt sent to ${worker}` : 'What it does'}</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[12px] text-text-muted" data-testid="task-brief">{card.brief}</pre>
          </details>
        )}
        <pre
          ref={terminal}
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-black/40 px-4 py-2.5 font-mono text-[11.5px] text-text"
          data-testid="task-terminal"
          aria-label={`${worker} live output`}
        >
          {card.lines.length === 0
            ? <span className="text-text-subtle">{isAgent ? `Waiting for ${worker} to start…` : 'Running…'}</span>
            : card.lines.map((l, i) => (
              <span key={i} className={cn('block', l.stream === 'stderr' && 'text-danger')}>{l.text}</span>
            ))}
        </pre>
        {card.detail && <p className="px-4 py-2 text-[12px] text-text-muted">{card.detail}</p>}
      </div>
    </div>
  );
}

function Avatar({ label }: { label: string }) {
  return (
    <span className="mt-5 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-line bg-surface text-[10px] font-semibold text-text-muted" aria-hidden>
      {label}
    </span>
  );
}
