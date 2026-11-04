import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

process.env.AURA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-cloud-test-'));
process.env.AURA_GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com';
process.env.AURA_GOOGLE_CLIENT_SECRET = 'not-really-secret';

const { createSnapshot, extractSnapshot } = await import('./snapshot');
const auth = await import('./googleAuth');
const drive = await import('./drive');

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (root: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

describe('project snapshots', () => {
  it('round-trips the project and leaves out dependencies, build output and secrets', () => {
    const src = tmp('aura-snap-src-');
    write(src, 'src/app.ts', 'export const x = 1;\n');
    write(src, 'README.md', '# hi\n');
    write(src, `deep/${'d'.repeat(60)}/${'e'.repeat(60)}/file.txt`, 'long path');
    write(src, 'node_modules/pkg/index.js', 'x');
    write(src, '.git/HEAD', 'ref');
    write(src, 'dist/out.js', 'x');
    write(src, '.env', 'API_KEY=secret');
    write(src, '.env.local', 'API_KEY=secret');
    write(src, 'certs/server.pem', 'KEY');
    const snap = createSnapshot(src);
    expect(snap.files).toBe(3);
    const out = tmp('aura-snap-out-');
    expect(extractSnapshot(snap.bytes, out)).toBe(3);
    expect(fs.readFileSync(path.join(out, 'src/app.ts'), 'utf8')).toBe('export const x = 1;\n');
    expect(fs.existsSync(path.join(out, `deep/${'d'.repeat(60)}/${'e'.repeat(60)}/file.txt`))).toBe(true);
    for (const gone of ['node_modules', '.git', 'dist', '.env', '.env.local', 'certs/server.pem']) {
      expect(fs.existsSync(path.join(out, gone))).toBe(false);
    }
  });

  it('refuses an archive entry that escapes the target folder', () => {
    const h = Buffer.alloc(512);
    h.write('../escape.txt', 0, 'utf8');
    h.write('0000644\0', 100); h.write('00000000001\0', 124); h.write('0', 156); h.write('ustar\0', 257);
    const tar = Buffer.concat([h, Buffer.from('x'), Buffer.alloc(511), Buffer.alloc(1024)]);
    expect(() => extractSnapshot(zlib.gzipSync(tar), tmp('aura-snap-evil-'))).toThrow(/outside the project folder/);
  });
});

/** A fake Google: token, userinfo, revoke and Drive endpoints. */
function fakeGoogle() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const files: { id: string; name: string; mimeType: string; parents: string[]; size?: number; createdTime: string }[] = [];
  let n = 0;
  const ok = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const body = new URLSearchParams(String(init?.body));
      if (body.get('grant_type') === 'authorization_code') {
        expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        return ok({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: auth.GOOGLE_SCOPES.join(' ') });
      }
      return ok({ access_token: 'at-2', expires_in: 3600 });
    }
    if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return ok({ email: 'groot@example.com', name: 'Groot', picture: null });
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) return ok({});
    if (url.startsWith('https://www.googleapis.com/drive/v3/files?') && (!init?.method || init.method === 'GET')) {
      const q = new URL(url).searchParams.get('q') ?? '';
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const name = /name = '([^']+)'/.exec(q)?.[1];
      const wantFolder = q.includes("mimeType = 'application/vnd.google-apps.folder'");
      const hit = files.filter((x) => x.parents.includes(parent!) && (!name || x.name === name) && (wantFolder ? x.mimeType.endsWith('folder') : !x.mimeType.endsWith('folder')));
      return ok({ files: hit.map((x) => ({ id: x.id, name: x.name, size: String(x.size ?? 0), createdTime: x.createdTime })) });
    }
    if (url.startsWith('https://www.googleapis.com/drive/v3/files?fields=id') && init?.method === 'POST') {
      const meta = JSON.parse(String(init.body));
      const id = `folder_id_${++n}`;
      files.push({ id, name: meta.name, mimeType: meta.mimeType, parents: meta.parents, createdTime: new Date().toISOString() });
      return ok({ id });
    }
    if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')) {
      const meta = JSON.parse(String(init?.body));
      return ok({}, { location: `https://upload.example/session?name=${encodeURIComponent(meta.name)}&parent=${meta.parents[0]}` });
    }
    if (url.startsWith('https://upload.example/session')) {
      const u = new URL(url);
      const id = `file_id_${++n}xxxx`;
      const size = (init?.body as Uint8Array).length;
      files.push({ id, name: u.searchParams.get('name')!, mimeType: 'application/gzip', parents: [u.searchParams.get('parent')!], size, createdTime: new Date().toISOString() });
      return ok({ id, name: u.searchParams.get('name'), size: String(size), createdTime: new Date().toISOString() });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { f, calls, files };
}

