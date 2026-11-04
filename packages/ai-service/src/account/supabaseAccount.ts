/**
 * Accounts in Supabase (Auth + its free Postgres database).
 *
 * Only the project URL and the PUBLIC anon key are used. The admin (service role) key is
 * refused on sight: it must never be put in an app. Supabase Auth hashes passwords and
 * issues the sessions; this module only calls its REST API and maps the answers.
 */

import * as fs from 'node:fs';
import { AccountError, type PublicAccount } from './localAccount.js';
import type { AccountProvider, Session, SignUpResult } from './accountProvider.js';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function jwtRole(key: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1] ?? '', 'base64url').toString('utf-8')) as { role?: unknown };
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

/**
 * The configured project, from the environment or from a private file. Returns null when
 * nothing is configured; throws when what is configured is unsafe or malformed.
 */
export function loadSupabaseConfig(env: NodeJS.ProcessEnv, file?: string): SupabaseConfig | null {
  let url = (env.AURA_SUPABASE_URL ?? '').trim();
  let anonKey = (env.AURA_SUPABASE_ANON_KEY ?? '').trim();
  if ((!url || !anonKey) && file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as { url?: unknown; anonKey?: unknown };
      url = url || (typeof saved.url === 'string' ? saved.url.trim() : '');
      anonKey = anonKey || (typeof saved.anonKey === 'string' ? saved.anonKey.trim() : '');
    } catch {
      /* no file: not configured */
    }
  }
  if (!url || !anonKey) return null;
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url)) {
    throw new Error('AURA_SUPABASE_URL must look like https://<project>.supabase.co');
  }
  if (jwtRole(anonKey) === 'service_role') {
    throw new Error('That is the secret service-role key. Use the public anon key instead.');
  }
  return { url: url.replace(/\/$/, ''), anonKey };
}

interface AuthUser { email?: string; user_metadata?: { name?: string }; identities?: unknown[] }
interface AuthSession { access_token?: string; refresh_token?: string; user?: AuthUser }

function publicAccount(user: AuthUser | undefined): PublicAccount | null {
  if (!user || typeof user.email !== 'string') return null;
  const name = typeof user.user_metadata?.name === 'string' && user.user_metadata.name ? user.user_metadata.name : user.email.split('@')[0];
  return { email: user.email.toLowerCase(), name };
}

function failure(status: number, body: Record<string, unknown>, fallback: AccountError): AccountError {
  const code = String(body.error_code ?? body.code ?? '');
  const msg = String(body.msg ?? body.message ?? body.error_description ?? '');
  if (code === 'user_already_exists' || /already registered/i.test(msg)) {
    return new AccountError('exists', 'An account with this email already exists. Sign in instead.');
  }
  if (code === 'weak_password') return new AccountError('weak-password', msg || 'That password is too weak.');
  if (code === 'email_address_invalid' || code === 'validation_failed') return new AccountError('invalid-email', msg || 'Enter a valid email address.');
  if (code === 'invalid_credentials') return new AccountError('bad-credentials', 'The email or password is not right.');
  if (code === 'email_not_confirmed') return new AccountError('unconfirmed', 'Confirm your email first: open the message Supabase sent you, then sign in.');
  if (status === 429 || code.includes('rate_limit')) return new AccountError('locked', 'Too many attempts. Try again in a few minutes.');
  if (status >= 500) return new AccountError('unavailable', 'The account service is not available right now.');
  return fallback;
}

export class SupabaseAccounts implements AccountProvider {
  readonly kind = 'supabase' as const;

  constructor(private readonly cfg: SupabaseConfig, private readonly doFetch: FetchLike = globalThis.fetch as unknown as FetchLike) {}

  private async call(path: string, opts: { method?: string; body?: unknown; bearer?: string } = {}) {
    try {
      const res = await this.doFetch(`${this.cfg.url}/auth/v1${path}`, {
        method: opts.method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: this.cfg.anonKey,
          authorization: `Bearer ${opts.bearer ?? this.cfg.anonKey}`,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: res.ok, status: res.status, json };
    } catch {
      throw new AccountError('unavailable', 'AURA Hub could not reach the account service. Check the internet connection.');
    }
  }

  async hasAccounts(): Promise<boolean> {
    return true;
  }

  async signUp(emailRaw: string, password: string, name?: string): Promise<SignUpResult> {
    const email = emailRaw.trim().toLowerCase();
    const r = await this.call('/signup', { body: { email, password, data: { name: (name ?? '').trim() } } });
    if (!r.ok) throw failure(r.status, r.json, new AccountError('invalid-email', 'The account could not be created.'));
    const s = r.json as AuthSession & AuthUser;
    const session = s.access_token ? s : null;
    if (session?.access_token) {
      const account = publicAccount(session.user);
      if (account) return { confirmed: true, account, token: session.access_token, refreshToken: session.refresh_token };
    }
    // Supabase answers a sign-up for an existing address with a user that has no identities.
    if (Array.isArray(s.identities) && s.identities.length === 0) {
      throw new AccountError('exists', 'An account with this email already exists. Sign in instead.');
    }
    return { confirmed: false, message: 'Check your email: confirm your address, then sign in.' };
  }

  async signIn(emailRaw: string, password: string): Promise<Session> {
    const r = await this.call('/token?grant_type=password', { body: { email: emailRaw.trim().toLowerCase(), password } });
    if (!r.ok) throw failure(r.status, r.json, new AccountError('bad-credentials', 'The email or password is not right.'));
    return this.toSession(r.json as AuthSession);
  }

  async resolve(token: string): Promise<PublicAccount | null> {
    if (!token) return null;
    const r = await this.call('/user', { method: 'GET', bearer: token });
    return r.ok ? publicAccount(r.json as AuthUser) : null;
  }

  async refresh(refreshToken: string): Promise<Session | null> {
    if (!refreshToken) return null;
    const r = await this.call('/token?grant_type=refresh_token', { body: { refresh_token: refreshToken } });
    return r.ok ? this.toSession(r.json as AuthSession) : null;
  }

  async signOut(token: string): Promise<void> {
    if (!token) return;
    await this.call('/logout', { bearer: token }).catch(() => undefined);
  }

  private toSession(s: AuthSession): Session {
    const account = publicAccount(s.user);
    if (!account || !s.access_token) throw new AccountError('unavailable', 'The account service gave an unexpected answer.');
    return { account, token: s.access_token, refreshToken: s.refresh_token };
  }
}
