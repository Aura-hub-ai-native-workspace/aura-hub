/**
 * quality — Stage 9, Mission Quality Score. 100% deterministic, zero
 * model self-rating.
 * ==================================================================
 * Runs last, after Risk Analysis (Stage 7) and Mission Review (Stage
 * 8) have both produced their real outputs. Every one of the 8
 * required sub-scores is a real, checkable ratio computed from the
 * mission's own artifacts — never a model asked "how good is this
 * plan, 0-10?". Same philosophy as `risk.ts` and the Diagnosis
 * Engine's Confidence Engine: deterministic scoring is the platform's
 * one consistent way of avoiding a model grading its own homework.
 */
import type {
  ExtractedIntent,
  GoalGraph,
  IntentClassification,
  MissionReviewVerdict,
  MissionScope,
  MissionSignals,
  MissionStrategy,
  QualityScore,
  RiskAnalysis,
} from './types';

function capUnit(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

const STOPWORDS = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'your', 'about', 'into', 'their', 'them', 'they', 'were', 'what', 'when', 'where', 'which', 'while', 'should', 'could', 'would', 'and', 'the', 'for', 'are', 'was']);

function significantWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().match(/[a-z][a-z-]{3,}/g)?.filter((w) => !STOPWORDS.has(w)) ?? [],
  );
}

/** Fraction of the intent's real vocabulary that actually shows up somewhere in the goals produced — a concrete, checkable stand-in for "did the plan understand what was asked". */
function computeIntentUnderstanding(intent: ExtractedIntent, goalGraph: GoalGraph): number {
  const intentWords = significantWords([intent.primaryGoal, ...intent.secondaryGoals, intent.expectedOutcome].join(' '));
  if (!intentWords.size) return goalGraph.goals.length ? 0.5 : 0;
  const goalWords = significantWords(goalGraph.goals.map((g) => `${g.title} ${g.rationale}`).join(' '));
  let hits = 0;
  for (const w of intentWords) if (goalWords.has(w)) hits++;
  return capUnit(hits / intentWords.size);
}

/** Fraction of goals that cite a real architecture layer name from Stage 3's signals — vacuously perfect when the project has no resolved layers, since there is nothing to be aware of. */
function computeArchitectureAwareness(goalGraph: GoalGraph, signals: MissionSignals): number {
  if (!signals.architectureLayers.length) return 1;
  const layerNames = signals.architectureLayers.map((l) => l.title.toLowerCase());
  const relevant = goalGraph.goals.filter((g) => /architect|layer|boundary|module/i.test(`${g.title} ${g.rationale}`));
  const base = goalGraph.goals.length ? relevant.length / goalGraph.goals.length : 0;
  const citesReal = goalGraph.goals.some((g) => layerNames.some((n) => g.relatedEvidence.some((e) => e.toLowerCase().includes(n))));
  return capUnit(base * 0.5 + (citesReal ? 0.5 : 0));
}

/** Evidence-citation ratio: fraction of goals that actually cite at least one piece of real evidence, rather than asserting a goal ungrounded. */
function computeKnowledgeUsage(goalGraph: GoalGraph): number {
  if (!goalGraph.goals.length) return 0;
  const cited = goalGraph.goals.filter((g) => g.relatedEvidence.length > 0).length;
  return capUnit(cited / goalGraph.goals.length);
}

/** How many distinct real signal categories (of the ones gathered in Stage 3) are actually referenced anywhere in the plan's text. */
function computeProjectAwareness(goalGraph: GoalGraph, signals: MissionSignals): number {
  const haystack = [
    ...goalGraph.goals.map((g) => `${g.title} ${g.rationale} ${g.relatedEvidence.join(' ')}`),
    ...goalGraph.tasks.map((t) => `${t.title} ${t.description} ${t.targetFile ?? ''}`),
  ].join(' ').toLowerCase();

  const categories: { present: boolean; referenced: boolean }[] = [
    { present: signals.healthIssues.length > 0, referenced: signals.healthIssues.some((i) => haystack.includes(i.message.toLowerCase().slice(0, 20))) },
    { present: signals.hotspots.length > 0, referenced: signals.hotspots.some((h) => haystack.includes(h.file.toLowerCase())) },
    { present: signals.securityFindings.length > 0, referenced: signals.securityFindings.some((s) => haystack.includes(s.file.toLowerCase())) },
    { present: signals.technicalDebt.length > 0, referenced: signals.technicalDebt.some((t) => haystack.includes(t.file.toLowerCase())) },
    { present: signals.dependencySummary.looseRange > 0, referenced: haystack.includes('dependenc') },
    { present: signals.gitStatus.available && signals.gitStatus.dirty, referenced: haystack.includes('git') || haystack.includes('uncommitted') || haystack.includes('commit') },
  ];

  const applicable = categories.filter((c) => c.present);
  if (!applicable.length) return 1; // nothing present to be aware of
  return capUnit(applicable.filter((c) => c.referenced).length / applicable.length);
}

