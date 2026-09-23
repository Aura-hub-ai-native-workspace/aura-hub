import { useEffect, useRef, useState } from 'react';
import { centralAgentClient } from '../../ai/centralAgentClient';

type DocRecord = { path: string; chunk_count: number; extraction_status: string; ingested_at: string };

export default function DocumentsPanel() {
  const [docs, setDocs] = useState<DocRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = () => {
    setLoading(true);
    centralAgentClient.listDocuments()
      .then((r) => { setDocs(r.documents); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'failed to load'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleFile = async (file: File) => {
    setUploading(true);
    setUploadMsg(null);
    setError(null);
    try {
      const r = await centralAgentClient.ingestDocument(file);
      setUploadMsg(`Ingested — ${r.chunk_count} chunks (${r.extraction_status})`);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'upload failed');
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  return (
    <div className="flex h-full flex-col gap-3 p-3 text-sm">
      <div
        className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border-subtle p-6 transition hover:border-accent"
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.docx,.txt,.md"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
        />
        {uploading
          ? <span className="text-fg-muted animate-pulse">Ingesting…</span>
          : <><span className="text-fg-muted">Drop a PDF, DOCX or TXT here</span><span className="text-xs text-fg-subtle">or click to browse</span></>
        }
      </div>

      {uploadMsg && <p className="rounded-lg bg-surface-active px-3 py-2 text-xs text-fg-success">{uploadMsg}</p>}
      {error && <p className="rounded-lg bg-surface-active px-3 py-2 text-xs text-fg-danger">{error}</p>}

      <div className="flex items-center justify-between">
        <span className="font-medium text-fg-base">Knowledge base</span>
        <button onClick={load} className="text-xs text-fg-muted hover:text-fg-base">Refresh</button>
      </div>

      {loading
        ? <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-surface-active" />)}</div>
        : docs.length === 0
          ? <p className="text-center text-xs text-fg-muted py-4">No documents ingested yet.</p>
          : <ul className="space-y-1 overflow-y-auto">
              {docs.map((d) => (
                <li key={d.path} className="rounded-lg bg-surface-subtle px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs text-fg-base">{d.path.split('/').pop()}</span>
                    <span className={`shrink-0 text-xs ${d.extraction_status === 'ok' ? 'text-fg-success' : 'text-fg-muted'}`}>
                      {d.chunk_count} chunks
                    </span>
                  </div>
                  <p className="truncate text-xs text-fg-muted">{d.path}</p>
                </li>
              ))}
            </ul>
      }
    </div>
  );
}
