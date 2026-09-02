/**
 * The renderer's only door to the update engine.
 * ==================================================================
 * ONE `UpdateService` for the whole application, created lazily and
 * shared. That is the point of this module: a service per component
 * would mean a component remount silently starts a second check, and two
 * machines would each believe they own the update lifecycle.
 *
 * Components get a state and five actions. They never see the adapter,
 * never see Tauri, never see the endpoint, never parse metadata and never
 * compare versions — every one of those belongs to the service and the
 * applicability policy beneath it.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { UpdateService, type UpdaterAdapter } from './updateService';
import { UNRESOLVED_VERSION } from './types';
import type { InstallKind, UpdateDiagnostics, UpdateState } from './types';

/* ── Environment ─────────────────────────────────────────────────── */

/** True only inside the packaged desktop shell. */
export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Stand-in used when the UI runs in a plain browser (`npm run dev`
 * without the shell).
 *
 * It reports `unknown`, which the service refuses — a browser preview
 * cannot install a desktop update, and saying so is more useful than
 * pretending to check. It fabricates no version and no candidate.
 */
function createUnsupportedAdapter(): UpdaterAdapter {
  return {
    currentVersion: async () => APP_VERSION,
    platform: async () => ({ os: 'browser', arch: 'unknown' }),
    check: async () => null,
    relaunch: async () => { throw new Error('restart is only available in the desktop application'); },
    sourceHost: () => null,
    installKind: async (): Promise<InstallKind> => 'unknown',
  };
}

/**
 * The build's version, injected by Vite from the package manifest.
 *
 * Used ONLY as the browser-preview fallback. In the desktop shell the
 * version comes from `getVersion()` — the running binary's own identity —
 * so no component ever hardcodes a version string.
 */
const APP_VERSION: string = (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? UNRESOLVED_VERSION;

/* ── The single service ──────────────────────────────────────────── */

let service: UpdateService | null = null;
let adapterKind: 'native' | 'unsupported' = 'unsupported';

/**
 * The one service instance.
 *
 * The native adapter is imported dynamically so that `@tauri-apps/*`
 * never loads in a browser preview, where it would throw on import and
 * take the whole Settings screen down with it.
 */
export function getUpdateService(): UpdateService {
  if (!service) {
    service = new UpdateService(createUnsupportedAdapter());
    if (isDesktopRuntime()) {
      void import('./tauriAdapter')
        .then(({ createTauriUpdaterAdapter }) => {
          service = new UpdateService(createTauriUpdaterAdapter());
          adapterKind = 'native';
          for (const l of pendingListeners) l(service!.getState());
        })
        .catch(() => { /* stays on the unsupported adapter */ });
    }
  }
  return service;
}

/** Listeners registered before the native adapter finished loading. */
const pendingListeners = new Set<(s: UpdateState) => void>();

export function updateAdapterKind(): 'native' | 'unsupported' {
  return adapterKind;
}

/* ── React binding ───────────────────────────────────────────────── */

/**
 * Subscribe to the shared service.
 *
 * `useSyncExternalStore` rather than local state: the service is the
 * store, and mirroring its state into a component would create a second
 * copy that can disagree with it.
 */
export function useUpdateState(): UpdateState {
  const subscribe = useCallback((onChange: () => void) => {
    const svc = getUpdateService();
    const listener = () => onChange();
    pendingListeners.add(listener);
    const unsub = svc.subscribe(listener);
    // Both are released: the service subscription and the pending-listener
    // registration. Leaving either behind leaks on every remount.
    return () => { unsub(); pendingListeners.delete(listener); };
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => getUpdateService().getState(),
    () => ({ kind: 'idle' }) as UpdateState,
  );
}

export interface UpdaterActions {
  check: () => Promise<void>;
  install: () => Promise<void>;
  restart: () => Promise<void>;
  cancel: () => Promise<void>;
  diagnostics: () => UpdateDiagnostics;
}

/** The five actions, bound to the shared service. Stable across renders. */
export function useUpdaterActions(): UpdaterActions {
  return {
    check: useCallback(async () => { await getUpdateService().check(); }, []),
    install: useCallback(async () => { await getUpdateService().downloadAndInstall(); }, []),
    restart: useCallback(async () => { await getUpdateService().restart(); }, []),
    cancel: useCallback(async () => { await getUpdateService().cancel(); }, []),
    diagnostics: useCallback(() => getUpdateService().diagnostics(), []),
  };
}

/* ── Startup check ───────────────────────────────────────────────── */

/**
 * One background check per application session.
 *
 * Module-level rather than per-component: mounting the Settings screen
 * twice must not produce two checks, and neither must a React StrictMode
 * double-mount in development.
 */
let startupCheckStarted = false;

export function resetStartupCheckForTests(): void {
  startupCheckStarted = false;
}

/**
 * Check for an update in the background, after the application is already
 * usable.
 *
 * Deliberately fire-and-forget: startup never awaits the update server. A
 * server that is down, slow or unreachable delays nothing and blocks
 * nothing — the promise settles into the service's state, and the state
 * is the only thing the UI reads.
 */
export function startBackgroundUpdateCheck(delayMs = 4000): () => void {
  if (startupCheckStarted || !isDesktopRuntime()) return () => {};
  startupCheckStarted = true;

  const timer = window.setTimeout(() => {
    /* `check()` settles the state itself, including on an unexpected
       throw, which it converts to `failed`. This catch is the last
       resort for a rejection that escapes even that — and it must not be
       empty. An empty catch here is exactly what hid v0.1.2's permanent
       `checking` state, behind a comment asserting the state recorded a
       reason it had never been given.

       It reports INTO the service rather than swallowing, so there stays
       one place that knows what the updater is doing. A background check
       is still not an interruption: the failure lands in state, the
       Updates panel shows it with a retry, and nothing is raised over
       whatever the user is doing. */
    void getUpdateService().check().catch((e: unknown) => {
      getUpdateService().reportCheckFailure(e);
    });
  }, delayMs);

  return () => window.clearTimeout(timer);
}
