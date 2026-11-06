/**
 * Google Drive as AURA's cloud: `My Drive / AURA Hub / <project> / <project> <date>.tar.gz`.
 *
 * Uses only the `drive.file` permission, so every lookup here sees only what AURA created. Every
 * send is a new dated version; nothing in the cloud is overwritten or deleted by AURA.
 */
import fs from 'node:fs';
import { googleAccessToken } from './googleAuth';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
export const ROOT_FOLDER = 'AURA Hub';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

type Fetch = typeof fetch;

export interface CloudVersion { id: string; name: string; size: number; createdTime: string; webViewLink: string | null }

/** Node's fetch says only "fetch failed"; the real reason is in `cause`. */
export function networkError(e: unknown): Error {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  const why = err.cause?.code ?? err.cause?.message ?? err.message;
  return new Error(`Could not reach Google Drive (${why}). Check the internet connection and try again.`);
}

async function send(f: Fetch, url: string, init: RequestInit): Promise<Response> {
  try { return await f(url, init); } catch (e) { throw networkError(e); }
}

async function authed(f: Fetch, url: string, init: RequestInit = {}): Promise<Response> {
  const token = await googleAccessToken(f);
  const res = await send(f, url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Google Drive: ${body.error?.message ?? `request failed (${res.status})`}`);
  }
  return res;
}

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function findFolder(f: Fetch, name: string, parent: string): Promise<string | null> {
  const query = `name = '${q(name)}' and mimeType = '${FOLDER_MIME}' and '${parent}' in parents and trashed = false`;
  const res = await authed(f, `${API}/files?${new URLSearchParams({ q: query, fields: 'files(id)', pageSize: '1', spaces: 'drive' })}`);
  const j = (await res.json()) as { files?: { id: string }[] };
  return j.files?.[0]?.id ?? null;
}

async function ensureFolder(f: Fetch, name: string, parent: string): Promise<string> {
  const found = await findFolder(f, name, parent);
  if (found) return found;
  const res = await authed(f, `${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
  });
  return ((await res.json()) as { id: string }).id;
}

/** The folder for one project, created on first use. */
export async function projectFolder(projectName: string, f: Fetch = fetch): Promise<string> {
  const root = await ensureFolder(f, ROOT_FOLDER, 'root');
  return ensureFolder(f, projectName, root);
}

