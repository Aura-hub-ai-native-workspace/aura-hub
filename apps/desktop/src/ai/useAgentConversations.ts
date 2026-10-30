/**
 * useAgentConversations — scoped chats over the Central Agent.
 * ==================================================================
 * ONE engine, TWO scopes:
 *   · project   — "Let's Chat": conversation only (/agent/chat); it never runs work.
 *   · workspace — "Execution Chat": the Hub workspace's doing-thread.
 * Each scope lists, selects and persists through its OWN routes and its
 * own file family on the service, so the transcripts cannot mix. The
 * scope is captured with every turn (`owner`), so a late stream frame
 * from a turn started in one scope can never be persisted into the
 * other.
 *
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
 * Intelligence paths (only):
 *   project   — centralAgentClient.chat → :4320 /agent/chat (answers only)
 *   workspace — centralAgentClient.submit/message → :4320 /agent/sessions
 *   → CentralAgent → intent/plan/authority/Fabric/verify/evidence
 *   → answer.token frames + terminal AgentResult over the session SSE.
 * There is NO aiClient.stream (/stream) reference in this file.
 */

import { metaWithReason, reasonFromMeta } from './failureReason';
import { isStartedResult, waitForRun } from './backgroundRun';
import { foldPlanEvent, type BuildingDraft, type PlanStage } from './planProgress';
import { create } from 'zustand';
import {
  centralAgentClient,
  newClientSessionId,
  type AgentEventFrame,
  type AgentOutcome,
  type AgentResult,
  type EditorContext,
  type PlanReview,
  type ChatResearch,
  type ChatSource,
  type AgentTaskStatus,
} from './centralAgentClient';
import {
  aiClient,
  type ConversationScope,
  type ConversationSummary,
  type Handoff,
} from './aiClient';
import { useAppStore } from '@aura/core';
import { useWorkspace } from '../data/useWorkspace';
import { resolveWorkspaceProjectPath } from './workspaceProject';
import { eventPhrase, toolName } from './agentNarration';
import { EMPTY_TURN, foldChatEvent, type ChatStep } from './chatEvents';
import { missionClient } from './missionClient';
import { useLayoutStore } from '../ops/layoutStore';
import type { WorkspacePlan } from './missionClient';
import { BackendRefusedError } from '../backend/backendSession';

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
}

/** Shown when this view stops waiting. The run itself is not cancelled. */
const STILL_RUNNING_NOTE = 'Still running on the server. This view stopped waiting; the result appears here when you reopen the conversation.';

/**
 * Runs accepted in the background and not yet settled, per viewer. A reload
 * must not forget a run that is still working on the server. This is a
 * per-viewer convenience only: the authoritative result is the session.
 */
const PENDING_RUNS_KEY = 'aura.pendingRuns.v1';
interface PendingRun { convId: string; assistantId: string; sessionId: string; owner: Owner }

function readPendingRuns(): PendingRun[] {
  try {
    const raw = globalThis.localStorage?.getItem(PENDING_RUNS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as PendingRun[]) : [];
  } catch {
    return [];
  }
}

function writePendingRuns(runs: PendingRun[]): void {
  try {
    globalThis.localStorage?.setItem(PENDING_RUNS_KEY, JSON.stringify(runs));
  } catch {
    /* storage may be unavailable; the run is still followed in this session */
  }
}

function rememberPendingRun(run: PendingRun): void {
  writePendingRuns([...readPendingRuns().filter((r) => r.sessionId !== run.sessionId), run]);
}

function forgetPendingRun(sessionId: string): void {
  writePendingRuns(readPendingRuns().filter((r) => r.sessionId !== sessionId));
}

const IDLE_ACTIVITY: AgentActivity = {
  workers: {}, tools: [], phase: null,
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
  performed: string[];
  verified: string[];
  evidenceSummary: string | null;
  runId: string | null;
  needsInput: boolean;
  cancelled: boolean;
  /** Human names of what this turn actually used. Record, not claim. */
  tools: string[];
  /** What AURA understood the request to be. Display only. */
  understanding?: string | null;
  /** Mission-level verdict; null when no acceptance criteria were declared. */
  objective?: { accepted: boolean | null; unmet: string[] } | null;
  /** Each planned task's final state, in plan order. */
  tasks?: AgentTaskStatus[];
  failureReason?: string | null;
  /** Chat: the real pipeline steps seen while the answer was made. */
  chatSteps?: ChatStep[];
  /** Chat: sources the answer cites, what research did, what AURA noted, and the next steps offered. */
  sources?: ChatSource[];
  research?: ChatResearch | null;
  recorded?: { kind: string; title: string }[];
  nextActions?: string[];
  modelUsed?: { provider?: string; model?: string } | null;
  /** Chat: a plan built from this conversation's context, ready to send to the Planner. */
  planDraft?: { status: 'building' | 'ready' | 'failed'; missionId?: string; goal?: string; taskCount?: number; error?: string; stage?: PlanStage; elapsedMs?: number; receivedChars?: number };
}

