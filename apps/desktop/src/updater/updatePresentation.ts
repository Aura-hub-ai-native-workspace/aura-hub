/**
 * How each update state is shown to a person.
 * ==================================================================
 * A pure projection of `UpdateState` onto words. Separated from the
 * component so it can be tested without React, and so the mapping is one
 * table that can be read in full rather than branches scattered through
 * JSX.
 *
 * Two rules it exists to enforce:
 *
 *   1. **Every state maps to something truthful.** A state with no entry
 *      here is a compile error, not a blank panel.
 *
 *   2. **No raw state names reach the user.** `ready-to-install` is an
 *      internal word; "Ready to restart" is what it means. Internal
 *      vocabulary is preserved in the machine and translated here.
 */

import type { UpdateError, UpdateState, UpdateStateKind } from './types';

export type UpdateTone = 'positive' | 'attention' | 'critical' | 'info' | 'neutral';

export interface UpdatePresentation {
  /** Short status word, for the badge. */
  status: string;
  tone: UpdateTone;
  /** One sentence explaining the state. Never a stack trace. */
  detail: string;
  /** Whether a check may be started from here. */
  canCheck: boolean;
  /** Whether the primary upgrade action applies. */
  canInstall: boolean;
  /** Whether a restart is what happens next. */
  canRestart: boolean;
  /** Whether retrying is safe — false for states where it would not help. */
  canRetry: boolean;
  /** True while something is genuinely in flight. */
  busy: boolean;
}

/**
 * Failure wording, by cause.
 *
 * The service already supplies a plain sentence per code; these add the
 * user's NEXT STEP, which differs completely between "you're offline" and
 * "the signature was wrong", and is the part that makes an error
 * actionable rather than merely honest.
 */
const FAILURE_DETAIL: Record<UpdateError['code'], string> = {
  NETWORK_ERROR: 'Couldn\'t reach the update server. Check your connection and try again.',
  INVALID_METADATA: 'The update information could not be read. Try again later.',
  INVALID_SIGNATURE: 'This update could not be authenticated and was not installed. Your current version is unchanged.',
  INCOMPATIBLE_PLATFORM: 'This update is not for this operating system.',
  UNSUPPORTED_ARCHITECTURE: 'This update is not for this processor.',
  DOWNGRADE_REJECTED: 'AURA Hub is already up to date.',
  MISSING_ARTIFACT: 'This release has no download for this platform yet.',
  DOWNLOAD_FAILED: 'The download did not finish. Your current version is unchanged.',
  INSTALL_FAILED: 'The update could not be installed. Your current version is still intact.',
  RESTART_FAILED: 'The update was installed, but AURA Hub could not restart itself. Close and reopen the app to finish.',
  UPDATE_CANCELLED: 'The update was cancelled. Your current version is unchanged.',
  UNSUPPORTED_INSTALL: 'Automatic updates aren\'t available for this installation.',
};

/** Retrying a signature failure or an unsupported install cannot help. */
const RETRYABLE: ReadonlySet<UpdateError['code']> = new Set([
  'NETWORK_ERROR', 'INVALID_METADATA', 'DOWNLOAD_FAILED', 'INSTALL_FAILED', 'MISSING_ARTIFACT',
]);

const IDLE: UpdatePresentation = {
  status: 'Ready', tone: 'neutral',
  detail: 'Check whether a newer version of AURA Hub is available.',
  canCheck: true, canInstall: false, canRestart: false, canRetry: false, busy: false,
};

export function presentUpdateState(state: UpdateState): UpdatePresentation {
  switch (state.kind) {
    case 'idle':
      return IDLE;

    case 'checking':
      return {
        status: 'Checking', tone: 'info', detail: 'Looking for a newer version…',
        canCheck: false, canInstall: false, canRestart: false, canRetry: false, busy: true,
      };

    case 'up-to-date':
      return {
        status: 'Up to date', tone: 'positive',
        detail: `AURA Hub ${state.currentVersion} is the latest version.`,
        canCheck: true, canInstall: false, canRestart: false, canRetry: false, busy: false,
      };

    case 'update-available':
      return {
        status: 'Update available', tone: 'attention',
        detail: `AURA Hub ${state.candidate.version} is available to install.`,
        canCheck: false, canInstall: true, canRestart: false, canRetry: false, busy: false,
      };

    case 'downloading':
      return {
        status: 'Downloading', tone: 'info',
        // The percentage lives on the progress bar; repeating it here
        // would let the two disagree when the total is unknown.
        detail: `Downloading AURA Hub ${state.candidate.version}…`,
        canCheck: false, canInstall: false, canRestart: false, canRetry: false, busy: true,
      };

    case 'installing':
      return {
        status: 'Installing', tone: 'info',
        detail: `Installing AURA Hub ${state.candidate.version}…`,
        canCheck: false, canInstall: false, canRestart: false, canRetry: false, busy: true,
      };

    case 'ready-to-install':
      // The native updater has already downloaded, verified and installed.
      // What remains is the relaunch, so this reads as "ready to restart"
      // rather than implying another install step is pending.
      return {
        status: 'Ready to restart', tone: 'positive',
        detail: `AURA Hub ${state.candidate.version} has been downloaded and verified. Restart to finish.`,
        canCheck: false, canInstall: false, canRestart: true, canRetry: false, busy: false,
      };

    case 'restarting':
      return {
        status: 'Restarting', tone: 'info',
        detail: `Restarting into AURA Hub ${state.candidate.version}…`,
        canCheck: false, canInstall: false, canRestart: false, canRetry: false, busy: true,
      };

    case 'cancelled':
      return {
        status: 'Cancelled', tone: 'neutral',
        detail: 'The update was cancelled. Your current version is unchanged.',
        canCheck: true, canInstall: Boolean(state.candidate), canRestart: false, canRetry: false, busy: false,
      };

    case 'failed': {
      const code = state.error.code;
      return {
        // An unsupported install is a fact about this installation, not a
        // fault, and is toned accordingly.
        status: code === 'UNSUPPORTED_INSTALL' ? 'Not available' : 'Update failed',
        tone: code === 'UNSUPPORTED_INSTALL' ? 'neutral'
          : code === 'INVALID_SIGNATURE' ? 'critical' : 'attention',
        detail: FAILURE_DETAIL[code] ?? state.error.message,
        canCheck: code !== 'UNSUPPORTED_INSTALL',
        canInstall: false,
        canRestart: false,
        canRetry: RETRYABLE.has(code),
        busy: false,
      };
    }
  }
}

/** Every state kind this projection handles — used by the test matrix. */
export const PRESENTED_STATES: readonly UpdateStateKind[] = [
  'idle', 'checking', 'up-to-date', 'update-available', 'downloading',
  'installing', 'ready-to-install', 'restarting', 'cancelled', 'failed',
];

/**
 * Human byte sizes for the download row.
 *
 * Returns null when the server declared no length. The caller then shows
 * a percentage or nothing at all — never an invented total.
 */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Release notes as displayable lines.
 *
 * Nothing is invented: absent or blank notes yield an empty list and the
 * section is omitted. Markdown bullets are unwrapped so the release's own
 * text renders as a list rather than as literal asterisks.
 */
export function releaseNoteLines(notes: string | null): string[] {
  if (!notes) return [];
  return notes
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter((l) => l.length > 0)
    .slice(0, 12);
}
