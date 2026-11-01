import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountError } from './localAccount';
import { SupabaseAccounts, loadSupabaseConfig } from './supabaseAccount';

const URL_OK = 'https://abcdefgh.supabase.co';
const jwt = (role: string) => `h.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.s`;
const ANON = jwt('anon');
const CFG = { url: URL_OK, anonKey: ANON };

type Reply = { status: number; body: unknown };
function fake(routes: Record<string, Reply>) {
  const calls: { url: string; auth?: string; body?: string }[] = [];
  const f = (async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, auth: init?.headers?.authorization, body: init?.body });
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    const r = key ? routes[key] : { status: 404, body: {} };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  }) as unknown as ConstructorParameters<typeof SupabaseAccounts>[1];
  return { f, calls };
}
const session = { access_token: 'at', refresh_token: 'rt', user: { email: 'Owner@Gmail.com', user_metadata: { name: 'Owner' } } };

describe('loadSupabaseConfig', () => {
  it('is null until configured, and reads the environment or a private file', () => {
    expect(loadSupabaseConfig({})).toBeNull();
    expect(loadSupabaseConfig({ AURA_SUPABASE_URL: URL_OK + '/', AURA_SUPABASE_ANON_KEY: ANON })).toEqual(CFG);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aura-sb-')), 'supabase.json');
    fs.writeFileSync(file, JSON.stringify({ url: URL_OK, anonKey: ANON }));
    expect(loadSupabaseConfig({}, file)).toEqual(CFG);
  });
  it('refuses the secret service-role key and a URL that is not a Supabase project', () => {
    expect(() => loadSupabaseConfig({ AURA_SUPABASE_URL: URL_OK, AURA_SUPABASE_ANON_KEY: jwt('service_role') })).toThrow(/service-role/);
    expect(() => loadSupabaseConfig({ AURA_SUPABASE_URL: 'http://evil.example.com', AURA_SUPABASE_ANON_KEY: ANON })).toThrow(/supabase\.co/);
  });
});

describe('SupabaseAccounts', () => {
  it('signs in and returns the account with its session tokens', async () => {
    const { f, calls } = fake({ '/auth/v1/token?grant_type=password': { status: 200, body: session } });
    const s = await new SupabaseAccounts(CFG, f).signIn(' Owner@Gmail.com ', 'pw-long-enough');
    expect(s).toEqual({ account: { email: 'owner@gmail.com', name: 'Owner' }, token: 'at', refreshToken: 'rt' });
    expect(JSON.parse(calls[0].body!).email).toBe('owner@gmail.com');
    expect(calls[0].auth).toBe(`Bearer ${ANON}`);
  });

  it('opens a session on sign-up when no confirmation is needed, otherwise asks to confirm', async () => {
    const open = fake({ '/auth/v1/signup': { status: 200, body: session } });
    const a = await new SupabaseAccounts(CFG, open.f).signUp('owner@gmail.com', 'pw-long-enough', 'Owner');
    expect(a).toMatchObject({ confirmed: true, token: 'at' });
    const pending = fake({ '/auth/v1/signup': { status: 200, body: { email: 'o@g.com', identities: [{ id: 1 }] } } });
    const b = await new SupabaseAccounts(CFG, pending.f).signUp('o@g.com', 'pw-long-enough');
    expect(b).toMatchObject({ confirmed: false });
  });

  it('maps Supabase refusals to plain account errors', async () => {
    const dup = fake({ '/auth/v1/signup': { status: 200, body: { email: 'o@g.com', identities: [] } } });
    await expect(new SupabaseAccounts(CFG, dup.f).signUp('o@g.com', 'pw-long-enough')).rejects.toMatchObject({ code: 'exists' });
    const weak = fake({ '/auth/v1/signup': { status: 422, body: { error_code: 'weak_password', msg: 'Password should be at least 6 characters.' } } });
    await expect(new SupabaseAccounts(CFG, weak.f).signUp('o@g.com', 'abc')).rejects.toMatchObject({ code: 'weak-password' });
    const bad = fake({ '/auth/v1/token?grant_type=password': { status: 400, body: { error_code: 'invalid_credentials' } } });
    await expect(new SupabaseAccounts(CFG, bad.f).signIn('o@g.com', 'nope-nope')).rejects.toMatchObject({ code: 'bad-credentials' });
    const unconfirmed = fake({ '/auth/v1/token?grant_type=password': { status: 400, body: { error_code: 'email_not_confirmed' } } });
    await expect(new SupabaseAccounts(CFG, unconfirmed.f).signIn('o@g.com', 'nope-nope')).rejects.toMatchObject({ code: 'unconfirmed' });
  });

  it('says the service is unavailable instead of failing silently', async () => {
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as ConstructorParameters<typeof SupabaseAccounts>[1];
    const err = await new SupabaseAccounts(CFG, down).signIn('o@g.com', 'pw-long-enough').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountError);
    expect((err as AccountError).code).toBe('unavailable');
  });

  it('resolves, refreshes and signs out with the session tokens', async () => {
    const { f, calls } = fake({
      '/auth/v1/user': { status: 200, body: session.user },
      '/auth/v1/token?grant_type=refresh_token': { status: 200, body: { ...session, access_token: 'at2' } },
      '/auth/v1/logout': { status: 204, body: {} },
    });
    const sb = new SupabaseAccounts(CFG, f);
    expect(await sb.resolve('at')).toEqual({ email: 'owner@gmail.com', name: 'Owner' });
    expect(calls[0].auth).toBe('Bearer at');
    expect((await sb.refresh('rt'))?.token).toBe('at2');
    await sb.signOut('at');
    expect(calls[2].url.endsWith('/auth/v1/logout')).toBe(true);
    expect(await new SupabaseAccounts(CFG, fake({ '/auth/v1/user': { status: 401, body: {} } }).f).resolve('old')).toBeNull();
  });
});
