import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import type { ProjectRecord } from '../../ai/aiClient';

export interface AgentRow { id: string; name: string; detected: boolean; status: string; drift: string }

const initial = (name: string) => name.trim().charAt(0).toUpperCase();

/** The one thing Home is for: say what you want. A greeting, a question and a large prompt. */
export function PromptHero({ greeting, value, onChange, onSubmit, suggestions }: {
  greeting: string; value: string; onChange: (v: string) => void; onSubmit: (text: string) => void; suggestions: string[];
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const go = () => { const t = value.trim(); if (t) onSubmit(t); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
  };
  return (
    <div>
      <h1 className="text-[44px] font-medium leading-[1.08] tracking-[-0.03em] text-text sm:text-[52px]">
        {greeting}
        <span className="block text-text-subtle">What do you want to build?</span>
      </h1>

      <div className="mt-9 rounded-[28px] bg-surface p-5 transition-colors focus-within:bg-surface-hover">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          rows={3}
          placeholder="Describe an app, ask a question, or point me at a problem…"
          aria-label="Tell AURA what you want to build"
          data-testid="home-prompt"
          className="w-full resize-none bg-transparent text-[17px] leading-relaxed text-text outline-none placeholder:text-text-subtle"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[12px] text-text-subtle">Enter to start · Shift Enter for a new line</span>
          <button
            type="button"
            onClick={go}
            disabled={!value.trim()}
            aria-label="Start"
            data-testid="start-building"
            className="grid h-10 w-10 place-items-center rounded-full bg-text text-canvas transition-[opacity,transform] duration-200 enabled:hover:scale-105 enabled:active:scale-95 disabled:opacity-25"
          >
            <Icon name="arrow-right" size={18} />
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSubmit(s)}
            className="rounded-full bg-surface px-4 py-2 text-[13px] text-text-muted transition-colors hover:bg-surface-active hover:text-text"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Recent projects as a few large, calm cards. No tables, no counts. */
export function ProjectCards({ projects, onOpen, onAdd, onAll, showingAll, relTime }: {
  projects: ProjectRecord[]; onOpen: (id: string) => void; onAdd: () => void; onAll: () => void; showingAll: boolean; relTime: (iso: string | null) => string;
}) {
  return (
    <section>
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold text-text">{projects.length ? 'Pick up where you left off' : 'Start with a folder'}</h2>
        <div className="flex gap-5 text-[13px] text-text-muted">
          {projects.length > 0 && <button onClick={onAll} className="transition-colors hover:text-text">{showingAll ? 'Hide library' : 'All projects'}</button>}
          <button onClick={onAdd} className="transition-colors hover:text-text">Add project</button>
        </div>
      </div>
      {projects.length === 0 ? (
        <button onClick={onAdd} className="flex h-[112px] w-full items-center justify-center rounded-3xl bg-surface text-[14px] text-text-muted transition-colors hover:bg-surface-hover hover:text-text">
          Add a folder and AURA will profile and index it
        </button>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {projects.slice(0, 4).map((p) => (
            <button
              key={p.id}
              onClick={() => onOpen(p.id)}
              className="group flex h-[132px] flex-col justify-between rounded-3xl bg-surface p-5 text-left transition-[background-color,transform] duration-200 hover:-translate-y-0.5 hover:bg-surface-hover"
            >
              <span className="grid h-9 w-9 place-items-center rounded-full bg-surface-active text-[13px] font-semibold text-text" aria-hidden="true">{initial(p.name)}</span>
              <span>
                <span className="block truncate text-[16px] font-semibold tracking-[-0.01em] text-text">{p.name}</span>
                <span className="block truncate text-[12.5px] text-text-muted">{p.language} · {relTime(p.lastOpenedAt)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** The agents, as presence rather than a list: overlapped initials and one sentence. */
export function AgentStrip({ agents, loading, onManage }: { agents: AgentRow[]; loading: boolean; onManage: () => void }) {
  const ready = agents.filter((a) => a.detected);
  const shown = ready.slice(0, 5);
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex shrink-0 -space-x-2" aria-hidden="true">
          {shown.map((a) => (
            <span key={a.id} className="grid h-8 w-8 place-items-center rounded-full bg-surface-active text-[12px] font-semibold text-text ring-2 ring-canvas">{initial(a.name)}</span>
          ))}
        </div>
        <p className={cn('truncate text-[13px] text-text-muted')}>
          {loading ? 'Looking for your agents…' : ready.length ? `${ready.length} agent${ready.length > 1 ? 's' : ''} ready: ${ready.map((a) => a.name).join(', ')}` : 'No AI agents found on this machine yet'}
        </p>
      </div>
      <button onClick={onManage} className="shrink-0 text-[13px] text-text-muted transition-colors hover:text-text">Manage</button>
    </div>
  );
}
