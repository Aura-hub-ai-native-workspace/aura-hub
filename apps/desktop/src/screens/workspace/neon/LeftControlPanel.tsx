import { Icon, IconButton, type IconName } from '@aura/ui';
import type { ProjectRecord } from '../../../ai/aiClient';
import type { WorkerDescriptor } from '../../../ai/workerClient';
import type { ToolSlot } from '../../../workspace/toolSlots';
import type { WorkerSlot } from '../../../workspace/workerSlots';
import { OrchestrationGraph } from './OrchestrationGraph';

/**
 * LeftControlPanel — the AURA Hub: who AURA can call on, and the one
 * place you talk to it.
 *
 * The rail used to read as an inventory dashboard — a grid of worker
 * cards, a grid of tool cards, and the agent itself as a small strip
 * wedged between them. That inverted the product: the orchestrator
 * looked like one more item in a list of resources. It now reads top to
 * bottom as minds → AURA → tools, with the composer directly beneath,
 * so the thing you address is visibly the thing that commands the rest.
 *
 * Presentational only. Every value comes from WorkspaceScreen props, and
 * every one of them originates in the backend or the saved layout: worker
 * verdicts from `GET /workers`, the three tool slots from the workspace
 * layout resolved against the environment catalogue, the phase line from
 * the existing hub progress.
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
  projects,
  projectId,
  onSelectProject,
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
}: {
  /** The workspace's three active tool slots, filled or empty. */
  toolSlots: ToolSlot[];
  /** The workspace's six worker slots, filled or empty. */
  workerSlots: WorkerSlot[];
  scanning: boolean;
  projects: ProjectRecord[];
  projectId: string | null;
  onSelectProject: (id: string | null) => void;
  /** What AURA is doing, in the conversation's own words. */
  phase: string;
  /** Opens worker management for one slot, or for the rail's own button
      when no slot asked. Never scans the machine. */
  onAddWorker: (index: number | null) => void;
  /** Frees one worker slot. Layout only. */
  onRemoveWorker: (index: number) => void;
  /** Opens worker management to swap one slot's occupant. Layout only. */
  onReplaceWorker: (index: number, workerId: string) => void;
  /** Opens AURA Everything from an empty slot. Never scans the machine. */
  onAddTool: () => void;
  /** Removes a tool from the active workspace. Layout only. */
  onRemoveTool: (nodeId: string) => void;
  /** Opens AURA Everything to swap one slot's occupant. Layout only. */
  onReplaceTool: (index: number, nodeId: string) => void;
  onRelayout: () => void;
  onInspect: (nodeId: string) => void;
  /** Real AI workers, with the backend's own connection verdict. */
  workers: WorkerDescriptor[];
  workersConnecting: string[];
  workersError: string | null;
  /** node id → live lifecycle while the Central Agent holds a task. */
  workerActivity: Map<string, string>;
  onRefreshWorkers: () => void;
  onConnectWorker: (id: string) => void;
  onDisconnectWorker: (id: string) => void;
  /** True while AURA is working, so the graph can breathe. */
  agentBusy: boolean;
}) {
  const connected = workers.filter((w) => w.connected).length;
  const governed = workers.filter((w) => w.governance === 'FULLY_GOVERNED').length;
  const hasProject = Boolean(projectId);

  return (
    <aside
      aria-label="AURA Hub"
      data-testid="left-control-panel"
      className="flex min-h-0 w-full flex-col gap-4"
    >
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
            One Prompt. Multiple Minds.
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

      {/* MINDS → AURA → TOOLS */}
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

      {/* Honest counts, straight from the backend's verdicts. */}
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

      {!hasProject && projects.length > 0 && (
        <label className="flex items-center gap-2 text-[11.5px] text-text-subtle">
          <Icon name="folder" size={13} />
          <span className="sr-only">Select project</span>
          <select
            value={projectId ?? ''}
            onChange={(e) => onSelectProject(e.target.value || null)}
            data-testid="hub-project"
            className="neon-focus min-w-0 flex-1 truncate rounded-md border border-[rgba(125,146,255,0.3)] bg-transparent px-2 py-1 text-text outline-none"
          >
            <option value="">Choose a project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* The rail's own way into worker management, kept for the case a
          slot cannot serve: it says which surface it opens without
          claiming a slot, and the surface fills the first free one (or
          says plainly that there is none). A TOOL has no equivalent
          button, because a tool belongs to a slot and the empty slot
          above already carries its own "+ Add Tool".
          Neither entry point triggers a machine scan: the roster and the
          inventory are already known, and a button labelled "add" should
          not cost twenty seconds of probing. */}
      <button
        type="button"
        onClick={() => onAddWorker(null)}
        data-testid="add-worker-open"
        className="neon-focus inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-[rgba(122,92,255,0.4)] bg-[rgba(122,92,255,0.1)] text-[12px] font-semibold text-[#c9bcff] transition-colors hover:bg-[rgba(122,92,255,0.18)]"
      >
        <Icon name="plus" size={14} />
        Add Worker
      </button>
    </aside>
  );
}

export type LeftDockIcon = IconName;
