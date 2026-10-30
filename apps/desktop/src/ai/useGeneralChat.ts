/**
 * useGeneralChat — the "Start Building" conversation.
 * ------------------------------------------------------------------
 * General chat has no project. Every question is answered by the Central
 * Agent's /agent/chat with web research and the shared context for this
 * conversation space; the answer streams from real events, its citations
 * point at real sources, and what it consulted is kept with the session so
 * it is still there after navigating away or restarting the app.
 *
 * It never executes anything: the same words that would start work in
 * Workspace only get a reply here.
 */
import { create } from 'zustand';
import {
  centralAgentClient, newClientSessionId,
  type AgentEventFrame, type ChatResearch, type ChatSource, type ModelStatus,
} from './centralAgentClient';
import { EMPTY_TURN, foldChatEvent, type LiveTurn } from './chatEvents';
import { describeTransportFailure } from './cancellation';

export interface GeneralTurn {
  id: string;
  question: string;
  answer: string;
  /**
   * 'stopping' means a stop was asked for and nothing has confirmed it: the
   * answer is still being made until the agent says 'cancelled' (or finishes).
   */
  status: 'streaming' | 'stopping' | 'done' | 'error' | 'cancelled';
  /** What the last Stop actually did: a failed or unconfirmed request, or a run that finished first. */
  stopNote?: string;
  /** What happened while this answer was being made (real events). */
  live: LiveTurn;
  /** Sources the answer actually cites. */
  sources: ChatSource[];
  research: ChatResearch | null;
  nextActions: string[];
  recorded: { kind: string; title: string }[];
  model: { provider?: string; model?: string } | null;
  error?: string;
}

export interface RecentChat { sessionId: string; title: string; updatedAt: string; turns: number; adoptedBy?: string | null }

interface GeneralChatState {
  sessionId: string | null;
  turns: GeneralTurn[];
  phase: 'idle' | 'working';
  recent: RecentChat[];
  agentUp: boolean | null;
  modelStatus: ModelStatus | null;
  /** Restore the most recent general conversation, if there is one. */
  load: () => Promise<void>;
  open: (sessionId: string) => Promise<void>;
  newChat: () => void;
  send: (text: string) => Promise<void>;
  /** Ask the agent to stop the answer. Resolves once the request has landed or failed. */
  stop: () => Promise<void>;
  /** A stop request is in flight (the button waits). */
  stopRequesting: boolean;
  refreshModelStatus: () => Promise<void>;
}

let seq = 0;
const tid = () => `gt${Date.now().toString(36)}${seq++}`;
let inflight: { controller: AbortController; sessionId: string; turnId: string; unsubscribe: (() => void) | null } | null = null;
/** A stop request in flight: a repeated press joins it instead of sending another. */
let stopRequest: Promise<void> | null = null;

function errorText(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/failed to fetch|networkerror|load failed|connection refused/i.test(msg)) {
    return 'The AURA agent is not reachable. Check that AURA is running, then try again.';
  }
  return msg || 'The request failed.';
}

function restoreTurns(session: { chatTurns?: unknown[] } | null): GeneralTurn[] {
  const raw = Array.isArray(session?.chatTurns) ? (session!.chatTurns as Record<string, unknown>[]) : [];
  return raw.map((t) => ({
    id: tid(),
    question: String(t.question ?? ''),
    answer: String(t.answer ?? ''),
    status: 'done' as const,
    live: EMPTY_TURN,
    sources: (Array.isArray(t.sources) ? t.sources : []) as ChatSource[],
    research: (t.research as ChatResearch | null) ?? null,
    nextActions: (Array.isArray(t.nextActions) ? t.nextActions : []) as string[],
    recorded: (Array.isArray(t.recorded) ? t.recorded : []) as { kind: string; title: string }[],
    model: (t.model as GeneralTurn['model']) ?? null,
  }));
}

