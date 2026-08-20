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

/** Bug Bot lifecycle for a single finding. Mirrors the required statuses:
 *  detected → analyzed → fix-proposed → awaiting-approval → approved →
 *  fixing → verifying → verified | verification-failed → reverted | rejected,
 *  with `failed` reserved for operation errors (e.g. a disk write that broke).
 *  `reverted` means the user rolled back a fix whose verification failed and
 *  the original content was restored — distinct from `rejected`, where no
 *  change was ever applied. */
export type BugBotStatus =
  | 'detected'
  | 'analyzing'
  | 'analyzed'
  | 'fix-proposed'
  | 'awaiting-approval'
  | 'approved'
  | 'fixing'
  | 'verifying'
  | 'verified'
  | 'verification-failed'
  | 'reverted'
  | 'rejected'
  | 'failed';

/** Outcome of the post-fix verification re-scan. Honest by construction:
 *  `passed` is set only when a real re-scan no longer reports the same
 *  signature; `skipped` means no re-scan was possible (no fix / no model). */
export interface AuraBugVerification {
  checkedAt: string;
  method: string;
  passed: boolean | null;
  detail: string;
}

/** What the scan covers. `file` is the existing single-active-file scan;
 *  `open` covers every open tab's live buffer; `project` walks the real
 *  project tree (bounded) through the existing confined fs bridge. */
export type AuraBugScope = 'file' | 'open' | 'project';

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
  /** Deterministic (never AI-fabricated) statement of the likely cause,
   *  derived from the diagnostic itself. Always an INFERENCE, never a fact. */
  rootCause?: string;
  /** Bug Bot lifecycle status (defaults to `detected` until analyzed). */
  status: BugBotStatus;
  /** Set after an approved fix has been re-scanned. */
  verification?: AuraBugVerification;
  /** The exact pre-fix file text, captured when a fix is approved so the
   *  change can be reverted deterministically if verification fails. */
  preFixContent?: string;
  /** True while this finding's fix is being written/verified. */
  applying?: boolean;
}

export type AuraBugPhase = 'idle' | 'scanning' | 'done' | 'error';

/** Status of the optional AI-augmented scan (existing frontend AI integration). */
export type AuraBugAiStatus = 'idle' | 'pending' | 'done' | 'unavailable';
