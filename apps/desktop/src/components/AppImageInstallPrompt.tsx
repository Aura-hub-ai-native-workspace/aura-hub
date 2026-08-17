/**
 * AppImageInstallPrompt — the "install this" offer, shown once.
 * ------------------------------------------------------------------
 * A downloaded AppImage has no way into the application menu. This offers
 * the one action that puts it there, and only in the case where that action
 * is meaningful: running from an AppImage that is not already the installed
 * copy. Launched from the menu, or installed from a .deb, or run in dev,
 * this renders nothing at all.
 *
 * It is an offer, never automatic. Copying eighty megabytes into a user's
 * home directory because they double-clicked a file is not a decision this
 * should make for them, and "Not now" is a real answer — dismissing it is
 * remembered so the same prompt does not reappear on every launch.
 */
import { useEffect, useState } from 'react';
import { Button } from '@aura/ui';

interface IntegrationStatus {
  is_appimage: boolean;
  installed: boolean;
  running_installed: boolean;
  app_path: string | null;
  desktop_path: string | null;
}

const DISMISSED = 'aura.appimage.installPromptDismissed';

type Invoke = <T>(cmd: string) => Promise<T>;

async function tauriInvoke(): Promise<Invoke | null> {
  try {
    const core = await import('@tauri-apps/api/core');
    return core.invoke as Invoke;
  } catch {
    return null; // browser/dev — there is no shell to ask
  }
}

export function AppImageInstallPrompt() {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(DISMISSED) === 'true',
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const invoke = await tauriInvoke();
      if (!invoke || cancelled) return;
      try {
        const s = await invoke<IntegrationStatus>('appimage_status');
        if (!cancelled) setStatus(s);
      } catch {
        /* Not Linux, or the command is unavailable — nothing to offer. */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const install = async () => {
    const invoke = await tauriInvoke();
    if (!invoke) return;
    setBusy(true);
    setError(null);
    try {
      const s = await invoke<IntegrationStatus>('appimage_install');
      setStatus(s);
      setDone(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    try { localStorage.setItem(DISMISSED, 'true'); } catch { /* ignore */ }
    setDismissed(true);
  };

  // Only the case this exists for: a portable AppImage that is not the copy
  // already installed.
  const relevant = status?.is_appimage && !status.running_installed && !status.installed;
  if (!relevant || (dismissed && !done)) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Install AURA Hub"
      data-testid="appimage-install-prompt"
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-xl">
        {done ? (
          <>
            <h2 className="text-[15px] font-semibold text-text">AURA Hub is installed</h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-text-muted">
              It is in your application menu now, with its icon. You can launch it from
              there like any other application, and the file you downloaded is no longer
              needed.
            </p>
            <div className="mt-4 flex justify-end">
              <Button variant="primary" onClick={() => setDone(false)}>Continue</Button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-[15px] font-semibold text-text">Install AURA Hub?</h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-text-muted">
              You are running AURA Hub straight from the file you downloaded. Installing
              copies it to your applications folder and adds it to your application menu
              with its icon, so you can launch it normally and delete the download.
            </p>
            <p className="mt-2 text-[11.5px] leading-relaxed text-text-subtle">
              Everything stays in your home folder. No administrator password, nothing
              installed system-wide, and you can remove it again from Settings.
            </p>
            {error && <p className="mt-3 text-[11.5px] text-critical">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={dismiss} disabled={busy}>Not now</Button>
              <Button variant="primary" onClick={install} disabled={busy}>
                {busy ? 'Installing…' : 'Install AURA Hub'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
