import { useEffect, useState } from 'react';
import { centralAgentClient } from '../../ai/centralAgentClient';

type ArtifactRecord = { name: string; path: string; size_bytes: number; created_at: string };

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ArtifactsPanel() {
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    centralAgentClient.listArtifacts()
      .then((r) => { setArtifacts(r.artifacts); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'failed to load'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="flex h-full flex-col gap-3 p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium text-fg-base">Generated Artifacts</span>
        <button onClick={load} className="text-xs text-fg-muted hover:text-fg-base">Refresh</button>
      </div>

      {error && <p className="rounded-lg bg-surface-active px-3 py-2 text-xs text-fg-danger">{error}</p>}

      {loading
        ? <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-active" />)}</div>
        : artifacts.length === 0
          ? <p className="text-center text-xs text-fg-muted py-4">No artifacts generated yet.</p>
          : <ul className="space-y-1 overflow-y-auto">
              {artifacts.map((a) => (
                <li key={a.path} className="rounded-xl bg-surface-subtle px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-fg-base">{a.name}</span>
                    <span className="shrink-0 text-xs text-fg-muted">{humanSize(a.size_bytes)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs text-fg-muted">{a.path}</span>
                    <a
                      href={`/artifacts/download?path=${encodeURIComponent(a.path)}`}
                      download={a.name}
                      className="shrink-0 rounded bg-accent px-2 py-0.5 text-xs font-medium text-white hover:opacity-90"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Download
                    </a>
                  </div>
                  <p className="mt-0.5 text-xs text-fg-subtle">
                    {new Date(a.created_at).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
      }
    </div>
  );
}
