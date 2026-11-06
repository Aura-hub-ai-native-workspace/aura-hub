/**
 * "Continue with Google" for AURA Hub.
 *
 * Google refuses its sign-in inside embedded app windows, so the consent page opens once in the
 * person's own browser and returns to a one-shot listener on 127.0.0.1 (the loopback flow Google
 * documents for desktop apps, with PKCE). The refresh token is kept encrypted in AURA's secret
 * store; only the name, email and picture are kept in plain JSON. The only Drive permission asked
 * for is `drive.file`: AURA can see the files it created and nothing else in the person's Drive.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { homePath, readJsonFile } from '../persist';
import { secrets } from '../secrets';

export const GOOGLE_SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.file'];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const REFRESH_SECRET = 'google.refresh_token';
const PROFILE_FILE = () => homePath('google-account.json');
/** The stored refresh token, through the secret store's public resolve path (values never leave this module). */
const readRefresh = (): string | null => (secrets.has(REFRESH_SECRET) ? secrets.resolve(`{{secret:${REFRESH_SECRET}}}`).text : null);
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

export interface GoogleConfig { clientId: string; clientSecret: string }
export interface GoogleProfile { email: string; name: string; picture: string | null; signedInAt: string }

type Fetch = typeof fetch;

/**
 * The client baked into release builds. esbuild replaces these two names from the CI secrets; a
 * desktop OAuth client's secret is not confidential, and PKCE protects each sign-in.
 */
const BUILT_IN_CLIENT = {
  clientId: process.env.AURA_BUILT_IN_GOOGLE_CLIENT_ID ?? '',
  clientSecret: process.env.AURA_BUILT_IN_GOOGLE_CLIENT_SECRET ?? '',
};

/** The OAuth client: environment, then ~/.aura/google-oauth.env (KEY=value lines), then the built-in one. */
export function loadGoogleConfig(
  env: NodeJS.ProcessEnv = process.env,
  file = homePath('google-oauth.env'),
  builtIn: GoogleConfig = BUILT_IN_CLIENT,
): GoogleConfig | null {
  let id = env.AURA_GOOGLE_CLIENT_ID?.trim();
  let secret = env.AURA_GOOGLE_CLIENT_SECRET?.trim();
  if ((!id || !secret) && fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
      if (!m) continue;
      if (m[1] === 'AURA_GOOGLE_CLIENT_ID' && !id) id = m[2].trim();
      if (m[1] === 'AURA_GOOGLE_CLIENT_SECRET' && !secret) secret = m[2].trim();
    }
  }
  if (id && secret) return { clientId: id, clientSecret: secret };
  return builtIn.clientId && builtIn.clientSecret ? builtIn : null;
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthUrl(cfg: GoogleConfig, redirectUri: string, state: string, challenge: string): string {
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  return u.toString();
}

/** Open a URL in the person's default browser, without a shell. */
export function openInBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  try { spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).unref(); } catch { /* the UI shows the link too */ }
}

const PAGE = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0a0a0b;color:#e8e8ea;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:420px;text-align:center"><div style="font-weight:600;font-size:18px">${title}</div><p style="color:#9a9aa2">${body}</p></div>`;

interface Pending { state: string; done: Promise<GoogleProfile>; authUrl: string; close: () => void }
let pending: Pending | null = null;

/**
 * Start a sign-in: opens Google's consent page and resolves when the browser comes back.
 * Returns the URL as well, so the app can offer "open it again" if the browser did not appear.
 */