export function versionName(projectName: string, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${projectName} ${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}.${p(at.getMinutes())}.${p(at.getSeconds())}.tar.gz`;
}

/** Upload one snapshot as a new version (resumable upload, so large projects survive). */
export async function uploadVersion(projectName: string, bytes: Buffer, f: Fetch = fetch, at = new Date()): Promise<CloudVersion> {
  const folder = await projectFolder(projectName, f);
  const start = await authed(f, `${UPLOAD}?uploadType=resumable&fields=id,name,size,createdTime,webViewLink`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'application/gzip', 'x-upload-content-length': String(bytes.length) },
    body: JSON.stringify({ name: versionName(projectName, at), parents: [folder], mimeType: 'application/gzip', description: 'AURA Hub project snapshot' }),
  });
  const session = start.headers.get('location');
  if (!session) throw new Error('Google Drive did not open an upload session.');
  const put = await authed(f, session, { method: 'PUT', headers: { 'content-type': 'application/gzip' }, body: new Uint8Array(bytes) });
  const j = (await put.json()) as { id: string; name: string; size?: string; createdTime: string; webViewLink?: string };
  return { id: j.id, name: j.name, size: Number(j.size ?? bytes.length), createdTime: j.createdTime, webViewLink: j.webViewLink ?? null };
}

/** Upload size of one piece: a multiple of 256 KiB, as the resumable protocol requires. */
export const CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * Upload a snapshot file as a new version, in pieces, through Google's resumable protocol. A piece
 * that fails is retried (up to 3 times) from where Drive says it got to, so one dropped connection
 * does not lose the whole upload. `onProgress` gets bytes sent so far.
 */
export async function uploadVersionFile(projectName: string, file: string, onProgress?: (sent: number, total: number) => void,
  f: Fetch = fetch, at = new Date(), chunk = CHUNK_BYTES): Promise<CloudVersion> {
  const total = fs.statSync(file).size;
  const folder = await projectFolder(projectName, f);
  const start = await authed(f, `${UPLOAD}?uploadType=resumable&fields=id,name,size,createdTime,webViewLink`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'application/gzip', 'x-upload-content-length': String(total) },
    body: JSON.stringify({ name: versionName(projectName, at), parents: [folder], mimeType: 'application/gzip', description: 'AURA Hub project snapshot' }),
  });
  const session = start.headers.get('location');
  if (!session) throw new Error('Google Drive did not open an upload session.');
  const fd = await fs.promises.open(file, 'r');
  try {
    let offset = 0;
    let tries = 0;
    for (;;) {
      const len = Math.min(chunk, total - offset);
      const buf = Buffer.alloc(len);
      if (len > 0) await fd.read(buf, 0, len, offset);
      const range = total === 0 ? 'bytes */0' : `bytes ${offset}-${offset + len - 1}/${total}`;
      let res: Response;
      try {
        const token = await googleAccessToken(f);
        res = await f(session, { method: 'PUT', headers: { 'content-range': range, authorization: `Bearer ${token}` }, body: new Uint8Array(buf) });
      } catch (e) {
        if (++tries > 3) throw networkError(e);
        offset = await committedOffset(f, session, total);
        continue;
      }
      if (res.status === 308) {
        // Drive keeps what it got and says how far in a Range header ("bytes=0-N").
        const m = /bytes=0-(\d+)/.exec(res.headers.get('range') ?? '');
        offset = m ? Number(m[1]) + 1 : offset;
        tries = 0;
        onProgress?.(offset, total);
        continue;
      }
      if (res.ok) {
        onProgress?.(total, total);
        const j = (await res.json()) as { id: string; name: string; size?: string; createdTime: string; webViewLink?: string };
        return { id: j.id, name: j.name, size: Number(j.size ?? total), createdTime: j.createdTime, webViewLink: j.webViewLink ?? null };
      }
      if (res.status >= 500 && ++tries <= 3) { offset = await committedOffset(f, session, total); continue; }
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(`Google Drive: ${body.error?.message ?? `upload failed (${res.status})`}`);
    }
  } finally {
    await fd.close();
  }
}

/** Ask the upload session how much it has (an empty PUT with "bytes star/total"). */
async function committedOffset(f: Fetch, session: string, total: number): Promise<number> {
  const token = await googleAccessToken(f);
  const res = await send(f, session, { method: 'PUT', headers: { 'content-range': `bytes */${total}`, authorization: `Bearer ${token}` } });
  const m = /bytes=0-(\d+)/.exec(res.headers.get('range') ?? '');
  return m ? Number(m[1]) + 1 : 0;
}

/** Versions of a project in the cloud, newest first. */
export async function listVersions(projectName: string, f: Fetch = fetch): Promise<CloudVersion[]> {
  const root = await findFolder(f, ROOT_FOLDER, 'root');
  if (!root) return [];
  const folder = await findFolder(f, projectName, root);
  if (!folder) return [];
  const query = `'${folder}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`;
  const res = await authed(f, `${API}/files?${new URLSearchParams({ q: query, orderBy: 'createdTime desc', pageSize: '50', fields: 'files(id,name,size,createdTime,webViewLink)' })}`);
  const j = (await res.json()) as { files?: { id: string; name: string; size?: string; createdTime: string; webViewLink?: string }[] };
  return (j.files ?? []).map((x) => ({ id: x.id, name: x.name, size: Number(x.size ?? 0), createdTime: x.createdTime, webViewLink: x.webViewLink ?? null }));
}

export async function downloadVersion(id: string, f: Fetch = fetch): Promise<Buffer> {
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new Error('not a Drive file id');
  const res = await authed(f, `${API}/files/${id}?alt=media`);
  return Buffer.from(await res.arrayBuffer());
}
