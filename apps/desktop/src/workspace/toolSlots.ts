/**
 * toolSlots — the Workspace's three active tool slots.
 * ==================================================================
 * The orchestration graph draws a fixed row: three slots, always, filled
 * or not. This module turns the persisted layout (`hubStore`, key
 * `aura.workspace.layout`) plus the live environment into exactly that.
 *
 * A SLOT IS NOT A SEARCH RESULT. These three are the tools the user chose
 * to keep in this workspace — not the first three catalogue entries, not
 * everything discovered on the machine, and not everything installed. The
 * layout store is the only thing that decides which ids occupy them, and
 * slot order is the order they were placed in.
 *
 * The state on a slot is read off the environment node and nothing else.
 * There is no derived "ready" or "verified": `ACTIVE` is the store's own
 * `connected` flag, `UNAVAILABLE` is a probe verdict of absence or a
 * catalogue entry with no connector, and everything else in between is
 * `SELECTED` — chosen for the workspace, with no claim about the machine.
 * A tool whose id no longer resolves to a catalogue node is `UNAVAILABLE`
 * rather than quietly dropped, so a slot the user filled never vanishes
 * without explanation.
 */

import type { EnvironmentNode } from '@aura/connected-environment';
import { ACTIVE_TOOL_SLOTS, type PlacedNode } from './hubStore';

export type ToolSlotState = 'EMPTY' | 'SELECTED' | 'ACTIVE' | 'UNAVAILABLE';

export interface ToolSlot {
  /** 0-based position in the fixed row. */
  index: number;
  /** The tool held here, or null while the slot is empty. */
  nodeId: string | null;
  /** The live environment node, when the id still resolves to one. */
  node: EnvironmentNode | null;
  state: ToolSlotState;
}

/** Slot state, read off real fields only. Never a computed readiness claim. */
export function slotState(nodeId: string | null, node: EnvironmentNode | null): ToolSlotState {
  if (!nodeId) return 'EMPTY';
  if (!node) return 'UNAVAILABLE';
  if (node.connected) return 'ACTIVE';
  if (node.health.status === 'not-installed' || node.health.status === 'no-connector') {
    return 'UNAVAILABLE';
  }
  return 'SELECTED';
}

/**
 * The three slots, in the order the tools were placed. Always exactly
 * `ACTIVE_TOOL_SLOTS` long: extra placements are ignored rather than
 * drawn, and missing ones stay visible as empty slots.
 */
export function deriveToolSlots(placed: PlacedNode[], nodes: EnvironmentNode[]): ToolSlot[] {
  const slots: ToolSlot[] = [];
  for (let index = 0; index < ACTIVE_TOOL_SLOTS; index += 1) {
    const nodeId = placed[index]?.nodeId ?? null;
    const node = nodeId ? nodes.find((n) => n.id === nodeId) ?? null : null;
    slots.push({ index, nodeId, node, state: slotState(nodeId, node) });
  }
  return slots;
}
