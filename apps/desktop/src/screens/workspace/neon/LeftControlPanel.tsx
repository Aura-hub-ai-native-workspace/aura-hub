import { Icon, IconButton, type IconName } from '@aura/ui';
import type { WorkerDescriptor } from '../../../ai/workerClient';
import type { ToolSlot } from '../../../workspace/toolSlots';
import type { WorkerSlot } from '../../../workspace/workerSlots';
import { AuraComposer } from './AuraComposer';
import { OrchestrationGraph } from './OrchestrationGraph';

/**
 * LeftControlPanel — capability graph and the one composer.
 *
 * The panel shows who AURA can call on (workers above, tools below the
 * central AURA Agent node), then pins the composer at the bottom so the
 * interaction model reads as: compose → AURA → capabilities. The graph
 * scrolls independently; the composer is always reachable without scrolling.
 *
 * The panel itself holds no state: the graph is a pure view over the
 * workspace's slots, and the composer owns everything it needs (its text
 * arrives lifted from WorkspaceScreen so the suggestion chips can send,
 * and its attachment/send controls live in AuraComposer). That boundary
 * is guarded by `addToolFlow.test.ts` — the rail passes callbacks
 * through and holds no replace state.
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
  webResearch,
  onWebResearchChange,
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
  /** Whether this request may reach the web. Held by the screen, passed through. */
  webResearch: boolean;
  onWebResearchChange: (next: boolean) => void;
}) {
  const connected = workers.filter((w) => w.connected).length;
  const governed = workers.filter((w) => w.governance === 'FULLY_GOVERNED').length;

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

      {/* Composer — always visible at the bottom of the rail. The composer
          owns its controls (message box, attachment, send/stop); the rail
          above stays a pure view over workspace state. */}
      <AuraComposer
        text={text}
        onTextChange={setText}
        onSend={onSend}
        onStop={onStop}
        busy={busy}
        webResearch={webResearch}
        onWebResearchChange={onWebResearchChange}
      />
    </aside>
  );
}

export type LeftDockIcon = IconName;
