import type { MouseEvent } from 'react';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import { AuraLogo } from '../../../brand/AuraLogo';
import { CATEGORY_ICON, CATEGORY_LABEL, STATUS_LABEL } from '../../../environment/presentation';
import type { NodeCategory } from '@aura/connected-environment';
import { ACTIVE_TOOL_SLOTS, WORKER_SLOTS } from '../../../workspace/hubStore';
import type { ToolSlot } from '../../../workspace/toolSlots';
import {
  workerSlotCaption,
  workerSlotName,
  type WorkerSlot,
} from '../../../workspace/workerSlots';

/**
 * OrchestrationGraph — the product story, drawn once.
 *
 * Minds above, AURA in the middle, tools below, joined by lines that run
 * only through the centre. That shape is the claim the whole system
 * rests on: a worker never hands work to another worker, and never picks
 * up a tool by itself — everything goes through AURA, which is why there
 * is a place to put policy, approval and verification at all. Drawing a
 * line from one worker to another would picture a system this product
 * deliberately does not run.
 *
 * The lines are CSS, not a graph engine. Nothing here holds state: the
 * worker tiles restate `GET /workers`, the tool slots restate the saved
 * workspace layout, and the centre restates the agent's own phase.
 *
 * BOTH ROWS ARE SLOTS. The worker row used to draw `workers.slice(0, 6)`
 * — whatever the backend listed first, unchangeable — while the tool row
 * below it was already a chosen, persisted, editable set. The two rows
 * are the same kind of thing to a user, so they now behave the same way:
 * six worker slots, filled or empty, each one add-able, replaceable and
 * freeable, and none of it touching the machine.
 *
 * The tool row is a FIXED THREE SLOTS — filled or empty, always drawn.
 * It used to render `tools.slice(0, 3)`, which quietly collapsed to two
 * tiles, or none, and left nothing to click. Three slots say what the
 * workspace holds and, just as importantly, what it has room for; an
 * empty one is the only place a tool is added from the graph. The slots
 * are the user's active workspace tools, never a catalogue listing, and
 * a fourth can never appear because there is no fourth slot to draw.
 *
 * A filled slot carries two small controls: replace its occupant, or
 * free it. Replace is what keeps the row honest at capacity — with three
 * tools placed there is no empty slot to add from, and without it the
 * only way to change your mind would be to remove a tool first and hope
 * the surface offered what you wanted.
 */

const LIFECYCLE_DOT: Record<string, string> = {
  CONNECTED: 'bg-neon-success',
  ACTIVE: 'bg-neon-cyan',
  PARKED: 'bg-neon-warning',
  FAILED: 'bg-neon-danger',
  TERMINATED: 'bg-neon-danger',
  COMPLETED: 'bg-neon-success',
  CANCELLED: 'bg-neon-warning',
};

/**
 * Initials from the worker's own name — "OpenCode" → "OC".
 *
 * A recognisable mark per worker without shipping vendor logos we do not
 * have, and without inventing a capability word to fill the space. It is
 * derived from the name the backend reports and nothing else.
 */
