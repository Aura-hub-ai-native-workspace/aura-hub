/**
 * reviewer — Stage 8, one adversarial LLM call per surviving candidate.
 * ==================================================================
 * A second, distinct model role: it tries to PROVE the patch wrong —
 * doesn't fix the root cause, breaks a real caller, introduces a new
 * null-deref, violates the file's style, or overclaims confidence.
 * Rejects only on a genuine, specific flaw — never a vague objection.
 */
import type { PipelineManager } from '../pipeline';
import { parseModelJson } from '../jsonMode';
import type { Classification, ImpactReport, PatchLimiterResult, RootCause, ReviewerVerdict } from './types';

const SYSTEM =
  'You are an adversarial code reviewer. Your ONLY job is to try to prove the given patch WRONG. Look specifically for: ' +
  'it does not actually fix the stated root cause; it breaks a real caller of this file; it introduces a NEW null/undefined-access bug; ' +
  'it violates the surrounding file\'s real style/conventions; or the confidence signals given overclaim what was actually verified. ' +
  'Reject ONLY for a genuine, specific flaw you can name — never for a vague or generic objection. ' +
  'You output ONLY valid JSON, no prose, no code fences. The JSON object must have exactly these keys: ' +
  '"verdict" (one of "pass"|"reject"), "flaws" (array of short specific strings — empty if verdict is "pass"), "summary" (one short sentence).';

function buildUserPrompt(
  classification: Classification,
  rootCause: RootCause,
  patch: { summary: string; explanation: string; newText: string },
  limiter: PatchLimiterResult,
  impact: ImpactReport,
): string {
  const lines: string[] = [];
  lines.push(`Category: ${classification.category}`);
  lines.push(`Root cause claimed: ${rootCause.summary}`);
  lines.push(`Patch summary: ${patch.summary}`);
  lines.push(`Patch explanation: ${patch.explanation}`);
  lines.push('Patch new text:');
  lines.push('```');
  lines.push(patch.newText);
  lines.push('```');
  lines.push(`Patch Limiter decision: ${limiter.decision} (${limiter.reasons.join('; ')})`);
  lines.push(`Simulation: compiled=${impact.compiled}, categoryStillPresent=${impact.categoryStillPresent}, referencesBroken=${impact.referencesBroken.length}`);
  if (impact.diagnostics.length) lines.push(`Compiler diagnostics on patched file: ${impact.diagnostics.map((d) => `L${d.line}: ${d.message}`).join(' | ')}`);
  lines.push('Respond with ONLY the JSON object described in the system message.');
  return lines.join('\n');
}

export async function reviewPatch(
  pipeline: PipelineManager,
  classification: Classification,
  rootCause: RootCause,
  patch: { summary: string; explanation: string; newText: string },
  limiter: PatchLimiterResult,
  impact: ImpactReport,
  signal?: AbortSignal,
): Promise<{ ok: true; verdict: ReviewerVerdict } | { ok: false; error: { type: string; message: string; retryable: boolean } }> {
  const user = buildUserPrompt(classification, rootCause, patch, limiter, impact);
  const res = await pipeline.generate({ system: SYSTEM, user, json: true }, signal);
  if (!res.ok) return { ok: false, error: res.error };

  let parsed: Record<string, unknown>;
  try {
    parsed = parseModelJson(res.text);
  } catch (e) {
    return { ok: false, error: { type: 'parse_error', message: (e as Error).message, retryable: true } };
  }

  const verdict = parsed.verdict === 'reject' ? 'reject' : 'pass';
  const flaws = Array.isArray(parsed.flaws) ? (parsed.flaws as unknown[]).filter((f): f is string => typeof f === 'string') : [];

  return {
    ok: true,
    verdict: { verdict, flaws, summary: typeof parsed.summary === 'string' ? parsed.summary : '' },
  };
}
