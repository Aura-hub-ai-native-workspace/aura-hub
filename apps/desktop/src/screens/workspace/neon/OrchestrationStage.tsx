import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import { AuraLogo } from '../../../brand/AuraLogo';
import {
  workerSlotCaption,
  workerSlotName,
  type WorkerSlot,
} from '../../../workspace/workerSlots';

/**
 * OrchestrationStage — the right panel's standing identity (v3, Stage A).
 *
 * Three layers, top to bottom:
 *   1. the brand row — "AURA Hub" and the tagline;
 *   2. the Central Agent hero — the primary orchestration entity, with
 *      its live phase, model, project and a connection verdict that is
 *      only ever "connected" when the service actually answered;
 *   3. the six worker slots as a 3×2 grid, each card restating
 *      `GET /workers` (name, provider/runtime, readiness, live activity
 *      word, capabilities). Slots that are empty, uninstalled or
 *      unverified are DRAWN that way — an unconnected machine never
 *      renders as connected.
 *
 * The connector between hero and grid is a static spine: it pictures
 * the real topology (AURA commands, workers answer), it does not
 * animate delegation that is not happening. Breathing is reserved for
 * the one state that earns it: a worker the CURRENT RUN actually
 * reports working — a merely connected worker sits calm, because a
 * connection is a fact, not an activity.
 *
 * Stage B deepens the truthfulness: the grid carries the roster's own
 * state — an unreachable service says so instead of pretending an
 * empty row, a readiness handshake in flight says "Proving…", a
 * worker the backend proved says "Proven", and the roster can be
 * re-asked with the same refresh the Capabilities tab uses.
 *
 * Presentational only; every value arrives as a prop from
 * WorkspaceScreen, which sources them from the existing stores.
 */

