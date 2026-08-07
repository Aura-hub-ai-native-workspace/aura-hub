/**
 * intentExtraction — Stage 1 refinement + Stage 2 (Intent Extraction),
 * combined into ONE LLM call.
 * ==================================================================
 * Two reasons these are one call, not two: (a) refining a category
 * choice and extracting the goal behind that category are the same
 * reasoning act — the model reads the same mission text once either
 * way; (b) real Groq free-tier rate limits (documented against
 * `llama-3.1-8b-instant` during the Diagnosis Engine build — 6000 TPM
 * exhausted after 1-2 calls) make every avoidable extra call a real
 * cost, not a free one.
 *
 * The model is handed the deterministic classifier's own candidate
 * list (see `intentClassifier.ts`) and may only pick AMONG those
 * candidates — never invent a category. This is enforced in code
 * (`resolveCategory` below), not merely by prompt instruction: if the
 * model returns anything outside the candidate set (or no candidates
 * existed at all), the deterministic top choice wins outright.
 */
import type { PipelineManager } from '../pipeline';
import { parseModelJson } from '../jsonMode';
import type {
  ExtractedIntent,
  IntentClassification,
  MissionCategory,
  MissionRiskLevel,
  MissionScope,
  MissionSignals,
  RequiredQuality,
} from './types';

const SCOPES: MissionScope[] = ['narrow', 'moderate', 'broad'];
const RISKS: MissionRiskLevel[] = ['low', 'medium', 'high'];
const QUALITIES: RequiredQuality[] = ['prototype', 'standard', 'production'];

const SYSTEM = 'You output ONLY valid JSON, no prose, no code fences. The JSON object must have exactly these keys: ' +
  '"category" (string — you MUST copy this verbatim from the "candidates" list given to you; never invent a category not in that list), ' +
  '"categoryConfidence" (number 0-1 — your honest confidence in that category choice), ' +
  '"primaryGoal" (string — the single concrete objective this mission is actually about; be specific to what THIS mission asked for, never a generic restatement of the category), ' +
  '"secondaryGoals" (array of short strings — real, subordinate goals implied by the text; empty array if none), ' +
  '"constraints" (array of short strings — real limitations stated or clearly implied, e.g. a deadline, a tech constraint, "do not touch X"; empty array if none), ' +
  '"deadline" (string or null — a concrete deadline if one is stated or clearly implied, else null; never fabricate one), ' +
  '"targetComponents" (array of short strings — real parts of the system this mission is actually about, drawn from the project signals given; empty array if the mission is project-wide), ' +
  '"expectedOutcome" (string — what "done" concretely looks like for this specific mission), ' +
  '"scope" (one of "narrow"|"moderate"|"broad"), ' +
  '"riskLevel" (one of "low"|"medium"|"high" — risk of the CHANGE this mission implies, not of the project generally), ' +
  '"requiredQuality" (one of "prototype"|"standard"|"production"). ' +
  'CRITICAL: a mission like "prepare for Saturday\'s presentation" must produce presentation-specific goals (stable demo, polished UI, fast startup, no crashes) — ' +
  'it must NOT produce generic goals like "security audit", "database redesign", or "production deployment" just because those are common engineering topics. ' +
  'Every goal you write must be traceable to the actual mission text or the real project signals given below — never a generic checklist.';

function renderSignalsBrief(signals: MissionSignals): string {
  const lines: string[] = [];
  lines.push(`Health score: ${signals.health ? `${signals.health.overall}/100` : 'unavailable'}`);
  if (signals.healthIssues.length) lines.push(`Health issues: ${signals.healthIssues.slice(0, 6).map((i) => i.message).join(', ')}`);
  lines.push(`Architecture layers: ${signals.architectureLayers.map((l) => l.title).join(', ') || 'none resolved'}`);
  if (signals.hotspots.length) lines.push(`Change hotspots: ${signals.hotspots.slice(0, 6).map((h) => `${h.file} (${h.reason})`).join(', ')}`);
  lines.push(`Verification score: ${signals.verificationScore}/100`);
  if (signals.securityFindings.length) lines.push(`Pattern-scan security findings: ${signals.securityFindings.length} (not a full audit)`);
  lines.push(signals.gitStatus.available
    ? `Git: branch ${signals.gitStatus.branch}, ${signals.gitStatus.dirty ? `${signals.gitStatus.changedFiles} uncommitted change(s)` : 'clean'}`
    : `Git: unavailable (${signals.gitStatus.reason})`);
  if (signals.recentCommits.length) lines.push(`Recent commits: ${signals.recentCommits.slice(0, 5).map((c) => c.subject).join(' | ')}`);
  if (signals.technicalDebt.length) lines.push(`Technical debt markers found: ${signals.technicalDebt.length}`);
  lines.push(`Dependencies: ${signals.dependencySummary.total} total, ${signals.dependencySummary.looseRange} loosely pinned`);
  if (signals.openMissions.length) lines.push(`Other open missions: ${signals.openMissions.map((m) => m.text).join(' | ')}`);
  return lines.join('\n');
}

