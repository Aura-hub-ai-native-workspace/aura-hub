/**
 * AuraBug — controller hook (Bug Bot).
 * ------------------------------------------------------------------
 * Owns the scan lifecycle for the editor workspace:
 *   • scope: the active file (existing behavior), all open tabs, or a
 *     bounded walk of the real project tree,
 *   • auto-scan when the active file changes or is saved (file scope),
 *   • manual rescan with optional AI augmentation (active file only),
 *   • a governed fix lifecycle: detect → analyze → propose → review →
 *     approve (write through the editor's own save authority) → verify
 *     by deterministic re-scan → revert on failed verification.
 *
 * Nothing here invents results: deterministic findings come from Monaco's
 * language service + the static heuristics; AI augmentation is gated
 * behind service health + a provider key, exactly as before. Fixes are
 * only ever written after an explicit user approval, and every approved /
 * rejected / reverted decision is recorded to Engineering Memory.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import { aiClient, type GraphView } from '../../ai/aiClient';
import { recordBugBotMemory } from '../../ops/memoryRecorder';
import { getActiveEditor } from '../editorRegistry';
import { useEditorStore } from '../editorStore';
import {
  analyzeHeuristics,
  applyPatch,
  collectModelMarkers,
  collectOpenFileTargets,
  collectProjectTargets,
  markersToIssues,
  runAiAnalysis,
  scanTargets,
  verifyFix,
} from './scan';
import type {
  AuraBugAiStatus,
  AuraBugIssue,
  AuraBugPhase,
  AuraBugScope,
  AuraBugSeverity,
  AuraBugVerification,
} from './types';

const SEVERITY_RANK: Record<AuraBugSeverity, number> = { error: 0, bug: 1, warning: 2 };

/** Deduplicate identical findings across sources, then order by severity + line. */
function dedupeIssues(issues: AuraBugIssue[]): AuraBugIssue[] {
  const seen = new Set<string>();
  const out: AuraBugIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.filePath}|${issue.line ?? 0}|${issue.title.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return (a.line ?? 0) - (b.line ?? 0);
  });
}

/** Human labels + tones for the Bug Bot lifecycle (panel + status badges). */
export const STATUS_LABEL: Record<AuraBugIssue['status'], string> = {
  detected: 'Detected',
  analyzing: 'Analyzing',
  analyzed: 'Analyzed',
  'fix-proposed': 'Fix proposed',
  'awaiting-approval': 'Awaiting approval',
  approved: 'Approved',
  fixing: 'Fixing',
  verifying: 'Verifying',
  verified: 'Verified',
  'verification-failed': 'Verification failed',
  rejected: 'Rejected',
  failed: 'Failed',
};

export interface AuraBugController {
  phase: AuraBugPhase;
  issues: AuraBugIssue[];
  aiStatus: AuraBugAiStatus;
  aiEnabled: boolean;
  setAiEnabled: (on: boolean) => void;
  selectedId: string | null;
  scope: AuraBugScope;
  setScope: (scope: AuraBugScope) => void;
  filesScanned: number;
  scopeMessage: string | null;
  reviewId: string | null;
  reviewing: AuraBugIssue | null;
  clearReview: () => void;
  rescan: () => void;
  navigateTo: (issue: AuraBugIssue) => void;
  reviewFix: (issueId: string) => void;
  approveFix: (issueId: string) => void;
  rejectFix: (issueId: string) => void;
  revertFix: (issueId: string) => void;
}

const EMPTY_VERIFICATION: AuraBugVerification | undefined = undefined;

