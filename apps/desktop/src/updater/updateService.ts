/**
 * UpdateService — the update state machine.
 * ==================================================================
 * Orchestrates check → download → install → restart around an adapter,
 * and is the only thing a UI talks to. It holds no knowledge of minisign,
 * of metadata parsing internals, or of how bytes are fetched; a renderer
 * that imports this file learns a state and five methods, nothing more.
 *
 * The adapter is an interface rather than a direct import so the whole
 * machine — including every failure path — is exercisable without a
 * native runtime. That is not a testing convenience: the failure paths
 * are the part of an updater that must not be discovered in production,
 * and they are unreachable from a real Tauri build on demand.
 *
 * What this file must never do: install, execute, or trust anything the
 * adapter has not returned from the native updater. There is no fallback
 * path, no "try the URL directly", no shell.
 */

import { evaluateRuntimeCandidate, resolveTarget } from './applicability';
import type {
  DownloadProgress,
  InstallKind,
  UpdateCandidate,
  UpdateDiagnostics,
  UpdateError,
  UpdateErrorCode,
  UpdateState,
  UpdateTarget,
} from './types';
import { canSelfUpdate, UNRESOLVED_VERSION } from './types';

/* ── Adapter contract ────────────────────────────────────────────── */

/** A pending update as the native updater describes it. */
export interface AdapterUpdate {
  /**
   * What the native updater parsed out of the signed metadata for THIS
   * machine. Not the whole document: by this point the updater has
   * already selected the platform artifact and does not expose the
   * platforms map. AURA re-checks what is still checkable — target
   * support and version ordering — via `evaluateRuntimeCandidate`.
   */
  offered: { version: unknown; releaseDate?: unknown; notes?: unknown; mandatory?: unknown };
  /**
   * Download AND install, in one native call. Tauri deliberately couples
   * them: the bytes it verified are the bytes it installs, with no
   * window in between for anything else to substitute a file. AURA does
   * not get to hold a verified artifact and install it later, and should
   * not want to.
   */
  downloadAndInstall(onProgress: (p: DownloadProgress) => void): Promise<void>;
  /** Release native resources for an update we are not going to install. */
  close?(): Promise<void>;
}

export interface UpdaterAdapter {
  /** The running application's version. */
  currentVersion(): Promise<string>;
  /** OS and architecture, for target resolution. */
  platform(): Promise<{ os: string; arch: string }>;
  /** Ask the endpoint. Resolves null when there is no update at all. */
  check(): Promise<AdapterUpdate | null>;
  /** Relaunch after a successful install. */
  relaunch(): Promise<void>;
  /** Host of the configured endpoint, for diagnostics. Never a full URL. */
  sourceHost(): string | null;
  /**
   * Whether this installation can replace itself.
   *
   * Optional so an adapter written before this existed keeps working; a
   * missing implementation reads as 'unknown', which is refused rather
   * than assumed updatable.
   */
  installKind?(): Promise<InstallKind>;
}

/* ── Errors ──────────────────────────────────────────────────────── */

const MESSAGES: Record<UpdateErrorCode, string> = {
  NETWORK_ERROR: 'AURA Hub could not reach the update server.',
  INVALID_METADATA: 'The update information was not readable.',
  INVALID_SIGNATURE: 'This update could not be verified and was not installed.',
  INCOMPATIBLE_PLATFORM: 'This update is not for this operating system.',
  UNSUPPORTED_ARCHITECTURE: 'This update is not for this processor architecture.',
  DOWNGRADE_REJECTED: 'AURA Hub is already up to date.',
  MISSING_ARTIFACT: 'This release has no download for this platform yet.',
  DOWNLOAD_FAILED: 'The update download did not finish.',
  INSTALL_FAILED: 'The update could not be installed.',
  RESTART_FAILED: 'The update installed, but AURA Hub could not restart itself.',
  UPDATE_CANCELLED: 'The update was cancelled.',
  UNSUPPORTED_INSTALL: 'Automatic updates are not available for this installation.',
};

function err(code: UpdateErrorCode, detail?: string): UpdateError {
  return { code, message: MESSAGES[code], detail };
}

/**
 * Classify a native failure.
 *
 * Signature failures are singled out deliberately: they are the one
 * failure that may indicate tampering rather than bad luck, and folding
 * them into a generic "download failed" would hide exactly the event the
 * signing key exists to surface.
 */