/** The mission-status fields of a result, for the message metadata. */
function missionMeta(result: AgentResult): Pick<AgentMsgMeta,
  'understanding' | 'objective' | 'tasks' | 'failureReason'> {
  const unmet = result.unmetAcceptance ?? [];
  const accepted = result.objectiveAccepted ?? null;
  return {
    understanding: result.understanding ?? null,
    objective: accepted === null && unmet.length === 0 ? null : { accepted, unmet },
    tasks: result.tasks ?? [],
    failureReason: result.failureReason ?? null,
  };
}

/** What the Planner hands over: the reserved session and the actual plan. */
export interface PlanExecution {
  plan: WorkspacePlan;
  sessionId: string;
  projectId: string;
  projectPath: string;
}

export type PlanStartResult =
  | { status: 'started' }
  /** This revision is already running or ran, under `sessionId`. */
  | { status: 'duplicate'; sessionId: string }
  | { status: 'failed'; error: string };

export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'streaming' | 'done' | 'error' | 'cancelled';
  error?: string;
  agent?: AgentMsgMeta;
}

interface AgentConvState {
  /** Which surface owns the store right now. */
  scope: ConversationScope;
  projectId: string | null;
  projectPath: string | null;
  /** Set in workspace scope: `workspace:<projectId>`. */
  workspaceId: string | null;
  /** Handoffs offered to the active workspace (workspace scope only). */
  handoffs: Handoff[];
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
  /** Switch the store to a workspace's Execution Chat scope. */
  loadForWorkspace: (workspaceId: string) => Promise<void>;
  reloadList: () => Promise<void>;
  select: (cid: string) => Promise<void>;
  newConversation: () => Promise<string | null>;
  /**
   * Planner → Workspace: run a handed-over plan as a live Workspace turn in
   * the plan's own project. Resolves once Workspace has CONFIRMED the run
   * exists (its session was created) — or with why it did not start; the
   * run itself keeps going in the transcript.
   */
  executePlan: (handoff: PlanExecution) => Promise<PlanStartResult>;
  rename: (cid: string, title: string) => Promise<void>;
  remove: (cid: string) => Promise<void>;
  send: (text: string, opts?: { editorContext?: EditorContext; webResearch?: boolean }) => Promise<void>;
  /** Answer a needs-clarification prompt on the thread's live session. */
  answer: (text: string) => Promise<void>;
  stop: () => void;
  regenerate: () => Promise<void>;
  /** Project chat: build a plan from this conversation's shared context. */
  buildPlan: (messageId: string) => Promise<void>;
  /** Stop a plan that is being built from chat. */
  cancelPlan: (messageId: string) => void;
  /** Open the Planner on the plan a chat message built. */
  sendToPlanner: (messageId: string) => void;
  /** Offer a project Let's Chat message (or messages) to the workspace. */
  handoffToWorkspace: (convId: string, messageIds: string[], title: string, notes?: string) => Promise<Handoff>;
  /** Re-read the workspace's handoff inbox. */
  reloadHandoffs: () => Promise<void>;
  /** Accept an offered handoff into the active execution chat. */
  acceptHandoff: (handoff: Handoff) => Promise<void>;
}

/** Plans being built from chat, by message: the duplicate guard and the cancel handle. */
const planControllers = new Map<string, AbortController>();

let seq = 0;
const nid = () => `am${Date.now().toString(36)}${seq++}`;

