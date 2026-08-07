/**
 * useAiAction — the orchestrator for every right-click/Ctrl+I action.
 * ------------------------------------------------------------------
 * One pipeline for all 12 actions (see actionSpecs.ts): resolve real
 * context from the knowledge graph (instant, no network), then make one
 * grounded call to `POST /code/action`. The progress UI it exposes is
 * intentionally built from real, discrete steps — real counts before any
 * network call, then a real elapsed-time counter during it — rather than
 * a fabricated "reasoning" stream (this repo's `generate()` primitive is
 * single-shot, not token-streamed; see codeAction.ts on the backend).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { aiClient, type ActionKind, type CodeActionResponse, type RiskLevel } from '../ai/aiClient';
import { useEditorStore } from './editorStore';
import type { EditorSelection } from './editorTypes';
import { contextForSelection, riskFloor as computeRiskFloor } from './aiContext';
import { useProjectData } from '../screens/project/sections/shared';

export type AiActionPhase = 'idle' | 'context-resolved' | 'generating' | 'done' | 'error';

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
  contextSummary: AiActionContextSummary | null;
  risk: { level: RiskLevel; reasons: string[] } | null;
  elapsedMs: number;
  response: CodeActionResponse | null;
  errorMessage: string | null;
}

const IDLE_STATE: AiActionState = {
  phase: 'idle', action: null, filePath: null, selection: null, originalCode: '',
  contextSummary: null, risk: null, elapsedMs: 0, response: null, errorMessage: null,
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

/** Up to `n` lines immediately before/after the selection — reference-only context for the prompt. */
export function surroundingLines(content: string, selection: EditorSelection | null, n = 12): { before: string; after: string } {
  if (!selection) return { before: '', after: '' };
  const lines = content.split('\n');
  const before = lines.slice(Math.max(0, selection.startLine - 1 - n), selection.startLine - 1).join('\n');
  const after = lines.slice(selection.endLine, selection.endLine + n).join('\n');
  return { before, after };
}

/** Splices `replacement` into `content` at `selection` (or replaces the whole file when there's no selection). */
export function spliceSelection(content: string, selection: EditorSelection | null, replacement: string): string {
  if (!selection) return replacement;
  const lines = content.split('\n');
  const before = lines.slice(0, selection.startLine - 1);
  const startLine = lines[selection.startLine - 1] ?? '';
  const endLine = lines[selection.endLine - 1] ?? '';
  const beforeLine = startLine.slice(0, selection.startColumn - 1);
  const afterLine = endLine.slice(selection.endColumn - 1);
  const after = lines.slice(selection.endLine);
  return [...before, beforeLine + replacement + afterLine, ...after].join('\n');
}

export function useAiAction(projectId: string) {
  const [state, setState] = useState<AiActionState>(IDLE_STATE);
  const { graph } = useProjectData(projectId);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  const run = useCallback(
    async (action: ActionKind, customInstruction?: string) => {
      const { activePath, openFiles } = useEditorStore.getState();
      const file = activePath ? openFiles[activePath] : undefined;
      if (!file) return;

      const selectedCode = extractSelection(file.content, file.selection);
      const ctx = contextForSelection(graph, file.path, file.cursor.line);
      const floor = computeRiskFloor(action, ctx, selectedCode);

      setState({
        phase: 'context-resolved',
        action,
        filePath: file.path,
        selection: file.selection,
        originalCode: selectedCode,
        contextSummary: {
          symbolLabel: ctx.symbol ? `${ctx.symbol.kind} ${ctx.symbol.name}` : null,
          dependencyCount: ctx.dependencies.length,
          referenceCount: ctx.referenceCount,
          dependentFileCount: ctx.dependentFileCount,
        },
        risk: floor,
        elapsedMs: 0,
        response: null,
        errorMessage: null,
      });

      const surrounding = surroundingLines(file.content, file.selection);
      const t0 = Date.now();
      timerRef.current = setInterval(() => {
        setState((s) => (s.phase === 'generating' ? { ...s, elapsedMs: Date.now() - t0 } : s));
      }, 100);
      setState((s) => ({ ...s, phase: 'generating' }));

      try {
        const res = await aiClient.codeAction({
          projectId,
          action,
          filePath: file.path,
          language: file.language,
          selectedCode,
          selectionRange: file.selection,
          surroundingContext: surrounding,
          symbol: ctx.symbol,
          dependencies: ctx.dependencies,
          dependents: ctx.dependents,
          dependentFileCount: ctx.dependentFileCount,
          customInstruction,
          riskFloor: floor,
        });
        if (timerRef.current) clearInterval(timerRef.current);
        if (!res.ok) {
          setState((s) => ({ ...s, phase: 'error', response: res, errorMessage: res.error?.message ?? 'The AI request failed.' }));
          return;
        }
        setState((s) => ({ ...s, phase: 'done', response: res }));
      } catch (e) {
        if (timerRef.current) clearInterval(timerRef.current);
        setState((s) => ({ ...s, phase: 'error', errorMessage: (e as Error).message }));
      }
    },
    [graph, projectId],
  );

  const reset = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    setState(IDLE_STATE);
  }, []);

  return { state, run, reset };
}
