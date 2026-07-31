/**
 * rootCause — Stage 3, LLM call #1. Explains WHY the classified bug
 * happens, grounded only in the real Stage 1/2 evidence already
 * gathered — it is never asked (and never allowed) to propose code.
 * Same single-shot JSON-mode convention as `codeAction.ts`.
 */
import type { PipelineManager } from '../pipeline';
import { parseModelJson } from '../jsonMode';
import type { Classification, FailureSignals, RootCause } from './types';

function renderRefs(refs: { kind: string; name: string; relPath: string }[], limit = 8): string {
  if (!refs.length) return 'none detected';
  const shown = refs.slice(0, limit).map((r) => `${r.kind} ${r.name} (${r.relPath})`);
  return shown.join(', ') + (refs.length > limit ? ` (+${refs.length - limit} more)` : '');
}

const SYSTEM = 'You output ONLY valid JSON, no prose, no code fences. The JSON object must have exactly these keys: ' +
  '"summary" (string — explain WHY this happens, not how to fix it; ground every claim in the evidence given, invent nothing), ' +
  '"evidenceUsed" (array of short strings, each quoting or paraphrasing one piece of evidence you actually relied on), ' +
  '"relatedComponents" (array of {"id":string,"name":string,"kind":string,"relPath":string}, drawn only from the dependencies/dependents given), ' +
  '"aiStatedConfidence" (one of "low"|"medium"|"high" — your own honest sense of how well-evidenced this explanation is). ' +
  'You must NOT propose any code, patch, or fix — that is a separate, later stage. Explain the root cause only.';

function buildUserPrompt(classification: Classification, signals: FailureSignals): string {
  const lines: string[] = [];
  lines.push(`Deterministically classified category: ${classification.category}`);
  lines.push('Detector checks that fired (never invented — these are real, deterministic checks):');
  for (const c of classification.checksRun) lines.push(`- [${c.fired ? 'x' : ' '}] ${c.name}`);
  lines.push('Detector evidence:');
  for (const e of classification.evidence) lines.push(`- ${e}`);
  lines.push('');
  lines.push(`File: ${signals.file.relPath}  Language: ${signals.file.language}  Total lines: ${signals.file.totalLines}`);
  lines.push(signals.symbol ? `Nearest symbol: ${signals.symbol.kind} ${signals.symbol.name} (line ${signals.symbol.line})` : 'Nearest symbol: none resolved');
  lines.push(`Architecture layer: ${signals.architectureLayer}`);
  lines.push(`Real exports of this file: ${signals.exports.join(', ') || 'none'}`);
  lines.push(`Depends on: ${renderRefs(signals.dependencies)}`);
  lines.push(`Referenced by ${signals.dependents.length} location(s) across ${signals.dependentFileCount} file(s): ${renderRefs(signals.dependents)}`);
  if (signals.crossLayerImports.length) {
    lines.push(`Cross-layer imports: ${signals.crossLayerImports.map((c) => `${c.specifier}→${c.targetLayer}(${c.allowed ? 'ok' : 'DISALLOWED'})`).join(', ')}`);
  }
  lines.push(
    Array.isArray(signals.gitHistory)
      ? `Recent git history: ${signals.gitHistory.map((h) => `${h.hash} ${h.date} ${h.subject}`).join(' | ')}`
      : `Git history: unavailable (${signals.gitHistory.reason})`,
  );
  lines.push(`Related tests: ${signals.relatedTests.found ? signals.relatedTests.paths.join(', ') : 'none found'}`);
  if (signals.compilerDiagnostics.length) {
    lines.push(`Compiler diagnostics (syntax/local only): ${signals.compilerDiagnostics.map((d) => `L${d.line}: ${d.message}`).join(' | ')}`);
  }
  if (signals.memoryRecall.length) {
    lines.push(`Related prior memory: ${signals.memoryRecall.map((m) => `[${m.kind}] ${m.title}`).join(' | ')}`);
  }
  lines.push('Respond with ONLY the JSON object described in the system message. Use only the real data given above — invent nothing.');
  return lines.join('\n');
}

export async function generateRootCause(
  pipeline: PipelineManager,
  classification: Classification,
  signals: FailureSignals,
  signal?: AbortSignal,
): Promise<{ ok: true; rootCause: RootCause } | { ok: false; error: { type: string; message: string; retryable: boolean } }> {
  const user = buildUserPrompt(classification, signals);
  const res = await pipeline.generate({ system: SYSTEM, user, json: true }, signal);
  if (!res.ok) return { ok: false, error: res.error };

  let parsed: Record<string, unknown>;
  try {
    parsed = parseModelJson(res.text);
  } catch (e) {
    return { ok: false, error: { type: 'parse_error', message: (e as Error).message, retryable: true } };
  }

  const relatedComponents = Array.isArray(parsed.relatedComponents)
    ? (parsed.relatedComponents as unknown[])
        .filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object'))
        .map((r) => ({ id: String(r.id ?? ''), name: String(r.name ?? ''), kind: String(r.kind ?? ''), relPath: String(r.relPath ?? '') }))
    : [];
  const confidence = parsed.aiStatedConfidence === 'high' || parsed.aiStatedConfidence === 'medium' ? parsed.aiStatedConfidence : 'low';

  return {
    ok: true,
    rootCause: {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      evidenceUsed: Array.isArray(parsed.evidenceUsed) ? (parsed.evidenceUsed as unknown[]).filter((e): e is string => typeof e === 'string') : [],
      relatedComponents,
      aiStatedConfidence: confidence,
    },
  };
}
