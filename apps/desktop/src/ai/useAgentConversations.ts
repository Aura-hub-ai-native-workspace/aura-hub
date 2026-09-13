/**
 * useAgentConversations — project Ask AURA over the Central Agent.
 * ==================================================================
 * The project-level counterpart to Ctrl+I's `useAiAction`: same
 * Central Agent, same session contract, broader context (project +
 * conversation + optional editor snapshot instead of editor-first).
 *
 * Thread persistence stays in the EXISTING TS conversation store
 * (list/get/create/rename/remove/append per project). The agent
 * session id rides in the assistant message's `meta.agent.sessionId`
 * — no second database, no parallel session architecture.
 *
 * Works with or WITHOUT an open project. A project gives the thread a
 * home in the existing per-project conversation store; without one the
 * same conversation runs in memory against the same Central Agent, so
 * "Hi" does not require choosing a directory first. Nothing else
 * changes: one store, one session contract, one event stream.
 *
 * Intelligence path (only):
 *   centralAgentClient.submit/message → :4320 /agent/sessions
 *   → CentralAgent → intent/plan/authority/Fabric/verify/evidence
 *   → answer.token frames + terminal AgentResult over the session SSE.
 * There is NO aiClient.stream (/stream) reference in this file.
 */

import { create } from 'zustand';
import {
  centralAgentClient,
  newClientSessionId,
  type AgentEventFrame,
  type AgentOutcome,
  type AgentResult,
  type EditorContext,
  type PlanReview,
} from './centralAgentClient';
import {
  aiClient,
  type ConversationSummary,
} from './aiClient';
import { eventPhrase, toolName } from './agentNarration';

export type AgentConvPhase = 'idle' | 'working';

/**
 * What AURA is doing right now, in a form the UI can show without
 * learning backend vocabulary. Rebuilt from the SAME frames the
 * transcript already consumes — no second subscription, no second
 * source of truth, and nothing here is inferred: a tool appears only
 * once the backend reported using it.
 */
export interface AgentActivity {
  /** Live worker node id → lifecycle word, for the capability graph. */
  workers: Record<string, string>;
  /** Human names of what AURA actually reached for, in first-use order. */
  tools: string[];
  /** One short phrase, or null when nothing is happening. */
  phase: string | null;
  /** A decision is pending. */
  awaitingApproval: boolean;
}

const IDLE_ACTIVITY: AgentActivity = {
  workers: {}, tools: [], phase: null, awaitingApproval: false,
};

export interface AgentMsgMeta {
  sessionId: string | null;
  outcome: AgentOutcome | null;
  /** Server-generated leg correlation for this message's run. */
  requestId: string | null;
  /** Safe lifecycle labels from session SSE, in arrival order. */
  progress: string[];
  /** Raw event types behind the labels — drives AgentPhaseStrip. */
  events: string[];
  plan: PlanReview | null;
  approvalId: string | null;
  performed: string[];
  verified: string[];
  evidenceSummary: string | null;
  runId: string | null;
  needsInput: boolean;
  cancelled: boolean;
  /** Human names of what this turn actually used. Record, not claim. */
  tools: string[];
}

export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'streaming' | 'done' | 'error' | 'cancelled';
  error?: string;
  agent?: AgentMsgMeta;
}

interface AgentConvState {
  projectId: string | null;
  projectPath: string | null;
  conversations: ConversationSummary[];
  activeId: string | null;
  messages: AgentChatMessage[];
  phase: AgentConvPhase;
  /** Live capability activity for the current turn. */
  activity: AgentActivity;
  loading: boolean;
  /** Liveness of the agent service itself (not a provider key). */
  agentUp: boolean | null;

  loadForProject: (projectId: string | null, projectPath?: string | null) => Promise<void>;
  reloadList: () => Promise<void>;
  select: (cid: string) => Promise<void>;
  newConversation: () => Promise<string | null>;
  rename: (cid: string, title: string) => Promise<void>;
  remove: (cid: string) => Promise<void>;
  send: (text: string, opts?: { editorContext?: EditorContext }) => Promise<void>;
  /** Answer a needs-clarification prompt on the thread's live session. */
  answer: (text: string) => Promise<void>;
  decide: (messageId: string, granted: boolean, reason?: string) => Promise<void>;
  stop: () => void;
  regenerate: () => Promise<void>;
}