export function OrchestrationStage({
  connectedProviders,
  availableTools,
  agentPhase,
  agentBusy,
  agentUp,
  modelName,
  projectName,
  projectPath,
  workerSlots,
  workerActivity,
  scanning,
  workersConnecting,
  workersError,
  workersLoading,
  onRefreshWorkers,
  onManageWorker,
}: {
  /** Provider ids the model service reports as connected. */
  connectedProviders: string[];
  /** Tool names the current run has actually reached for. */
  availableTools: string[];
  /** The agent's own phase line, or null when nothing reported. */
  agentPhase: string | null;
  agentBusy: boolean;
  /** Liveness of the Central Agent service. null = not yet asked. */
  agentUp: boolean | null;
  /** The model this host is currently pointed at, when known. */
  modelName: string | null;
  /** Active project display name, or null when none is selected. */
  projectName: string | null;
  projectPath: string | null;
  /** The six worker slots, filled or empty — never a catalogue dump. */
  workerSlots: WorkerSlot[];
  /** Live worker id → activity word, from the frames the run streams. */
  workerActivity: Map<string, string>;
  /** Environment inventory scan in flight (affects slot captions). */
  scanning: boolean;
  /** Worker ids with a readiness handshake currently in flight. */
  workersConnecting: string[];
  /** Set when the roster could not be read. Never rendered as "no workers". */
  workersError: string | null;
  /** True while the roster is being (re)read. */
  workersLoading: boolean;
  /** Re-ask the backend for its worker roster (same store as the Capabilities tab). */
  onRefreshWorkers: () => void;
  /** Open the existing worker-slot management surface for a slot. */
  onManageWorker: (index: number) => void;
}) {
  const connected = workerSlots.filter((s) => s.worker?.connected).length;
  const filled = workerSlots.filter((s) => s.workerId).length;
  /* The denominator of the grid header is the roster's own size, when
     it answered. Slots may be filled beyond it or fall short of it —
     both are real, and neither is corrected here. */
  const rosterTotal = workerSlots.filter((s) => s.worker).length || filled;

  return (
    <div className="flex shrink-0 flex-col px-4 pt-3" data-testid="orchestration-stage">
      {/* 1 — Brand row: who this surface belongs to. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <AuraLogo size={22} />
          <span className="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-text">
            AURA Hub
          </span>
        </div>
        <span
          className="truncate text-[11px] italic tracking-wide text-text-subtle"
          data-testid="aura-tagline"
        >
          Thinking. Collaborating. Building.
        </span>
      </div>

      {/* 2 — The Central Agent, the primary entity of this panel. */}
      <div
        className="relative mt-2.5 overflow-hidden rounded-2xl border border-[rgba(122,92,255,0.38)] bg-gradient-to-b from-[var(--ws-grad-from)] to-[var(--ws-grad-to)] p-3.5 shadow-glow-violet"
        data-testid="central-agent-hero"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-[rgba(183,166,255,0.55)] to-transparent"
        />
        <div className="flex items-center gap-3">
          <span className="relative grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-[rgba(122,92,255,0.45)] bg-[rgba(122,92,255,0.14)]">
            <AuraLogo size={28} />
            {agentBusy && (
              <span
                aria-hidden
                className="absolute -bottom-0.5 -right-0.5 grid h-3.5 w-3.5 place-items-center rounded-full border-2 border-ws-panel"
              >
                <span className="h-2 w-2 rounded-full bg-neon-cyan aura-breathe" />
              </span>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-[15px] font-semibold leading-tight tracking-[-0.01em] text-text">
                AURA Central Agent
              </span>
              {modelName && (
                <span className="min-w-0 max-w-[180px] truncate rounded-full border border-[rgba(122,92,255,0.32)] bg-ws-soft px-2 py-0.5 text-[10px] uppercase tracking-wide text-ws-ink-violet" title={modelName}>
                  {modelName}
                </span>
              )}
              {agentUp === false && (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(255,93,122,0.5)] bg-[rgba(255,93,122,0.1)] px-2 py-0.5 text-[10px] font-semibold text-ws-bad"
                  role="status"
                >
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-neon-danger" />
                  Offline
                </span>
              )}
            </div>
            <div className="mt-0.5 truncate text-[11px] uppercase tracking-[0.16em] text-text-subtle">
              {agentPhase ?? 'One prompt · multiple minds'}
            </div>
          </div>
          {/* The project AURA is working in — the hero's anchor to real work. */}
          <span
            className="hidden min-w-0 items-center gap-1.5 rounded-xl border border-[rgba(125,146,255,0.28)] bg-ws-soft px-2.5 py-1.5 sm:inline-flex"
            title={projectPath ?? 'No project selected'}
            data-testid="hero-project"
          >
            <Icon name="folder" size={13} className="shrink-0 text-text-subtle" />
            <span className="max-w-[160px] truncate text-[11.5px] text-text-muted">
              {projectName ?? 'No project selected'}
            </span>
          </span>
        </div>

        {/* Readiness chips — every count is a backend answer, never a hope. */}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5" data-testid="hero-readiness">
          <HeroChip
            icon="cpu"
            label={`${connectedProviders.length} provider${connectedProviders.length === 1 ? '' : 's'}`}
            sub={connectedProviders.length ? connectedProviders.slice(0, 3).join(', ') + (connectedProviders.length > 3 ? '…' : '') : 'not yet reported'}
            tone={connectedProviders.length > 0 ? 'ok' : 'muted'}
          />
          <HeroChip
            icon="command"
            label={`${availableTools.length} tool${availableTools.length === 1 ? '' : 's'}`}
            sub={availableTools.length ? availableTools.slice(0, 3).join(', ') + (availableTools.length > 3 ? '…' : '') : 'none seen this run'}
            tone={availableTools.length > 0 ? 'ok' : 'muted'}
          />
          <HeroChip
            icon="layout"
            label={`${connected} connected`}
            sub={`${filled} of 6 slots filled`}
            tone={connected > 0 ? 'ok' : 'muted'}
          />
        </div>
      </div>

      {/* The spine: AURA above, workers below. Static on purpose — it
          pictures the topology, it does not perform fake delegation.
          Dot-in-line so it reads as a connector, not a stray glyph. */}
      <div aria-hidden className="flex flex-col items-center py-0.5">
        <span className="h-1.5 w-px bg-[rgba(122,92,255,0.35)]" />
        <span className="my-px h-1.5 w-1.5 rounded-full border border-[rgba(122,92,255,0.5)] bg-ws-panel" />
        <span className="h-1.5 w-px bg-[rgba(122,92,255,0.2)]" />
      </div>

      {/* 3 — The worker grid: six slots, 3×2, truthful at every state.
          The header restates the roster's own counts and re-asks it on
          demand; an unreachable roster is a banner, never a blank. */}
      <div className="flex items-center justify-between gap-2 pb-1" data-testid="worker-grid-header">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-text-subtle">
            Workers
          </span>
          <span className="min-w-0 truncate text-[10.5px] text-text-subtle" data-testid="worker-grid-count">
            {workersError
              ? 'roster unreachable'
              : `${connected} of ${rosterTotal} connected`}
          </span>
        </span>
        <button
          type="button"
          onClick={onRefreshWorkers}
          disabled={workersLoading}
          data-testid="worker-grid-refresh"
          aria-label="Refresh the worker roster"
          title={workersError ? 'Ask the backend again for its worker roster' : 'Refresh the worker roster'}
          className="neon-focus grid h-6 w-6 shrink-0 place-items-center rounded-lg text-text-subtle transition-colors hover:bg-[rgba(125,146,255,0.12)] hover:text-text disabled:opacity-50"
        >
          <Icon name="refresh" size={13} />
        </button>
      </div>
      {workersError && (
        <p
          role="status"
          data-testid="worker-grid-error"
          className="mb-2 rounded-lg border border-[rgba(255,181,71,0.42)] bg-[rgba(255,181,71,0.08)] px-2.5 py-1.5 text-[10.5px] leading-snug text-ws-warn"
        >
          The worker roster could not be read: {workersError}. Slots hold their places and
          claim nothing until the backend answers.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3" data-testid="worker-grid">
        {workerSlots.map((slot) => (
          <WorkerStageCard
            key={slot.index}
            slot={slot}
            activity={slot.workerId ? workerActivity.get(slot.workerId) ?? null : null}
            connecting={slot.workerId ? workersConnecting.includes(slot.workerId) : false}
            scanning={scanning}
            onManage={() => onManageWorker(slot.index)}
          />
        ))}
      </div>
    </div>
  );
}

function HeroChip({
  icon,
  label,
  sub,
  tone,
}: {
  icon: 'cpu' | 'command' | 'layout';
  label: string;
  sub: string;
  tone: 'ok' | 'muted';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] leading-tight',
        tone === 'ok'
          ? 'border-[rgba(122,92,255,0.32)] bg-ws-soft text-text-muted'
          : 'border-line bg-ws-soft text-text-subtle',
      )}
      title={sub}
    >
      <Icon name={icon} size={12} className="shrink-0" />
      {label}
    </span>
  );
}

