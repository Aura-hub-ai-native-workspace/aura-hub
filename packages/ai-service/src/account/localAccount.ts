/**
 * Individual accounts for AURA Hub, kept entirely on this machine.
 *
 * Sign-up and sign-in happen inside the hub: an email address (a Gmail address is the
 * usual choice) and a password. Nothing leaves the machine and no outside identity
 * provider is involved. Passwords are stored only as scrypt hashes, sessions only as
 * SHA-256 hashes of their token, and the file is readable by its owner alone.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type AccountErrorCode =
  | 'invalid-email' | 'weak-password' | 'exists' | 'bad-credentials' | 'locked'
  | 'unconfirmed'   // the account exists but its email is not confirmed yet
  | 'unavailable';  // the account service could not be reached or refused the request

export class AccountError extends Error {
  constructor(readonly code: AccountErrorCode, message: string) {
    super(message);
  }
}

export interface PublicAccount {
  email: string;
  name: string;
}

interface StoredAccount extends PublicAccount {
  salt: string;
  hash: string;
  createdAt: number;
}

interface StoredSession {
  tokenHash: string;
  email: string;
  expiresAt: number;
}

interface Store {
  version: 1;
  accounts: StoredAccount[];
  sessions: StoredSession[];
}

export const MIN_PASSWORD_LENGTH = 8;
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_FAILURES = 5;
export const LOCK_MS = 5 * 60 * 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function hashPassword(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, 64);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export class AccountStore {
  private failures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  private read(): Store {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<Store>;
      return { version: 1, accounts: parsed.accounts ?? [], sessions: parsed.sessions ?? [] };
    } catch {
      return { version: 1, accounts: [], sessions: [] };
    }
  }

  private write(store: Store): void {
    const live = store.sessions.filter((s) => s.expiresAt > this.now());
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...store, sessions: live }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  hasAccounts(): boolean {
    return this.read().accounts.length > 0;
  }

  signUp(emailRaw: string, password: string, name?: string): { account: PublicAccount; token: string } {
    const email = normalizeEmail(emailRaw);
    if (!EMAIL_RE.test(email)) throw new AccountError('invalid-email', 'Enter a valid email address.');
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new AccountError('weak-password', `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    const store = this.read();
    if (store.accounts.some((a) => a.email === email)) {
      throw new AccountError('exists', 'An account with this email already exists. Sign in instead.');
    }
    const salt = crypto.randomBytes(16);
    const account: StoredAccount = {
      email,
      name: (name ?? '').trim() || email.split('@')[0],
      salt: salt.toString('hex'),
      hash: hashPassword(password, salt).toString('hex'),
      createdAt: this.now(),
    };
    store.accounts.push(account);
    const token = this.openSession(store, email);
    this.write(store);
    return { account: { email: account.email, name: account.name }, token };
  }

  signIn(emailRaw: string, password: string): { account: PublicAccount; token: string } {
    const email = normalizeEmail(emailRaw);
    const fail = this.failures.get(email);
    if (fail && fail.lockedUntil > this.now()) {
      throw new AccountError('locked', 'Too many wrong passwords. Try again in a few minutes.');
    }
    const store = this.read();
    const found = store.accounts.find((a) => a.email === email);
    // Always do the same work, so a missing account and a wrong password look alike.
    const salt = found ? Buffer.from(found.salt, 'hex') : Buffer.alloc(16);
    const attempt = hashPassword(password, salt);
    const expected = found ? Buffer.from(found.hash, 'hex') : Buffer.alloc(attempt.length);
    const ok = found !== undefined && attempt.length === expected.length && crypto.timingSafeEqual(attempt, expected);
    if (!ok) {
      // The count restarts only after a lock has expired, not while failures are still adding up.
      const lockExpired = fail !== undefined && fail.lockedUntil !== 0 && fail.lockedUntil <= this.now();
      const count = (lockExpired ? 0 : fail?.count ?? 0) + 1;
      this.failures.set(email, { count, lockedUntil: count >= MAX_FAILURES ? this.now() + LOCK_MS : 0 });
      throw new AccountError('bad-credentials', 'The email or password is not right.');
    }
    this.failures.delete(email);
    const token = this.openSession(store, email);
    this.write(store);
    return { account: { email: found.email, name: found.name }, token };
  }

  /** The account a live session belongs to, or null. */
  resolve(token: string): PublicAccount | null {
    if (!token) return null;
    const store = this.read();
    const hash = sha256(token);
    const session = store.sessions.find((s) => s.tokenHash === hash && s.expiresAt > this.now());
    if (!session) return null;
    const account = store.accounts.find((a) => a.email === session.email);
    return account ? { email: account.email, name: account.name } : null;
  }

  signOut(token: string): void {
    const store = this.read();
    const hash = sha256(token);
    store.sessions = store.sessions.filter((s) => s.tokenHash !== hash);
    this.write(store);
  }

  private openSession(store: Store, email: string): string {
    const token = crypto.randomBytes(32).toString('base64url');
    store.sessions.push({ tokenHash: sha256(token), email, expiresAt: this.now() + SESSION_MS });
    return token;
  }
}