describe('Continue with Google', () => {
  beforeEach(async () => { await auth.signOutGoogle(fakeGoogle().f, false); });

  it('builds a PKCE consent URL with only the narrow Drive scope', () => {
    const cfg = auth.loadGoogleConfig()!;
    const { challenge } = auth.pkcePair();
    const u = new URL(auth.buildAuthUrl(cfg, 'http://127.0.0.1:5555', 'st', challenge));
    expect(u.searchParams.get('scope')).toBe('openid email profile https://www.googleapis.com/auth/drive.file');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('access_type')).toBe('offline');
  });

  it('signs in through the loopback page, keeps only the profile in plain text, and refreshes', async () => {
    const g = fakeGoogle();
    let opened = '';
    const { done } = await auth.startGoogleSignIn({ fetchImpl: g.f, open: (u) => { opened = u; } });
    const consent = new URL(opened);
    const back = `${consent.searchParams.get('redirect_uri')}/?state=${consent.searchParams.get('state')}&code=abc`;
    const page = await (await fetch(back)).text();
    expect(page).toContain('You are signed in');
    const profile = await done;
    expect(profile.email).toBe('groot@example.com');
    expect(auth.googleProfile()?.email).toBe('groot@example.com');
    const onDisk = fs.readFileSync(path.join(process.env.AURA_HOME!, 'google-account.json'), 'utf8');
    expect(onDisk).not.toContain('rt-1');
    expect(await auth.googleAccessToken(g.f)).toBe('at-1');
  });

  it('a callback with the wrong state is refused and the sign-in keeps waiting', async () => {
    const g = fakeGoogle();
    let opened = '';
    await auth.startGoogleSignIn({ fetchImpl: g.f, open: (u) => { opened = u; } });
    const redirect = new URL(opened).searchParams.get('redirect_uri');
    const res = await fetch(`${redirect}/?state=forged&code=abc`);
    expect(res.status).toBe(400);
    expect(auth.pendingGoogleSignIn()).not.toBeNull();
  });

  it('sign-out revokes at Google and forgets the account on this device', async () => {
    const g = fakeGoogle();
    let opened = '';
    const { done } = await auth.startGoogleSignIn({ fetchImpl: g.f, open: (u) => { opened = u; } });
    const c = new URL(opened);
    await fetch(`${c.searchParams.get('redirect_uri')}/?state=${c.searchParams.get('state')}&code=abc`);
    await done;
    await auth.signOutGoogle(g.f);
    expect(g.calls.some((x) => x.url.startsWith('https://oauth2.googleapis.com/revoke'))).toBe(true);
    expect(auth.googleProfile()).toBeNull();
    await expect(auth.googleAccessToken(g.f)).rejects.toThrow(/Sign in with Google/);
  });
});

describe('Send to cloud (Google Drive)', () => {
  it('creates AURA Hub/<project>, uploads dated versions, and lists them newest first', async () => {
    const g = fakeGoogle();
    let opened = '';
    const { done } = await auth.startGoogleSignIn({ fetchImpl: g.f, open: (u) => { opened = u; } });
    const c = new URL(opened);
    await fetch(`${c.searchParams.get('redirect_uri')}/?state=${c.searchParams.get('state')}&code=abc`);
    await done;

    const v1 = await drive.uploadVersion('Shop', Buffer.from('one'), g.f, new Date(2026, 10, 3, 9, 5, 7));
    await drive.uploadVersion('Shop', Buffer.from('two!'), g.f, new Date(2026, 10, 3, 10, 0, 0));
    expect(v1.name).toBe('Shop 2026-11-03 09.05.07.tar.gz');
    const folders = g.files.filter((x) => x.mimeType.endsWith('folder'));
    expect(folders.map((x) => x.name)).toEqual(['AURA Hub', 'Shop']);
    const versions = await drive.listVersions('Shop', g.f);
    expect(versions).toHaveLength(2);
    expect(await drive.listVersions('Other', g.f)).toEqual([]);
  });
});