export function classifyNativeError(e: unknown): UpdateError {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  const text = raw.toLowerCase();

  if (/signature|minisign|verify|untrusted|tampered/.test(text)) {
    return err('INVALID_SIGNATURE', raw);
  }
  if (/network|fetch|dns|econnrefused|enotfound|timed? ?out|offline|unreachable/.test(text)) {
    return err('NETWORK_ERROR', raw);
  }
  if (/download|incomplete|truncat|connection reset|interrupt/.test(text)) {
    return err('DOWNLOAD_FAILED', raw);
  }
  if (/json|parse|malformed|invalid.*(manifest|metadata)/.test(text)) {
    return err('INVALID_METADATA', raw);
  }
  if (/install|permission|denied|disk|space|write/.test(text)) {
    return err('INSTALL_FAILED', raw);
  }
  return err('INSTALL_FAILED', raw);
}

/* ── Service ─────────────────────────────────────────────────────── */

export type UpdateListener = (state: UpdateState) => void;

export class UpdateService {
  private state: UpdateState = { kind: 'idle' };
  private listeners = new Set<UpdateListener>();

  private pending: AdapterUpdate | null = null;
  private candidate: UpdateCandidate | null = null;
  private progress: DownloadProgress | null = null;
  private target: UpdateTarget | null = null;
  private version = UNRESOLVED_VERSION;
  private install: InstallKind = 'unknown';

  private lastCheckAt: string | null = null;
  private lastSuccessfulCheckAt: string | null = null;
  private lastError: UpdateError | null = null;

  /** Set while a check or download is in flight, to reject re-entry. */
  private busy = false;
  /** Set by `cancel()`; consulted at every await boundary. */
  private cancelRequested = false;

  constructor(private readonly adapter: UpdaterAdapter) {}

  /* ── observation ───────────────────────────────────────────────── */

  getState(): UpdateState {
    return this.state;
  }

  subscribe(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }

  private set(next: UpdateState): void {
    this.state = next;
    for (const l of this.listeners) l(next);
  }

  private fail(error: UpdateError): void {
    this.lastError = error;
    this.set({ kind: 'failed', error, candidate: this.candidate });
  }

  /* ── check ─────────────────────────────────────────────────────── */

  /**
   * Ask whether an applicable update exists.
   *
   * A failed check is never fatal: the state records why, and the
   * application carries on. An update server being down must not look
   * like anything being wrong with AURA Hub itself.
   */
  async check(): Promise<UpdateState> {
    if (this.busy) return this.state;
    this.busy = true;
    this.cancelRequested = false;
    this.lastError = null;
    this.set({ kind: 'checking' });

    try {
      this.version = await this.adapter.currentVersion();
      const { os, arch } = await this.adapter.platform();
      this.target = resolveTarget(os, arch);
      this.lastCheckAt = new Date().toISOString();

      /* Can this installation even replace itself?
         Asked BEFORE the network, so a .deb user gets the honest answer
         ("download the new one") instead of a download that would fail at
         the last step. An adapter that cannot say reads as 'unknown' and
         is refused — guessing "yes" risks a broken install, guessing "no"
         costs only a manual download. */
      this.install = this.adapter.installKind ? await this.adapter.installKind() : 'unknown';
      if (!canSelfUpdate(this.install)) {
        this.fail(err('UNSUPPORTED_INSTALL', `install kind: ${this.install}`));
        return this.state;
      }

      let pending: AdapterUpdate | null;
      try {
        pending = await this.adapter.check();
      } catch (e) {
        this.fail(classifyNativeError(e));
        return this.state;
      }

      this.lastSuccessfulCheckAt = this.lastCheckAt;

      if (!pending) {
        this.set({ kind: 'up-to-date', currentVersion: this.version, checkedAt: this.lastCheckAt });
        return this.state;
      }

      // The policy gate. A candidate the native updater is willing to
      // offer still has to be applicable to THIS install.
      const verdict = evaluateRuntimeCandidate({
        currentVersion: this.version,
        target: this.target,
        version: pending.offered.version,
        releaseDate: pending.offered.releaseDate,
        notes: pending.offered.notes,
        mandatory: pending.offered.mandatory,
      });

      if (!verdict.applicable) {
        await pending.close?.().catch(() => { /* nothing to salvage */ });
        // "Already up to date" is the honest reading of a same-or-older
        // candidate, and is not an error the user needs to see as one.
        if (verdict.code === 'DOWNGRADE_REJECTED') {
          this.lastError = err(verdict.code, verdict.detail);
          this.set({ kind: 'up-to-date', currentVersion: this.version, checkedAt: this.lastCheckAt });
          return this.state;
        }
        this.fail(err(verdict.code, verdict.detail));
        return this.state;
      }

      this.pending = pending;
      this.candidate = verdict.candidate;
      this.set({ kind: 'update-available', candidate: verdict.candidate });
      return this.state;
    } finally {
      this.busy = false;
    }
  }

