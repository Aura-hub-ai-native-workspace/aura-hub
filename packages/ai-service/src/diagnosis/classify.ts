/**
 * classify — Stage 2, 100% deterministic. Never asks the LLM to
 * classify. Runs the 4 real detectors in a fixed, most-specific-first
 * order; first fire wins. `'unknown'` is a first-class, honest outcome
 * — it means none of the real detectors fired, not that the engine
 * failed, and the orchestrator stops the pipeline right here when it
 * happens (no root cause, no patch).
 */
import { detectArchitectureSmell } from './detectors/architectureSmell';
import { detectBrokenApi } from './detectors/brokenApi';
import { detectDeadCode } from './detectors/deadCode';
import { detectNullBug } from './detectors/nullBug';
import type { BugCategory, Classification, DetectorContext } from './types';

const ORDER: { category: BugCategory; run: (ctx: DetectorContext) => ReturnType<typeof detectNullBug> }[] = [
  { category: 'null-bug', run: detectNullBug },
  { category: 'dead-code', run: detectDeadCode },
  { category: 'broken-api', run: detectBrokenApi },
  { category: 'architecture-smell', run: detectArchitectureSmell },
];

export function classify(ctx: DetectorContext): Classification {
  const allChecks: Classification['checksRun'] = [];
  for (const { category, run } of ORDER) {
    const result = run(ctx);
    allChecks.push(...result.checksRun.map((c) => ({ ...c, name: `[${category}] ${c.name}` })));
    if (result.fires) return { category, evidence: result.evidence, checksRun: result.checksRun };
  }
  // 'unknown' still reports every check that ran, so the UI can show honestly what was ruled out.
  return { category: 'unknown', evidence: [], checksRun: allChecks };
}
