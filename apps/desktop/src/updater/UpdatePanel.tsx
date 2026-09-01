/**
 * UpdatePanel — the Updates surface.
 * ==================================================================
 * Presentation only. It renders whatever `UpdateService` says and calls
 * five methods on it. It does not fetch metadata, does not know the
 * endpoint, does not compare versions, does not verify anything, and does
 * not decide when an update applies — all of that belongs to the service
 * and the applicability policy beneath it.
 *
 * Progress shown here is always the native updater's own reported
 * progress. When the server declares no content length there is no
 * percentage and none is invented.
 */

import { useEffect, useState } from 'react';
import { useAppStore } from '@aura/core';
import { Badge, Button, Card, CardHeader, Icon } from '@aura/ui';
import { useUpdateState, useUpdaterActions, isDesktopRuntime } from './useUpdater';
import { presentUpdateState, formatBytes, releaseNoteLines } from './updatePresentation';
import { UNRESOLVED_VERSION } from './types';

/** Where a .deb user goes instead. The project's real releases page. */
const RELEASES_URL = 'https://github.com/Aura-hub-ai-native-workspace/aura-hub/releases/latest';

export function UpdatePanel() {
  const state = useUpdateState();
  const { check, install, restart, diagnostics } = useUpdaterActions();
  const autoUpdateCheck = useAppStore((s) => s.autoUpdateCheck);
  const setAutoUpdateCheck = useAppStore((s) => s.setAutoUpdateCheck);

  const view = presentUpdateState(state);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);

  /* The running binary's own version, from the service — never a literal
     in this file. Re-read whenever the state changes, because the first
     successful check is what populates it. */
  useEffect(() => {
    const v = diagnostics().currentVersion;
    setCurrentVersion(v && v !== UNRESOLVED_VERSION ? v : null);
  }, [state, diagnostics]);

  const candidate =
    state.kind === 'update-available' || state.kind === 'downloading'
      || state.kind === 'ready-to-install' || state.kind === 'installing'
      || state.kind === 'restarting'
      ? state.candidate
      : state.kind === 'cancelled' || state.kind === 'failed'
        ? state.candidate
        : null;

  const notes = releaseNoteLines(candidate?.notes ?? null);
  const unsupportedInstall = state.kind === 'failed' && state.error.code === 'UNSUPPORTED_INSTALL';

  return (
    <Card>
      <CardHeader
        title="Updates"
        subtitle={currentVersion ? `AURA Hub ${currentVersion}` : 'AURA Hub'}
        action={<Badge tone={view.tone} dot>{view.status}</Badge>}
      />

      <div className="mt-4 space-y-4">
        <p className="text-[12.5px] leading-relaxed text-text-muted">{view.detail}</p>

        {/* Version comparison — only once there is a real candidate. */}
        {candidate && !unsupportedInstall && (
          <div className="grid grid-cols-2 gap-3">
            <VersionBox label="Current" value={candidate.currentVersion} />
            <VersionBox label="New" value={candidate.version} highlight />
          </div>
        )}

        {/* Release notes, only when the release actually supplied them. */}
        {notes.length > 0 && !unsupportedInstall && (
          <div>
            <h4 className="mb-1.5 text-[12px] font-semibold text-text">What's new</h4>
            <ul className="space-y-1">
              {notes.map((line, i) => (
                <li key={i} className="flex gap-1.5 text-[12px] leading-snug text-text-muted">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-text-subtle" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            {candidate?.releaseDate && (
              <p className="mt-2 text-[11px] text-text-subtle">Released {formatDate(candidate.releaseDate)}</p>
            )}
          </div>
        )}

        {state.kind === 'downloading' && <DownloadRow progress={state.progress} />}

        {/* A .deb install cannot replace itself; point at the real
            releases page rather than offering a button that would fail. */}
        {unsupportedInstall && (
          <div className="rounded-xl border border-line bg-surface-active/40 px-3.5 py-3">
            <p className="text-[12px] leading-relaxed text-text-muted">
              This copy was installed by your system package manager, which owns updating it.
              Download the latest release directly when you want to upgrade.
            </p>
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline"
            >
              <Icon name="link" size={13} /> Latest release
            </a>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {view.canCheck && (
            <Button size="sm" variant="secondary" icon="refresh" onClick={() => void check()}>
              Check for Updates
            </Button>
          )}
          {view.canInstall && (
            <Button size="sm" variant="primary" icon="deploy" onClick={() => void install()}>
              Upgrade Now
            </Button>
          )}
          {view.canRestart && (
            <Button size="sm" variant="primary" icon="refresh" onClick={() => void restart()}>
              Restart &amp; Install
            </Button>
          )}
          {view.canRetry && (
            <Button size="sm" variant="secondary" icon="refresh" onClick={() => void check()}>
              Retry
            </Button>
          )}
          {view.busy && (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-text-subtle">
              <Icon name="refresh" size={13} className="animate-spin" />
              Working…
            </span>
          )}
        </div>

        {/* The one preference. Checking only ever looks; nothing installs
            without the explicit action above. */}
        <label className="flex items-center justify-between gap-3 border-t border-line pt-3">
          <span className="min-w-0">
            <span className="block text-[12.5px] font-medium text-text">Check for updates automatically</span>
            <span className="mt-0.5 block text-[11px] text-text-subtle">
              Looks for new versions in the background. Never installs on its own.
            </span>
          </span>
          <input
            type="checkbox"
            checked={autoUpdateCheck}
            onChange={(e) => setAutoUpdateCheck(e.target.checked)}
            className="h-4 w-4 shrink-0 accent-[var(--accent,#3b6bff)]"
            aria-label="Check for updates automatically"
          />
        </label>

        {!isDesktopRuntime() && (
          <p className="text-[11px] text-text-subtle">
            Updates are managed by the desktop application.
          </p>
        )}
      </div>
    </Card>
  );
}

/**
 * The download row.
 *
 * Shows bytes only when the native updater reported a total. With no
 * total there is no bar and no percentage — an indeterminate download is
 * shown as indeterminate rather than as a fabricated number.
 */
function DownloadRow({ progress }: { progress: { downloaded: number; total: number | null; percent: number | null } }) {
  const done = formatBytes(progress.downloaded);
  const total = formatBytes(progress.total);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[11.5px] text-text-muted">
        <span>Downloading update…</span>
        <span>{progress.percent !== null ? `${progress.percent}%` : done ?? ''}</span>
      </div>
      {progress.percent !== null ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-active">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      ) : (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-active">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
        </div>
      )}
      {total && done && (
        <p className="mt-1 text-[11px] text-text-subtle">{done} / {total}</p>
      )}
    </div>
  );
}

function VersionBox({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`rounded-xl px-3 py-2 ${highlight ? 'bg-accent-50 dark:bg-accent/15' : 'bg-surface-active/50'}`}>
      <div className="text-[10.5px] text-text-subtle">{label}</div>
      <div className={`mt-0.5 font-mono text-[13px] font-semibold ${highlight ? 'text-accent' : 'text-text'}`}>
        {value}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}