/** Runs the AuraBug controller for the editor workspace. */
export function useAuraBug(projectId: string | null, graph: GraphView | null, includeAi: boolean): AuraBugController {
  const activePath = useEditorStore((s) => s.activePath);
  const activeLoading = useEditorStore((s) => (s.activePath ? (s.openFiles[s.activePath]?.loading ?? true) : true));
  const activeDirty = useEditorStore((s) => (s.activePath ? (s.openFiles[s.activePath]?.dirty ?? false) : false));

  const [phase, setPhase] = useState<AuraBugPhase>('idle');
  const [issues, setIssues] = useState<AuraBugIssue[]>([]);
  const [aiStatus, setAiStatus] = useState<AuraBugAiStatus>('idle');
  const [aiEnabled, setAiEnabled] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scope, setScopeState] = useState<AuraBugScope>('file');
  const [filesScanned, setFilesScanned] = useState(0);
  const [scopeMessage, setScopeMessage] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);

  const scanIdRef = useRef(0);
  const appliedRef = useRef(new Set<string>());
  /** True while a governed fix is being written/verified/reverted. The
   *  save-triggered auto-rescan must not fire during this window — it
   *  would replace the issue (dropping `verification` / `preFixContent`)
   *  before the lifecycle can finish, which is what breaks the
   *  verification-failed → revert path. */
  const fixInFlightRef = useRef(false);
  const decorationIdsRef = useRef<string[]>([]);
  const wasLoadingRef = useRef(true);
  const wasDirtyRef = useRef(false);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const aiEnabledRef = useRef(aiEnabled);
  aiEnabledRef.current = aiEnabled;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const issuesRef = useRef(issues);
  issuesRef.current = issues;

  const clearHighlight = useCallback(() => {
    const editor = getActiveEditor();
    if (!editor) return;
    decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, []);
  }, []);

  const patchIssue = useCallback((issueId: string, patch: Partial<AuraBugIssue>) => {
    setIssues((prev) => prev.map((i) => (i.id === issueId ? { ...i, ...patch } : i)));
  }, []);

  /** The single-file scan (existing AuraBug behavior) with optional AI. */
  const runFileScan = useCallback(async () => {
    const { activePath: path, openFiles } = useEditorStore.getState();
    const file = path ? openFiles[path] : undefined;
    if (!file || file.loading || file.error) return;

    const editor = getActiveEditor();
    const model = editor?.getModel();
    const content = model ? model.getValue() : file.content;
    const uri = monaco.Uri.parse(file.path);

    const scanId = ++scanIdRef.current;
    appliedRef.current = new Set();
    setPhase('scanning');
    setIssues([]);
    setSelectedId(null);
    setReviewId(null);
    clearHighlight();
    setFilesScanned(1);
    setScopeMessage(null);

    let deterministic: AuraBugIssue[] = [];
    try {
      const markers = await collectModelMarkers(uri);
      deterministic = markersToIssues(markers, file);
    } catch {
      deterministic = [];
    }
    deterministic = deterministic.concat(analyzeHeuristics(content, file));

    const wantAi = aiEnabledRef.current && includeAi && !!projectId;
    let aiIssues: AuraBugIssue[] = [];
    let nextAiStatus: AuraBugAiStatus = wantAi ? 'pending' : 'unavailable';
    if (wantAi && projectId) {
      const res = await runAiAnalysis(projectId, file, content, graphRef.current);
      aiIssues = res.issues;
      nextAiStatus = res.status;
    }

    if (scanId !== scanIdRef.current) return;
    setIssues(dedupeIssues([...deterministic, ...aiIssues]));
    setAiStatus(nextAiStatus);
    setPhase('done');
  }, [projectId, includeAi, clearHighlight]);

  /** The multi-file scan: every open tab, or the bounded project walk. */
  const runMultiFileScan = useCallback(async (target: AuraBugScope) => {
    const scanId = ++scanIdRef.current;
    appliedRef.current = new Set();
    setPhase('scanning');
    setIssues([]);
    setSelectedId(null);
    setReviewId(null);
    clearHighlight();
    setScopeMessage(null);

    let targets;
    let message: string | undefined;
    if (target === 'project') {
      const res = await collectProjectTargets();
      targets = res.targets;
      message = res.message;
    } else {
      targets = collectOpenFileTargets();
    }

    if (!targets.length) {
      if (scanId !== scanIdRef.current) return;
      setIssues([]);
      setAiStatus('unavailable');
      setFilesScanned(0);
      setScopeMessage(message ?? 'No files to scan.');
      setPhase('done');
      return;
    }

    const res = await scanTargets(targets);
    if (scanId !== scanIdRef.current) return;
    setIssues(dedupeIssues(res.issues));
    setAiStatus('unavailable');
    setFilesScanned(res.filesScanned);
    setScopeMessage(message ?? null);
    setPhase('done');
  }, [clearHighlight]);

  const rescan = useCallback(() => {
    if (fixInFlightRef.current) return;
    if (scopeRef.current === 'file') void runFileScan();
    else void runMultiFileScan(scopeRef.current);
  }, [runFileScan, runMultiFileScan]);

  const setScope = useCallback(
    (next: AuraBugScope) => {
      if (fixInFlightRef.current) return;
      setScopeState(next);
      if (next === 'file') void runFileScan();
      else void runMultiFileScan(next);
    },
    [runFileScan, runMultiFileScan],
  );

  // Rescan whenever the active file changes (open or switch) — file scope
  // only, matching the original AuraBug behavior. openFile sets activePath
  // before content finishes loading, so a scan started here no-ops until
  // the loading->ready transition below fires.
  useEffect(() => {
    if (scopeRef.current !== 'file') return;
    if (fixInFlightRef.current) return;
    void runFileScan();
  }, [runFileScan, activePath]);

  // A file that just finished loading is scan-ready; catch the moment
  // openFile flips loading from true to false (the activePath effect
  // above already fired and bailed out).
  useEffect(() => {
    if (scopeRef.current !== 'file') return;
    if (fixInFlightRef.current) return;
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = activeLoading;
    if (wasLoading && !activeLoading) void runFileScan();
  }, [activeLoading, runFileScan]);

  // Rescan when the active file is saved (dirty -> clean).
  useEffect(() => {
    if (scopeRef.current !== 'file') return;
    if (fixInFlightRef.current) return;
    const wasDirty = wasDirtyRef.current;
    wasDirtyRef.current = activeDirty;
    if (wasDirty && !activeDirty) void runFileScan();
  }, [activeDirty, runFileScan]);

  const navigateTo = useCallback(
    (issue: AuraBugIssue) => {
      if (issue.line === undefined) return;
      const editor = getActiveEditor();
      if (!editor) return;
      const model = editor.getModel();
      if (!model) return;

      const line = Math.min(issue.line, model.getLineCount());
      const position = new monaco.Position(line, 1);
      const range = new monaco.Range(line, 1, line, model.getLineMaxColumn(line));
      editor.setPosition(position);
      editor.revealRangeInCenter(range, monaco.editor.ScrollType.Smooth);
      editor.setSelection(range);
      decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, [
        {
          range: new monaco.Range(line, 1, line, 1),
          options: {
            isWholeLine: true,
            className: 'aurabug-active-line',
          },
        },
      ]);
      setSelectedId(issue.id);
    },
    [],
  );

  /** Move a finding into the review step — it now awaits explicit approval. */
  const reviewFix = useCallback((issueId: string) => {
    const issue = issuesRef.current.find((i) => i.id === issueId);
    if (!issue) return;
    patchIssue(issueId, { status: 'awaiting-approval' });
    setReviewId(issueId);
    setSelectedId(issueId);
  }, [patchIssue]);

  const clearReview = useCallback(() => {
    setReviewId(null);
  }, []);

  /**
   * Approve & apply a fix through the editor's own governed change
   * authority (the same path AIActionDialog uses): update the live buffer,
   * save to disk via the confined Tauri bridge, then re-verify the file
   * deterministically. Only a genuine re-scan can mark the fix verified.
   */
  const approveFix = useCallback(
    async (issueId: string) => {
      const issue = issuesRef.current.find((i) => i.id === issueId);
      if (!issue?.fix) return;

      const state = useEditorStore.getState();
      const openFiles = state.openFiles;
      const file = openFiles[issue.filePath];
      if (!file) {
        patchIssue(issueId, { status: 'failed', verification: { checkedAt: new Date().toISOString(), method: 'none', passed: null, detail: 'The file is not open — open it, then approve the fix again.' } });
        return;
      }
      if (file.loading || file.error) {
        patchIssue(issueId, { status: 'failed', verification: { checkedAt: new Date().toISOString(), method: 'none', passed: null, detail: 'The file could not be loaded, so the fix was not applied.' } });
        return;
      }
      if (appliedRef.current.has(issueId)) return;
      if (fixInFlightRef.current) return;
      appliedRef.current.add(issueId);
      fixInFlightRef.current = true;

      const preFixContent = file.content;
      const patched = applyPatch(preFixContent, issue);
      patchIssue(issueId, { status: 'approved', applying: true, preFixContent });

      try {
        state.updateContent(issue.filePath, patched);
        await state.saveFile(issue.filePath);
        const after = useEditorStore.getState().openFiles[issue.filePath];
        if (after?.saveError) throw new Error(after.saveError);

        patchIssue(issueId, { status: 'fixing' });
        void aiClient.reindex(); // fire-and-forget — refresh the Knowledge Fabric shortly after

        patchIssue(issueId, { status: 'verifying' });
        const verification = await verifyFix(issue);
        patchIssue(issueId, {
          verification,
          status: verification.passed === true ? 'verified' : 'verification-failed',
          applying: false,
        });
        recordBugBotMemory({
          filePath: issue.filePath,
          event: 'fix-approved',
          title: `Bug Bot fix applied: ${issue.title}`,
          summary: verification.passed === true ? 'Applied and verified by deterministic re-scan.' : `Applied, but ${verification.detail}`,
          severity: issue.severity,
        });
      } catch (e) {
        patchIssue(issueId, {
          status: 'failed',
          applying: false,
          verification: {
            checkedAt: new Date().toISOString(),
            method: 'none',
            passed: null,
            detail: (e as Error).message || 'The fix could not be written to disk.',
          },
        });
        recordBugBotMemory({
          filePath: issue.filePath,
          event: 'fix-failed',
          title: `Bug Bot fix failed to apply: ${issue.title}`,
          summary: (e as Error).message || 'Write failed',
          severity: issue.severity,
        });
      } finally {
        fixInFlightRef.current = false;
      }
    },
    [patchIssue],
  );

  const rejectFix = useCallback(
    (issueId: string) => {
      const issue = issuesRef.current.find((i) => i.id === issueId);
      if (!issue) return;
      patchIssue(issueId, { status: 'rejected', applying: false, verification: EMPTY_VERIFICATION });
      setReviewId(null);
      recordBugBotMemory({
        filePath: issue.filePath,
        event: 'fix-rejected',
        title: `Bug Bot fix declined: ${issue.title}`,
        summary: issue.suggestedFix ?? 'No fix applied',
        severity: issue.severity,
      });
    },
    [patchIssue],
  );

  /** Roll back a fix whose verification failed — restore the exact pre-fix content. */
  const revertFix = useCallback(
    async (issueId: string) => {
      const issue = issuesRef.current.find((i) => i.id === issueId);
      if (!issue?.preFixContent) return;
      const state = useEditorStore.getState();
      const file = state.openFiles[issue.filePath];
      if (!file) return;
      if (appliedRef.current.has(issueId)) return;
      if (fixInFlightRef.current) return;
      appliedRef.current.add(issueId);
      fixInFlightRef.current = true;
      patchIssue(issueId, { applying: true });
      try {
        state.updateContent(issue.filePath, issue.preFixContent);
        await state.saveFile(issue.filePath);
        const after = useEditorStore.getState().openFiles[issue.filePath];
        if (after?.saveError) throw new Error(after.saveError);
        patchIssue(issueId, {
          status: 'rejected',
          applying: false,
          verification: undefined,
          preFixContent: undefined,
        });
        recordBugBotMemory({
          filePath: issue.filePath,
          event: 'fix-reverted',
          title: `Bug Bot fix reverted: ${issue.title}`,
          summary: 'Reverted to the pre-fix content after failed verification.',
          severity: issue.severity,
        });
      } catch (e) {
        patchIssue(issueId, {
          applying: false,
          verification: {
            checkedAt: new Date().toISOString(),
            method: 'none',
            passed: null,
            detail: (e as Error).message || 'The revert could not be written to disk.',
          },
        });
      } finally {
        fixInFlightRef.current = false;
      }
    },
    [patchIssue],
  );

  const reviewing = reviewId ? (issues.find((i) => i.id === reviewId) ?? null) : null;

  return {
    phase,
    issues,
    aiStatus,
    aiEnabled,
    setAiEnabled,
    selectedId,
    scope,
    setScope,
    filesScanned,
    scopeMessage,
    reviewId,
    reviewing,
    clearReview,
    rescan,
    navigateTo,
    reviewFix,
    approveFix,
    rejectFix,
    revertFix,
  };
}
