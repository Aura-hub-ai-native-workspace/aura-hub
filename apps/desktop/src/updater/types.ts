/**
 * The update engine's vocabulary.
 * ==================================================================
 * AURA orchestrates UX and policy around Tauri's native updater. It does
 * not reimplement the updater's security model:
 *
 *   AURA owns   — is this candidate APPLICABLE to this install?
 *                 (version ordering, downgrade, platform, architecture,
 *                  metadata well-formedness), and the state a UI renders.
 *
 *   Tauri owns  — is this candidate AUTHENTIC and INTACT?
 *                 (minisign signature over the metadata and the artifact,
 *                  checked against the public key in tauri.conf.json),
 *                 plus the platform install and restart.
 *
 * Those are different questions and are deliberately answered in
 * different places. Applicability is policy and must be testable without
 * a native runtime; authenticity is cryptography and must never be
 * re-implemented, weakened, or bypassed here.
 */

/* ── Errors ──────────────────────────────────────────────────────── */

/**
 * Why an update did not proceed. Every failure is one of these — the UI
 * must never show a bare "Update failed", because the user's next action
 * differs completely between "you're offline" and "the signature was
 * wrong".
 */
export type UpdateErrorCode =
  /** The update server could not be reached at all. */
  | 'NETWORK_ERROR'
  /** Metadata was reachable but is not valid update metadata. */
  | 'INVALID_METADATA'
  /** Signature verification failed. Raised BY the native updater. */
  | 'INVALID_SIGNATURE'
  /** The candidate targets a different operating system. */
  | 'INCOMPATIBLE_PLATFORM'
  /** The candidate targets a different CPU architecture. */
  | 'UNSUPPORTED_ARCHITECTURE'
  /** The candidate is older than, or equal to, what is installed. */
  | 'DOWNGRADE_REJECTED'
  /** Metadata is valid but carries no artifact for this target. */
  | 'MISSING_ARTIFACT'
  /** The download did not complete. */
  | 'DOWNLOAD_FAILED'
  /** The native installer reported failure. */
  | 'INSTALL_FAILED'
  /** Installed, but the relaunch did not happen. */
  | 'RESTART_FAILED'
  /** The user (or the app) stopped it. Not a fault. */
  | 'UPDATE_CANCELLED'
  /**
   * This installation cannot install its own updates.
   *
   * Distinct from INCOMPATIBLE_PLATFORM: the platform is supported and a
   * valid artifact exists — this particular *installation* just is not
   * self-updating. A .deb install is the real case: Tauri's Linux updater
   * replaces an AppImage in place and has nothing to replace here.
   *
   * The user's next step is a download, not a retry, so it must not be
   * folded into INSTALL_FAILED.
   */
  | 'UNSUPPORTED_INSTALL';

export interface UpdateError {
  code: UpdateErrorCode;
  /** Plain sentence for a person. Never a raw stack or provider blob. */
  message: string;
  /** Technical detail for diagnostics. Never shown in normal UI. */
  detail?: string;
}

/* ── Candidate ───────────────────────────────────────────────────── */

/**
 * A release the updater is offering us, after AURA has decided it is
 * applicable. `notes` is release-notes prose; it is displayed, never
 * executed or interpreted.
 */
export interface UpdateCandidate {
  version: string;
  currentVersion: string;
  releaseDate: string | null;
  notes: string | null;
  /**
   * Whether the release marks itself as required. Recognised and carried
   * through; Phase 1 does not act on it. Forced updates are deliberately
   * not implemented until the updater is proven in production.
   */
  mandatory: boolean;
}

export interface DownloadProgress {
  /** Bytes received so far. */
  downloaded: number;
  /** Total bytes, when the server declared a length. Null when unknown. */
  total: number | null;
  /** 0–100, or null when the total is unknown. Never fabricated. */
  percent: number | null;
}

/* ── State machine ───────────────────────────────────────────────── */

/**
 * One state at a time, each carrying exactly what a renderer needs.
 *
 * `ready-to-install` is a distinct state on purpose: downloading and
 * installing are separate user-visible steps, and nothing installs or
 * restarts without an explicit call.
 */
export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; currentVersion: string; checkedAt: string }
  | { kind: 'update-available'; candidate: UpdateCandidate }
  | { kind: 'downloading'; candidate: UpdateCandidate; progress: DownloadProgress }
  | { kind: 'ready-to-install'; candidate: UpdateCandidate }
  | { kind: 'installing'; candidate: UpdateCandidate }
  | { kind: 'restarting'; candidate: UpdateCandidate }
  | { kind: 'cancelled'; candidate: UpdateCandidate | null }
  | { kind: 'failed'; error: UpdateError; candidate: UpdateCandidate | null };

export type UpdateStateKind = UpdateState['kind'];

/* ── Platform identity ───────────────────────────────────────────── */

/**
 * The four targets this product actually ships, named as Tauri's own
 * updater names them. Nothing else is claimed: the bundle configuration
 * and CI matrix produce exactly these, so an artifact for anything else
 * has no business installing here.
 */
export type UpdateTarget =
  | 'linux-x86_64'
  | 'windows-x86_64'
  | 'darwin-x86_64'
  | 'darwin-aarch64';

export const SUPPORTED_TARGETS: readonly UpdateTarget[] = [
  'linux-x86_64',
  'windows-x86_64',
  'darwin-x86_64',
  'darwin-aarch64',
] as const;

/* ── Version sentinel ────────────────────────────────────────────── */

/**
 * The version reported before the running binary has been asked.
 *
 * Exported so the service and any renderer agree on what "not yet known"
 * looks like, instead of each comparing against its own literal. A UI that
 * hardcoded a version string would be one release away from lying.
 */
export const UNRESOLVED_VERSION = '0.0.0';

/* ── Installation shape ──────────────────────────────────────────── */

/**
 * How this copy of AURA Hub was installed, which decides whether it can
 * update itself in place.
 *
 *   self-updating — Tauri's updater can replace this installation
 *                   (AppImage on Linux; the normal case on Windows/macOS)
 *   managed       — installed by a system package manager (.deb). The
 *                   package manager owns the files; the updater must not
 *                   fight it, and the honest answer is "get the new one".
 *   unknown       — could not be determined. Treated as NOT self-updating,
 *                   because guessing "yes" risks a failed install where
 *                   guessing "no" only costs a manual download.
 */
export type InstallKind = 'self-updating' | 'managed' | 'unknown';

/** Only a self-updating install may run the download/install path. */
export function canSelfUpdate(kind: InstallKind): boolean {
  return kind === 'self-updating';
}

/* ── Diagnostics ─────────────────────────────────────────────────── */

/**
 * What the updater is willing to say about itself.
 *
 * Deliberately excludes signatures, signed metadata bodies, endpoint
 * credentials and anything key-shaped. A diagnostics view exists to
 * explain a failure, not to expose the trust anchor's inputs.
 */
export interface UpdateDiagnostics {
  currentVersion: string;
  candidateVersion: string | null;
  target: UpdateTarget | null;
  state: UpdateStateKind;
  progress: DownloadProgress | null;
  /** Where metadata came from. Host only — never a full signed payload. */
  updateSource: string | null;
  lastCheckAt: string | null;
  lastSuccessfulCheckAt: string | null;
  errorCode: UpdateErrorCode | null;
  errorMessage: string | null;
  /** How this copy was installed — explains an UNSUPPORTED_INSTALL result. */
  installKind: InstallKind;
}