let seq = 0;
const nid = () => `am${Date.now().toString(36)}${seq++}`;

const EVENT_LABELS: Array<[RegExp, string]> = [
  [/^session\.started$/, 'Request received'],
  [/^intent\.compiled$/, 'Understanding request'],
  [/^intent\.clarification-needed$/, 'Needs your input'],
  [/^plan\.created$/, 'Plan ready'],
  [/^capability\.discovery$/, 'Checking capabilities'],
  [/^authority\.checked$/, 'Authority check'],
  [/^workflow\.(compiled|validated)$/, 'Plan validated'],
  [/^execution\.started$/, 'Executing'],
  [/^worker\.lifecycle$/, 'Working'],
  [/^worker\.action$/, 'Governed action'],
  [/^invocation\.observed$/, 'Governed action'],
  [/^approval\.required$/, 'Waiting for approval'],
  [/^verification\.completed$/, 'Verifying'],
  [/^answer\.started$/, 'Composing answer'],
  [/^result\.ready$/, 'Completed'],
  [/^agent\.(failed|cancelled)$/, 'Settling'],
  [/^run\.cancell/, 'Cancelling'],
  [/^stream\.reconnecting$/, 'Live updates paused — reconnecting'],
];

function labelForEvent(type: string): string | null {
  for (const [re, label] of EVENT_LABELS) {
    if (re.test(type)) return label;
  }
  return null;
}

function errorText(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/failed to fetch|networkerror|load failed|connection refused/i.test(msg)) {
    return 'Central Agent unavailable — could not reach the agent service. Check that AURA is running and try again.';
  }
  return msg || 'The Central Agent request failed.';
}

/** Latest assistant meta carrying a session, scanning newest-first. */
function sessionOf(messages: AgentChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const sid = messages[i].agent?.sessionId;
    if (sid) return sid;
  }
  return null;
}

interface Inflight {
  seq: number;
  sessionId: string;
  convId: string;
  assistantId: string;
  controller: AbortController;
  unsubscribe: (() => void) | null;
  settled: boolean;
}

let inflight: Inflight | null = null;
let cancelTimer: ReturnType<typeof setTimeout> | undefined;

function clearInflight() {
  if (inflight?.unsubscribe) inflight.unsubscribe();
  inflight = null;
  if (cancelTimer) clearTimeout(cancelTimer);
  cancelTimer = undefined;
}

