/**
 * evolution — Stage 9, Patch Evolution. Compares only the candidates
 * that survived BOTH the Patch Limiter (not auto-rejected) and the
 * Reviewer (not rejected). Never fabricates a recommendation: if zero
 * candidates survive, `recommended` is honestly `null`. If exactly one
 * survives, it's recommended without spending an LLM call on a
 * comparison that has nothing to compare against.
 */
import type { PipelineManager } from '../pipeline';
import { parseModelJson } from '../jsonMode';
import type { DiagnosisComparison, PatchCandidate } from './types';

const SYSTEM =
  'You compare two or three already-generated, already-reviewed code patches that all address the same root cause. ' +
  'Compare them on performance, maintainability, security, complexity, and developer experience. ' +
  'You output ONLY valid JSON, no prose, no code fences. The JSON object must have exactly these keys: ' +
  '"recommended" (the candidate id you recommend, e.g. "A"), "writeup" (a short paragraph explaining the comparison and why).';

function buildUserPrompt(survivors: PatchCandidate[]): string {
  const lines: string[] = [];
  for (const c of survivors) {
    lines.push(`Candidate ${c.id} — strategy: ${c.strategy}`);
    lines.push(`Summary: ${c.summary}`);
    lines.push(`Explanation: ${c.explanation}`);
    lines.push(`Limiter decision: ${c.limiter.decision} (${c.limiter.reasons.join('; ')})`);
    lines.push(`Confidence: diagnosis=${c.confidence.diagnosis.toFixed(2)} patch=${c.confidence.patch.toFixed(2)} simulation=${c.confidence.simulation.toFixed(2)} overall=${c.confidence.overall.toFixed(2)}`);
    lines.push(`Reviewer: ${c.reviewer.verdict} — ${c.reviewer.summary}`);
    lines.push('');
  }
  lines.push('Respond with ONLY the JSON object described in the system message.');
  return lines.join('\n');
}

export async function compareCandidates(
  pipeline: PipelineManager,
  candidates: PatchCandidate[],
  signal?: AbortSignal,
): Promise<DiagnosisComparison> {
  const survivors = candidates.filter((c) => c.limiter.decision !== 'auto-rejected' && c.reviewer.verdict !== 'reject');

  if (survivors.length === 0) return { recommended: null, writeup: 'No candidate survived both the Patch Limiter and the adversarial Reviewer — nothing can be honestly recommended.' };
  if (survivors.length === 1) return { recommended: survivors[0].id, writeup: `Only ${survivors[0].id} survived both the Patch Limiter and the Reviewer, so it is recommended by elimination — no comparison was needed.` };

  const user = buildUserPrompt(survivors);
  const res = await pipeline.generate({ system: SYSTEM, user, json: true }, signal);
  if (!res.ok) {
    const fallback = survivors.reduce((best, c) => (c.confidence.overall > best.confidence.overall ? c : best));
    return { recommended: fallback.id, writeup: `Comparison call failed (${res.error.message}) — falling back to the surviving candidate with the highest overall confidence.` };
  }

  try {
    const parsed = parseModelJson(res.text);
    const survivorIds = new Set(survivors.map((c) => c.id));
    const recommended = parsed.recommended === 'A' || parsed.recommended === 'B' || parsed.recommended === 'C' ? parsed.recommended : null;
    return {
      recommended: recommended && survivorIds.has(recommended) ? recommended : survivors[0].id,
      writeup: typeof parsed.writeup === 'string' ? parsed.writeup : '',
    };
  } catch {
    const fallback = survivors.reduce((best, c) => (c.confidence.overall > best.confidence.overall ? c : best));
    return { recommended: fallback.id, writeup: 'Comparison response was not valid JSON — falling back to the surviving candidate with the highest overall confidence.' };
  }
}
