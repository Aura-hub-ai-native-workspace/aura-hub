/**
 * jsonMode — the shared "ask an LLM for pure JSON" convention.
 * ------------------------------------------------------------------
 * Mirrors the `generate-json` workflow node's exact fence-stripping +
 * parse convention (see workflow/nodes.ts): strip code fences, JSON.parse,
 * hard-fail with no retry on malformed output. Used by both codeAction.ts
 * and the mission planner so this convention exists in exactly one place.
 */

export type RiskLevel = 'safe' | 'medium' | 'high';

export function parseModelJson<T = Record<string, unknown>>(raw: string): T {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new Error('model did not return valid JSON');
  }
}

function riskRank(level: RiskLevel): number {
  return level === 'high' ? 2 : level === 'medium' ? 1 : 0;
}
function levelFromRank(r: number): RiskLevel {
  return r >= 2 ? 'high' : r >= 1 ? 'medium' : 'safe';
}

/** The model may add reasons but can never downgrade a deterministic floor. */
export function mergeRisk(
  floor: { level: RiskLevel; reasons: string[] },
  llm: { level?: unknown; reasons?: unknown } | undefined,
): { level: RiskLevel; reasons: string[] } {
  const llmLevel: RiskLevel = llm?.level === 'high' || llm?.level === 'medium' || llm?.level === 'safe' ? llm.level : 'safe';
  const llmReasons = Array.isArray(llm?.reasons) ? (llm!.reasons as unknown[]).filter((r): r is string => typeof r === 'string') : [];
  return {
    level: levelFromRank(Math.max(riskRank(floor.level), riskRank(llmLevel))),
    reasons: [...floor.reasons.map((r) => `Automated: ${r}`), ...llmReasons.map((r) => `AI: ${r}`)],
  };
}