export const useGeneralChat = create<GeneralChatState>((set, get) => {
  const patchTurn = (id: string, fn: (t: GeneralTurn) => GeneralTurn) =>
    set((s) => ({ turns: s.turns.map((t) => (t.id === id ? fn(t) : t)) }));

  const refreshRecent = async () => {
    try { set({ recent: (await centralAgentClient.chats()).chats }); } catch { /* the list is a convenience */ }
  };

  /**
   * Leave this conversation while an answer is still being made. The turn is
   * no longer on screen, so there is nothing to confirm; the stop is still
   * sent, and a failure is logged instead of discarded.
   */
  const abandon = () => {
    const f = inflight;
    if (!f) return;
    void centralAgentClient.cancel(f.sessionId, 'conversation closed').catch((e) => {
      console.warn(`could not stop the answer for ${f.sessionId} after leaving it:`, e);
    });
    f.controller.abort();
  };

  return {
    sessionId: null, turns: [], phase: 'idle', recent: [], agentUp: null, modelStatus: null, stopRequesting: false,

    async load() {
      centralAgentClient.health().then(() => set({ agentUp: true })).catch(() => set({ agentUp: false }));
      void get().refreshModelStatus();
      await refreshRecent();
      if (get().sessionId || get().turns.length) return;
      const latest = get().recent.find((c) => !c.adoptedBy) ?? get().recent[0];
      if (latest) await get().open(latest.sessionId);
    },

    async open(sessionId) {
      abandon();
      try {
        const session = await centralAgentClient.getSession(sessionId) as unknown as { chatTurns?: unknown[] };
        set({ sessionId, turns: restoreTurns(session), phase: 'idle' });
      } catch {
        set({ sessionId: null, turns: [], phase: 'idle' });
      }
    },

    newChat() {
      abandon();
      set({ sessionId: null, turns: [], phase: 'idle' });
    },

    async refreshModelStatus() {
      try { set({ modelStatus: await centralAgentClient.modelsStatus() }); } catch { /* status is advisory */ }
    },

    async send(text) {
      const question = text.trim();
      if (!question || get().phase !== 'idle') return;
      const sessionId = get().sessionId ?? newClientSessionId();
      const id = tid();
      const controller = new AbortController();
      set((s) => ({
        sessionId, phase: 'working',
        turns: [...s.turns, { id, question, answer: '', status: 'streaming', live: EMPTY_TURN, sources: [], research: null,
          nextActions: [], recorded: [], model: null }],
      }));
      const unsubscribe = centralAgentClient.events(sessionId, (frame: AgentEventFrame) => {
        if (inflight?.turnId !== id || frame.sessionId !== sessionId) return;
        patchTurn(id, (t) => {
          const live = foldChatEvent(t.live, frame);
          return { ...t, live, answer: live.answer, sources: live.sources, research: live.research as ChatResearch | null };
        });
      });
      inflight = { controller, sessionId, turnId: id, unsubscribe };
      try {
        const res = await centralAgentClient.chat(question, { sessionId, surface: 'general-chat', signal: controller.signal });
        if (inflight?.turnId !== id) return;
        const r = res.result;
        // The authoritative summary replaces the streamed text; citations
        // are the ones the answer really used.
        patchTurn(id, (t) => ({
          ...t,
          // The agent's own outcome decides: 'cancelled' confirms a stop; an
          // answer that arrived while a stop was pending finished first.
          stopNote: t.status === 'stopping' && r.outcome !== 'cancelled'
            ? 'The answer finished before the stop took effect.' : undefined,
          answer: r.summary, status: r.outcome === 'cancelled' ? 'cancelled' : 'done',
          sources: r.sources ?? [], research: r.research ?? t.research,
          nextActions: r.nextActions ?? [], recorded: r.recorded ?? [], model: r.model ?? null,
        }));
      } catch (e) {
        if (inflight?.turnId !== id) return;
        if ((e as Error)?.name === 'AbortError') patchTurn(id, (t) => ({ ...t, status: 'cancelled' }));
        else patchTurn(id, (t) => ({ ...t, status: 'error', error: errorText(e) }));
      } finally {
        if (inflight?.turnId === id) {
          const un = inflight.unsubscribe;
          inflight = null;
          set({ phase: 'idle' });
          setTimeout(() => un?.(), 1500);
          void refreshRecent();
        }
      }
    },

    async stop() {
      const f = inflight;
      if (!f) return;
      if (stopRequest) return stopRequest;
      patchTurn(f.turnId, (t) => ({ ...t, status: 'stopping', stopNote: undefined }));
      set({ stopRequesting: true });
      stopRequest = (async () => {
        try {
          await centralAgentClient.cancel(f.sessionId, 'stopped from Start Building');
        } catch (e) {
          // The request did not land: the answer is still being made, and
          // the person is told so instead of seeing "Stopped".
          if (inflight?.turnId === f.turnId) {
            patchTurn(f.turnId, (t) => ({
              ...t, status: 'streaming',
              stopNote: `Could not stop the answer: ${describeTransportFailure(e)} It is still being made.`,
            }));
          }
          return;
        }
        // Landed. Not stopped yet: the pending reply says whether the agent
        // cancelled or finished first, and nothing here may say "Stopped" early.
        if (inflight?.turnId === f.turnId) {
          patchTurn(f.turnId, (t) => t.status === 'stopping'
            ? { ...t, stopNote: 'Stop requested. Waiting for the agent to confirm.' } : t);
        }
      })().finally(() => { stopRequest = null; set({ stopRequesting: false }); });
      return stopRequest;
    },
  };
});
