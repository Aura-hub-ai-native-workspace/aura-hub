import { describe, expect, it } from 'vitest';
import { accountStatus, checkSession, signIn, signUp } from './accountClient';
import { clearAccount, readAccount, writeAccount } from './accountSession';

const reply = (status: number, body: unknown) =>
  (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;

describe('accountClient', () => {
  it('returns the account and token on a good sign-in', async () => {
    const r = await signIn('a@b.co', 'longenough', reply(200, { account: { email: 'a@b.co', name: 'A' }, token: 't1' }));
    expect(r).toEqual({ ok: true, account: { email: 'a@b.co', name: 'A', token: 't1' } });
  });

  it('returns the service message when the account is refused', async () => {
    const r = await signUp('a@b.co', 'x', 'A', reply(400, { message: 'The password needs at least 8 characters.' }));
    expect(r).toEqual({ ok: false, message: 'The password needs at least 8 characters.' });
  });

  it('says the service is unreachable instead of failing silently', async () => {
    const down = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    const r = await signIn('a@b.co', 'longenough', down);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain('could not reach');
    expect(await accountStatus(down)).toBeNull();
    expect(await checkSession({ token: 't' }, down)).toBe('unreachable');
  });

  it('treats 401 as an ended session and keeps the session when the service errors', async () => {
    expect(await checkSession({ token: 't' }, reply(401, {}))).toBe('invalid');
    expect(await checkSession({ token: 't' }, reply(500, {}))).toBe('unreachable');
    expect(await checkSession({ token: 't' }, reply(200, { account: {} }))).toBe('valid');
  });

  it('renews an expired cloud session with its refresh token', async () => {
    const seq = [reply(401, {}), reply(200, { token: 'new', refreshToken: 'newer' })];
    const fetchSeq = (async (...a: Parameters<typeof fetch>) => seq.shift()!(...a)) as unknown as typeof fetch;
    let renewed: unknown = null;
    expect(await checkSession({ token: 'old', refreshToken: 'r' }, fetchSeq, (n) => { renewed = n; })).toBe('valid');
    expect(renewed).toEqual({ token: 'new', refreshToken: 'newer' });
    const seq2 = [reply(401, {}), reply(401, {})];
    const fetchSeq2 = (async (...a: Parameters<typeof fetch>) => seq2.shift()!(...a)) as unknown as typeof fetch;
    expect(await checkSession({ token: 'old', refreshToken: 'r' }, fetchSeq2)).toBe('invalid');
  });

  it('reports where accounts live and whether any exists', async () => {
    expect(await accountStatus(reply(200, { hasAccounts: false, provider: 'local' }))).toEqual({ hasAccounts: false, provider: 'local' });
    expect(await accountStatus(reply(200, { hasAccounts: true, provider: 'supabase' }))).toEqual({ hasAccounts: true, provider: 'supabase' });
  });

  it('shows a confirm-your-email notice, not an error, when sign-up needs confirmation', async () => {
    const r = await signUp('a@b.co', 'longenough', 'A', reply(200, { confirmed: false, message: 'Check your email.' }));
    expect(r).toEqual({ ok: false, pendingConfirmation: true, message: 'Check your email.' });
  });

  it('keeps the refresh token from a cloud sign-in', async () => {
    const r = await signIn('a@b.co', 'longenough', reply(200, { account: { email: 'a@b.co', name: 'A' }, token: 't', refreshToken: 'r' }));
    expect(r).toEqual({ ok: true, account: { email: 'a@b.co', name: 'A', token: 't', refreshToken: 'r' } });
  });
});

describe('accountSession', () => {
  it('round-trips an account and clears it', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    expect(readAccount(storage)).toBeNull();
    writeAccount({ email: 'a@b.co', name: 'A', token: 't' }, storage);
    expect(readAccount(storage)).toEqual({ email: 'a@b.co', name: 'A', token: 't' });
    clearAccount(storage);
    expect(readAccount(storage)).toBeNull();
  });

  it('ignores a stored value without a token', () => {
    expect(readAccount({ getItem: () => JSON.stringify({ email: 'a@b.co' }) })).toBeNull();
    expect(readAccount({ getItem: () => 'not json' })).toBeNull();
  });
});