  /* ── download + install ────────────────────────────────────────── */

  /**
   * Download and install the offered update.
   *
   * One method because the native updater performs them as one verified
   * operation (see `AdapterUpdate.downloadAndInstall`). Splitting them in
   * this layer would imply AURA holds a verified artifact between the
   * two, which it does not and must not.
   *
   * Never restarts on its own — `restart()` is a separate, explicit call.
   */
  async downloadAndInstall(): Promise<UpdateState> {
    if (this.busy) return this.state;
    if (!this.pending || !this.candidate) {
      this.fail(err('INSTALL_FAILED', 'No update has been offered. Check for updates first.'));
      return this.state;
    }
    // Re-checked here and not only in `check()`: this method is public, and
    // a gate that only runs on the happy path is not a gate.
    if (!canSelfUpdate(this.install)) {
      this.fail(err('UNSUPPORTED_INSTALL', `install kind: ${this.install}`));
      return this.state;
    }

    this.busy = true;
    this.cancelRequested = false;
    const candidate = this.candidate;
    this.progress = { downloaded: 0, total: null, percent: null };
    this.set({ kind: 'downloading', candidate, progress: this.progress });

    try {
      await this.pending.downloadAndInstall((p) => {
        this.progress = p;
        // A cancel that arrived mid-download is reflected immediately;
        // the native call still runs to completion, and the state below
        // settles on 'cancelled' rather than claiming success.
        if (!this.cancelRequested) {
          this.set({ kind: 'downloading', candidate, progress: p });
        }
      });
    } catch (e) {
      this.fail(classifyNativeError(e));
      return this.state;
    } finally {
      this.busy = false;
    }

    if (this.cancelRequested) {
      this.set({ kind: 'cancelled', candidate });
      return this.state;
    }

    // Reached only when the native updater returned without throwing,
    // which is the only evidence AURA has that an install happened. It
    // never reports success on its own authority.
    this.set({ kind: 'ready-to-install', candidate });
    return this.state;
  }

  /* ── restart ───────────────────────────────────────────────────── */

  /** Relaunch into the installed version. Explicit, never automatic. */
  async restart(): Promise<UpdateState> {
    if (!this.candidate) {
      this.fail(err('RESTART_FAILED', 'There is no installed update to restart into.'));
      return this.state;
    }
    const candidate = this.candidate;
    this.set({ kind: 'restarting', candidate });
    try {
      await this.adapter.relaunch();
      return this.state;
    } catch (e) {
      this.fail(err('RESTART_FAILED', e instanceof Error ? e.message : String(e)));
      return this.state;
    }
  }

  /* ── cancel ────────────────────────────────────────────────────── */

  /**
   * Stop an update the user no longer wants.
   *
   * Tauri's download+install is not itself interruptible, so this is
   * honest about its limits: before the download starts it prevents it;
   * during, it marks the outcome cancelled rather than pretending the
   * bytes stopped moving. It never leaves the machine claiming success.
   */
  async cancel(): Promise<UpdateState> {
    this.cancelRequested = true;
    const candidate = this.candidate;

    if (this.state.kind === 'downloading') {
      return this.state; // settles as 'cancelled' when the native call returns
    }

    if (this.pending) {
      await this.pending.close?.().catch(() => { /* already gone */ });
      this.pending = null;
    }
    this.set({ kind: 'cancelled', candidate });
    return this.state;
  }

  /* ── diagnostics ───────────────────────────────────────────────── */

  /**
   * Safe to render in an advanced view and safe to copy into a bug
   * report: no signatures, no signed metadata bodies, no credentials,
   * and the source is a host rather than a full URL.
   */
  diagnostics(): UpdateDiagnostics {
    return {
      currentVersion: this.version,
      candidateVersion: this.candidate?.version ?? null,
      target: this.target,
      state: this.state.kind,
      progress: this.progress,
      updateSource: this.adapter.sourceHost(),
      lastCheckAt: this.lastCheckAt,
      lastSuccessfulCheckAt: this.lastSuccessfulCheckAt,
      errorCode: this.lastError?.code ?? null,
      errorMessage: this.lastError?.message ?? null,
      installKind: this.install,
    };
  }
}