/** Composite of task-level hygiene: average self-reported confidence, title uniqueness (no near-duplicate tasks), and file-operation tasks actually naming a file. */
function computeTaskQuality(goalGraph: GoalGraph): number {
  if (!goalGraph.tasks.length) return 0;
  const avgConfidence = goalGraph.tasks.reduce((s, t) => s + t.confidence, 0) / goalGraph.tasks.length;
  const normalizedTitles = goalGraph.tasks.map((t) => t.title.trim().toLowerCase());
  const uniqueness = new Set(normalizedTitles).size / normalizedTitles.length;
  const fileOps = goalGraph.tasks.filter((t) => t.kind === 'file-operation');
  const fileOpCorrectness = fileOps.length ? fileOps.filter((t) => Boolean(t.targetFile)).length / fileOps.length : 1;
  return capUnit(0.5 * avgConfidence + 0.3 * uniqueness + 0.2 * fileOpCorrectness);
}

/** Directly derived from Stage 7's risk and Stage 8's adversarial verdict — the two upstream stages whose whole job is finding real safety problems. */
function computeSafety(risk: RiskAnalysis, review: MissionReviewVerdict): number {
  const reviewFactor = review.verdict === 'approved' ? 1 : capUnit(1 - review.findings.length * 0.15);
  return capUnit(0.6 * (1 - risk.overall) + 0.4 * reviewFactor);
}

const SCOPE_DURATION_RANGE_MIN: Record<MissionScope, [number, number]> = {
  narrow: [20, 300],
  moderate: [120, 900],
  broad: [300, 2400],
};

/** Whether the plan's own total time estimate is a plausible match for the scope the intent itself claimed — catches wildly under- or over-scoped plans. */
function computeRealism(goalGraph: GoalGraph, intent: ExtractedIntent): number {
  if (!goalGraph.tasks.length) return 0;
  const total = goalGraph.tasks.reduce((s, t) => s + t.estimatedDurationMinutes, 0);
  const [lo, hi] = SCOPE_DURATION_RANGE_MIN[intent.scope];
  if (total >= lo && total <= hi) return 1;
  const distance = total < lo ? (lo - total) / lo : (total - hi) / hi;
  return capUnit(1 - distance);
}

const WEIGHTS = {
  intentUnderstanding: 0.2,
  architectureAwareness: 0.1,
  knowledgeUsage: 0.15,
  projectAwareness: 0.15,
  taskQuality: 0.15,
  safety: 0.15,
  realism: 0.1,
} as const;

export function computeMissionQuality(
  classification: IntentClassification,
  intent: ExtractedIntent,
  _strategy: MissionStrategy,
  goalGraph: GoalGraph,
  signals: MissionSignals,
  risk: RiskAnalysis,
  review: MissionReviewVerdict,
): QualityScore {
  const intentUnderstanding = capUnit(computeIntentUnderstanding(intent, goalGraph) * (classification.category === 'unknown' ? 0.5 : 1));
  const architectureAwareness = computeArchitectureAwareness(goalGraph, signals);
  const knowledgeUsage = computeKnowledgeUsage(goalGraph);
  const projectAwareness = computeProjectAwareness(goalGraph, signals);
  const taskQuality = computeTaskQuality(goalGraph);
  const safety = computeSafety(risk, review);
  const realism = computeRealism(goalGraph, intent);

  const overall = capUnit(
    WEIGHTS.intentUnderstanding * intentUnderstanding +
    WEIGHTS.architectureAwareness * architectureAwareness +
    WEIGHTS.knowledgeUsage * knowledgeUsage +
    WEIGHTS.projectAwareness * projectAwareness +
    WEIGHTS.taskQuality * taskQuality +
    WEIGHTS.safety * safety +
    WEIGHTS.realism * realism,
  );

  return { intentUnderstanding, architectureAwareness, knowledgeUsage, projectAwareness, taskQuality, safety, realism, overall };
}
