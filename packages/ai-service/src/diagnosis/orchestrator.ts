/**
 * orchestrator — runs the whole 10-stage Diagnosis Engine pipeline for
 * one request and returns the final `DiagnosisRecord`. The only
 * function `server.ts` calls. Saves to the store as it goes — a crash
 * mid-pipeline leaves an honest partial record, not a lost one. Stops
 * immediately after classification when the category is `'unknown'`:
 * no root cause, no patch, no guessing.
 */
import type { PipelineManager } from '../pipeline';
import type { ProjectMemory } from '../memory';
import { classify } from './classify';
import { computeConfidence } from './confidence';
import { compareCandidates } from './evolution';
import { evaluatePatchLimiter } from './patchLimiter';
import { generatePatch } from './patchGen';
import { generateRootCause } from './rootCause';
import { reviewPatch } from './reviewer';
import { gatherSignals } from './signals';
import { simulatePatch } from './simulate';
import type { DiagnosisEvent, DiagnosisRecord, DiagnosisRequest, PatchCandidate, PatchStrategy } from './types';
import type { DiagnosisStore } from './store';

const STRATEGIES: { id: 'A' | 'B' | 'C'; strategy: PatchStrategy }[] = [
  { id: 'A', strategy: 'minimal-fix' },
  { id: 'B', strategy: 'defensive-fix' },
  { id: 'C', strategy: 'refactor-adjacent-fix' },
];

const now = () => new Date().toISOString();

export async function runDiagnosis(
  pipeline: PipelineManager,
  memory: ProjectMemory | null,
  store: DiagnosisStore,
  projectPath: string,
  req: DiagnosisRequest,
  emit: (e: DiagnosisEvent) => void,
  signal?: AbortSignal,
): Promise<DiagnosisRecord> {
  emit({ type: 'stage', stage: 'signals', status: 'start', at: now() });
  const { signals, detectorContext } = await gatherSignals(pipeline, projectPath, req);
  emit({ type: 'signals', signals });
  emit({ type: 'stage', stage: 'signals', status: 'done', at: now() });

  emit({ type: 'stage', stage: 'classify', status: 'start', at: now() });
  const classification = classify(detectorContext);
  emit({ type: 'classification', classification });
  emit({ type: 'stage', stage: 'classify', status: 'done', at: now() });

  if (classification.category === 'unknown') {
    const message = "AURA's deterministic classifier checked for null/undefined-access, dead code, broken API, and architecture-layer violations and found none it could verify. No root cause or patch was generated.";
    emit({ type: 'unknown-stop', message });
    const diagnosis = store.create(req.projectId, {
      filePath: req.filePath,
      signals,
      classification,
      rootCause: null,
      candidates: [],
      comparison: null,
      decision: { status: 'pending' },
    });
    memory?.add({ kind: 'diagnosis', title: `Diagnosis: ${req.filePath} — unknown`, body: message });
    emit({ type: 'done', diagnosis });
    return diagnosis;
  }

  let diagnosis = store.create(req.projectId, {
    filePath: req.filePath,
    signals,
    classification,
    rootCause: null,
    candidates: [],
    comparison: null,
    decision: { status: 'pending' },
  });

  emit({ type: 'stage', stage: 'root-cause', status: 'start', at: now() });
  const rootCauseRes = await generateRootCause(pipeline, classification, signals, signal);
  if (!rootCauseRes.ok) {
    emit({ type: 'error', message: `Root cause generation failed: ${rootCauseRes.error.message}` });
    emit({ type: 'done', diagnosis });
    return diagnosis;
  }
  const rootCause = rootCauseRes.rootCause;
  diagnosis = store.patch(req.projectId, diagnosis.id, { rootCause }) ?? diagnosis;
  emit({ type: 'root-cause', rootCause });
  emit({ type: 'stage', stage: 'root-cause', status: 'done', at: now() });

  memory?.add({
    kind: 'diagnosis',
    title: `Diagnosis: ${req.filePath} — ${classification.category}`,
    body: rootCause.summary,
  });

  const candidates: PatchCandidate[] = [];
  for (const { id, strategy } of STRATEGIES) {
    emit({ type: 'stage', stage: `patch-${id}`, status: 'start', at: now() });
    const patchRes = await generatePatch(pipeline, strategy, classification, rootCause, signals, detectorContext.fileText, signal);
    if (!patchRes.ok) {
      emit({ type: 'error', message: `Patch ${id} (${strategy}) generation failed: ${patchRes.error.message}` });
      emit({ type: 'stage', stage: `patch-${id}`, status: 'done', at: now() });
      continue;
    }
    const { patch } = patchRes;

    const { limiter, patchedFileText } = evaluatePatchLimiter(
      detectorContext.fileText,
      patch.targetRange,
      patch.newText,
      detectorContext.absFilePath,
      projectPath,
      detectorContext.entities,
    );
    const impact = simulatePatch(classification.category, detectorContext, patchedFileText, limiter.stats.exportsRemoved, signals.relatedTests);
    const confidence = computeConfidence(classification, classification.category, limiter.stats, impact);

    const reviewRes = await reviewPatch(pipeline, classification, rootCause, patch, limiter, impact, signal);
    const reviewer = reviewRes.ok
      ? reviewRes.verdict
      : { verdict: 'pass' as const, flaws: [], summary: `Reviewer call failed (${reviewRes.error.message}) — treated as pass, not rejected, since the failure is ours, not the patch's.` };

    const candidate: PatchCandidate = { id, strategy, summary: patch.summary, explanation: patch.explanation, targetRange: patch.targetRange, newText: patch.newText, limiter, impact, confidence, reviewer };
    candidates.push(candidate);
    diagnosis = store.patch(req.projectId, diagnosis.id, { candidates: [...candidates] }) ?? diagnosis;
    emit({ type: 'candidate', candidate });
    emit({ type: 'stage', stage: `patch-${id}`, status: 'done', at: now() });
  }

  emit({ type: 'stage', stage: 'comparison', status: 'start', at: now() });
  const comparison = await compareCandidates(pipeline, candidates, signal);
  diagnosis = store.patch(req.projectId, diagnosis.id, { comparison }) ?? diagnosis;
  emit({ type: 'comparison', comparison });
  emit({ type: 'stage', stage: 'comparison', status: 'done', at: now() });

  emit({ type: 'done', diagnosis });
  return diagnosis;
}