export const useAgentConversations = create<AgentConvState>((set, get) => {
  const patchMsg = (id: string, fn: (m: AgentChatMessage) => AgentChatMessage) =>
    set({ messages: get().messages.map((m) => (m.id === id ? fn(m) : m)) });

  const pushEvent = (id: string, type: string, label: string | null) =>
    patchMsg(id, (m) => {
      if (!m.agent) return m;
      const events = m.agent.events[m.agent.events.length - 1] === type
        ? m.agent.events : [...m.agent.events.slice(-99), type];
      const progress = !label || m.agent.progress[m.agent.progress.length - 1] === label
        ? m.agent.progress : [...m.agent.progress, label];
      return { ...m, agent: { ...m.agent, events, progress } };
    });

  const appendTokens = (id: string, text: string) =>
    patchMsg(id, (m) => {
      if (!m.agent || m.agent.cancelled) return m;
      return { ...m, content: m.content + text };
    });

  /**
   * Folds one frame into the live activity model.
   *
   * Reads only fields the backend actually sends. A worker appears
   * when `worker.lifecycle` names its node; a tool appears when a
   * capability id is present and `agentNarration` has an honest name
   * for it. Nothing is added on speculation, so an idle turn shows an
   * empty indicator rather than a plausible-looking one.
   */
  const absorbActivity = (frame: AgentEventFrame) => {
    const payload = frame.payload ?? {};
    const phrase = eventPhrase(frame.type);
    const prev = get().activity;
    const next: AgentActivity = {
      workers: prev.workers,
      tools: prev.tools,
      phase: phrase ?? prev.phase,
      awaitingApproval:
        frame.type === 'approval.required' ? true
          : frame.type === 'result.ready' || frame.type === 'run.cancelled'
            ? false : prev.awaitingApproval,
    };

    if (frame.type === 'worker.lifecycle') {
      const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId : null;
      const lifecycle = typeof payload.lifecycle === 'string' ? payload.lifecycle : '';
      if (nodeId) next.workers = { ...prev.workers, [nodeId]: lifecycle };
      const worker = typeof payload.worker === 'string' ? payload.worker : null;
      if (worker && !next.tools.includes(worker)) next.tools = [...next.tools, worker];
    }

    const capability = typeof payload.capabilityId === 'string' ? payload.capabilityId : null;
    const named = toolName(capability);
    if (named && !next.tools.includes(named)) next.tools = [...next.tools, named];

    if (frame.type === 'capability.discovery' && Array.isArray(payload.tools)) {
      for (const entry of payload.tools as Array<Record<string, unknown>>) {
        // Only capabilities the backend reported as actually available.
        if (entry?.available !== true) continue;
        const name = toolName(typeof entry.id === 'string' ? entry.id : null);
        if (name && !next.tools.includes(name)) next.tools = [...next.tools, name];
      }
    }
    set({ activity: next });
  };

  async function persistAssistant(convId: string, m: AgentChatMessage) {
    const { projectId } = get();
    if (!projectId) return;
    try {
      await aiClient.appendMessage(projectId, convId, {
        role: 'assistant',
        content: m.content,
        meta: m.agent ? { agent: { ...m.agent, events: m.agent.events.slice(-100), progress: m.agent.progress.slice(-20), plan: m.agent.plan ? { planId: m.agent.plan.planId, steps: m.agent.plan.steps.length } : null } } : undefined,
        error: m.status === 'error',
      });
      void get().reloadList();
    } catch { /* thread persistence never fails the visible result */ }
  }

  /** Route a terminal-or-parked result into the assistant message. */
  async function adoptResult(convId: string, assistantId: string, result: AgentResult, sessionId: string) {
    // The turn keeps the record of what it used, so the transcript can
    // still say "Used Git and OpenCode" after the live line has gone.
    // It is a record of reported use, never a claim of success.
    const used = get().activity.tools;
    if (used.length) {
      patchMsg(assistantId, (m) => (m.agent ? { ...m, agent: { ...m.agent, tools: used } } : m));
    }
    if (result.outcome === 'awaiting-approval') {
      let plan: PlanReview | null = null;
      try {
        plan = await centralAgentClient.planReview(sessionId);
      } catch { /* advisory; approval ids are authoritative */ }
      // Exact correlation only: the approval id comes from THIS
      // result's evidence. When it is absent we render a deterministic
      // error rather than guessing another session's pending
      // approval (the backend would refuse it with 409).
      const approvalId: string | null = result.evidence?.approvalIds?.[0] ?? null;
      if (!approvalId) {
        const entry = get().messages.find((m) => m.id === assistantId);
        patchMsg(assistantId, (m) => ({
          ...m, status: 'error',
          error: 'The run parked for approval but named no approval. Nothing was approved; start a new request.',
        }));
        if (entry) void persistAssistant(convId, { ...entry, status: 'error', error: 'Parked approval reference missing.' });
        return;
      }
      patchMsg(assistantId, (m) => ({
        ...m,
        status: 'done',
        content: result.summary,
        agent: m.agent ? {
          ...m.agent, outcome: result.outcome, plan, approvalId,
          performed: result.performed, verified: result.verified,
          evidenceSummary: result.evidence?.summary ?? null, runId: result.runId ?? null,
        } : m.agent,
      }));
    } else if (result.outcome === 'completed') {
      // Authoritative summary replaces streamed tokens (it carries the
      // deterministic trailer); streamed text was progress, not record.
      patchMsg(assistantId, (m) => ({
        ...m,
        status: 'done',
        content: result.summary,
        agent: m.agent ? {
          ...m.agent, outcome: result.outcome,
          performed: result.performed, verified: result.verified,
          evidenceSummary: result.evidence?.summary ?? null, runId: result.runId ?? null,
        } : m.agent,
      }));
    } else if (result.outcome === 'needs-clarification') {
      patchMsg(assistantId, (m) => ({
        ...m,
        status: 'done',
        content: result.summary,
        agent: m.agent ? { ...m.agent, outcome: result.outcome, needsInput: true } : m.agent,
      }));
    } else if (result.outcome === 'cancelled') {
      patchMsg(assistantId, (m) => ({
        ...m,
        status: 'cancelled',
        agent: m.agent ? { ...m.agent, outcome: result.outcome, cancelled: true } : m.agent,
      }));
    } else {
      patchMsg(assistantId, (m) => ({
        ...m,
        status: 'error',
        error: result.summary || `The request ${result.outcome}.`,
        agent: m.agent ? { ...m.agent, outcome: result.outcome } : m.agent,
      }));
    }
    const final = get().messages.find((m) => m.id === assistantId);
    if (final && final.status !== 'cancelled') void persistAssistant(convId, final);
  }

  async function drive(
    convId: string,
    assistantId: string,
    sessionId: string,
    instruction: string,
    editorContext: EditorContext | undefined,
    followUp: boolean,
  ) {
    const { projectId, projectPath } = get();
    const mySeq = (inflight?.seq ?? 0) + 1;
    const controller = new AbortController();
    const flight: Inflight = {
      seq: mySeq, sessionId, convId, assistantId,
      controller, unsubscribe: null, settled: false,
    };
    inflight = flight;
    set({ phase: 'working', activity: IDLE_ACTIVITY });

    const alive = () => inflight === flight && !flight.settled;

    flight.unsubscribe = centralAgentClient.events(sessionId, (frame: AgentEventFrame) => {
      if (!alive() || frame.sessionId !== sessionId) return;
      if (frame.type === 'answer.token') {
        const text = typeof frame.payload.text === 'string' ? frame.payload.text : '';
        if (text) appendTokens(assistantId, text);
        return;
      }
      if (frame.type === 'run.cancelled') {
        flight.settled = true;
        patchMsg(assistantId, (m) => ({
          ...m, status: 'cancelled',
          agent: m.agent ? { ...m.agent, outcome: 'cancelled', cancelled: true } : m.agent,
        }));
        return;
      }
      const label = labelForEvent(frame.type);
      pushEvent(assistantId, frame.type, label);
      absorbActivity(frame);
    });

    const finish = () => {
      if (inflight === flight) {
        flight.settled = true;
        inflight = null;
        // The tool list survives the turn: it is the record of what was
        // used, and the transcript shows it beside the answer. Only the
        // live phase clears.
        set({ phase: 'idle', activity: { ...get().activity, phase: null, workers: {} } });
        setTimeout(() => flight.unsubscribe?.(), 1500);
      }
    };

    try {
      const res = followUp
        ? await centralAgentClient.message(sessionId, instruction, {
          projectId: projectId ?? undefined,
          projectPath: projectPath ?? undefined,
          editorContext, signal: controller.signal,
        }).then((r) => ({ result: r.result, sessionId, requestId: r.requestId ?? null }))
        : await centralAgentClient.submit(instruction, {
          projectId: projectId ?? undefined,
          projectPath: projectPath ?? undefined,
          editorContext, sessionId, signal: controller.signal,
        }).then((r) => ({ ...r, requestId: r.requestId ?? null }));
      if (!alive()) return; // cancelled or superseded mid-flight
      const finalSid = res.sessionId ?? sessionId;
      patchMsg(assistantId, (m) => (m.agent ? { ...m, agent: { ...m.agent, sessionId: finalSid, requestId: res.requestId } } : m));
      await adoptResult(convId, assistantId, res.result, finalSid);
    } catch (e) {
      if (!alive()) return;
      if ((e as Error)?.name === 'AbortError') {
        patchMsg(assistantId, (m) => ({
          ...m, status: 'cancelled',
          agent: m.agent ? { ...m.agent, cancelled: true } : m.agent,
        }));
      } else {
        const entry = get().messages.find((m) => m.id === assistantId);
        patchMsg(assistantId, (m) => ({ ...m, status: 'error', error: errorText(e) }));
        if (entry) void persistAssistant(convId, { ...entry, status: 'error', error: errorText(e) });
      }
    } finally {
      finish();
    }
  }

  return {
    projectId: null,
    projectPath: null,
    conversations: [],
    activeId: null,
    messages: [],
    phase: 'idle',
    activity: IDLE_ACTIVITY,
    loading: false,
    agentUp: null,

    async loadForProject(projectId, projectPath = null) {
      if (get().projectId === projectId) return;
      if (inflight) {
        inflight.controller.abort();
        clearInflight();
      }
      set({ projectId, projectPath, conversations: [], activeId: null, messages: [], phase: 'idle', activity: IDLE_ACTIVITY, loading: !!projectId, agentUp: null });
      // Liveness is asked either way: without a project there is still
      // an agent to talk to, and "is it running" is the one thing the
      // user needs to know before typing.
      centralAgentClient.health()
        .then(() => { if (get().projectId === projectId) set({ agentUp: true }); })
        .catch(() => { if (get().projectId === projectId) set({ agentUp: false }); });
      if (!projectId) return;
      try {
        const { conversations } = await aiClient.listConversations(projectId);
        if (get().projectId !== projectId) return; // superseded
        set({ conversations, loading: false });
        if (conversations.length) await get().select(conversations[0].id);
      } catch {
        if (get().projectId === projectId) set({ loading: false });
      }
    },

    async reloadList() {
      const { projectId } = get();
      if (!projectId) return;
      try { set({ conversations: (await aiClient.listConversations(projectId)).conversations }); } catch { /* keep */ }
    },

    async select(cid) {
      const { projectId } = get();
      if (!projectId) return;
      if (inflight) {
        inflight.controller.abort();
        clearInflight();
      }
      set({ activeId: cid, phase: 'idle' });
      try {
        const conv = await aiClient.getConversation(projectId, cid);
        if (get().activeId !== cid) return; // superseded
        set({
          messages: conv.messages.map((m) => {
            const agent = (m.meta as { agent?: Partial<AgentMsgMeta> } | null)?.agent;
            const full: AgentMsgMeta | undefined = agent?.sessionId
              ? {
                sessionId: agent.sessionId,
                outcome: agent.outcome ?? null,
                requestId: agent.requestId ?? null,
                progress: agent.progress ?? [],
                events: agent.events ?? [],
                plan: null,
                approvalId: agent.approvalId ?? null,
                performed: agent.performed ?? [],
                verified: agent.verified ?? [],
                evidenceSummary: agent.evidenceSummary ?? null,
                runId: agent.runId ?? null,
                needsInput: agent.needsInput ?? false,
                cancelled: agent.cancelled ?? false,
                tools: agent.tools ?? [],
              }
              : undefined;
            const status = m.error ? 'error' as const : full?.cancelled ? 'cancelled' as const : 'done' as const;
            return { id: m.id, role: m.role, content: m.content, status, agent: full };
          }),
        });
      } catch {
        if (get().activeId === cid) set({ messages: [] });
      }
    },

    async newConversation() {
      const { projectId } = get();
      if (!projectId) return null;
      if (inflight) {
        inflight.controller.abort();
        clearInflight();
      }
      const conv = await aiClient.createConversation(projectId);
      set({ activeId: conv.id, messages: [], phase: 'idle' });
      await get().reloadList();
      return conv.id;
    },

    async rename(cid, title) {
      const { projectId } = get();
      if (!projectId) return;
      await aiClient.renameConversation(projectId, cid, title);
      await get().reloadList();
    },

    async remove(cid) {
      const { projectId, activeId } = get();
      if (!projectId) return;
      // Deleting the live thread stops its run first: no orphaned
      // governed work may outlive the conversation that asked for it.
      if (inflight && activeId === cid) get().stop();
      await aiClient.removeConversation(projectId, cid);
      if (get().activeId === cid) set({ activeId: null, messages: [] });
      await get().reloadList();
      const first = get().conversations[0];
      if (first && !get().activeId) await get().select(first.id);
    },

    async send(text, opts) {
      const trimmed = text.trim();
      const { projectId, phase } = get();
      if (!trimmed || phase !== 'idle') return;

      // With a project, the thread is stored per project as before.
      // Without one, the same conversation runs against the same agent
      // under a local id and simply is not persisted — the alternative
      // was refusing to answer "Hi" until a directory was chosen.
      let cid = get().activeId;
      if (!cid) cid = projectId ? await get().newConversation() : nid();
      if (!cid) return;
      const convId: string = cid;
      if (!get().activeId) set({ activeId: convId });

      const priorSid = sessionOf(get().messages);
      const userId = nid();
      const assistantId = nid();
      const agentMeta: AgentMsgMeta = {
        sessionId: priorSid, outcome: null, requestId: null,
        progress: [], events: [],
        plan: null, approvalId: null, performed: [], verified: [],
        evidenceSummary: null, runId: null, needsInput: false, cancelled: false,
        tools: [],
      };
      set({
        messages: [
          ...get().messages,
          { id: userId, role: 'user', content: trimmed, status: 'done' },
          { id: assistantId, role: 'assistant', content: '', status: 'streaming', agent: agentMeta },
        ],
      });
      const pid = get().projectId;
      if (pid) {
        aiClient.appendMessage(pid, convId, { role: 'user', content: trimmed })
          .then(() => get().reloadList()).catch(() => {});
      }

      if (priorSid) {
        await drive(convId, assistantId, priorSid, trimmed, opts?.editorContext, true);
      } else {
        const sessionId = newClientSessionId();
        patchMsg(assistantId, (m) => (m.agent ? { ...m, agent: { ...m.agent, sessionId } } : m));
        await drive(convId, assistantId, sessionId, trimmed, opts?.editorContext, false);
      }
    },

    async answer(text) {
      // Clarifications ride the thread's live session via message():
      // send() already routes to the existing session when one is
      // mapped, which is exactly the server's clarification-continuation
      // path (the answer merges into the pending question, zero side
      // effects in between). No separate logic, no forked session.
      await get().send(text);
    },

    async decide(messageId, granted, reason) {
      const msg = get().messages.find((m) => m.id === messageId);
      const sessionId = msg?.agent?.sessionId;
      const approvalId = msg?.agent?.approvalId;
      if (!sessionId || !approvalId || !msg?.agent) return;
      pushEvent(messageId, 'approval.required', granted ? 'Approval granted — resuming' : 'Approval denied');
      patchMsg(messageId, (m) => ({ ...m, status: 'streaming' }));
      try {
        const { result } = await centralAgentClient.approve(sessionId, approvalId, granted, reason);
        const cid = get().activeId;
        if (!cid) return;
        await adoptResult(cid, messageId, result, sessionId);
      } catch (e) {
        patchMsg(messageId, (m) => ({ ...m, status: 'error', error: errorText(e) }));
      }
    },

    stop() {
      const flight = inflight;
      if (!flight || flight.settled) return;
      const sid = flight.sessionId;
      const attempt = async (triesLeft: number): Promise<void> => {
        if (inflight !== flight) return;
        try {
          await centralAgentClient.cancel(sid, 'cancelled from Ask AURA');
        } catch (e) {
          const msg = (e as Error)?.message ?? '';
          if (/no such session/i.test(msg) && triesLeft > 0) {
            await new Promise((r) => { cancelTimer = setTimeout(r, 400); });
            return attempt(triesLeft - 1);
          }
        }
      };
      void attempt(25);
      flight.controller.abort();
      if (flight.unsubscribe) flight.unsubscribe();
      flight.settled = true;
      patchMsg(flight.assistantId, (m) => ({
        ...m, status: 'cancelled',
        agent: m.agent ? { ...m.agent, cancelled: true } : m.agent,
      }));
      inflight = null;
      // Clearing `inflight` above is what makes the in-flight `finish()`
      // a no-op — its guard is `inflight === flight`. So the live state
      // has to be torn down here too, or the workspace goes on saying
      // "Working · using Git" after the user has stopped the work. The
      // tool list survives for the same reason it survives a normal
      // finish: it is the record of what ran before the stop.
      set({ phase: 'idle', activity: { ...get().activity, phase: null, workers: {} } });
    },

    async regenerate() {
      const { phase, messages, activeId } = get();
      if (phase !== 'idle' || !activeId) return;
      let lastUser = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { lastUser = i; break; }
      }
      if (lastUser < 0) return;
      // Agent semantics: re-asking continues the SAME session as a new
      // turn (the session is the memory; nothing is deleted server-side).
      await get().send(messages[lastUser].content);
    },
  };
});
