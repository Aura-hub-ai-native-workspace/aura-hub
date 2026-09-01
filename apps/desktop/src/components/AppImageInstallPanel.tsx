/**
 * AppImageInstallPanel — the Settings surface for the installation itself.
 * ==========================================================================
 * `AppImageInstallPrompt` offers the install once, at the moment it is
 * useful. This is the durable counterpart: where the installation can be
 * inspected, repaired, and — the part that was missing — undone.
 *
 * Both the prompt and the README shipped inside the Linux archive tell the
 * user they can remove AURA Hub again from Settings. Until this existed,
 * `appimage_uninstall` was registered in the shell and called by nothing,
 * so that sentence was false. This makes it true.
 *
 * Presentation only. Every decision about WHAT install and uninstall touch
 * lives in `appimage.rs`; this decides only when to offer them, and refuses
 * to offer either where neither is meaningful — a .deb installation, a dev
 * run, or any platform that is not Linux.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, CardHeader, Icon } from '@aura/ui';

interface IntegrationStatus {
  is_appimage: boolean;
  installed: boolean;
  running_installed: boolean;
  app_path: string | null;
  desktop_path: string | null;
}

type Invoke = <T>(cmd: string) => Promise<T>;

async function tauriInvoke(): Promise<Invoke | null> {
  try {
    const core = await import('@tauri-apps/api/core');
    return core.invoke as Invoke;
  } catch {
    return null; // browser/dev — there is no shell to ask
  }
}

/** What just happened, so the panel can confirm it rather than go quiet. */
type Outcome = { kind: 'installed' | 'removed' } | null;

export function AppImageInstallPanel() {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const refresh = useCallback(async () => {
    const invoke = await tauriInvoke();
    if (!invoke) return null;
    try {
      const s = await invoke<IntegrationStatus>('appimage_status');
      setStatus(s);
      return s;
    } catch {
      /* Not Linux, or the command is unavailable — there is nothing to show. */
      return null;
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (cmd: 'appimage_install' | 'appimage_uninstall', kind: 'installed' | 'removed') => {
    const invoke = await tauriInvoke();
    if (!invoke) return;
    setBusy(true);
    setError(null);
    try {
      const s = await invoke<IntegrationStatus>(cmd);
      setStatus(s);
      setOutcome({ kind });
      setConfirming(false);
    } catch (e) {
      // The Rust side returns a list of the paths it could not remove. Show
      // it verbatim: a partial uninstall is exactly the case where a vague
      // "something went wrong" leaves the user unable to finish by hand.
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Neither action means anything for a .deb installation, a dev run, or a
  // platform without AppImages. Rendering an inert panel there would imply
  // AURA Hub manages an installation it does not own.
  if (!status || (!status.is_appimage && !status.installed)) return null;

  const { installed, running_installed: runningInstalled, app_path: appPath } = status;

  return (
    <Card>
      <CardHeader
        title="Installation"
        subtitle="AURA Hub in your application menu"
        action={
          <Badge tone={installed ? 'positive' : 'neutral'} dot>
            {installed ? 'Installed' : 'Portable'}
          </Badge>
        }
      />

      <div className="mt-4 space-y-4">
        {installed ? (
          <>
            <p className="text-[12.5px] leading-relaxed text-text-muted">
              AURA Hub is in your application menu with its icon, and launches from there
              like any other application. The file you originally downloaded is not needed.
            </p>
            {appPath && (
              <div className="rounded-xl border border-line bg-surface-active/40 px-3.5 py-3">
                <div className="text-[10.5px] font-medium uppercase tracking-wide text-text-subtle">
                  Installed at
                </div>
                <div className="mt-1 break-all font-mono text-[11.5px] text-text-muted">{appPath}</div>
              </div>
            )}
          </>
        ) : (
          <p className="text-[12.5px] leading-relaxed text-text-muted">
            You are running AURA Hub straight from the file you downloaded. Adding it to
            your applications copies it into your home folder and puts it in your
            application menu, so you can launch it normally and delete the download.
          </p>
        )}

        {outcome && !error && (
          <div className="flex items-start gap-2 rounded-xl border border-positive/30 bg-positive/5 px-3.5 py-3">
            <Icon name="check" size={13} className="mt-0.5 shrink-0 text-positive" />
            <p className="text-[11.5px] leading-relaxed text-text-muted">
              {outcome.kind === 'installed'
                ? 'Added to your application menu.'
                : 'Removed from your application menu. Your projects, settings and history are untouched.'}
            </p>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-danger/30 bg-danger/5 px-3.5 py-3">
            <p className="break-words text-[11.5px] leading-relaxed text-critical">{error}</p>
          </div>
        )}

        {confirming ? (
          <div className="rounded-xl border border-line bg-surface-active/40 px-3.5 py-3">
            <p className="text-[12px] leading-relaxed text-text-muted">
              Remove AURA Hub from your application menu? This deletes the installed copy,
              its launcher entry and its icons.
              {runningInstalled && ' The window you are using now stays open until you close it.'}
            </p>
            <p className="mt-2 text-[11.5px] leading-relaxed text-text-subtle">
              Your projects, settings and history are not touched — uninstalling the
              application is not the same as discarding the work done with it.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="danger"
                loading={busy}
                onClick={() => void run('appimage_uninstall', 'removed')}
              >
                Remove
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {!installed && status.is_appimage && (
              <Button
                size="sm"
                variant="primary"
                icon="plus"
                loading={busy}
                onClick={() => void run('appimage_install', 'installed')}
              >
                Add to Applications
              </Button>
            )}
            {installed && (
              <>
                {/* Re-running install over an existing installation is the
                    supported repair: every destination is a fixed path, so it
                    overwrites rather than accumulating a second entry. */}
                {status.is_appimage && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="refresh"
                    loading={busy}
                    onClick={() => void run('appimage_install', 'installed')}
                  >
                    Repair
                  </Button>
                )}
                <Button size="sm" variant="ghost" icon="close" disabled={busy} onClick={() => setConfirming(true)}>
                  Remove from Applications
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
