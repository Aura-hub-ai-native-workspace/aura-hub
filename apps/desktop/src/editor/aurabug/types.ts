/**
 * AuraBug — domain types.
 * ------------------------------------------------------------------
 * AuraBug is a frontend-only code-analysis assistant inside the Code
 * Editor. It scans the currently open file through whatever analysis
 * already exists on the frontend (Monaco's language-service markers,
 * light static heuristics, and — when the local AI service + a provider
 * key are available — the existing AI integration). No backend code is
 * involved.
 */

/** Human-facing severity. Errors are compiler errors, bugs are
 *  runtime-risk signals (null/undefined access etc.), warnings are
 *  lint-style findings. */
export type AuraBugSeverity = 'error' | 'bug' | 'warning';

/** Where an issue came from — shown so nothing is ever overstated. */
export type AuraBugSource = 'language-service' | 'heuristic' | 'ai';

/** A safe, deterministic edit we can apply on explicit confirmation. */
export interface AuraBugFixPatch {
  /** 1-based, inclusive line range to replace in the file. */
  startLine: number;
  endLine: number;
  /** Replacement text for that line range. */
  newText: string;
}

export interface AuraBugIssue {
  id: string;
  severity: AuraBugSeverity;
  /** Short title, e.g. `Undefined variable "userData"`. */
  title: string;
  /** Human explanation of why this is a problem. */
  explanation: string;
  filePath: string;
  fileName: string;
  line?: number;
  column?: number;
  /** Compiler/error code when available (e.g. `ts(2304)`). */
  code?: string;
  source: AuraBugSource;
  /** Optional human-readable fix description. */
  suggestedFix?: string;
  /** Optional safe patch — enables the "Apply Fix" flow. */
  fix?: AuraBugFixPatch;
  /** Set true after the user confirms a fix (until the next rescan). */
  applied?: boolean;
}

export type AuraBugPhase = 'idle' | 'scanning' | 'done' | 'error';

/** Status of the optional AI-augmented scan (existing frontend AI integration). */
export type AuraBugAiStatus = 'idle' | 'pending' | 'done' | 'unavailable';
