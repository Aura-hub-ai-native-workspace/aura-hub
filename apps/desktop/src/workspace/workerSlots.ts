/**
 * workerSlots — the Workspace's six AI worker slots.
 * ==================================================================
 * The counterpart to `toolSlots`, one row up in the same graph, and
 * deliberately the same shape: the orchestration graph draws six slots,
 * always, filled or not, and this module turns the persisted
 * arrangement (`hubStore`, key `aura.workspace.workers`) plus the live
 * worker roster into exactly that.
 *
 * A SLOT IS NOT THE ROSTER. The six used to be `workers.slice(0, 6)` —
 * whatever the backend listed first, in the backend's order, with no way
 * to choose. They are now the workers the user keeps in this workspace.
 * The layout is the only thing that decides which ids occupy them, and
 * `null` is a kept, visible, empty slot rather than a gap that closes.
 *
 * THE STATE IS READ, NEVER INFERRED. `connected` is the backend's own
 * verdict, earned by proving a dispatch and a correlated reply; nothing
 * here upgrades "installed" into "connected", or a familiar id into
 * either. Two absences are kept apart on purpose:
 *
 *   • `UNKNOWN`   — the roster has not been read yet, so there is no
 *                   answer about this worker. Saying "not installed"
 *                   here would be inventing a measurement.
 *   • `UNAVAILABLE` — the roster HAS answered and this id is not in it,
 *                   or the worker is not installed, or AURA has no
 *                   verified way to drive it.
 *
 * A worker whose id no longer resolves keeps its slot and says so,
 * rather than vanishing without explanation.
 */

import type { WorkerDescriptor } from '../ai/workerClient';
import { WORKER_SLOTS } from './hubStore';

export type WorkerSlotState = 'EMPTY' | 'UNKNOWN' | 'SELECTED' | 'ACTIVE' | 'UNAVAILABLE';

export interface WorkerSlot {
  /** 0-based position in the fixed row. */
  index: number;
  /** The worker chosen for this slot, or null while it is empty. */
  workerId: string | null;
  /** The live descriptor, when the id still resolves in the roster. */
  worker: WorkerDescriptor | null;
  state: WorkerSlotState;
}

/**
 * Slot state from real fields only.
 *
 * `rosterKnown` is what separates "not there" from "not asked yet", so
 * an unread roster can never render as a machine-wide absence.
 */
export function workerSlotState(
  workerId: string | null,
  worker: WorkerDescriptor | null,
  rosterKnown: boolean,
): WorkerSlotState {
  if (!workerId) return 'EMPTY';
  if (!worker) return rosterKnown ? 'UNAVAILABLE' : 'UNKNOWN';
  if (worker.connected) return 'ACTIVE';
  if (!worker.installed) return 'UNAVAILABLE';
  // AURA has no verified way to drive this runtime. Offering Connect
  // would be offering a button that cannot succeed.
  if (worker.lifecycle === 'UNSUPPORTED' || worker.reason === 'ADAPTER_UNKNOWN') {
    return 'UNAVAILABLE';
  }
  return 'SELECTED';
}

/**
 * The slot's caption — the honest short line under the tile.
 *
 * Every branch restates something the backend said. There is no
 * "Ready", no "Available to AURA", and no default that assumes a
 * connection: an unanswered roster says so in as many words.
 */
export function workerSlotCaption(slot: WorkerSlot): string {
  if (!slot.workerId) return '';
  if (!slot.worker) return slot.state === 'UNKNOWN' ? 'Unknown' : 'Not in worker catalogue';
  if (slot.worker.connected) return 'Connected';
  if (!slot.worker.installed) return 'Not installed';
  if (slot.state === 'UNAVAILABLE') return 'Unavailable';
  return 'Not connected';
}

/** What to call this slot's occupant. The id stands in when nothing resolves. */
export function workerSlotName(slot: WorkerSlot): string {
  return slot.worker?.name ?? slot.workerId ?? '';
}

/**
 * The six slots, in saved order. Always exactly `WORKER_SLOTS` long:
 * extra saved entries are ignored rather than drawn, and missing ones
 * stay visible as empty slots.
 *
 * `rosterKnown` defaults to "the roster has entries", which is the
 * honest reading of an empty list from a service that always reports
 * six: it has not answered yet.
 */
export function deriveWorkerSlots(
  workerIds: (string | null)[],
  workers: WorkerDescriptor[],
  rosterKnown: boolean = workers.length > 0,
): WorkerSlot[] {
  const slots: WorkerSlot[] = [];
  for (let index = 0; index < WORKER_SLOTS; index += 1) {
    const workerId = workerIds[index] ?? null;
    const worker = workerId ? workers.find((w) => w.id === workerId) ?? null : null;
    slots.push({ index, workerId, worker, state: workerSlotState(workerId, worker, rosterKnown) });
  }
  return slots;
}
