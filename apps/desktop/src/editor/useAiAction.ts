/**
 * useAiAction — the orchestrator for every right-click/Ctrl+I action.
 * ------------------------------------------------------------------
 * Ctrl+I is an ENTRY POINT into AURA, not its own AI: every action
 * submits to the Central Agent (`POST /agent/sessions`) with the
 * canonical project identity plus a bounded, fenced editor snapshot.
 * The agent owns intent, planning, authority, execution (Capability
 * Fabric), verification and evidence. The renderer NEVER writes
 * AI-proposed code itself and NEVER calls a provider directly.
 *
 * Read-only actions render the agent's answer. Mutating actions park
 * on approval and execute server-side; the editor only refreshes the
 * tab from disk afterwards (see `reloadFile`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  centralAgentClient,
  newClientSessionId,
  type AgentEventFrame,
  type AgentResult,
  type EditorContext,
  type PlanReview,
} from '../ai/centralAgentClient';
import { useEditorStore } from './editorStore';
import type { EditorSelection } from './editorTypes';
import { contextForSelection } from './aiContext';
import { useProjectData } from '../screens/project/sections/shared';
import type { ActionKind } from '../ai/aiClient';

export type AiActionPhase =
  | 'idle'
  | 'context-resolved'
  | 'generating'
  | 'awaiting-approval'
  | 'done'
  | 'error'
  | 'cancelled';

export interface AiActionContextSummary {
  symbolLabel: string | null;
  dependencyCount: number;
  referenceCount: number;
  dependentFileCount: number;
}

export interface AiActionState {
  phase: AiActionPhase;
  action: ActionKind | null;
  filePath: string | null;
  selection: EditorSelection | null;
  originalCode: string;
  /** Snapshot guard: result is marked stale when the tab moved on. */
  snapshotLength: number;
  contextSummary: AiActionContextSummary | null;
  elapsedMs: number;
  sessionId: string | null;
  /** Server-generated leg correlation for the current run. */
  requestId: string | null;
  /** Safe progress labels derived from agent lifecycle events. */
  progress: string[];
  result: AgentResult | null;
  planReview: PlanReview | null;
  approvalId: string | null;
  stale: boolean;
  errorMessage: string | null;
}

const IDLE_STATE: AiActionState = {
  phase: 'idle', action: null, filePath: null, selection: null, originalCode: '',
  snapshotLength: 0, contextSummary: null, elapsedMs: 0, sessionId: null,
  requestId: null,
  progress: [], result: null, planReview: null, approvalId: null,
  stale: false, errorMessage: null,
};

/** Exact text the current selection (or whole file, if none) covers. */
export function extractSelection(content: string, selection: EditorSelection | null): string {
  if (!selection) return content;
  const lines = content.split('\n');
  if (selection.startLine === selection.endLine) {
    return lines[selection.startLine - 1]?.slice(selection.startColumn - 1, selection.endColumn - 1) ?? '';
  }
  const first = lines[selection.startLine - 1]?.slice(selection.startColumn - 1) ?? '';
  const middle = lines.slice(selection.startLine, selection.endLine - 1);
  const last = lines[selection.endLine - 1]?.slice(0, selection.endColumn - 1) ?? '';
  return [first, ...middle, last].join('\n');
}

/** Up to `n` lines immediately before/after the selection — reference-only context for the agent. */
export function surroundingLines(content: string, selection: EditorSelection | null, n = 12): { before: string; after: string } {
  if (!selection) return { before: '', after: '' };
  const lines = content.split('\n');
  const before = lines.slice(Math.max(0, selection.startLine - 1 - n), selection.startLine - 1).join('\n');
  const after = lines.slice(selection.endLine, selection.endLine + n).join('\n');
  return { before, after };
}

