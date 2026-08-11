/**
 * AuraBug — controller hook.
 * ------------------------------------------------------------------
 * Owns the scan lifecycle for the currently active editor file:
 *   • auto-scan when the active file changes or is saved,
 *   • manual rescan (with optional AI augmentation),
 *   • safe fix application into the live model,
 *   • navigation + a pulsing line highlight in the editor.
 *
 * The deterministic scan (editor diagnostics + static heuristics) runs
 * on every file change; the heavier AI-augmented scan is gated behind
 * `includeAi` so it only fires while the results panel is open.
 * Everything is frontend-only — see ./scan.ts for the analysis sources.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import type { GraphView } from '../../ai/aiClient';
import { getActiveEditor } from '../editorRegistry';
import { useEditorStore } from '../editorStore';
import {
  analyzeHeuristics,
  applyPatch,
  collectModelMarkers,
  markersToIssues,
  runAiAnalysis,
} from './scan';
import type { AuraBugAiStatus, AuraBugIssue, AuraBugPhase, AuraBugSeverity } from './types';

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

export interface AuraBugController {
  phase: AuraBugPhase;
  issues: AuraBugIssue[];
  aiStatus: AuraBugAiStatus;
  aiEnabled: boolean;
  setAiEnabled: (on: boolean) => void;
  selectedId: string | null;
  rescan: () => void;
  applyFix: (issueId: string) => void;
  navigateTo: (issue: AuraBugIssue) => void;
}

/** Runs the AuraBug controller for the active editor file. */
export function useAuraBug(projectId: string | null, graph: GraphView | null, includeAi: boolean): AuraBugController {
  const activePath = useEditorStore((s) => s.activePath);
  const activeLoading = useEditorStore((s) => (s.activePath ? (s.openFiles[s.activePath]?.loading ?? true) : true));
  const activeDirty = useEditorStore((s) => (s.activePath ? (s.openFiles[s.activePath]?.dirty ?? false) : false));
  const updateContent = useEditorStore((s) => s.updateContent);

  const [phase, setPhase] = useState<AuraBugPhase>('idle');
  const [issues, setIssues] = useState<AuraBugIssue[]>([]);
  const [aiStatus, setAiStatus] = useState<AuraBugAiStatus>('idle');
  const [aiEnabled, setAiEnabled] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const scanIdRef = useRef(0);
  const appliedRef = useRef(new Set<string>());
  const decorationIdsRef = useRef<string[]>([]);
  const wasLoadingRef = useRef(true);
  const wasDirtyRef = useRef(false);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const aiEnabledRef = useRef(aiEnabled);
  aiEnabledRef.current = aiEnabled;

  const clearHighlight = useCallback(() => {
    const editor = getActiveEditor();
    if (!editor) return;
    decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, []);
  }, []);

  const runScan = useCallback(async () => {
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
    clearHighlight();

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

  // Rescan whenever the active file changes (open or switch). openFile
  // sets activePath before content finishes loading, so a scan started
  // here no-ops until the loading->ready transition below fires.
  useEffect(() => {
    void runScan();
  }, [runScan, activePath]);

  // A file that just finished loading is scan-ready; catch the moment
  // openFile flips loading from true to false (the activePath effect
  // above already fired and bailed out).
  useEffect(() => {
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = activeLoading;
    if (wasLoading && !activeLoading) void runScan();
  }, [activeLoading, runScan]);

  // Rescan when the active file is saved (dirty -> clean).
  useEffect(() => {
    const wasDirty = wasDirtyRef.current;
    wasDirtyRef.current = activeDirty;
    if (wasDirty && !activeDirty) void runScan();
  }, [activeDirty, runScan]);

  const applyFix = useCallback(
    (issueId: string) => {
      const { activePath: path, openFiles } = useEditorStore.getState();
      const file = path ? openFiles[path] : undefined;
      const issue = issues.find((i) => i.id === issueId);
      if (!file || !issue?.fix || appliedRef.current.has(issueId)) return;

      appliedRef.current.add(issueId);
      updateContent(file.path, applyPatch(file.content, issue));
      setIssues((prev) => prev.map((i) => (i.id === issueId ? { ...i, applied: true } : i)));
      setSelectedId(issueId);
    },
    [issues, updateContent],
  );

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

  return {
    phase,
    issues,
    aiStatus,
    aiEnabled,
    setAiEnabled,
    selectedId,
    rescan: () => void runScan(),
    applyFix,
    navigateTo,
  };
}
