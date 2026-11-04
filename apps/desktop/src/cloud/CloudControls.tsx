import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@aura/core';
import { formatBytes, listCloudVersions, restoreCloudVersion, sendToCloud, type CloudVersion } from './cloudClient';

type Busy = null | 'send' | 'list' | string;

/**
 * "Send to cloud" for a project: uploads a snapshot (without dependencies,
 * build output or secrets) as a new dated version in Google Drive › AURA Hub.
 * Cloud versions can be restored into a new folder beside the project.
 */
export function CloudControls({ projectId }: { projectId: string }) {
  const openSettings = useAppStore((s) => s.openSettings);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [versions, setVersions] = useState<CloudVersion[] | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // A success message clears itself; an error stays until the person closes it.
  useEffect(() => {
    if (note?.tone !== 'ok') return;
    const t = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(t);
  }, [note]);

  // The versions panel closes on any click outside it.
  useEffect(() => {
    if (!versions) return;
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setVersions(null); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [versions]);

  const fail = (e: unknown) => {
    const err = e as Error & { code?: string };
    if (err.code === 'not-signed-in') { setNeedsSignIn(true); setNote(null); return; }
    setNote({ tone: 'err', text: err.message });
  };

  const send = async () => {
    setBusy('send'); setNote(null); setNeedsSignIn(false);
    try {
      const r = await sendToCloud(projectId, (p) => setProgress(p.phase === 'packing'
        ? `Packing… ${p.files} files`
        : `Sending… ${p.total ? Math.floor((p.sent / p.total) * 100) : 0}% of ${formatBytes(p.total)}`));
      setNote({ tone: 'ok', text: `Sent to cloud · ${r.files} files · ${formatBytes(r.version.size)}${r.skipped.length ? ` · ${r.skipped.length} large file(s) left out` : ''}` });
      if (versions) setVersions([r.version, ...versions]);
    } catch (e) { fail(e); } finally { setBusy(null); setProgress(null); }
  };

  const toggleVersions = async () => {
    if (versions) { setVersions(null); return; }
    setBusy('list'); setNote(null);
    try { setVersions((await listCloudVersions(projectId)).versions); } catch (e) { fail(e); } finally { setBusy(null); }
  };

  const restore = async (v: CloudVersion) => {
    setBusy(v.id); setNote(null);
    try {
      const r = await restoreCloudVersion(projectId, v.id);
      setNote({ tone: 'ok', text: `Restored ${r.files} files to “${r.path}” — added to your projects.` });
      setVersions(null);
    } catch (e) { fail(e); } finally { setBusy(null); }
  };

  return (
    <div ref={root} className="relative flex flex-col items-end" data-testid="cloud-controls">
      <div className="flex items-center gap-2">
        <button type="button" onClick={toggleVersions} disabled={busy !== null}
          className="rounded-md border border-line px-3 py-1.5 text-[12.5px] font-medium text-text-muted hover:bg-surface-active hover:text-text disabled:opacity-50">
          {busy === 'list' ? 'Loading…' : 'Cloud versions'}
        </button>
        <button type="button" onClick={send} disabled={busy !== null}
          className="rounded-md bg-text px-3.5 py-1.5 text-[12.5px] font-semibold text-canvas hover:opacity-90 disabled:opacity-50">
          {busy === 'send' ? (progress ?? 'Preparing…') : 'Send to cloud'}
        </button>
      </div>
      {needsSignIn && (
        <p className="mt-2 w-[320px] text-right text-[12.5px] text-text-muted">
          Sign in with Google to send projects to the cloud.{' '}
          <button type="button" className="font-medium text-text underline" onClick={() => openSettings('account')}>Sign in</button>
        </p>
      )}
      {note && (
        <div role={note.tone === 'err' ? 'alert' : 'status'} data-testid="cloud-note"
          className={`mt-2 flex w-[320px] items-start justify-end gap-2 text-right text-[12.5px] ${note.tone === 'ok' ? 'text-text-muted' : 'text-red-500'}`}>
          <span className="break-words">{note.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNote(null)} className="shrink-0 leading-none opacity-60 hover:opacity-100">×</button>
        </div>
      )}
      {versions && (
        <div className="absolute right-0 z-50 mt-2 w-[420px] rounded-lg border border-line bg-surface shadow-xl" data-testid="cloud-versions">
          <div className="border-b border-line px-4 py-3">
            <div className="text-[13px] font-semibold text-text">Cloud versions</div>
            <div className="text-[12px] text-text-muted">Google Drive › AURA Hub. Restoring makes a new folder; your current files are not touched.</div>
          </div>
          {versions.length === 0 ? (
            <p className="px-4 py-4 text-[12.5px] text-text-muted">No versions yet. Use “Send to cloud” to save the first one.</p>
          ) : (
            <ul className="max-h-72 divide-y divide-line overflow-y-auto">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-[12.5px] text-text">{new Date(v.createdTime).toLocaleString()}</div>
                    <div className="text-[11.5px] text-text-muted">{formatBytes(v.size)}</div>
                  </div>
                  <button type="button" onClick={() => restore(v)} disabled={busy !== null}
                    className="shrink-0 rounded-md border border-line px-2.5 py-1 text-[12px] font-medium text-text hover:bg-surface-active disabled:opacity-50">
                    {busy === v.id ? 'Restoring…' : 'Restore'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
