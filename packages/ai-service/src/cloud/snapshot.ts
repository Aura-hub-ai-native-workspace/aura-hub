/**
 * Project snapshots for "Send to cloud": a .tar.gz of the project's own files.
 *
 * Left out on purpose: dependencies and build output that can be recreated (node_modules, dist,
 * target, .venv, caches), the git object store, and anything that looks like a secret (.env files,
 * private keys, credential files) — a cloud copy must never carry a password. Restoring refuses any
 * entry that would land outside the target folder.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.turbo', '.cache',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.gradle', '.idea', 'coverage',
  'graphify-out', '.aura',
]);
const SECRET_FILE = /(^\.env(\..*)?$)|(\.(pem|key|p12|pfx|keystore|jks)$)|(^id_(rsa|ed25519|ecdsa)$)|(^credentials(\.json)?$)|(^\.npmrc$)|(^\.netrc$)/i;
/** Single files above this are left out (logged), so one stray dataset cannot fill the person's Drive. */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

export interface SnapshotResult { bytes: Buffer; files: number; skipped: string[] }

export function shouldSkip(rel: string, isDir: boolean): boolean {
  const name = path.basename(rel);
  return isDir ? SKIP_DIRS.has(name) : SECRET_FILE.test(name);
}

/**
 * The files a snapshot considers. In a git repository: what git tracks plus untracked files that
 * are not ignored (`git ls-files -co --exclude-standard`), so the project's own .gitignore decides
 * what is build output. Elsewhere: a walk that skips the usual generated folders. Secret-looking
 * files and anything inside a skipped folder are left out either way; symlinks are never followed.
 */
export function* projectFiles(root: string): Generator<{ rel: string; abs: string; stat: fs.Stats }> {
  const git = fs.existsSync(path.join(root, '.git'))
    ? spawnSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })
    : null;
  if (git && git.status === 0) {
    const rels = git.stdout.toString('utf8').split('\0').filter(Boolean).sort();
    for (const rel of rels) {
      const parts = rel.split('/');
      if (parts.slice(0, -1).some((d) => SKIP_DIRS.has(d)) || shouldSkip(rel, false)) continue;
      const abs = path.join(root, rel);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(abs); } catch { continue; } // listed but deleted
      if (stat.isFile()) yield { rel, abs, stat };
    }
    return;
  }
  yield* walk(root);
}

function* walk(root: string, rel = ''): Generator<{ rel: string; abs: string; stat: fs.Stats }> {
  const dir = path.join(root, rel);
  for (const name of fs.readdirSync(dir).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const abs = path.join(root, r);
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) continue; // never follow a link out of the project
    if (stat.isDirectory()) { if (!shouldSkip(r, true)) yield* walk(root, r); continue; }
    if (stat.isFile() && !shouldSkip(r, false)) yield { rel: r, abs, stat };
  }
}

/* ── minimal ustar ──────────────────────────────────────────────────────── */

function octal(n: number, width: number) {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number, mtime: number, mode: number): Buffer {
  const h = Buffer.alloc(512);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    // ustar splits long paths at a slash: prefix (155) / name (100).
    const cut = name.lastIndexOf('/', name.length - 1);
    let i = cut;
    while (i > 0 && (Buffer.byteLength(name.slice(i + 1)) > 100 || Buffer.byteLength(name.slice(0, i)) > 155)) i = name.lastIndexOf('/', i - 1);
    if (i <= 0) throw new Error(`path too long for a snapshot: ${name}`);
    prefix = name.slice(0, i);
    base = name.slice(i + 1);
  }
  h.write(base, 0, 100, 'utf8');
  h.write(octal(mode & 0o7777, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(Math.floor(mtime / 1000), 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write('0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 'ascii');
  return h;
}

/** Build the snapshot of `root` in memory. */
export function createSnapshot(root: string): SnapshotResult {
  const chunks: Buffer[] = [];
  const skipped: string[] = [];
  let files = 0;
  for (const { rel, abs, stat } of projectFiles(root)) {
    if (stat.size > MAX_FILE_BYTES) { skipped.push(`${rel} (larger than ${MAX_FILE_BYTES / 1024 / 1024} MB)`); continue; }
    const data = fs.readFileSync(abs);
    let head: Buffer;
    try { head = header(rel, data.length, stat.mtimeMs, stat.mode); } catch { skipped.push(`${rel} (path too long for a snapshot)`); continue; }
    chunks.push(head);
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
    files++;
  }
  chunks.push(Buffer.alloc(1024));
  return { bytes: zlib.gzipSync(Buffer.concat(chunks), { level: 6 }), files, skipped };
}

export interface SnapshotFile { file: string; size: number; files: number; skipped: string[] }

/**
 * Build the snapshot straight into `outFile`, a file at a time, so a large project never has to
 * fit in memory. `onFile` reports progress (files done, bytes read).
 */
export async function createSnapshotFile(root: string, outFile: string, onFile?: (files: number, bytes: number) => void): Promise<SnapshotFile> {
  const skipped: string[] = [];
  let files = 0;
  let read = 0;
  async function* entries() {
    for (const { rel, abs, stat } of projectFiles(root)) {
      if (stat.size > MAX_FILE_BYTES) { skipped.push(`${rel} (larger than ${MAX_FILE_BYTES / 1024 / 1024} MB)`); continue; }
      let data: Buffer;
      try { data = await fs.promises.readFile(abs); } catch { skipped.push(`${rel} (could not be read)`); continue; }
      let head: Buffer;
      try { head = header(rel, data.length, stat.mtimeMs, stat.mode); } catch { skipped.push(`${rel} (path too long for a snapshot)`); continue; }
      yield head;
      yield data;
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) yield Buffer.alloc(pad);
      files++;
      read += data.length;
      onFile?.(files, read);
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(entries()), zlib.createGzip({ level: 6 }), fs.createWriteStream(outFile, { mode: 0o600 }));
  return { file: outFile, size: fs.statSync(outFile).size, files, skipped };
}

/** Unpack a snapshot into `target` (created if needed). Returns the number of files written. */
export function extractSnapshot(gz: Buffer, target: string): number {
  const tar = zlib.gunzipSync(gz);
  const root = path.resolve(target);
  fs.mkdirSync(root, { recursive: true });
  let off = 0;
  let files = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, n: number) => h.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
    const name = [str(345, 155), str(0, 100)].filter(Boolean).join('/');
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = str(156, 1) || '0';
    const mode = parseInt(str(100, 8).trim() || '644', 8);
    off += 512;
    const dest = path.resolve(root, name);
    if (!dest.startsWith(root + path.sep) || path.isAbsolute(name) || name.split('/').includes('..')) {
      throw new Error(`refused to restore "${name}": it points outside the project folder`);
    }
    if (type === '0') {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, tar.subarray(off, off + size), { mode: mode & 0o777 });
      files++;
    }
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}