function buildUserPrompt(text: string, classification: IntentClassification, signals: MissionSignals): string {
  const lines: string[] = [];
  lines.push(`Mission text (verbatim): "${text}"`);
  lines.push('');
  lines.push('Deterministic classifier candidates (you may ONLY choose "category" from this list):');
  if (classification.candidates.length) {
    for (const c of classification.candidates) {
      lines.push(`- ${c.category} (score ${c.score}, matched: ${c.matchedSignals.join(', ')})`);
    }
  } else {
    lines.push('- (none matched — the classifier found no confident category; if you also cannot tell, use "unknown")');
  }
  lines.push('');
  lines.push('Real, current project signals (use these to ground targetComponents / constraints / riskLevel — never invent signals not listed here):');
  lines.push(renderSignalsBrief(signals));
  lines.push('');
  lines.push('Respond with ONLY the JSON object described in the system message.');
  return lines.join('\n');
}

function resolveCategory(modelCategory: unknown, classification: IntentClassification): { category: MissionCategory; source: 'deterministic' | 'refined' } {
  const allowed = new Set<string>(classification.candidates.map((c) => c.category));
  if (classification.category === 'unknown' && !allowed.size) {
    return { category: 'unknown', source: 'deterministic' };
  }
  if (typeof modelCategory === 'string' && allowed.has(modelCategory)) {
    return { category: modelCategory as MissionCategory, source: modelCategory === classification.category ? 'deterministic' : 'refined' };
  }
  return { category: classification.category, source: 'deterministic' };
}

function pickEnum<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

export async function refineClassificationAndExtractIntent(
  pipeline: PipelineManager,
  text: string,
  classification: IntentClassification,
  signals: MissionSignals,
  signal?: AbortSignal,
): Promise<
  | { ok: true; classification: IntentClassification; intent: ExtractedIntent }
  | { ok: false; error: { type: string; message: string; retryable: boolean } }
> {
  const user = buildUserPrompt(text, classification, signals);
  const res = await pipeline.generate({ system: SYSTEM, user, json: true }, signal);
  if (!res.ok) return { ok: false, error: res.error };

  let parsed: Record<string, unknown>;
  try {
    parsed = parseModelJson(res.text);
  } catch (e) {
    return { ok: false, error: { type: 'parse_error', message: (e as Error).message, retryable: true } };
  }

  const resolved = resolveCategory(parsed.category, classification);
  const modelConfidence = typeof parsed.categoryConfidence === 'number' && Number.isFinite(parsed.categoryConfidence)
    ? Math.min(0.99, Math.max(0, parsed.categoryConfidence))
    : classification.confidence;

  const refinedClassification: IntentClassification = {
    category: resolved.category,
    confidence: resolved.source === 'refined' ? modelConfidence : Math.max(classification.confidence, resolved.category === classification.category ? modelConfidence : classification.confidence),
    candidates: classification.candidates,
    source: resolved.source,
  };

  const intent: ExtractedIntent = {
    primaryGoal: typeof parsed.primaryGoal === 'string' && parsed.primaryGoal.trim() ? parsed.primaryGoal.trim() : text.trim(),
    secondaryGoals: Array.isArray(parsed.secondaryGoals) ? (parsed.secondaryGoals as unknown[]).filter((g): g is string => typeof g === 'string' && g.trim().length > 0) : [],
    constraints: Array.isArray(parsed.constraints) ? (parsed.constraints as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim().length > 0) : [],
    deadline: typeof parsed.deadline === 'string' && parsed.deadline.trim() ? parsed.deadline.trim() : null,
    targetComponents: Array.isArray(parsed.targetComponents) ? (parsed.targetComponents as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim().length > 0) : [],
    expectedOutcome: typeof parsed.expectedOutcome === 'string' ? parsed.expectedOutcome.trim() : '',
    scope: pickEnum(parsed.scope, SCOPES, 'moderate'),
    riskLevel: pickEnum(parsed.riskLevel, RISKS, 'medium'),
    requiredQuality: pickEnum(parsed.requiredQuality, QUALITIES, 'standard'),
  };

  return { ok: true, classification: refinedClassification, intent };
}