export async function startGoogleSignIn(opts: { fetchImpl?: Fetch; open?: (url: string) => void; config?: GoogleConfig | null } = {}): Promise<{ authUrl: string; done: Promise<GoogleProfile> }> {
  const cfg = opts.config === undefined ? loadGoogleConfig() : opts.config;
  if (!cfg) throw new Error('Google sign-in is not configured on this machine (no OAuth client).');
  pending?.close();
  const f = opts.fetchImpl ?? fetch;
  const state = b64url(crypto.randomBytes(16));
  const { verifier, challenge } = pkcePair();

  let resolveDone!: (p: GoogleProfile) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<GoogleProfile>((res, rej) => { resolveDone = res; rejectDone = rej; });
  done.catch(() => undefined);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/') { res.writeHead(404).end(); return; }
    const finish = (status: number, title: string, body: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE(title, body));
    };
    if (url.searchParams.get('state') !== state) { finish(400, 'Sign-in not recognised', 'This page did not come from the sign-in AURA Hub started. You can close it.'); return; }
    const err = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (err || !code) {
      finish(400, 'Sign-in cancelled', 'Nothing was changed. You can close this tab and return to AURA Hub.');
      cleanup(); rejectDone(new Error(err === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed: ${err ?? 'no code'}`));
      return;
    }
    try {
      const profile = await exchangeCode(cfg, code, verifier, redirectUri, f);
      finish(200, 'You are signed in', `Signed in as ${escapeHtml(profile.email)}. You can close this tab and return to AURA Hub.`);
      cleanup(); resolveDone(profile);
    } catch (e) {
      finish(500, 'Sign-in failed', 'Google did not complete the sign-in. Return to AURA Hub and try again.');
      cleanup(); rejectDone(e as Error);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const timer = setTimeout(() => { cleanup(); rejectDone(new Error('Google sign-in timed out. Try again.')); }, SIGN_IN_TIMEOUT_MS);
  function cleanup() { clearTimeout(timer); server.close(); if (pending?.state === state) pending = null; }

  const authUrl = buildAuthUrl(cfg, redirectUri, state, challenge);
  pending = { state, done, authUrl, close: () => { cleanup(); rejectDone(new Error('A newer sign-in replaced this one.')); } };
  (opts.open ?? openInBrowser)(authUrl);
  return { authUrl, done };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

async function exchangeCode(cfg: GoogleConfig, code: string, verifier: string, redirectUri: string, f: Fetch): Promise<GoogleProfile> {
  const res = await f(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
  });
  const tok = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; scope?: string };
  if (!res.ok || !tok.access_token) throw new Error(`Google token exchange failed: ${tok.error ?? res.status}`);
  if (!tok.refresh_token) throw new Error('Google did not grant offline access; try signing in again.');
  if (tok.scope && !tok.scope.split(' ').includes('https://www.googleapis.com/auth/drive.file')) {
    throw new Error('Google Drive access was not granted, so AURA cannot send projects to the cloud. Sign in again and allow it.');
  }
  const info = await f(USERINFO_URL, { headers: { authorization: `Bearer ${tok.access_token}` } });
  const p = (await info.json().catch(() => ({}))) as { email?: string; name?: string; picture?: string };
  if (!info.ok || !p.email) throw new Error('Could not read the Google account after sign-in.');
  secrets.set(REFRESH_SECRET, tok.refresh_token, 'Google account (AURA cloud)');
  const profile: GoogleProfile = { email: p.email, name: p.name ?? p.email, picture: p.picture ?? null, signedInAt: new Date().toISOString() };
  fs.writeFileSync(PROFILE_FILE(), JSON.stringify(profile, null, 2), { mode: 0o600 });
  cachedAccess = { token: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 - 60_000 };
  return profile;
}

/** Who is signed in with Google, or null. */
export function googleProfile(): GoogleProfile | null {
  if (!secrets.has(REFRESH_SECRET)) return null;
  return readJsonFile<GoogleProfile | null>(PROFILE_FILE(), null);
}

let cachedAccess: { token: string; expiresAt: number } | null = null;

/** A short-lived access token for Drive, refreshed from the stored refresh token. */
export async function googleAccessToken(fetchImpl: Fetch = fetch): Promise<string> {
  if (cachedAccess && cachedAccess.expiresAt > Date.now()) return cachedAccess.token;
  const cfg = loadGoogleConfig();
  const refresh = readRefresh();
  if (!cfg || !refresh) throw new NotSignedInError();
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' }),
  });
  const tok = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !tok.access_token) {
    if (tok.error === 'invalid_grant') { await signOutGoogle(fetchImpl, false); throw new NotSignedInError('Your Google sign-in expired. Sign in again.'); }
    throw new Error(`Google refused the token refresh: ${tok.error ?? res.status}`);
  }
  cachedAccess = { token: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 - 60_000 };
  return cachedAccess.token;
}

export class NotSignedInError extends Error {
  constructor(message = 'Sign in with Google to send projects to the cloud.') { super(message); this.name = 'NotSignedInError'; }
}

/** Sign out: revoke at Google (best effort) and forget the token and profile on this device. */
export async function signOutGoogle(fetchImpl: Fetch = fetch, revoke = true): Promise<void> {
  const refresh = readRefresh();
  if (revoke && refresh) {
    await fetchImpl(`${REVOKE_URL}?${new URLSearchParams({ token: refresh })}`, { method: 'POST' }).catch(() => undefined);
  }
  secrets.remove(REFRESH_SECRET);
  try { fs.unlinkSync(PROFILE_FILE()); } catch { /* already gone */ }
  cachedAccess = null;
}

/** The sign-in in progress, for the app to show "waiting for your browser". */
export function pendingGoogleSignIn(): { authUrl: string } | null {
  return pending ? { authUrl: pending.authUrl } : null;
}
