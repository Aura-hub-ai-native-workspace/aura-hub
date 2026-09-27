/**
 * Agent Workspace v2 — attachments hook.
 * =====================================================================
 * The left composer's attachment flow:
 *
 *   picker (hidden <input type="file">)  ──►  user selects files
 *                                              │
 *                                              ▼
 *                                       V2Attachment[] (one per file)
 *                                       status: pending
 *                                              │
 *                                              ▼
 *                                       POST /documents/ingest  (existing
 *                                       backend route; NO new storage)
 *                                              │
 *                                     ┌────────┴─────────┐
 *                                     ▼                  ▼
 *                                success              failure
 *                                status: ready        status: failed
 *                                kbPath: ...           error: <backend>
 *
 * The UI's job:
 *   • show live previews (image pixels for images; name + size for others)
 *   • let the user remove files before they are sent
 *   • keep the list visible and honest about its state
 *
 * The UI does NOT:
 *   • upload a second copy to a new backend
 *   • guess what the model will do with the file
 *   • pretend "ready" until the backend says so
 *
 * Ingestion is async per file; the list is append-order stable so the
 * user can read it top-to-bottom the way they clicked the picker.
 */
import { useCallback, useState } from 'react';
import { centralAgentClient } from '../../ai/centralAgentClient';
import type { V2Attachment } from './types';

let seq = 0;
const nid = () => `att-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);

/** File extensions that the existing document engine is expected to
 *  handle — informational only (the backend is authoritative). */
const DOC_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', 'text/markdown', 'text/csv',
]);

/** True when the file looks like one AURA can ingest today. Files outside
 *  this set are rejected at selection time with a clear message instead
 *  of being silently discarded by the backend and leaving a blank list. */
export function isIngestable(file: File): boolean {
  return IMAGE_TYPES.has(file.type) || DOC_TYPES.has(file.type);
}

export function useAttachments(onLimitReached?: (n: number) => void) {
  const [attachments, setAttachments] = useState<V2Attachment[]>([]);

  const pick = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files) return;
      const all = Array.from(files);
      const picked = all.slice(0, 12); // soft cap; keep the UI honest
      if (all.length > picked.length) onLimitReached?.(all.length);
      for (const file of picked) {
        const id = nid();
        let previewUrl: string | null = null;
        if (file.type.startsWith('image/')) {
          previewUrl = URL.createObjectURL(file);
        }
        const att: V2Attachment = {
          id,
          file,
          previewUrl,
          isImage: file.type.startsWith('image/'),
          status: !isIngestable(file) ? 'failed' : 'ingesting',
          kbPath: null,
          error: !isIngestable(file)
            ? `Unsupported type '${file.type || 'unknown'}' — pick an image, PDF, DOC(X), TXT, MD or CSV.`
            : null,
        };
        setAttachments((prev) => [...prev, att]);
        if (!isIngestable(file)) return;
        // Start the ingest. We do not gate the UI on it — the list
        // updates when each file's state settles, so the user keeps
        // working while AURA prepares the knowledge base.
        void (async () => {
          try {
            const res = await centralAgentClient.ingestDocument(file);
            setAttachments((prev) =>
              prev.map((a) =>
                a.id === id
                  ? { ...a, status: 'ready', kbPath: res.path ?? null }
                  : a,
              ),
            );
          } catch (e) {
            setAttachments((prev) =>
              prev.map((a) =>
                a.id === id
                  ? {
                      ...a,
                      status: 'failed',
                      error: e instanceof Error ? e.message : 'ingestion failed',
                    }
                  : a,
              ),
            );
          }
        })();
      }
    },
    [onLimitReached],
  );

  const remove = useCallback((id: string) => {
    setAttachments((prev) => {
      const next = prev.filter((a) => a.id !== id);
      const gone = prev.find((a) => a.id === id);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setAttachments((prev) => {
      for (const a of prev) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return [];
    });
  }, []);

  const busyCount = attachments.filter((a) => a.status === 'ingesting').length;
  const readyCount = attachments.filter((a) => a.status === 'ready').length;
  const failedCount = attachments.filter((a) => a.status === 'failed').length;

  return {
    attachments,
    add: pick,
    remove,
    clear,
    busyCount,
    readyCount,
    failedCount,
    allSettled: attachments.length > 0 && busyCount === 0,
  };
}