describe('large projects', () => {
  it('follows .gitignore in a git repository and still never sends secrets', async () => {
    const { execFileSync } = await import('node:child_process');
    const src = tmp('aura-snap-git-');
    execFileSync('git', ['init', '-q'], { cwd: src });
    write(src, '.gitignore', 'bundle/\n*.log\n');
    write(src, 'src/a.ts', 'a');
    write(src, 'bundle/runtime.bin', 'x'.repeat(1000));
    write(src, 'debug.log', 'x');
    write(src, '.env', 'SECRET=1');
    const snap = createSnapshot(src);
    const out = tmp('aura-snap-git-out-');
    extractSnapshot(snap.bytes, out);
    expect(fs.existsSync(path.join(out, 'src/a.ts'))).toBe(true);
    expect(fs.existsSync(path.join(out, '.gitignore'))).toBe(true);
    for (const gone of ['bundle', 'debug.log', '.env']) expect(fs.existsSync(path.join(out, gone))).toBe(false);
  });

  it('streams a snapshot to a file that unpacks to the same files', async () => {
    const { createSnapshotFile } = await import('./snapshot');
    const src = tmp('aura-snap-stream-');
    for (let i = 0; i < 30; i++) write(src, `f/${i}.txt`, `file ${i}\n`.repeat(50));
    const file = path.join(tmp('aura-snap-file-'), 's.tar.gz');
    let calls = 0;
    const r = await createSnapshotFile(src, file, () => { calls++; });
    expect(r.files).toBe(30);
    expect(calls).toBe(30);
    const out = tmp('aura-snap-stream-out-');
    expect(extractSnapshot(fs.readFileSync(file), out)).toBe(30);
    expect(fs.readFileSync(path.join(out, 'f/7.txt'), 'utf8')).toBe('file 7\n'.repeat(50));
  });

  it('uploads in pieces and carries on from where Drive got to after a dropped piece', async () => {
    // Sign in first so the access token is available.
    const g = fakeGoogle();
    let opened = '';
    const { done } = await auth.startGoogleSignIn({ fetchImpl: g.f, open: (u) => { opened = u; } });
    const c = new URL(opened);
    await fetch(`${c.searchParams.get('redirect_uri')}/?state=${c.searchParams.get('state')}&code=abc`);
    await done;

    const data = Buffer.from('0123456789'.repeat(100)); // 1000 bytes
    const file = path.join(tmp('aura-up-'), 'v.tar.gz');
    fs.writeFileSync(file, data);
    const got: Buffer[] = [];
    let dropped = false;
    const pieces: string[] = [];
    const f = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://upload.example/chunked')) {
        const range = new Headers(init?.headers).get('content-range') ?? '';
        pieces.push(range);
        if (range.startsWith('bytes */')) {
          const have = Buffer.concat(got).length;
          return new Response(null, { status: 308, headers: have ? { range: `bytes=0-${have - 1}` } : {} });
        }
        if (!dropped && range.startsWith('bytes 256-')) { dropped = true; throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); }
        got.push(Buffer.from(init!.body as Uint8Array));
        const have = Buffer.concat(got).length;
        if (have < 1000) return new Response(null, { status: 308, headers: { range: `bytes=0-${have - 1}` } });
        return new Response(JSON.stringify({ id: 'file_big_123456', name: 'x', size: '1000', createdTime: 'now' }), { status: 200 });
      }
      if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')) {
        return new Response('{}', { status: 200, headers: { location: 'https://upload.example/chunked' } });
      }
      return g.f(input, init);
    }) as typeof fetch;
    const progress: number[] = [];
    const v = await drive.uploadVersionFile('Big', file, (sent) => progress.push(sent), f, new Date(), 256);
    expect(v.id).toBe('file_big_123456');
    expect(Buffer.concat(got).equals(data)).toBe(true);
    expect(dropped).toBe(true);
    expect(pieces.some((p) => p.startsWith('bytes */'))).toBe(true);
    expect(progress[progress.length - 1]).toBe(1000);
  });

  it('turns Node\'s bare "fetch failed" into a reason a person can act on', () => {
    const e = drive.networkError(new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } }));
    expect(e.message).toBe('Could not reach Google Drive (ETIMEDOUT). Check the internet connection and try again.');
  });
});

describe('snapshot edge cases', () => {
  it('a path too long for the archive is left out and reported, not fatal', () => {
    const src = tmp('aura-snap-long-');
    const long = `${'a'.repeat(120)}/${'b'.repeat(120)}/${'c'.repeat(120)}.txt`;
    write(src, long, 'x');
    write(src, 'ok.txt', 'y');
    const snap = createSnapshot(src);
    expect(snap.files).toBe(1);
    expect(snap.skipped.some((s) => s.includes('path too long'))).toBe(true);
  });
});
