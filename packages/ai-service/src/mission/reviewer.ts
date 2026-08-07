/**
 * reviewer — Stage 8, Mission Review. One adversarial LLM call over the
 * whole Goal Graph.
 * ==================================================================
 * Distinct role from Stage 5's planner and from the Diagnosis Engine's
 * per-patch `diagnosis/reviewer.ts` — this reviewer's job is to find
 * planning defects across the WHOLE mission: a missing goal the intent
 * implies but the graph never covers, work that doesn't serve the
 * stated intent, an assumption not backed by the real evidence given,
 * more process than the mission's scope/quality warrants, two tasks
 * doing the same thing, or priorities that don't reflect real risk.
 * It flags only genuine, specific defects — never a vague objection —
 * and the orchestrator (Stage 5→8 loop) is allowed to regenerate the
 * Goal Graph AT MOST ONCE in response to a "revise" verdict, never in
 * an unbounded loop.
 */
import type { PipelineManager } from '../pipeline';
import { parseModelJson } from '../jsonMode';
import type { ExtractedIntent, GoalGraph, MissionReviewFinding, MissionReviewVerdict, MissionSignals, MissionStrategy, ReviewFindingType } from './types';

const FINDING_TYPES: ReviewFindingType[] = ['missing-goal', 'unnecessary-work', 'wrong-assumption', 'over-planning', 'duplicate-task', 'weak-prioritization'];

const SYSTEM =
  'You are an adversarial mission-plan reviewer — a second, skeptical Senior Staff Engineer. Your ONLY job is to find genuine, specific ' +
  'defects in the given Goal Graph. Look specifically for: a goal the mission\'s intent clearly implies but the graph never covers ("missing-goal"); ' +
  'a goal or task that does not actually serve the stated intent ("unnecessary-work"); a goal/task resting on an assumption not backed by the real ' +
  'evidence given ("wrong-assumption"); more process/ceremony than the mission\'s scope and required quality actually warrant ("over-planning"); ' +
  'two tasks that do the same real work ("duplicate-task"); priorities that do not reflect the mission\'s actual risk/urgency ("weak-prioritization"). ' +
  'Flag ONLY genuine, specific defects you can name — never a vague or generic objection, and never flag something just because a plan "could always ' +
  'have more" — an appropriately-scoped plan should have few or zero findings. ' +
  'You output ONLY valid JSON, no prose, no code fences. The JSON object must have exactly these keys: ' +
  '"verdict" (one of "approved"|"revise" — "revise" only if you found at least one genuine defect worth fixing), ' +
  '"findings" (array of {"type":one of "missing-goal"|"unnecessary-work"|"wrong-assumption"|"over-planning"|"duplicate-task"|"weak-prioritization","detail":string} — empty if verdict is "approved"), ' +
  '"summary" (one short sentence).';

function renderGoalGraph(goalGraph: GoalGraph): string {
  const lines: string[] = [];
  lines.push(`Goals (${goalGraph.goals.length}):`);
  for (const g of goalGraph.goals) {
    lines.push(`- [${g.id}] (${g.priority}) ${g.title} — ${g.rationale}`);
  }
  lines.push(`Tasks (${goalGraph.tasks.length}):`);
  for (const t of goalGraph.tasks) {
    lines.push(`- [${t.id}] goal=${t.goalId} kind=${t.kind} priority=${t.priority} risk=${t.risk} owner=${t.owner} automation=${t.automationLevel} target=${t.targetFile ?? 'none'} — ${t.title}: ${t.description}`);
  }
  return lines.join('\n');
}

function buildUserPrompt(missionText: string, intent: ExtractedIntent, strategy: MissionStrategy, goalGraph: GoalGraph, signals: MissionSignals): string {
  const lines: string[] = [];
  lines.push(`Mission (verbatim): ${missionText}`);
  lines.push(`Category: ${strategy.category}`);
  lines.push(`Extracted primary goal: ${intent.primaryGoal}`);
  if (intent.secondaryGoals.length) lines.push(`Extracted secondary goals: ${intent.secondaryGoals.join('; ')}`);
  lines.push(`Scope: ${intent.scope}  Required quality: ${intent.requiredQuality}  Risk level: ${intent.riskLevel}`);
  lines.push('');
  lines.push(renderGoalGraph(goalGraph));
  lines.push('');
  lines.push(`Real project signals available: health=${signals.health ? `${signals.health.overall}/100` : 'n/a'}, verification=${signals.verificationScore}/100, hotspots=${signals.hotspots.length}, securityFindings=${signals.securityFindings.length}, technicalDebt=${signals.technicalDebt.length}`);
  lines.push('Respond with ONLY the JSON object described in the system message.');
  return lines.join('\n');
}

export async function reviewMission(
  pipeline: PipelineManager,
  missionText: string,
  intent: ExtractedIntent,
  strategy: MissionStrategy,
  goalGraph: GoalGraph,
  signals: MissionSignals,
  signal?: AbortSignal,
): Promise<{ ok: true; verdict: MissionReviewVerdict } | { ok: false; error: { type: string; message: string; retryable: boolean } }> {
  const user = buildUserPrompt(missionText, intent, strategy, goalGraph, signals);
  const res = await pipeline.generate({ system: SYSTEM, user, json: true }, signal);
  if (!res.ok) return { ok: false, error: res.error };

  let parsed: Record<string, unknown>;
  try {
    parsed = parseModelJson(res.text);
  } catch (e) {
    return { ok: false, error: { type: 'parse_error', message: (e as Error).message, retryable: true } };
  }

  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings: MissionReviewFinding[] = rawFindings
    .filter((f): f is Record<string, unknown> => Boolean(f && typeof f === 'object'))
    .map((f) => ({
      type: (FINDING_TYPES as string[]).includes(f.type as string) ? (f.type as ReviewFindingType) : 'wrong-assumption',
      detail: typeof f.detail === 'string' ? f.detail : '',
    }))
    .filter((f) => f.detail.trim().length > 0);

  const verdict: MissionReviewVerdict['verdict'] = parsed.verdict === 'revise' && findings.length > 0 ? 'revise' : 'approved';

  return {
    ok: true,
    verdict: {
      verdict,
      findings,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      revisionApplied: false,
    },
  };
}
