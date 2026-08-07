/**
 * useDiagnosis — orchestrator for the Engineering Diagnosis Engine.
 * ------------------------------------------------------------------
 * Its own hook (not a retrofit of `useAiAction`) because the state is
 * meaningfully richer: a 10-stage pipeline with per-candidate patch
 * data, not a single request/response. `run()` streams real SSE stage
 * events from the backend; `accept()`/`reject()` are separate, explicit
 * calls — nothing is ever written to disk by `run()` itself.
 */
import { useCallback, useRef, useState } from 'react';
import {
  diagnosisClient,
  type Classification,
  type DiagnosisComparison,
  type DiagnosisEvent,
  type DiagnosisRecord,
  type FailureSignals,
  type PatchCandidate,
  type RootCause,
} from '../ai/diagnosisClient';
import { useEditorStore } from './editorStore';
import { splicePatch } from './editorTypes';
import { recordDiagnosisMemory } from '../ops/memoryRecorder';

export type DiagnosisPhase = 'idle' | 'analyzing' | 'diagnosing' | 'patching' | 'reviewing' | 'done' | 'error';

export interface DiagnosisState {
  phase: DiagnosisPhase;
  filePath: string | null;
  signals: FailureSignals | null;
  classification: Classification | null;
  rootCause: RootCause | null;
  candidates: PatchCandidate[];
  comparison: DiagnosisComparison | null;
  diagnosis: DiagnosisRecord | null;
  unknownMessage: string | null;
  errorMessage: string | null;
}

const IDLE_STATE: DiagnosisState = {
  phase: 'idle', filePath: null, signals: null, classification: null, rootCause: null,
  candidates: [], comparison: null, diagnosis: null, unknownMessage: null, errorMessage: null,
};


export function useDiagnosis(projectId: string) {
  const [state, setState] = useState<DiagnosisState>(IDLE_STATE);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    const { activePath, openFiles } = useEditorStore.getState();
    const file = activePath ? openFiles[activePath] : undefined;
    if (!file) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setState({ ...IDLE_STATE, phase: 'analyzing', filePath: file.path });

    await diagnosisClient.run(
      projectId,
      { filePath: file.path, language: file.language, selectionRange: file.selection },
      (e: DiagnosisEvent) => {
        setState((s) => {
          switch (e.type) {
            case 'signals':
              return { ...s, signals: e.signals };
            case 'classification':
              return { ...s, classification: e.classification, phase: 'diagnosing' };
            case 'root-cause':
              return { ...s, rootCause: e.rootCause, phase: 'patching' };
            case 'candidate':
              return { ...s, candidates: [...s.candidates.filter((c) => c.id !== e.candidate.id), e.candidate].sort((a, b) => a.id.localeCompare(b.id)), phase: 'patching' };
            case 'comparison':
              return { ...s, comparison: e.comparison, phase: 'reviewing' };
            case 'unknown-stop':
              return { ...s, unknownMessage: e.message };
            case 'done':
              return { ...s, diagnosis: e.diagnosis, phase: 'done' };
            case 'error':
              return { ...s, errorMessage: e.message, phase: s.phase === 'idle' || s.phase === 'analyzing' ? 'error' : s.phase };
            default:
              return s;
          }
        });
      },
      ac.signal,
    );
  }, [projectId]);

  const accept = useCallback(async (candidateId: 'A' | 'B' | 'C') => {
    if (!state.diagnosis) return { ok: false, error: 'no diagnosis' };
    const result = await diagnosisClient.accept(projectId, state.diagnosis.id, candidateId);
    if (result.ok) {
      const candidate = state.diagnosis.candidates.find((c) => c.id === candidateId);
      const { openFiles, updateContent, saveFile } = useEditorStore.getState();
      const file = state.filePath ? openFiles[state.filePath] : undefined;
      // The backend already wrote the patch to disk (this is the real,
      // authoritative accept) — this resync just keeps the open editor
      // buffer in sync so the user isn't left looking at stale content.
      // saveFile() catches its own write errors onto the file record
      // instead of throwing, so a resync failure must be checked for
      // explicitly rather than assumed away.
      let resyncWarning: string | undefined;
      if (candidate && file) {
        const patched = splicePatch(file.content, candidate.targetRange, candidate.newText);
        updateContent(file.path, patched);
        await saveFile(file.path);
        const after = useEditorStore.getState().openFiles[file.path];
        if (after?.saveError) resyncWarning = `Accepted and saved, but the open tab could not refresh (${after.saveError}). Close and reopen the file to see the change.`;
      }
      setState((s) => (s.diagnosis ? { ...s, diagnosis: { ...s.diagnosis, decision: { status: 'accepted', candidateId, at: new Date().toISOString() } } } : s));
      recordDiagnosisMemory(projectId, {
        id: state.diagnosis.id,
        filePath: state.diagnosis.filePath,
        event: 'accepted',
        candidateId,
        category: state.diagnosis.classification.category,
      });
      if (resyncWarning) return { ok: true, error: resyncWarning };
    }
    return result;
  }, [projectId, state.diagnosis, state.filePath]);

  const reject = useCallback(async (candidateId?: 'A' | 'B' | 'C', reason?: string) => {
    if (!state.diagnosis) return { ok: false, error: 'no diagnosis' };
    const result = await diagnosisClient.reject(projectId, state.diagnosis.id, candidateId, reason);
    if (result.ok) {
      setState((s) => (s.diagnosis ? { ...s, diagnosis: { ...s.diagnosis, decision: { status: 'rejected', candidateId, reason, at: new Date().toISOString() } } } : s));
      recordDiagnosisMemory(projectId, {
        id: state.diagnosis.id,
        filePath: state.diagnosis.filePath,
        event: 'rejected',
        candidateId,
        reason,
        category: state.diagnosis.classification.category,
      });
    }
    return result;
  }, [projectId, state.diagnosis]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(IDLE_STATE);
  }, []);

  return { state, run, accept, reject, reset };
}