/** UI phrasing only — the Central Agent compiles the real intent. */
const INSTRUCTION: Record<ActionKind, string> = {
  explain: 'Explain what this code does and how it fits into the surrounding file. Do not modify anything.',
  refactor: 'Refactor this code for clarity and maintainability without changing its behavior.',
  optimize: 'Optimize this code for performance.',
  'generate-tests': 'Write tests for this code.',
  'add-docs': 'Add clear documentation comments to this code.',
  simplify: 'Simplify this code, removing unnecessary complexity.',
  'review-security': 'Review this code for security vulnerabilities. Do not modify anything; report findings.',
  convert: 'Convert this code as instructed.',
  rename: 'Rename the symbol as instructed, updating its uses within the given code.',
  custom: 'Follow the additional instruction exactly.',
};

const EVENT_LABELS: Array<[RegExp, string]> = [
  [/^session\.started$/, 'Request received'],
  [/^intent\.compiled$/, 'Understanding request'],
  [/^intent\.clarification-needed$/, 'Needs clarification'],
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
  [/^result\.ready$/, 'Completed'],
  [/^agent\.(failed|cancelled)$/, 'Settling'],
  [/^run\.cancell/, 'Cancelling'],
  [/^stream\.reconnecting$/, 'Live updates paused — reconnecting'],
];

function labelForEvent(frame: AgentEventFrame): string | null {
  for (const [re, label] of EVENT_LABELS) {
    if (re.test(frame.type)) return label;
  }
  return null;
}

function honestError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if ((e as Error)?.name === 'AbortError') return 'Request cancelled.';
  if (/failed to fetch|networkerror|load failed|connection refused/i.test(msg)) {
    return 'Central Agent unavailable — could not reach the agent service. Check that AURA is running and try again.';
  }
  return msg || 'The Central Agent request failed.';
}

