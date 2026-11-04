import { AI_BASE, backendFetch } from '../backend/backendSession';
import type { SignedInAccount } from './accountSession';

/** The app's own request helper: it adds the instance token and checks the service's identity. */
type Fetch = typeof fetch;

export type AccountResult =
  | { ok: true; account: SignedInAccount }
  | { ok: false; message: string; /** The account was created; confirm the email, then sign in. */ pendingConfirmation?: boolean };

export interface AccountStatus {
  hasAccounts: boolean;
  provider: 'local' | 'supabase';
}

async function post(path: string, body: unknown, doFetch: Fetch): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await doFetch(`${AI_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

function toAccount(json: Record<string, unknown>): SignedInAccount | null {
  const account = json.account as { email?: unknown; name?: unknown } | undefined;
  if (!account || typeof account.email !== 'string' || typeof json.token !== 'string') return null;
  return {
    email: account.email, name: String(account.name ?? account.email), token: json.token,
    ...(typeof json.refreshToken === 'string' && json.refreshToken ? { refreshToken: json.refreshToken } : {}),
  };
}

async function submit(path: string, body: unknown, doFetch: Fetch): Promise<AccountResult> {
  try {
    const r = await post(path, body, doFetch);
    const account = r.ok ? toAccount(r.json) : null;
    if (account) return { ok: true, account };
    if (r.ok && r.json.confirmed === false) {
      return { ok: false, pendingConfirmation: true, message: typeof r.json.message === 'string' ? r.json.message : 'Check your email to confirm, then sign in.' };
    }
    return { ok: false, message: typeof r.json.message === 'string' ? r.json.message : 'The account service did not accept that.' };
  } catch {
    return { ok: false, message: 'AURA Hub could not reach its account service. Check that the app finished starting.' };
  }
}

export const signUp = (email: string, password: string, name: string, doFetch: Fetch = backendFetch as Fetch) =>
  submit('/account/signup', { email, password, name }, doFetch);

export const signIn = (email: string, password: string, doFetch: Fetch = backendFetch as Fetch) =>
  submit('/account/signin', { email, password }, doFetch);

/** Where accounts live and whether any exists yet (decides sign-up or sign-in). Null when unreachable. */
export async function accountStatus(doFetch: Fetch = backendFetch as Fetch): Promise<AccountStatus | null> {
  try {
    const res = await doFetch(`${AI_BASE}/account/status`);
    const json = (await res.json()) as { hasAccounts?: unknown; provider?: unknown };
    if (typeof json.hasAccounts !== 'boolean') return null;
    return { hasAccounts: json.hasAccounts, provider: json.provider === 'supabase' ? 'supabase' : 'local' };
  } catch {
    return null;
  }
}

/**
 * 'valid' | 'invalid' (the service says sign in again) | 'unreachable' (keep the session for now).
 * An expired cloud session is renewed with its refresh token; the renewed tokens are passed to
 * `onRenewed` so the caller can store them.
 */
export async function checkSession(
  account: Pick<SignedInAccount, 'token' | 'refreshToken'>,
  doFetch: Fetch = backendFetch as Fetch,
  onRenewed?: (next: { token: string; refreshToken?: string }) => void,
): Promise<'valid' | 'invalid' | 'unreachable'> {
  try {
    const r = await post('/account/session', { token: account.token }, doFetch);
    if (r.ok) return 'valid';
    if (r.status !== 401) return 'unreachable';
    if (!account.refreshToken) return 'invalid';
    const renewed = await post('/account/refresh', { refreshToken: account.refreshToken }, doFetch);
    if (renewed.ok && typeof renewed.json.token === 'string') {
      onRenewed?.({
        token: renewed.json.token,
        ...(typeof renewed.json.refreshToken === 'string' ? { refreshToken: renewed.json.refreshToken } : {}),
      });
      return 'valid';
    }
    return renewed.status === 401 ? 'invalid' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

export async function signOutRemote(token: string, doFetch: Fetch = backendFetch as Fetch): Promise<void> {
  try {
    await post('/account/signout', { token }, doFetch);
  } catch {
    /* the local sign-out still happens */
  }
}
