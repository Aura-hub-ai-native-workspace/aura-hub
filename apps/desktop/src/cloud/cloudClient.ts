/** Google account and the cloud (Google Drive), through the AI service's /cloud routes. */
import { AI_BASE, backendFetch } from '../backend/backendSession';

export interface GoogleProfile { email: string; name: string; picture: string | null; signedInAt: string }
export interface GoogleState { configured: boolean; profile: GoogleProfile | null; pending: { authUrl: string } | null }
export interface CloudVersion { id: string; name: string; size: number; createdTime: string; webViewLink: string | null }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await backendFetch(`${AI_BASE}${path}`, init);
  const body = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!res.ok) {
    const err = new Error(body.message ?? `request failed (${res.status})`);
    (err as Error & { code?: string }).code = body.error;
    throw err;
  }
  return body;
}
const post = <T>(path: string, body: unknown = {}) =>
  call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const getGoogle = () => call<GoogleState>('/cloud/google');
export const startGoogleSignIn = () => post<{ authUrl: string }>('/cloud/google/signin');
export const signOutGoogle = () => post<{ ok: true }>('/cloud/google/signout');
export type SendProgress =
  | { phase: 'packing'; files: number; bytes: number }
  | { phase: 'uploading'; sent: number; total: number };

/** Send a project to the cloud, reporting progress; resolves with the new version. */
export async function sendToCloud(projectId: string, onProgress?: (p: SendProgress) => void): Promise<{ version: CloudVersion; files: number; skipped: string[] }> {
  const res = await backendFetch(`${AI_BASE}/cloud/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId }),
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    const err = new Error(body.message ?? `Send to cloud could not start (${res.status})`);
    (err as Error & { code?: string }).code = body.error;
    throw err;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') continue;
      let e: Record<string, unknown>;
      try { e = JSON.parse(d); } catch { continue; }
      if (e.phase === 'done') return e as unknown as { version: CloudVersion; files: number; skipped: string[] };
      if (e.phase === 'failed') {
        const err = new Error(String(e.message ?? 'Send to cloud failed'));
        (err as Error & { code?: string }).code = String(e.code ?? 'cloud');
        throw err;
      }
      onProgress?.(e as unknown as SendProgress);
    }
  }
  throw new Error('The connection to AURA closed before the upload finished.');
}
export const listCloudVersions = (projectId: string) => call<{ versions: CloudVersion[] }>(`/cloud/versions?projectId=${encodeURIComponent(projectId)}`);
export const restoreCloudVersion = (projectId: string, versionId: string) =>
  post<{ path: string; files: number; project: { id: string; name: string } }>('/cloud/restore', { projectId, versionId });

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