const EVENT_LABELS: Array<[RegExp, string]> = [
  [/^session\.started$/, 'Request received'],
  [/^intent\.compiled$/, 'Understanding request'],
  [/^intent\.clarification-needed$/, 'Needs your input'],
  [/^plan\.received$/, 'Plan received from Planner'],
  [/^plan\.created$/, 'Plan ready'],
  [/^task\.authored$/, 'AURA wrote a file'],
  [/^capability\.discovery$/, 'Checking capabilities'],
  [/^authority\.checked$/, 'Authority check'],
  [/^workflow\.(compiled|validated)$/, 'Plan validated'],
  [/^execution\.started$/, 'Executing'],
  [/^worker\.lifecycle$/, 'Working'],
  [/^worker\.action$/, 'Governed action'],
  [/^invocation\.observed$/, 'Governed action'],
  [/^verification\.completed$/, 'Verifying'],
  [/^task\.retried$/, 'Retrying a failed task'],
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

/** Real web sources cited anywhere in this conversation (for the plan's provenance). */
export function sourcesFromContext(messages: AgentChatMessage[]): { title: string; url: string }[] {
  const seen = new Map<string, { title: string; url: string }>();
  for (const m of messages) for (const s of m.agent?.sources ?? []) {
    if (/^https?:\/\//i.test(s.url) && !seen.has(s.url)) seen.set(s.url, { title: s.title, url: s.url });
  }
  return [...seen.values()].slice(0, 12);
}

function errorText(e: unknown): string {
  // A backend that is not this launch's is refused before any request. Say so,
  // and say why, rather than the generic unreachable message.
  if (e instanceof BackendRefusedError) return e.message;
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

/** The scope a turn was started in, captured once and carried through. */
interface Owner {
  scope: ConversationScope;
  projectId: string | null;
  workspaceId: string | null;
}

interface Inflight {
  seq: number;
  sessionId: string;
  convId: string;
  assistantId: string;
  controller: AbortController;
  unsubscribe: (() => void) | null;
  settled: boolean;
  /** The turn's scope, fixed at send() time. */
  owner: Owner;
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

  async function persistAssistant(convId: string, m: AgentChatMessage, owner: Owner) {
    if (!owner.projectId) return;
    try {
      const agentMeta = m.agent ? { agent: { ...m.agent, events: m.agent.events.slice(-100), progress: m.agent.progress.slice(-20), plan: m.agent.plan ? { planId: m.agent.plan.planId, steps: m.agent.plan.steps.length } : null } } : undefined;
      // A failed turn keeps its specific (scrubbed) reason across a restart.
      const meta = metaWithReason(agentMeta, m.status === 'error', m.error);
      if (owner.scope === 'workspace' && owner.workspaceId) {
        await aiClient.appendWorkspaceMessage(owner.workspaceId, convId, {
          role: 'assistant', content: m.content, meta, error: m.status === 'error',
        });
      } else {
        await aiClient.appendMessage(owner.projectId, convId, {
          role: 'assistant', content: m.content, meta, error: m.status === 'error',
        });
      }
      void get().reloadList();
    } catch { /* thread persistence never fails the visible result */ }
  }

  /** Route a terminal-or-parked result into the assistant message. */
  async function adoptResult(convId: string, assistantId: string, result: AgentResult, owner: Owner) {
    // The turn keeps the record of what it used, so the transcript can
    // still say "Used Git and OpenCode" after the live line has gone.
    // It is a record of reported use, never a claim of success.
    const used = get().activity.tools;
    if (used.length) {
      patchMsg(assistantId, (m) => (m.agent ? { ...m, agent: { ...m.agent, tools: used } } : m));
    }
    if (result.outcome === 'completed') {
      // Authoritative summary replaces streamed tokens (it carries the
      // deterministic trailer); streamed text was progress, not record.
      patchMsg(assistantId, (m) => ({
        ...m,
        status: 'done',
        content: result.summary,
        agent: m.agent ? {
          ...m.agent, outcome: result.outcome, ...missionMeta(result),
          performed: result.performed, verified: result.verified,
          evidenceSummary: result.evidence?.summary ?? null, runId: result.runId ?? null,
          ...(owner.scope === 'project' ? {
            sources: result.sources ?? [], research: result.research ?? m.agent.research ?? null,
            recorded: result.recorded ?? [], nextActions: result.nextActions ?? [],
            modelUsed: result.model ?? null,
          } : {}),
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
        agent: m.agent ? { ...m.agent, outcome: result.outcome, cancelled: true, ...missionMeta(result) } : m.agent,
      }));
    } else {
      patchMsg(assistantId, (m) => ({
        ...m,
        status: 'error',
        error: result.summary || `The request ${result.outcome}.`,
        agent: m.agent ? { ...m.agent, outcome: result.outcome, ...missionMeta(result) } : m.agent,
      }));
    }
    const final = get().messages.find((m) => m.id === assistantId);
    if (final && final.status !== 'cancelled') void persistAssistant(convId, final, owner);
  }

  /**
   * Follow a background run the server accepted: the turn stays live until
   * the run settles, is stopped, or this view's wait ceiling passes. The
   * result comes from the run's own session, never from `started`.
   */
  async function followBackgroundRun(
    convId: string, assistantId: string, sessionId: string, owner: Owner, flight: Inflight,
  ) {
    rememberPendingRun({ convId, assistantId, sessionId, owner });
    const wait = await waitForRun({
      sessionId,
      getSession: (sid) => centralAgentClient.getSession(sid),
      signal: flight.controller.signal,
    });
    // A settled or stopped wait is over, so its pending record goes. A
    // timed-out wait keeps it, so a reload can pick the run back up.
    if (wait.kind !== 'timeout') forgetPendingRun(sessionId);
    // Stop() has already settled this turn and owns its message.
    if (inflight !== flight || flight.settled) return;
    if (wait.kind === 'cancelled') return;
    if (wait.kind === 'timeout') {
      patchMsg(assistantId, (m) => ({ ...m, status: 'streaming', content: STILL_RUNNING_NOTE }));
      return;
    }
    await adoptResult(convId, assistantId, wait.result, owner);
  }

  /**
   * Re-attach to a run that was still working when this conversation was
   * last open: restore its placeholder, then follow it like a live turn.
   */
  async function resumePendingRuns(convId: string) {
    if (inflight) return;
    const pending = readPendingRuns().find((r) => r.convId === convId);
    if (!pending) return;
    if (!get().messages.some((m) => m.id === pending.assistantId)) {
      set({
        messages: [
          ...get().messages,
          {
            id: pending.assistantId, role: 'assistant', content: '', status: 'streaming',
            agent: {
              sessionId: pending.sessionId, outcome: null, requestId: null, progress: [], events: [],
              plan: null, performed: [], verified: [], evidenceSummary: null,
              runId: null, needsInput: false, cancelled: false, tools: [],
            },
          },
        ],
      });
    }
    const flight: Inflight = {
      seq: Date.now(), sessionId: pending.sessionId, convId,
      assistantId: pending.assistantId, controller: new AbortController(),
      unsubscribe: null, settled: false, owner: pending.owner,
    };
    inflight = flight;
    set({ phase: 'working', activity: IDLE_ACTIVITY });
    try {
      await followBackgroundRun(convId, pending.assistantId, pending.sessionId, pending.owner, flight);
    } finally {
      if (inflight === flight) {
        flight.settled = true;
        inflight = null;
        set({ phase: 'idle', activity: { ...get().activity, phase: null, workers: {} } });
      }
    }
  }

  /**
   * One Let's Chat turn. Project conversations are conversation-only: they
   * go to /agent/chat, which can never plan, invoke, dispatch or write. A
   * thread saved before the split may still point at a work session the
   * chat route refuses; the conversation then continues on a fresh chat
   * session instead of failing.
   */
  async function chatTurn(
    sessionId: string,
    instruction: string,
    followUp: boolean,
    projectId: string | null,
    projectPath: string | null,
    signal: AbortSignal,
  ): Promise<{ result: AgentResult; sessionId: string; requestId: string | null }> {
    const ask = (sid: string) => centralAgentClient.chat(instruction, {
      sessionId: sid, projectId: projectId ?? undefined, projectPath: projectPath ?? undefined,
      surface: 'project-chat', signal,
    }).then((r) => ({ result: r.result, sessionId: r.sessionId, requestId: r.requestId ?? null }));
    try {
      return await ask(sessionId);
    } catch (e) {
      if (!followUp || !/belongs to Workspace/i.test(errorText(e))) throw e;
      return ask(newClientSessionId());
    }
  }

  async function drive(
    convId: string,
    assistantId: string,
    sessionId: string,
    instruction: string,
    editorContext: EditorContext | undefined,
    followUp: boolean,
    owner: Owner,
    /**
     * The web-research choice for THIS leg, captured when the person
     * pressed send. It travels with the request and is never read back
     * off the session, so one turn's choice cannot leak into the next.
     */
    webResearch: boolean = false,
    /**
     * Run this leg through a different request (the Planner handoff), with
     * everything else — events, Stop, persistence, result — unchanged.
     */
    request?: (signal: AbortSignal) => Promise<{ result: AgentResult; sessionId: string; requestId?: string | null }>,
  ) {
    const { projectId, projectPath } = get();
    const mySeq = (inflight?.seq ?? 0) + 1;
    const controller = new AbortController();
    const flight: Inflight = {
      seq: mySeq, sessionId, convId, assistantId,
      controller, unsubscribe: null, settled: false, owner,
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
      if (owner.scope === 'project') {
        // The chat pipeline's own events become the visible trace. Tokens are
        // handled above; here only the steps, sources and research status.
        patchMsg(assistantId, (m) => {
          if (!m.agent) return m;
          const next = foldChatEvent({ ...EMPTY_TURN, steps: m.agent.chatSteps ?? [], sources: m.agent.sources ?? [],
            research: m.agent.research ? { status: m.agent.research.status, detail: m.agent.research.detail, kind: m.agent.research.kind } : null }, frame);
          return { ...m, agent: { ...m.agent, chatSteps: next.steps,
            sources: next.sources.length ? next.sources : m.agent.sources,
            research: next.research ? { ...(m.agent.research ?? { consulted: 0, cited: 0 }), ...next.research } as ChatResearch : m.agent.research } };
        });
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
      const res = request
        ? await request(controller.signal).then((r) => ({ ...r, requestId: r.requestId ?? null }))
        : owner.scope === 'project'
        ? await chatTurn(sessionId, instruction, followUp, projectId, projectPath, controller.signal)
        : followUp
        ? await centralAgentClient.message(sessionId, instruction, {
          projectId: projectId ?? undefined,
          projectPath: projectPath ?? undefined,
          editorContext, signal: controller.signal,
          webResearch,
        }).then((r) => ({ result: r.result, sessionId, requestId: r.requestId ?? null }))
        : await centralAgentClient.submit(instruction, {
          projectId: projectId ?? undefined,
          projectPath: projectPath ?? undefined,
          editorContext, sessionId, signal: controller.signal,
          webResearch,
        }).then((r) => ({ ...r, requestId: r.requestId ?? null }));
      if (!alive()) return; // cancelled or superseded mid-flight
      const finalSid = res.sessionId ?? sessionId;
      patchMsg(assistantId, (m) => (m.agent ? { ...m, agent: { ...m.agent, sessionId: finalSid, requestId: res.requestId } } : m));
      if (isStartedResult(res.result)) {
        // Accepted and running on the server. `started` is not an outcome:
        // the turn stays live and subscribed until the run settles.
        await followBackgroundRun(convId, assistantId, finalSid, owner, flight);
      } else {
        await adoptResult(convId, assistantId, res.result, owner);
      }
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
        if (entry) void persistAssistant(convId, { ...entry, status: 'error', error: errorText(e) }, owner);
      }
    } finally {
      finish();
    }
  }

  return {
    scope: 'project' as const,
    projectId: null,
    projectPath: null,
    workspaceId: null,
    handoffs: [],
    conversations: [],
    activeId: null,
    messages: [],
    phase: 'idle',
    activity: IDLE_ACTIVITY,
    loading: false,
    agentUp: null,

    async loadForProject(projectId, projectPath = null) {
      // Same project, already in project scope: nothing to do. A scope
      // change ALWAYS reloads — arriving here from a workspace means the
      // Let's Chat threads must replace the execution transcript.
      if (get().scope === 'project' && get().projectId === projectId) return;
      if (inflight) {
        inflight.controller.abort();
        clearInflight();
      }
      set({ scope: 'project', workspaceId: null, handoffs: [], projectId, projectPath, conversations: [], activeId: null, messages: [], phase: 'idle', activity: IDLE_ACTIVITY, loading: !!projectId, agentUp: null });
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

    async loadForWorkspace(workspaceId) {
      // Same workspace, already in workspace scope: nothing to do.
      if (get().scope === 'workspace' && get().workspaceId === workspaceId) return;
      if (inflight) {
        inflight.controller.abort();
        clearInflight();
      }
      const activeId = workspaceId.startsWith('workspace:')
        ? workspaceId.slice('workspace:'.length) : null;
      // Without the project path the workspace execution chat produces a
      // session whose invocations have no cwd, and every worker dispatch
      // fails with "No project directory is set". Resolve the active
      // project's registered path so delegated work has a home.
      const projectPath = resolveWorkspaceProjectPath(
        useWorkspace.getState().projects,
        activeId,
        useAppStore.getState().activeProjectId,
      );
      set({
        scope: 'workspace',
        workspaceId,
        projectId: activeId,
        projectPath,
        handoffs: [],
        conversations: [], activeId: null, messages: [], phase: 'idle', activity: IDLE_ACTIVITY,
        loading: true, agentUp: null,
      });
      centralAgentClient.health()
        .then(() => { if (get().scope === 'workspace' && get().workspaceId === workspaceId) set({ agentUp: true }); })
        .catch(() => { if (get().scope === 'workspace' && get().workspaceId === workspaceId) set({ agentUp: false }); });
      try {
        let { conversations } = await aiClient.listWorkspaceConversations(workspaceId);
        if (get().scope !== 'workspace' || get().workspaceId !== workspaceId) return; // superseded
        if (!conversations.length) {
          // A workspace is born with its first execution chat — the pane
          // must never open into an empty list.
          await aiClient.createWorkspaceConversation(workspaceId);
          conversations = (await aiClient.listWorkspaceConversations(workspaceId)).conversations;
          if (get().scope !== 'workspace' || get().workspaceId !== workspaceId) return;
        }
        set({ conversations, loading: false });
        if (conversations.length) await get().select(conversations[0].id);
        await get().reloadHandoffs();
      } catch {
        if (get().scope === 'workspace' && get().workspaceId === workspaceId) set({ loading: false });
      }
    },

    async reloadList() {
      const { scope, projectId, workspaceId } = get();
      if (scope === 'workspace') {
        if (!workspaceId) return;
        try { set({ conversations: (await aiClient.listWorkspaceConversations(workspaceId)).conversations }); } catch { /* keep */ }
        return;
      }
      if (!projectId) return;
      try { set({ conversations: (await aiClient.listConversations(projectId)).conversations }); } catch { /* keep */ }
    },

    async select(cid) {
      const { scope, projectId, workspaceId } = get();
      if (scope === 'workspace' ? !workspaceId : !projectId) return;
      if (inflight) {
        inflight.controller.abort();
        clearInflight();
      }
      set({ activeId: cid, phase: 'idle' });
      try {
        const conv = scope === 'workspace' && workspaceId
          ? await aiClient.getWorkspaceConversation(workspaceId, cid)
          : await aiClient.getConversation(projectId as string, cid);
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
                performed: agent.performed ?? [],
                verified: agent.verified ?? [],
                evidenceSummary: agent.evidenceSummary ?? null,
                runId: agent.runId ?? null,
                needsInput: agent.needsInput ?? false,
                cancelled: agent.cancelled ?? false,
                tools: agent.tools ?? [],
                understanding: agent.understanding ?? null,
                objective: agent.objective ?? null,
                tasks: agent.tasks ?? [],
                failureReason: agent.failureReason ?? null,
              }
              : undefined;
            const status = m.error ? 'error' as const : full?.cancelled ? 'cancelled' as const : 'done' as const;
            return { id: m.id, role: m.role, content: m.content, status, agent: full, ...(status === 'error' ? { error: reasonFromMeta(m.meta) } : {}) };
          }),
        });
        // A run still working on the server when this conversation was last
        // open is re-attached, so its result lands here when it settles.
        void resumePendingRuns(cid);
      } catch {
        if (get().activeId === cid) set({ messages: [] });
      }
    },

    async newConversation() {
      const { scope, projectId, workspaceId } = get();
      if (scope === 'workspace') {
        if (!workspaceId) return null;
        if (inflight) {
          inflight.controller.abort();
          clearInflight();
        }
        const conv = await aiClient.createWorkspaceConversation(workspaceId);
        set({ activeId: conv.id, messages: [], phase: 'idle' });
        await get().reloadList();
        return conv.id;
      }
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

    async executePlan(handoff) {
      const wsId = `workspace:${handoff.projectId}`;
      // Already started (a reload, a second window, a retried click): the
      // backend has this session, so never send the plan again.
      const existing = await centralAgentClient.getSession(handoff.sessionId).catch(() => null);
      if (existing) return { status: 'duplicate', sessionId: handoff.sessionId };
      if (get().scope !== 'workspace' || get().workspaceId !== wsId) {
        await get().loadForWorkspace(wsId);
      }
      if (get().phase !== 'idle') {
        return { status: 'failed', error: 'Workspace is still running another request in this project. Send the plan again when it finishes.' };
      }
      const owner: Owner = { scope: 'workspace', projectId: handoff.projectId, workspaceId: wsId };
      const convId = await get().newConversation();
      if (!convId) return { status: 'failed', error: 'Workspace could not open a conversation for this plan.' };
      const { plan } = handoff;
      const instruction = `Run plan from Planner: ${plan.goal} — ${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}, revision ${plan.revision}`;
      void get().rename(convId, `Plan: ${plan.goal}`.slice(0, 80)).catch(() => {});
      const userId = nid();
      const assistantId = nid();
      set({
        messages: [
          ...get().messages,
          { id: userId, role: 'user', content: instruction, status: 'done' },
          {
            id: assistantId, role: 'assistant', content: '', status: 'streaming',
            agent: {
              sessionId: handoff.sessionId, outcome: null, requestId: null, progress: [], events: [],
              plan: null, performed: [], verified: [], evidenceSummary: null,
              runId: null, needsInput: false, cancelled: false, tools: [],
            },
          },
        ],
      });
      aiClient.appendWorkspaceMessage(wsId, convId, { role: 'user', content: instruction })
        .then(() => get().reloadList()).catch(() => {});

      let refused: (Error & { code?: string; sessionId?: string }) | null = null;
      const run = drive(convId, assistantId, handoff.sessionId, instruction, undefined, false, owner, false,
        (signal) => centralAgentClient.executePlan(plan, {
          sessionId: handoff.sessionId, projectId: handoff.projectId, projectPath: handoff.projectPath, signal,
        }).catch((e) => { refused = e as Error & { code?: string; sessionId?: string }; throw e; }));

      // Confirmation is the backend's, never assumed: the run's session
      // exists once Workspace has accepted the plan and started it.
      for (let i = 0; i < 120; i += 1) {
        const err = refused as (Error & { code?: string; sessionId?: string }) | null;
        if (err) {
          return err.code === 'duplicate' && err.sessionId
            ? { status: 'duplicate', sessionId: err.sessionId }
            : { status: 'failed', error: err.message };
        }
        if (await centralAgentClient.getSession(handoff.sessionId).catch(() => null)) return { status: 'started' };
        await new Promise((r) => setTimeout(r, 500));
      }
      void run;
      return { status: 'failed', error: 'Workspace did not confirm the run within a minute. Check Workspace before sending again.' };
    },

    async rename(cid, title) {
      const { scope, projectId, workspaceId } = get();
      if (scope === 'workspace') {
        if (!workspaceId) return;
        await aiClient.renameWorkspaceConversation(workspaceId, cid, title);
      } else {
        if (!projectId) return;
        await aiClient.renameConversation(projectId, cid, title);
      }
      await get().reloadList();
    },

    async remove(cid) {
      const { scope, projectId, workspaceId, activeId } = get();
      // Deleting the live thread stops its run first: no orphaned
      // governed work may outlive the conversation that asked for it.
      if (scope === 'workspace') {
        if (!workspaceId) return;
        if (inflight && activeId === cid) get().stop();
        await aiClient.removeWorkspaceConversation(workspaceId, cid);
        if (get().activeId === cid) set({ activeId: null, messages: [] });
        await get().reloadList();
        const first = get().conversations[0];
        if (first && !get().activeId) await get().select(first.id);
        return;
      }
      if (!projectId) return;
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
      // The scope is captured HERE, once, and every persistence call in
      // this turn uses it — even if the user navigates to the other
      // surface mid-stream, the record lands where the turn began.
      const owner: Owner = { scope: get().scope, projectId: get().projectId, workspaceId: get().workspaceId };
      let cid = get().activeId;
      if (!cid) cid = owner.scope === 'workspace' || projectId ? await get().newConversation() : nid();
      if (!cid) return;
      const convId: string = cid;
      if (!get().activeId) set({ activeId: convId });

      const priorSid = sessionOf(get().messages);
      const userId = nid();
      const assistantId = nid();
      const agentMeta: AgentMsgMeta = {
        sessionId: priorSid, outcome: null, requestId: null,
        progress: [], events: [],
        plan: null, performed: [], verified: [],
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
      if (owner.projectId) {
        const persist = owner.scope === 'workspace' && owner.workspaceId
          ? aiClient.appendWorkspaceMessage(owner.workspaceId, convId, { role: 'user', content: trimmed })
          : aiClient.appendMessage(owner.projectId, convId, { role: 'user', content: trimmed });
        persist.then(() => get().reloadList()).catch(() => {});
      }

      if (priorSid) {
        await drive(convId, assistantId, priorSid, trimmed, opts?.editorContext, true, owner,
          opts?.webResearch === true);
      } else {
        const sessionId = newClientSessionId();
        patchMsg(assistantId, (m) => (m.agent ? { ...m, agent: { ...m.agent, sessionId } } : m));
        await drive(convId, assistantId, sessionId, trimmed, opts?.editorContext, false, owner,
          opts?.webResearch === true);
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


    cancelPlan(messageId) {
      planControllers.get(messageId)?.abort();
    },

    async buildPlan(messageId) {
      const { projectId } = get();
      const msg = get().messages.find((m) => m.id === messageId);
      // One plan per message at a time: checked on the controller map, not only
      // on rendered state, so a fast double click cannot start two.
      if (!projectId || !msg?.agent || msg.agent.planDraft?.status === 'building' || planControllers.has(messageId)) return;
      const controller = new AbortController();
      planControllers.set(messageId, controller);
      const setDraft = (planDraft: NonNullable<AgentMsgMeta['planDraft']>) =>
        patchMsg(messageId, (m) => (m.agent ? { ...m, agent: { ...m.agent, planDraft } } : m));
      setDraft({ status: 'building' });
      try {
        // The plan builder reads what this project has settled: goal,
        // requirements, decisions, rejected options, research. It is data the
        // planner must honour, sized to the planner's budget.
        const pkg = await centralAgentClient.contextPackage(projectId, 'plan implementation tasks', 12000);
        const goal = pkg.goal ?? get().messages.find((m) => m.role === 'user')?.content ?? '';
        if (!goal.trim()) throw new Error('There is no goal to plan yet. Say what you want to build first.');
        const sources = sourcesFromContext(get().messages);
        let mission: { id: string; goalGraph?: { tasks: unknown[] } | null; error?: string } | null = null;
        let failure: string | null = null;
        let building: BuildingDraft = { status: 'building' };
        await missionClient.create(projectId, goal, (e) => {
          if (e.type === 'done') mission = e.mission;
          else if (e.type === 'error') failure = e.message;
          else {
            const next = foldPlanEvent(building, e);
            if (next !== building) { building = next; setDraft(next); }
          }
        }, controller.signal, { text: pkg.text, scope: projectId, records: pkg.records, sources });
        // A stop that lands after the plan was already saved changes nothing: the
        // finished plan is real, so it is reported as it is. Only a stop that cut
        // the build short (no finished plan came back) is reported as stopped.
        if (controller.signal.aborted && !mission) throw new Error('Stopped before the plan was finished. Nothing was saved to the Planner.');
        const done = mission as { id: string; goalGraph?: { tasks: unknown[] } | null; error?: string } | null;
        if (!done || done.error || !done.goalGraph?.tasks.length) {
          throw new Error(done?.error ?? failure ?? 'The plan could not be built.');
        }
        setDraft({ status: 'ready', missionId: done.id, goal, taskCount: done.goalGraph.tasks.length });
      } catch (e) {
        setDraft({ status: 'failed', error: errorText(e) });
      } finally {
        planControllers.delete(messageId);
      }
    },

    sendToPlanner(messageId) {
      const draft = get().messages.find((m) => m.id === messageId)?.agent?.planDraft;
      if (!draft?.missionId) return;
      useAppStore.getState().setAskAuraOpen(false);
      useAppStore.getState().openWorkspace();
      const layout = useLayoutStore.getState();
      layout.setFocused({ missionId: draft.missionId });
      layout.openPanel('missions');
    },

    stop() {
      const flight = inflight;
      if (!flight || flight.settled) return;
      const sid = flight.sessionId;
      const attempt = async (triesLeft: number): Promise<void> => {
        if (inflight !== flight) return;
        try {
          await centralAgentClient.cancel(sid, get().scope === 'workspace' ? 'cancelled from Execution Chat' : "cancelled from Let's Chat");
        } catch (e) {
          const msg = (e as Error)?.message ?? '';
          if (/no such session/i.test(msg) && triesLeft > 0) {
            await new Promise((r) => { cancelTimer = setTimeout(r, 400); });
            return attempt(triesLeft - 1);
          }
        }
      };
      // The backend settles a stopped run into one terminal result — the
      // verified work kept, the stopped step marked, the objective not
      // accepted. Stopping drops the live stream, so read that result from
      // the session and show it; until it lands the message says "Stopped.".
      const adoptSettled = async (triesLeft: number): Promise<void> => {
        let result: AgentResult | null | undefined;
        try {
          result = (await centralAgentClient.getSession(sid))?.lastResult;
        } catch { result = null; }
        if (result && result.outcome === 'cancelled') {
          patchMsg(flight.assistantId, (m) => ({
            ...m, status: 'cancelled', content: result!.summary,
            agent: m.agent ? { ...m.agent, outcome: 'cancelled', cancelled: true, ...missionMeta(result!) } : m.agent,
          }));
          return;
        }
        if (triesLeft > 0) {
          await new Promise((r) => { setTimeout(r, 750); });
          return adoptSettled(triesLeft - 1);
        }
      };
      void attempt(25).then(() => adoptSettled(40));
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

    async handoffToWorkspace(convId, messageIds, title, notes) {
      const { scope, projectId } = get();
      // Only a PROJECT discussion can be handed off. The workspace's
      // execution chat is the destination, never the source.
      if (scope !== 'project' || !projectId) {
        throw new Error("handoffs can only be sent from a project Let's Chat conversation");
      }
      if (!messageIds.length) throw new Error('a handoff needs at least one message');
      return aiClient.createHandoff(projectId, {
        sourceConversationId: convId,
        sourceMessageIds: messageIds,
        title,
        notes,
        targetWorkspaceId: `workspace:${projectId}`,
      });
    },

    async reloadHandoffs() {
      const { scope, workspaceId } = get();
      if (scope !== 'workspace' || !workspaceId) return;
      try { set({ handoffs: (await aiClient.listWorkspaceHandoffs(workspaceId)).handoffs }); } catch { /* keep */ }
    },

    async acceptHandoff(handoff) {
      const { scope, workspaceId, activeId } = get();
      if (scope !== 'workspace' || !workspaceId) return;
      // The service appends the task block to the WORKSPACE conversation
      // only; re-selecting the active thread makes it visible here.
      await aiClient.acceptHandoff(handoff.projectId, handoff.id, {
        workspaceId,
        ...(activeId ? { conversationId: activeId } : {}),
      });
      await get().reloadHandoffs();
      const active = get().activeId;
      if (active) await get().select(active);
    },
  };
});
