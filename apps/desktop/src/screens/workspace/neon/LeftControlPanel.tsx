import { type KeyboardEvent } from 'react';
import { cn } from '@aura/core';
import { Icon, IconButton, type IconName } from '@aura/ui';
import type { WorkerDescriptor } from '../../../ai/workerClient';
import type { ToolSlot } from '../../../workspace/toolSlots';
import type { WorkerSlot } from '../../../workspace/workerSlots';
import { OrchestrationGraph } from './OrchestrationGraph';

/**
 * LeftControlPanel — capability graph and the one composer.
 *
 * The panel shows who AURA can call on (workers above, tools below the
 * central AURA Agent node), then pins the composer at the bottom so the
 * interaction model reads as: compose → AURA → capabilities. The graph
 * scrolls independently; the composer is always reachable without scrolling.
 *
 * Presentational only. Every value comes from WorkspaceScreen props.
 */
export interface RailReadiness {
  connected: number;
  available: number;
  missing: number;
  unscanned: number;
}

export function LeftControlPanel({
  toolSlots,
  workerSlots,
  scanning,
  phase,
  onAddWorker,
  onRemoveWorker,
  onReplaceWorker,
  onAddTool,
  onRemoveTool,
  onReplaceTool,
  onRelayout,
  onInspect,
  workers,
  workersConnecting,
  workersError,
  workerActivity,
  onRefreshWorkers,
  onConnectWorker,
  onDisconnectWorker,
  agentBusy,
  text,
  setText,
  onSend,
  onStop,
  busy,
}: {
  /** The workspace's three active tool slots, filled or empty. */
  toolSlots: ToolSlot[];
  /** The workspace's six worker slots, filled or empty. */
  workerSlots: WorkerSlot[];
  scanning: boolean;
  /** What AURA is doing, in the conversation's own words. */
  phase: string;
  onAddWorker: (index: number | null) => void;
  onRemoveWorker: (index: number) => void;
  onReplaceWorker: (index: number, workerId: string) => void;
  onAddTool: () => void;
  onRemoveTool: (nodeId: string) => void;
  onReplaceTool: (index: number, nodeId: string) => void;
  onRelayout: () => void;
  onInspect: (nodeId: string) => void;
  workers: WorkerDescriptor[];
  workersConnecting: string[];
  workersError: string | null;
  workerActivity: Map<string, string>;
  onRefreshWorkers: () => void;
  onConnectWorker: (id: string) => void;
  onDisconnectWorker: (id: string) => void;
  /** True while AURA is working, so the graph can breathe. */
  agentBusy: boolean;
  /** Composer text value — lifted to WorkspaceScreen so suggestion chips work. */
  text: string;
  setText: (text: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  /** True while AURA is executing — switches send → stop. */
  busy: boolean;
}) {
  const connected = workers.filter((w) => w.connected).length;
  const governed = workers.filter((w) => w.governance === 'FULLY_GOVERNED').length;

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

  return (
    <aside
      aria-label="AURA Hub"
      data-testid="left-control-panel"
      className="flex h-full min-h-0 flex-col"
    >
      {/* Scrollable capability area */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-4">
          {/* Brand */}
          <div className="flex items-center gap-2.5">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-neon-blue to-neon-violet text-white shadow-glow-blue">
              <Icon name="spark" size={20} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[17px] font-semibold tracking-[-0.01em] text-text">
                AURA <span className="text-neon-blue">Hub</span>
              </span>
              <span className="block truncate text-[11.5px] text-text-subtle">
                Sovereign AI Agent
              </span>
            </span>
            <IconButton icon="panel" label="Toggle panel" size="sm" onClick={onRelayout} />
          </div>

          {workersError && (
            <p
              role="alert"
              data-testid="worker-error"
              className="rounded-lg border border-[rgba(255,93,122,0.45)] bg-[rgba(255,93,122,0.1)] px-2.5 py-1.5 text-[11px] text-neon-danger"
            >
              {workersError}
            </p>
          )}

          {/* Capability graph: workers → AURA → tools */}
          <OrchestrationGraph
            workerSlots={workerSlots}
            workerActivity={workerActivity}
            connecting={workersConnecting}
            toolSlots={toolSlots}
            phase={phase}
            busy={agentBusy}
            onConnect={onConnectWorker}
            onDisconnect={onDisconnectWorker}
            onInspect={onInspect}
            onAddWorker={onAddWorker}
            onRemoveWorker={onRemoveWorker}
            onReplaceWorker={onReplaceWorker}
            onAddTool={onAddTool}
            onRemoveTool={onRemoveTool}
            onReplaceTool={onReplaceTool}
          />

          {/* Worker status counts */}
          <p
            data-testid="worker-readiness"
            className="flex items-center justify-center gap-1.5 text-[10.5px] text-text-subtle"
          >
            <span className="font-semibold text-neon-success">{connected}</span> of{' '}
            <span className="font-semibold">{workers.length}</span> connected
            {governed > 0 && (
              <>
                {' · '}
                <span className="font-semibold text-neon-success">{governed}</span> governed live
              </>
            )}
            <button
              type="button"
              onClick={onRefreshWorkers}
              data-testid="worker-refresh"
              className="neon-focus ml-1 inline-flex items-center gap-1 rounded px-1 text-text-muted transition-colors hover:text-text"
            >
              <Icon name="refresh" size={11} />
              {scanning ? 'Reading…' : 'Refresh'}
            </button>
          </p>

          <button
            type="button"
            onClick={() => onAddWorker(null)}
            data-testid="add-worker-open"
            className="neon-focus inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-xl border border-[rgba(125,146,255,0.22)] bg-transparent text-[11.5px] font-medium text-text-subtle transition-colors hover:border-[rgba(122,92,255,0.4)] hover:text-[#c9bcff]"
          >
            <Icon name="plus" size={13} />
            Add Worker
          </button>
        </div>
      </div>

      {/* Composer — always visible at the bottom of the rail */}
      <div className="shrink-0 border-t border-[rgba(125,146,255,0.22)] p-4 pt-3">
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
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            data-testid="agent-composer"
            placeholder="Type your message..."
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
      </div>
    </aside>
  );
}

export type LeftDockIcon = IconName;
