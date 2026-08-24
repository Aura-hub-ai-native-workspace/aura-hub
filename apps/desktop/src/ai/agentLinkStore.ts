/**
 * AgentLinkStore — the bridge between Central Agent surfaces and the
 * Workflow/Automation domains.
 * =====================================================================
 * Tiny, honest, and deliberately boring:
 *
 *   • `pendingRunRequest` — "open THIS engine run in Runs". Consumed once
 *     by the runs list; a missing run renders the backend's 404 honestly.
 *   • `lastSession` — the most recent agent session's public state, so
 *     Home's ACTIVE section can show "agent waiting for you" without a
 *     second polling loop. Set ONLY from real client responses.
 *   • `focusAskAura()` — palette/Home affordances raise focus without
 *     reaching into component internals.
 *
 * No backend calls live here; this is pure client-side linkage state.
 */

import { create } from 'zustand';
import type { AgentResult } from '../ai/centralAgentClient';

interface AgentLinkState {
  pendingRunRequest: { runId: string; requestedAt: number } | null;
  requestRunInspection: (runId: string) => void;
  consumeRunRequest: () => void;

  lastSessionId: string | null;
  lastOutcome: AgentResult['outcome'] | null;
  /** Approval ids the agent parked on — mirrors the result's evidence. */
  recordSession: (sessionId: string, outcome: AgentResult['outcome']) => void;

  focusTick: number;
  focusAskAura: () => void;
}

export const useAgentLink = create<AgentLinkState>((set) => ({
  pendingRunRequest: null,
  requestRunInspection: (runId) =>
    set({ pendingRunRequest: { runId, requestedAt: Date.now() } }),
  consumeRunRequest: () => set({ pendingRunRequest: null }),

  lastSessionId: null,
  lastOutcome: null,
  recordSession: (sessionId, outcome) =>
    set({ lastSessionId: sessionId, lastOutcome: outcome }),

  focusTick: 0,
  focusAskAura: () => set((s) => ({ focusTick: s.focusTick + 1 })),
}));
