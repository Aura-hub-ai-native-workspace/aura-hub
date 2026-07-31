/**
 * patchGen — Stage 4 (and Evolution's Version A/B/C), LLM calls #2-4.
 * ==================================================================
 * One function called three times with a distinct strategy baked into
 * three distinct system prompts. The output schema forces a surgical
 * range replace (`targetRange` + `newText`) instead of a full file —
 * structurally checkable downstream by the Patch Limiter, not just an
 * instruction the model might ignore.
 */
import type { PipelineManager } from '../pipeline';
import { parseModelJson } from '../jsonMode';
import type { Classification, FailureSignals, PatchStrategy, RootCause, TargetRange } from './types';

const PATCH_RULES =
  'PATCH RULES — absolutely forbidden: deleting or replacing the entire file; removing unrelated functions, exports, or imports; ' +
  'changing public APIs without explicit approval; removing tests; changing the architecture; renaming unrelated symbols; deleting docs. ' +
  'You are NOT allowed to redesign the file. The generated patch MUST be minimal: maximum edit scope is only the affected region(s). ' +
  'Preserve exact indentation and surrounding style.';

const STRATEGY_PROMPT: Record<PatchStrategy, string> = {
  'minimal-fix': 'Produce the smallest possible change that fixes the root cause described. Touch nothing else.',
  'defensive-fix': 'Produce a fix that also adds a real defensive guard (a null check, a bounds check, a validation) directly around the affected code — still bounded to the minimum region needed.',
  'refactor-adjacent-fix': 'Produce a fix that also makes one small, directly adjacent improvement (e.g. removing the now-dead branch, tightening a type) — still bounded to the minimum region needed, never a wider refactor.',
};

function buildSystemPrompt(strategy: PatchStrategy): string {
  return (
    'You output ONLY valid JSON, no prose, no code fences. The JSON object must have exactly these keys: ' +
    '"summary" (short string), "explanation" (string — what changed and why), ' +
    '"targetRange" (object: "startLine" number, "endLine" number — the 1-indexed inclusive line range in the ORIGINAL file to replace), ' +
    '"newText" (string — the complete replacement text for exactly that line range; may be multiple lines; do not include line numbers). ' +
    `Strategy for this patch: ${STRATEGY_PROMPT[strategy]} ${PATCH_RULES}`
  );
}

function numberedLines(text: string): string {
  return text.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
}

function buildUserPrompt(classification: Classification, rootCause: RootCause, signals: FailureSignals, fileText: string): string {
  const lines: string[] = [];
  lines.push(`Category: ${classification.category}`);
  lines.push(`Root cause: ${rootCause.summary}`);
  lines.push(`File: ${signals.file.relPath}  Language: ${signals.file.language}`);
  lines.push(signals.symbol ? `Nearest symbol: ${signals.symbol.kind} ${signals.symbol.name} (line ${signals.symbol.line})` : 'Nearest symbol: none resolved');
  lines.push(`Real exports of this file (do not remove any of these unless the root cause is specifically about one of them): ${signals.exports.join(', ') || 'none'}`);
  lines.push(`Referenced by ${signals.dependentFileCount} other file(s) — changing this symbol's public shape breaks those callers.`);
  lines.push('Full file, with 1-indexed line numbers (reference only — do not include these numbers in newText):');
  lines.push('```');
  lines.push(numberedLines(fileText));
  lines.push('```');
  lines.push('Respond with ONLY the JSON object described in the system message.');
  return lines.join('\n');
}

export interface PatchGenResult {
  summary: string;
  explanation: string;
  targetRange: TargetRange;
  newText: string;
}

export async function generatePatch(
  pipeline: PipelineManager,
  strategy: PatchStrategy,
  classification: Classification,
  rootCause: RootCause,
  signals: FailureSignals,
  fileText: string,
  signal?: AbortSignal,
): Promise<{ ok: true; patch: PatchGenResult } | { ok: false; error: { type: string; message: string; retryable: boolean } }> {
  const system = buildSystemPrompt(strategy);
  const user = buildUserPrompt(classification, rootCause, signals, fileText);
  const res = await pipeline.generate({ system, user, json: true }, signal);
  if (!res.ok) return { ok: false, error: res.error };

  let parsed: Record<string, unknown>;
  try {
    parsed = parseModelJson(res.text);
  } catch (e) {
    return { ok: false, error: { type: 'parse_error', message: (e as Error).message, retryable: true } };
  }

  const totalLines = fileText.split('\n').length;
  const rangeRaw = (parsed.targetRange ?? {}) as Record<string, unknown>;
  const startLine = clampLine(rangeRaw.startLine, totalLines);
  const endLine = Math.max(startLine, clampLine(rangeRaw.endLine, totalLines));

  return {
    ok: true,
    patch: {
      summary: typeof parsed.summary === 'string' ? parsed.summary : `${strategy} patch`,
      explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
      targetRange: { startLine, endLine },
      newText: typeof parsed.newText === 'string' ? parsed.newText : '',
    },
  };
}

function clampLine(v: unknown, total: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 1;
  return Math.min(Math.max(n, 1), Math.max(total, 1));
}