function monogram(name: string): string {
  const parts = name.split(/[\s-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  const compact = name.replace(/[^A-Za-z]/g, '');
  const caps = compact.replace(/[^A-Z]/g, '');
  if (caps.length >= 2) return caps.slice(0, 2);
  return compact.slice(0, 2).toUpperCase();
}

/**
 * Short, honest caption for a filled worker slot.
 *
 * A live lifecycle word wins while a task is in flight, because that is
 * the most specific true thing on screen. Everything else comes from
 * `workerSlotCaption`, which reads the backend's verdict and says
 * "Unknown" rather than guessing when there is no verdict yet.
 */
function workerCaption(slot: WorkerSlot, live: string | null): string {
  if (live) return live.charAt(0) + live.slice(1).toLowerCase();
  return workerSlotCaption(slot);
}

/** Keeps a control's click off the tile it sits on. */
function only(run: () => void) {
  return (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    run();
  };
}

function FilledWorkerSlot({
  slot,
  live,
  busy,
  onConnect,
  onDisconnect,
  onRemove,
  onReplace,
}: {
  slot: WorkerSlot;
  live: string | null;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
  onReplace: () => void;
}) {
  const worker = slot.worker;
  const name = workerSlotName(slot);
  const on = slot.state === 'ACTIVE';
  const state = live ?? (on ? 'CONNECTED' : '');
  const dot = LIFECYCLE_DOT[state] ?? 'bg-text-subtle';
  const caption = workerCaption(slot, live);

  return (
    <div
      className="group relative flex min-w-0 flex-col items-center text-center"
      data-testid="worker-slot"
      data-slot-index={slot.index}
      data-slot-state={slot.state}
      data-worker-id={slot.workerId ?? undefined}
    >
      <button
        type="button"
        onClick={on ? onDisconnect : onConnect}
        disabled={busy || (!on && slot.state !== 'SELECTED')}
        data-testid="worker-tile"
        data-worker-id={slot.workerId ?? undefined}
        data-connected={on}
        title={
          on
            ? `${name} — connected. ${worker?.detail || ''}`.trim()
            : `${name} — ${worker?.reason || caption.toLowerCase()}. ${worker?.detail || ''}`.trim()
        }
        className={cn(
          'neon-focus relative grid h-[68px] w-[68px] place-items-center rounded-2xl border transition-all duration-150 disabled:cursor-not-allowed',
          on
            ? 'border-[rgba(122,92,255,0.55)] bg-[rgba(122,92,255,0.12)] shadow-glow-violet hover:border-[rgba(122,92,255,0.8)]'
            : 'border-[rgba(125,146,255,0.22)] bg-[rgba(13,19,38,0.9)] hover:border-[rgba(125,146,255,0.45)]',
        )}
      >
        <span
          className={cn(
            'text-[20px] font-semibold tracking-tight',
            on ? 'text-[#c9bcff]' : 'text-text-subtle',
          )}
        >
          {monogram(name)}
        </span>
        <span
          aria-hidden
          className={cn(
            'absolute right-1.5 top-1.5 h-2 w-2 rounded-full',
            dot,
            (state === 'ACTIVE' || busy) && 'aura-breathe',
          )}
        />
      </button>
      <span className="mt-2 w-full truncate text-[12px] font-semibold text-text">{name}</span>
      <span
        className={cn(
          'w-full truncate text-[10.5px]',
          on ? 'text-neon-success' : 'text-text-subtle',
        )}
      >
        {caption}
      </span>

      {/* Swap this slot's occupant. The way to change your mind with all
          six taken, so choosing a different worker never costs a removal
          first. Opens the existing worker surface and nothing else. */}
      <button
        type="button"
        onClick={only(onReplace)}
        data-testid="worker-slot-replace"
        data-slot-index={slot.index}
        data-worker-id={slot.workerId ?? undefined}
        aria-label={`Replace ${name} in this workspace`}
        title={`Replace ${name} in worker slot ${slot.index + 1}. Nothing is uninstalled.`}
        className="neon-focus absolute -left-1 -top-1 grid h-5 w-5 place-items-center rounded-full border border-[rgba(122,92,255,0.4)] bg-[rgba(9,13,26,0.95)] text-text-subtle opacity-0 transition-opacity duration-150 hover:text-[#c9bcff] focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Icon name="refresh" size={10} />
      </button>

      {/* Frees the slot, and nothing else. The runtime stays installed,
          stays in the catalogue, and keeps whatever connection AURA
          already proved — this is a workspace layout edit. */}
      <button
        type="button"
        onClick={only(onRemove)}
        data-testid="worker-slot-remove"
        data-slot-index={slot.index}
        data-worker-id={slot.workerId ?? undefined}
        aria-label={`Remove ${name} from workspace`}
        title={`Remove ${name} from this workspace. Nothing is uninstalled or disconnected.`}
        className="neon-focus absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full border border-[rgba(125,146,255,0.32)] bg-[rgba(9,13,26,0.95)] text-text-subtle opacity-0 transition-opacity duration-150 hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Icon name="close" size={10} />
      </button>
    </div>
  );
}

/**
 * An empty worker slot. Deliberately the same restraint as an empty tool
 * slot: an invitation the size of the thing it would hold, opening the
 * existing worker surface without measuring anything.
 */
function EmptyWorkerSlot({ index, onAddWorker }: { index: number; onAddWorker: () => void }) {
  return (
    <div
      className="flex min-w-0 flex-col items-center text-center"
      data-testid="worker-slot"
      data-slot-index={index}
      data-slot-state="EMPTY"
    >
      <button
        type="button"
        onClick={onAddWorker}
        data-testid="worker-slot-add"
        data-slot-index={index}
        aria-label={`Add a worker to slot ${index + 1}`}
        title="Add an AI worker to this workspace"
        className="neon-focus flex min-w-0 flex-col items-center text-center"
      >
        <span className="grid h-[68px] w-[68px] place-items-center rounded-2xl border border-dashed border-[rgba(125,146,255,0.28)] bg-[rgba(10,16,34,0.55)] text-text-subtle transition-colors duration-150 hover:border-[rgba(122,92,255,0.5)] hover:text-[#c9bcff]">
          <Icon name="plus" size={18} />
        </span>
        <span className="mt-2 w-full truncate text-[12px] font-medium text-text-subtle">
          Add Worker
        </span>
      </button>
    </div>
  );
}

/**
 * How a filled slot reads. Every value here comes from the environment
 * node's own fields — nothing is inferred about installation, verification
 * or readiness, and `SELECTED` deliberately makes no claim at all.
 */
const SLOT_RING: Record<Exclude<ToolSlot['state'], 'EMPTY'>, string> = {
  ACTIVE: 'border-[rgba(32,211,255,0.55)] bg-[rgba(10,26,36,0.92)] text-neon-cyan shadow-glow-cyan',
  SELECTED: 'border-[rgba(32,211,255,0.28)] bg-[rgba(10,20,30,0.9)] text-neon-cyan',
  UNAVAILABLE: 'border-[rgba(255,181,71,0.34)] bg-[rgba(26,20,10,0.85)] text-neon-warning',
};

const SLOT_CAPTION: Record<Exclude<ToolSlot['state'], 'EMPTY'>, string> = {
  ACTIVE: 'text-neon-success',
  SELECTED: 'text-text-subtle',
  UNAVAILABLE: 'text-neon-warning',
};

/** The slot's second line: the node's real status, or why it cannot answer. */
function slotCaption(slot: ToolSlot): string {
  if (!slot.node) return 'Not in catalogue';
  if (slot.node.connected) return 'Connected';
  return STATUS_LABEL[slot.node.health.status];
}

function FilledSlot({
  slot,
  onInspect,
  onRemove,
  onReplace,
}: {
  slot: ToolSlot;
  onInspect: () => void;
  onRemove: () => void;
  onReplace: () => void;
}) {
  const state = slot.state as Exclude<ToolSlot['state'], 'EMPTY'>;
  const name = slot.node?.entry.name ?? slot.nodeId ?? '';
  const category = slot.node
    ? CATEGORY_LABEL[slot.node.entry.category as NodeCategory] ?? 'Tool'
    : 'Tool';

  return (
    <div
      className="group relative flex min-w-0 flex-col items-center gap-1.5 text-center"
      data-testid="tool-slot"
      data-slot-index={slot.index}
      data-slot-state={state}
      data-node-id={slot.nodeId ?? undefined}
    >
      <button
        type="button"
        onClick={onInspect}
        data-testid="hub-node"
        data-node-id={slot.nodeId ?? undefined}
        title={`${name} — ${category}. ${slotCaption(slot)}`}
        className="neon-focus flex min-w-0 flex-col items-center gap-1.5 text-center"
      >
        <span
          className={cn(
            'grid h-[56px] w-[56px] place-items-center rounded-2xl border transition-colors duration-150 hover:border-[rgba(32,211,255,0.55)]',
            SLOT_RING[state],
          )}
        >
          <Icon
            name={slot.node ? CATEGORY_ICON[slot.node.entry.category as NodeCategory] : 'code'}
            size={22}
          />
        </span>
        <span className="w-full truncate text-[11.5px] font-semibold text-text">{name}</span>
        <span className={cn('w-full truncate text-[10px]', SLOT_CAPTION[state])}>
          {slotCaption(slot)}
        </span>
      </button>

      {/* Swap this slot's occupant. The only way back to AURA Everything
          once all three slots are taken, and the reason removing a tool
          first is no longer the price of changing your mind. Opening the
          surface costs nothing: no scan, no probe, no install. */}
      <button
        type="button"
        onClick={onReplace}
        data-testid="tool-slot-replace"
        data-slot-index={slot.index}
        data-node-id={slot.nodeId ?? undefined}
        aria-label={`Replace ${name} in this workspace`}
        title={`Replace ${name} in slot ${slot.index + 1}. Nothing is installed or uninstalled.`}
        className="neon-focus absolute -left-1 -top-1 grid h-5 w-5 place-items-center rounded-full border border-[rgba(32,211,255,0.34)] bg-[rgba(9,13,26,0.95)] text-text-subtle opacity-0 transition-opacity duration-150 hover:text-neon-cyan focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Icon name="refresh" size={10} />
      </button>

      {/* Frees the slot, and nothing else. The tool stays installed, stays
          in the catalogue, and stays in the machine inventory — this is a
          workspace layout edit, not a change to the machine. */}
      <button
        type="button"
        onClick={onRemove}
        data-testid="tool-slot-remove"
        data-node-id={slot.nodeId ?? undefined}
        aria-label={`Remove ${name} from workspace`}
        title={`Remove ${name} from this workspace. Nothing is uninstalled.`}
        className="neon-focus absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full border border-[rgba(125,146,255,0.32)] bg-[rgba(9,13,26,0.95)] text-text-subtle opacity-0 transition-opacity duration-150 hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Icon name="close" size={10} />
      </button>
    </div>
  );
}

/**
 * An empty slot. Restrained on purpose — it is an invitation, not a
 * call to action competing with the agent above it. It opens AURA
 * Everything; it never scans the machine and never installs anything.
 */
function EmptySlot({ index, onAddTool }: { index: number; onAddTool: () => void }) {
  return (
    <div
      className="flex min-w-0 flex-col items-center gap-1.5 text-center"
      data-testid="tool-slot"
      data-slot-index={index}
      data-slot-state="EMPTY"
    >
      <button
        type="button"
        onClick={onAddTool}
        data-testid="tool-slot-add"
        data-slot-index={index}
        aria-label="Add tool to workspace"
        title="Add a tool to this workspace"
        className="neon-focus flex min-w-0 flex-col items-center gap-1.5 text-center"
      >
        <span className="grid h-[56px] w-[56px] place-items-center rounded-2xl border border-dashed border-[rgba(125,146,255,0.28)] bg-[rgba(10,16,34,0.55)] text-text-subtle transition-colors duration-150 hover:border-[rgba(32,211,255,0.45)] hover:text-neon-cyan">
          <Icon name="plus" size={18} />
        </span>
        <span className="w-full truncate text-[11.5px] font-medium text-text-subtle">
          Add Tool
        </span>
      </button>
    </div>
  );
}

/** One connector: down out of a tile, across, and into the centre. */
function Connectors({ count, direction }: { count: number; direction: 'down' | 'up' }) {
  if (count === 0) return null;
  return (
    <div aria-hidden className="relative h-7 w-full">
      <span
        className={cn(
          'absolute left-1/2 h-full w-px -translate-x-1/2',
          direction === 'down'
            ? 'bg-gradient-to-b from-[rgba(122,92,255,0.5)] to-[rgba(77,124,255,0.55)]'
            : 'bg-gradient-to-b from-[rgba(77,124,255,0.55)] to-[rgba(32,211,255,0.45)]',
        )}
      />
      {count > 1 && (
        <>
          <span
            className={cn(
              'absolute top-1/2 h-px',
              direction === 'down'
                ? 'left-[16%] right-[16%] bg-[rgba(122,92,255,0.35)]'
                : 'left-[16%] right-[16%] bg-[rgba(32,211,255,0.3)]',
            )}
          />
          <span className="absolute left-[16%] top-1/2 h-1/2 w-px bg-[rgba(122,92,255,0.28)]" />
          <span className="absolute right-[16%] top-1/2 h-1/2 w-px bg-[rgba(122,92,255,0.28)]" />
          {direction === 'down' && (
            <>
              <span className="absolute left-[16%] top-0 h-1/2 w-px bg-[rgba(122,92,255,0.28)]" />
              <span className="absolute right-[16%] top-0 h-1/2 w-px bg-[rgba(122,92,255,0.28)]" />
            </>
          )}
        </>
      )}
    </div>
  );
}

export function OrchestrationGraph({
  workerSlots,
  workerActivity,
  connecting,
  toolSlots,
  phase,
  busy,
  onConnect,
  onDisconnect,
  onInspect,
  onAddWorker,
  onRemoveWorker,
  onReplaceWorker,
  onAddTool,
  onRemoveTool,
  onReplaceTool,
}: {
  /** The workspace's six worker slots, from the saved arrangement. */
  workerSlots: WorkerSlot[];
  workerActivity: Map<string, string>;
  connecting: string[];
  /** The workspace's active tool slots, from the saved layout. */
  toolSlots: ToolSlot[];
  /** The agent's own phase line, from the existing hub progress. */
  phase: string;
  busy: boolean;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
  onInspect: (id: string) => void;
  /** Opens the existing worker surface for one slot. Never scans. */
  onAddWorker: (index: number) => void;
  /** Frees a worker slot. Layout only — never a disconnect. */
  onRemoveWorker: (index: number) => void;
  /** Opens the worker surface to swap this slot's occupant. Layout only. */
  onReplaceWorker: (index: number, workerId: string) => void;
  /** Opens AURA Everything. Never scans the machine, never installs. */
  onAddTool: () => void;
  /** Frees a slot. Layout only — never an uninstall. */
  onRemoveTool: (nodeId: string) => void;
  /** Opens AURA Everything to swap this slot's occupant. Layout only. */
  onReplaceTool: (index: number, nodeId: string) => void;
}) {
  // Exactly six, whatever arrives — the same padding the tool row gets,
  // for the same reason: a longer list from a future caller must not be
  // able to grow the row, and a shorter one must not shrink it.
  const shownWorkerSlots: (WorkerSlot | null)[] = Array.from(
    { length: WORKER_SLOTS },
    (_, i) => workerSlots[i] ?? null,
  );
  // Exactly three, whatever arrives. Padding here as well as in
  // `deriveToolSlots` means the row cannot grow a fourth tile even if a
  // future caller hands over a longer list.
  const shownSlots: (ToolSlot | null)[] = Array.from(
    { length: ACTIVE_TOOL_SLOTS },
    (_, i) => toolSlots[i] ?? null,
  );

  return (
    <div className="flex flex-col items-center">
      {/* MINDS — six slots, always drawn. */}
      <div
        className="grid w-full grid-cols-3 gap-x-2 gap-y-4"
        role="list"
        aria-label="Workspace AI workers"
        data-testid="worker-slots"
      >
        {shownWorkerSlots.map((slot, i) =>
          slot && slot.workerId ? (
            <div key={`worker-${i}-${slot.workerId}`} role="listitem" className="min-w-0">
              <FilledWorkerSlot
                slot={slot}
                live={workerActivity.get(slot.workerId) ?? null}
                busy={connecting.includes(slot.workerId)}
                onConnect={() => onConnect(slot.workerId as string)}
                onDisconnect={() => onDisconnect(slot.workerId as string)}
                onRemove={() => onRemoveWorker(slot.index)}
                onReplace={() => onReplaceWorker(slot.index, slot.workerId as string)}
              />
            </div>
          ) : (
            <div key={`worker-${i}-empty`} role="listitem" className="min-w-0">
              <EmptyWorkerSlot index={i} onAddWorker={() => onAddWorker(i)} />
            </div>
          ),
        )}
      </div>

      <Connectors count={WORKER_SLOTS} direction="down" />

      {/* THE ORCHESTRATOR — the largest thing in the rail, on purpose. */}
      <div className="flex flex-col items-center" data-testid="hub-aura-node">
        <span
          className={cn(
            'relative grid h-[104px] w-[104px] place-items-center rounded-full border-2 border-[rgba(122,92,255,0.6)]',
            'bg-[radial-gradient(circle_at_50%_35%,rgba(122,92,255,0.35),rgba(10,16,34,0.98)_70%)] shadow-glow-violet',
          )}
        >
          <AuraLogo size={52} />
          {busy && (
            <span
              aria-hidden
              className="aura-breathe absolute inset-0 rounded-full border-2 border-[rgba(122,92,255,0.5)]"
            />
          )}
        </span>
        <span className="mt-2.5 text-[17px] font-semibold tracking-[-0.01em] text-text">
          AURA Agent
        </span>
        <span className="text-[11.5px] text-text-muted">Plan · Use Tools · Get Results</span>
        <span className="mt-0.5 max-w-full truncate text-[11px] text-neon-cyan">{phase}</span>
      </div>

      <Connectors count={ACTIVE_TOOL_SLOTS} direction="up" />

      {/* ACTIVE WORKSPACE TOOLS — three slots, always drawn. */}
      <div
        className="grid w-full grid-cols-3 gap-2"
        role="list"
        aria-label="Active workspace tools"
        data-testid="tool-slots"
      >
        {shownSlots.map((slot, i) =>
          slot && slot.nodeId ? (
            <div key={`slot-${i}-${slot.nodeId}`} role="listitem" className="min-w-0">
              <FilledSlot
                slot={slot}
                onInspect={() => onInspect(slot.nodeId as string)}
                onRemove={() => onRemoveTool(slot.nodeId as string)}
                onReplace={() => onReplaceTool(slot.index, slot.nodeId as string)}
              />
            </div>
          ) : (
            <div key={`slot-${i}-empty`} role="listitem" className="min-w-0">
              <EmptySlot index={i} onAddTool={onAddTool} />
            </div>
          ),
        )}
      </div>
    </div>
  );
}
