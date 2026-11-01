import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountError, AccountStore, LOCK_MS, MAX_FAILURES, SESSION_MS } from './localAccount';

function store(now = { t: 1_000_000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-acct-'));
  const file = path.join(dir, 'accounts.json');
  return { s: new AccountStore(file, () => now.t), file, now };
}

describe('AccountStore', () => {
  it('signs up, then signs in, and a session resolves to the account', () => {
    const { s } = store();
    expect(s.hasAccounts()).toBe(false);
    const up = s.signUp('  Owner@Gmail.com ', 'correct horse', 'Owner');
    expect(up.account).toEqual({ email: 'owner@gmail.com', name: 'Owner' });
    expect(s.hasAccounts()).toBe(true);
    expect(s.resolve(up.token)).toEqual(up.account);
    const inn = s.signIn('OWNER@gmail.com', 'correct horse');
    expect(s.resolve(inn.token)?.email).toBe('owner@gmail.com');
  });

  it('refuses a bad email, a short password and a duplicate', () => {
    const { s } = store();
    expect(() => s.signUp('not-an-email', 'longenough')).toThrowError(expect.objectContaining({ code: 'invalid-email' }));
    expect(() => s.signUp('a@b.co', 'short')).toThrowError(expect.objectContaining({ code: 'weak-password' }));
    s.signUp('a@b.co', 'longenough');
    expect(() => s.signUp('A@B.co', 'longenough')).toThrowError(expect.objectContaining({ code: 'exists' }));
  });

  it('refuses a wrong password and an unknown account the same way, then locks', () => {
    const { s, now } = store();
    s.signUp('a@b.co', 'longenough');
    expect(() => s.signIn('a@b.co', 'wrong-pass')).toThrowError(expect.objectContaining({ code: 'bad-credentials' }));
    expect(() => s.signIn('nobody@b.co', 'whatever1')).toThrowError(expect.objectContaining({ code: 'bad-credentials' }));
    for (let i = 0; i < MAX_FAILURES; i++) {
      try { s.signIn('a@b.co', 'wrong-pass'); } catch (e) { expect(e).toBeInstanceOf(AccountError); }
    }
    expect(() => s.signIn('a@b.co', 'longenough')).toThrowError(expect.objectContaining({ code: 'locked' }));
    now.t += LOCK_MS + 1;
    expect(s.signIn('a@b.co', 'longenough').account.email).toBe('a@b.co');
  });

  it('ends a session on sign-out and when it expires', () => {
    const { s, now } = store();
    const { token } = s.signUp('a@b.co', 'longenough');
    s.signOut(token);
    expect(s.resolve(token)).toBeNull();
    const again = s.signIn('a@b.co', 'longenough').token;
    now.t += SESSION_MS + 1;
    expect(s.resolve(again)).toBeNull();
  });

  it('stores no password or token in clear text and keeps the file private', () => {
    const { s, file } = store();
    const { token } = s.signUp('a@b.co', 'my-secret-pass');
    const text = fs.readFileSync(file, 'utf-8');
    expect(text).not.toContain('my-secret-pass');
    expect(text).not.toContain(token);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
  });
});