/** One worker slot. A card, never a promise: the caption and the dot
    restate the backend's verdict, and an empty slot offers the real
    management surface instead of a fake occupant. A handshake in
    flight says "Proving…"; a worker the current run reports on breathes
    and shows the activity word; a merely connected worker sits calm. */
function WorkerStageCard({
  slot,
  activity,
  connecting,
  scanning,
  onManage,
}: {
  slot: WorkerSlot;
  activity: string | null;
  connecting: boolean;
  scanning: boolean;
  onManage: () => void;
}) {
  const state = scanning && slot.state === 'UNKNOWN' ? 'UNKNOWN' : slot.state;
  const name = workerSlotName(slot);
  /* "Proving…" is the caption while the readiness handshake runs — the
     backend's own word for a proof it has not finished earning. */
  const caption = connecting ? 'Proving…' : workerSlotCaption(slot);
  const capabilities = slot.worker?.capabilities ?? [];
  const proof = slot.worker?.proof ?? null;

  /* In-run is the run's own report: an activity word that is neither of
     the two non-answers ('IDLE', 'CONNECTED'). Same predicate the
     WorkerRail uses, so the two surfaces can never disagree. */
  const inRun = !!activity && activity !== 'IDLE' && activity !== 'CONNECTED';

  const dot =
    connecting ? 'bg-neon-cyan aura-breathe'
      : inRun ? 'bg-neon-success aura-breathe'
      : state === 'ACTIVE' ? 'bg-neon-success'
      : state === 'SELECTED' ? 'bg-neon-blue'
      : 'bg-text-subtle';

  const frame =
    state === 'ACTIVE'
      ? 'border-[rgba(31,211,138,0.4)] bg-gradient-to-b from-[var(--ws-grad-from)] to-[var(--ws-grad-to)]'
      : state === 'SELECTED'
        ? 'border-[rgba(77,124,255,0.35)] bg-gradient-to-b from-[var(--ws-grad-from)] to-[var(--ws-grad-to)]'
        : state === 'EMPTY'
          ? 'border-dashed border-[rgba(125,146,255,0.3)] bg-ws-soft'
          : state === 'UNAVAILABLE'
            ? 'border-line bg-ws-unavail'
            : 'border-line bg-ws-slot';

  return (
    <button
      type="button"
      onClick={onManage}
      data-testid={`worker-slot-${slot.index}`}
      data-state={state}
      aria-label={
        state === 'EMPTY'
          ? `Empty worker slot ${slot.index + 1} — add a worker`
          : `${name || 'Worker'} — ${caption}. Open management`
      }
      title={
        state === 'EMPTY'
          ? 'Add a worker to this slot'
          : `${name} — ${caption}${activity && inRun ? ` · ${activity}` : ''}${proof?.proved ? ` · proof: ${proof.detail}` : ''}`
      }
      className={cn(
        'neon-focus group flex min-h-[64px] flex-col items-start gap-1 rounded-xl border p-2.5 text-left transition-colors',
        frame,
        state === 'EMPTY' && 'hover:border-[rgba(32,211,255,0.45)]',
      )}
    >
      <span className="flex w-full items-center gap-1.5">
        <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[11.5px] font-medium leading-tight',
            state === 'EMPTY' ? 'text-text-subtle' : 'text-text',
          )}
        >
          {state === 'EMPTY' ? 'Empty slot' : name || 'Worker'}
        </span>
        {state === 'EMPTY' && <Icon name="plus" size={12} className="shrink-0 text-text-subtle" />}
      </span>

      <span
        className={cn(
          'truncate text-[10px] leading-tight',
          state === 'ACTIVE' ? 'text-ws-ok' : 'text-text-subtle',
        )}
      >
        {state === 'EMPTY' ? 'Add a worker' : caption}
      </span>

      {/* Readiness proof — the backend's own record that a real
          dispatch round-trip succeeded. Shown only when it exists. */}
      {proof?.proved && state !== 'EMPTY' && (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-[rgba(31,211,138,0.4)] bg-[rgba(31,211,138,0.08)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-ws-ok"
          data-testid={`worker-proof-${slot.index}`}
          title={`${proof.detail} (probe ${proof.probeId})`}
        >
          <Icon name="check" size={9} className="shrink-0" />
          Proven
        </span>
      )}

      {/* Live activity word — only while the run actually reports one. */}
      {inRun && state === 'ACTIVE' && (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-[rgba(32,211,255,0.4)] bg-[rgba(32,211,255,0.1)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-ws-ink-cyan"
          data-testid={`worker-activity-${slot.index}`}
        >
          <span aria-hidden className="h-1 w-1 rounded-full bg-neon-cyan aura-breathe" />
          {activity}
        </span>
      )}

      {/* Real capabilities from the worker descriptor — up to two, then a count. */}
      {state !== 'EMPTY' && capabilities.length > 0 && (
        <span className="mt-0.5 flex w-full flex-wrap items-center gap-1 overflow-hidden">
          {capabilities.slice(0, 2).map((cap) => (
            <span
              key={cap}
              className="max-w-[90px] truncate rounded border border-line bg-ws-soft px-1 py-px text-[9px] text-text-subtle"
              title={cap}
            >
              {cap}
            </span>
          ))}
          {capabilities.length > 2 && (
            <span className="text-[9px] text-text-subtle">+{capabilities.length - 2}</span>
          )}
        </span>
      )}
    </button>
  );
}
