import { useEffect, useRef, useState } from 'react';
import { centralAgentClient } from '../../ai/centralAgentClient';

type DocRecord = {
  path: string; chunk_count: number; extraction_status: string; ingested_at: string;
  engine?: string; documentStatus?: string; ocrUsed?: string | null;
};

type UploadResult = {
  chunkCount: number; engine: string; documentStatus: string;
  ocrUsed: string | null; pageCount: number; warnings: string[];
};

function EngineBadge({ engine, ocr }: { engine: string; ocr: string | null }) {
  const label = ocr ? `${engine}+${ocr}` : engine;
  return (
    <span className="rounded bg-surface-active px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">{label}</span>
  );
}

export default function DocumentsPanel() {
  const [docs, setDocs] = useState<DocRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
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
    setUploadResult(null);
    setError(null);
    try {
      const r = await centralAgentClient.ingestDocument(file);
      setUploadResult({
        chunkCount: r.chunkCount,
        engine: r.engine,
        documentStatus: r.documentStatus,
        ocrUsed: r.ocrUsed,
        pageCount: r.pageCount,
        warnings: r.warnings,
      });
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
          accept=".pdf,.docx,.doc,.txt,.md,.rst,.csv,.xlsx,.xls,.pptx,.ppt,.odt,.ods,.odp,.png,.jpg,.jpeg,.gif,.bmp,.tiff,.tif,.webp"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
        />
        {uploading
          ? <span className="text-fg-muted animate-pulse">Ingesting…</span>
          : <>
              <span className="text-fg-muted">Drop a document here</span>
              <span className="text-xs text-fg-subtle">PDF · DOCX · XLSX · PPTX · ODT · TXT · images · or click to browse</span>
            </>
        }
      </div>

      {uploadResult && (
        <div className="rounded-lg bg-surface-active px-3 py-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-fg-success">
              Ingested — {uploadResult.chunkCount} chunks
              {uploadResult.pageCount > 0 && `, ${uploadResult.pageCount} pages`}
            </span>
            <EngineBadge engine={uploadResult.engine} ocr={uploadResult.ocrUsed} />
          </div>
          {uploadResult.warnings.length > 0 && (
            <p className="mt-1 text-fg-warning">{uploadResult.warnings[0]}</p>
          )}
        </div>
      )}
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
                    <div className="flex shrink-0 items-center gap-1.5">
                      {d.engine && <EngineBadge engine={d.engine} ocr={d.ocrUsed ?? null} />}
                      <span className={`text-xs ${d.extraction_status === 'ok' ? 'text-fg-success' : 'text-fg-muted'}`}>
                        {d.chunk_count} chunks
                      </span>
                    </div>
                  </div>
                  <p className="truncate text-xs text-fg-muted">{d.path}</p>
                </li>
              ))}
            </ul>
      }
    </div>
  );
}
