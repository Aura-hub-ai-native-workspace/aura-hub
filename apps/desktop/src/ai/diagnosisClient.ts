/**
 * diagnosisClient — fetch wrappers for the Engineering Diagnosis Engine,
 * matching `aiClient.ts`'s style. `startDiagnosis` reuses the exact SSE
 * reader loop already established in `aiClient.runWorkflow`/`stream`
 * (buffered `\n`-split, `data:`/`[DONE]` framing) — copied, not
 * reinvented, so both stay in lockstep if the framing ever changes.
 */
import { aiClient, type CodeRelationRef } from './aiClient';

const BASE = aiClient.base;

export type BugCategory = 'null-bug' | 'dead-code' | 'broken-api' | 'architecture-smell' | 'unknown';
export interface DetectorCheck { name: string; fired: boolean }
export interface Classification { category: BugCategory; evidence: string[]; checksRun: DetectorCheck[] }

export interface GitLogEntry { hash: string; date: string; subject: string }
export interface GitBlameLine { line: number; hash: string; author: string; date: string }
export type Unavailable = { unavailable: true; reason: string };

export interface CrossLayerImport { specifier: string; resolvedRelPath: string; targetLayer: string; allowed: boolean }
export interface CompilerDiagnostic { message: string; line: number }

export interface FailureSignals {
  file: { relPath: string; language: string; totalLines: number };
  symbol: { id: string; name: string; kind: string; line: number } | null;
  imports: { local: string[]; external: string[] };
  exports: string[];
  dependencies: CodeRelationRef[];
  dependents: CodeRelationRef[];
  dependentFileCount: number;
  architectureLayer: string;
  crossLayerImports: CrossLayerImport[];
  gitHistory: GitLogEntry[] | Unavailable;
  gitBlame: GitBlameLine[] | Unavailable;
  relatedTests: { found: boolean; paths: string[] };
  relatedDocs: CodeRelationRef[];
  relatedApis: (CodeRelationRef & { method?: string; path?: string })[];
  dbRelations: CodeRelationRef[];
  compilerDiagnostics: CompilerDiagnostic[];
  runtimeLogs: Unavailable;
  memoryRecall: { id: string; kind: string; title: string }[];
}

export interface RootCause {
  summary: string;
  evidenceUsed: string[];
  relatedComponents: CodeRelationRef[];
  aiStatedConfidence: 'low' | 'medium' | 'high';
}

export interface PatchLimiterStats {
  linesAdded: number;
  linesRemoved: number;
  percentRemoved: number;
  entireFileChanged: boolean;
  exportsRemoved: string[];
  exportsAdded: string[];
  functionsModified: number;
  importsRemovedCount: number;
  architectureLayerChanged: boolean;
}
export type PatchDecision = 'auto-approved' | 'requires-manual-approval' | 'auto-rejected';
export interface PatchLimiterResult { decision: PatchDecision; reasons: string[]; stats: PatchLimiterStats }

export interface ImpactReport {
  compiled: boolean;
  diagnostics: CompilerDiagnostic[];
  categoryStillPresent: boolean;
  referencesBroken: CodeRelationRef[];
  testsFound: boolean;
  testFilePaths: string[];
  notes: string[];
}

export interface ConfidenceScores { diagnosis: number; patch: number; architecture: number; simulation: number; overall: number }
export interface ReviewerVerdict { verdict: 'pass' | 'reject'; flaws: string[]; summary: string }
export type PatchStrategy = 'minimal-fix' | 'defensive-fix' | 'refactor-adjacent-fix';
export interface TargetRange { startLine: number; endLine: number }

export interface PatchCandidate {
  id: 'A' | 'B' | 'C';
  strategy: PatchStrategy;
  summary: string;
  explanation: string;
  targetRange: TargetRange;
  newText: string;
  limiter: PatchLimiterResult;
  impact: ImpactReport;
  confidence: ConfidenceScores;
  reviewer: ReviewerVerdict;
}

export interface DiagnosisComparison { recommended: 'A' | 'B' | 'C' | null; writeup: string }
export interface DiagnosisDecision { status: 'pending' | 'accepted' | 'rejected'; candidateId?: 'A' | 'B' | 'C'; at?: string; reason?: string }

export interface DiagnosisRecord {
  id: string;
  projectId: string;
  filePath: string;
  createdAt: string;
  signals: FailureSignals;
  classification: Classification;
  rootCause: RootCause | null;
  candidates: PatchCandidate[];
  comparison: DiagnosisComparison | null;
  decision: DiagnosisDecision;
}
export interface DiagnosisSummary { id: string; projectId: string; filePath: string; createdAt: string; category: BugCategory; decision: DiagnosisDecision }

export type DiagnosisEvent =
  | { type: 'stage'; stage: string; status: 'start' | 'done'; at: string }
  | { type: 'signals'; signals: FailureSignals }
  | { type: 'classification'; classification: Classification }
  | { type: 'root-cause'; rootCause: RootCause }
  | { type: 'candidate'; candidate: PatchCandidate }
  | { type: 'comparison'; comparison: DiagnosisComparison }
  | { type: 'unknown-stop'; message: string }
  | { type: 'done'; diagnosis: DiagnosisRecord }
  | { type: 'error'; message: string };

export interface DiagnosisRequest {
  filePath: string;
  language: string;
  selectionRange: { startLine: number; startColumn: number; endLine: number; endColumn: number } | null;
}

export const diagnosisClient = {
  list: (projectId: string): Promise<{ diagnoses: DiagnosisSummary[] }> =>
    fetch(`${BASE}/projects/${projectId}/diagnose`).then((r) => r.json()),

  get: (projectId: string, id: string): Promise<DiagnosisRecord | { error: string }> =>
    fetch(`${BASE}/projects/${projectId}/diagnose/${id}`).then((r) => r.json()),

  accept: async (projectId: string, id: string, candidateId: 'A' | 'B' | 'C'): Promise<{ ok: boolean; error?: string }> => {
    try {
      const r = await fetch(`${BASE}/projects/${projectId}/diagnose/${id}/accept`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidateId }),
      });
      return await r.json();
    } catch (e) {
      return { ok: false, error: (e as Error).message || 'Service unreachable' };
    }
  },

  reject: async (projectId: string, id: string, candidateId?: 'A' | 'B' | 'C', reason?: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const r = await fetch(`${BASE}/projects/${projectId}/diagnose/${id}/reject`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidateId, reason }),
      });
      return await r.json();
    } catch (e) {
      return { ok: false, error: (e as Error).message || 'Service unreachable' };
    }
  },

  async run(projectId: string, req: DiagnosisRequest, onEvent: (e: DiagnosisEvent) => void, signal?: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/projects/${projectId}/diagnose`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), signal,
      });
    } catch (e) {
      onEvent({ type: 'error', message: (e as Error).message || 'Service unreachable' });
      return;
    }
    if (!res.body) { onEvent({ type: 'error', message: 'No stream body' }); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim();
          if (d === '[DONE]') return;
          onEvent(JSON.parse(d) as DiagnosisEvent);
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') onEvent({ type: 'error', message: (e as Error).message });
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
    }
  },
};