export function useAiAction(projectId: string, projectPath?: string) {
  const [state, setState] = useState<AiActionState>(IDLE_STATE);
  const { graph } = useProjectData(projectId);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const cancelRetryRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settledRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const snapshot = useCallback(() => stateRef.current, []);

  const stopTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = undefined;
  };
  const stopStream = () => {
    if (unsubscribeRef.current) unsubscribeRef.current();
    unsubscribeRef.current = null;
  };

  useEffect(() => () => {
    stopTimer();
    stopStream();
    if (cancelRetryRef.current) clearTimeout(cancelRetryRef.current);
    abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pushProgress = useCallback((label: string) => {
    setState((s) => (s.progress[s.progress.length - 1] === label ? s : { ...s, progress: [...s.progress, label] }));
  }, []);

  const onFrame = useCallback((frame: AgentEventFrame) => {
    const label = labelForEvent(frame);
    if (label) pushProgress(label);
  }, [pushProgress]);

  const settle = useCallback((patch: Partial<AiActionState>) => {
    settledRef.current = true;
    stopTimer();
    setState((s) => ({ ...s, ...patch }));
    // Keep the event tail briefly so a terminal `run.cancelled` that
    // arrives a beat later has nothing left to contradict.
    setTimeout(stopStream, 1500);
  }, []);

  /** Route a terminal-or-parked agent result into UI state. Never throws. */
  const routeResult = useCallback(async (result: AgentResult, sessionId: string) => {
    const { openFiles } = useEditorStore.getState();
    setState((s) => {
      const file = s.filePath ? openFiles[s.filePath] : undefined;
      const stale = !!file && file.content.length !== s.snapshotLength;
      return { ...s, stale };
    });
    switch (result.outcome) {
      case 'awaiting-approval': {
        let planReview: PlanReview | null = null;
        try {
          planReview = await centralAgentClient.planReview(sessionId);
        } catch { /* plan review is advisory; approval ids are authoritative */ }
        // Exact correlation only: the approval id comes from THIS
        // result's evidence. When it is absent we surface a
        // deterministic error rather than guessing another session's
        // pending approval (the backend would refuse it with 409).
        const approvalId = result.evidence?.approvalIds?.[0] ?? null;
        if (!approvalId) {
          settle({
            phase: 'error', result,
            errorMessage: 'The run parked for approval but named no approval. Nothing was approved; start a new request.',
          });
          return;
        }
        settle({ phase: 'awaiting-approval', result, planReview, approvalId });
        return;
      }
      case 'completed':
        settle({ phase: 'done', result });
        return;
      case 'needs-clarification':
        // The agent asked a question — the dialog shows it with a
        // follow-up box bound to the SAME session (see followUp).
        settle({ phase: 'done', result });
        return;
      case 'cancelled':
        settle({ phase: 'cancelled', result, errorMessage: null });
        return;
      default:
        settle({
          phase: 'error', result,
          errorMessage: result.summary || `The request ${result.outcome}.`,
        });
    }
  }, [settle]);

  const submitToAgent = useCallback(async (
    sessionId: string,
    instruction: string,
    editorCtx: EditorContext,
    opts: { followUpSid?: string } = {},
  ) => {
    settledRef.current = false;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    stopStream();
    unsubscribeRef.current = centralAgentClient.events(sessionId, (frame) => {
      if (settledRef.current && frame.type !== 'run.cancelled') return;
      onFrame(frame);
      if (frame.type === 'run.cancelled') {
        settle({ phase: 'cancelled', errorMessage: null });
      }
    });
    const t0 = Date.now();
    stopTimer();
    timerRef.current = setInterval(() => {
      setState((s) => (s.phase === 'generating' ? { ...s, elapsedMs: Date.now() - t0 } : s));
    }, 100);
    setState((s) => ({ ...s, phase: 'generating', elapsedMs: 0 }));
    try {
      const res = opts.followUpSid
        ? await centralAgentClient.message(sessionId, instruction, {
          projectId, projectPath, editorContext: editorCtx, signal: controller.signal,
        }).then((r) => ({ result: r.result, sessionId, requestId: r.requestId ?? null }))
        : await centralAgentClient.submit(instruction, {
          projectId, projectPath, editorContext: editorCtx,
          sessionId, signal: controller.signal,
        }).then((r) => ({ ...r, requestId: r.requestId ?? null }));
      const finalSid = res.sessionId ?? sessionId;
      setState((s) => ({ ...s, sessionId: finalSid, requestId: res.requestId }));
      await routeResult(res.result, finalSid);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        settle({ phase: 'cancelled', errorMessage: null });
      } else {
        settle({ phase: 'error', errorMessage: honestError(e) });
      }
    }
  }, [onFrame, projectId, projectPath, routeResult, settle]);

  const run = useCallback(async (action: ActionKind, customInstruction?: string) => {
    const { activePath, openFiles } = useEditorStore.getState();
    const file = activePath ? openFiles[activePath] : undefined;
    if (!file) return;

    const selectedCode = extractSelection(file.content, file.selection);
    const ctx = contextForSelection(graph, file.path, file.cursor.line);
    const surrounding = surroundingLines(file.content, file.selection);
    const instruction = customInstruction?.trim() && action === 'custom'
      ? customInstruction.trim()
      : [INSTRUCTION[action], customInstruction?.trim()].filter(Boolean).join('\nAdditional instruction: ');

    const editorCtx: EditorContext = {
      filePath: file.path,
      language: file.language,
      cursor: { line: file.cursor.line, column: file.cursor.column },
      selection: file.selection ?? undefined,
      selectedCode,
      surrounding,
      symbol: ctx.symbol ? `${ctx.symbol.kind} ${ctx.symbol.name}` : undefined,
      action,
      customInstruction: customInstruction?.trim() || undefined,
    };

    const sessionId = newClientSessionId();
    setState({
      ...IDLE_STATE,
      phase: 'context-resolved',
      action,
      filePath: file.path,
      selection: file.selection,
      originalCode: selectedCode,
      snapshotLength: file.content.length,
      contextSummary: {
        symbolLabel: ctx.symbol ? `${ctx.symbol.kind} ${ctx.symbol.name}` : null,
        dependencyCount: ctx.dependencies.length,
        referenceCount: ctx.referenceCount,
        dependentFileCount: ctx.dependentFileCount,
      },
      sessionId,
      progress: ['Analyzing project'],
    });
    await submitToAgent(sessionId, instruction, editorCtx);
  }, [graph, submitToAgent]);

  /** Follow-up on the same session (clarifications, refinements). */
  const followUp = useCallback(async (text: string) => {
    const prev = stateRef.current;
    if (!prev.sessionId) return;
    // Re-snapshot the CURRENT editor state — the follow-up answers in
    // the context the user sees now, not the one they started with.
    const cur = useEditorStore.getState();
    const file = prev.filePath ? cur.openFiles[prev.filePath] : undefined;
    const editorCtx: EditorContext = {
      filePath: prev.filePath ?? undefined,
      language: file?.language,
      cursor: file ? { line: file.cursor.line, column: file.cursor.column } : undefined,
      selection: file?.selection ?? undefined,
      selectedCode: file ? extractSelection(file.content, file.selection) : undefined,
      surrounding: file ? surroundingLines(file.content, file.selection) : undefined,
      action: prev.action ?? undefined,
      customInstruction: text,
    };
    const sid = prev.sessionId;
    setState((s) => ({ ...s, phase: 'generating', progress: [...s.progress, 'Follow-up sent'], errorMessage: null }));
    await submitToAgent(sid, text, editorCtx, { followUpSid: sid });
  }, [submitToAgent]);

  /** Approve or deny a parked governed action. Approval travels through
   *  the agent ledger — the same ledger the Fabric spends from. */
  const decide = useCallback(async (granted: boolean, reason?: string) => {
    const { sessionId, approvalId } = snapshot();
    if (!sessionId || !approvalId) return;
    setState((s) => ({ ...s, phase: 'generating', progress: [...s.progress, granted ? 'Approval granted — resuming' : 'Approval denied'] }));
    try {
      const { result } = await centralAgentClient.approve(sessionId, approvalId, granted, reason);
      await routeResult(result, sessionId);
    } catch (e) {
      settle({ phase: 'error', errorMessage: honestError(e) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeResult, settle]);

  /** REAL cancellation: the STOP is recorded server-side (retried while
   *  the session is still appearing), the stream is closed, and the run
   *  settles to `cancelled` — never a frontend-only state change. */
  const cancel = useCallback(() => {
    const { phase } = snapshot();
    if (phase !== 'generating' && phase !== 'context-resolved' && phase !== 'awaiting-approval') return;
    pushProgress('Cancelling');
    const attempt = async (triesLeft: number): Promise<void> => {
      const sid = snapshot().sessionId;
      if (!sid) return;
      try {
        await centralAgentClient.cancel(sid, 'cancelled from the code editor');
        return; // recorded — the run settles itself to `cancelled`
      } catch (e) {
        const msg = (e as Error)?.message ?? '';
        if (/no such session/i.test(msg) && triesLeft > 0) {
          await new Promise((r) => { cancelRetryRef.current = setTimeout(r, 400); });
          return attempt(triesLeft - 1);
        }
        // Any other failure still stops the LOCAL wait; the run keeps
        // its server-side state honestly (no fake `cancelled` claim —
        // the SSE `run.cancelled` event settles it when it lands).
      }
    };
    void attempt(25);
    abortRef.current?.abort();
    stopStream();
    settle({ phase: 'cancelled', errorMessage: null });
  }, [pushProgress, settle, snapshot]);

  const reset = useCallback(() => {
    const { phase } = snapshot();
    if (phase === 'generating') {
      // Closing mid-run stops the run — a dialog that disappears while
      // a governed action continues in the background would be an
      // orphaned side effect, the thing this architecture forbids.
      cancel();
    } else {
      stopTimer();
      stopStream();
      abortRef.current?.abort();
    }
    setState(IDLE_STATE);
  }, [cancel, snapshot]);

  return { state, run, reset, cancel, followUp, decide };
}
