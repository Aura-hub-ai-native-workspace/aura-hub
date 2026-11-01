/**
 * Where AURA Hub accounts live. The hub's own sign-in form always talks to this service;
 * the service keeps accounts either on this machine (local) or in a Supabase project
 * (Supabase Auth, free tier) when one is configured.
 */

import { AccountStore, type PublicAccount } from './localAccount.js';
import { SupabaseAccounts, loadSupabaseConfig } from './supabaseAccount.js';
import { homePath } from '../persist';

/** Turn on to use a configured Supabase project for accounts. */
export const SUPABASE_ENABLED = false;

export type { PublicAccount } from './localAccount.js';

export interface Session {
  account: PublicAccount;
  token: string;
  refreshToken?: string;
}

/** Sign-up either opens a session, or asks the person to confirm their email first. */
export type SignUpResult = ({ confirmed: true } & Session) | { confirmed: false; message: string };

export interface AccountProvider {
  readonly kind: 'local' | 'supabase';
  /** Whether any account exists. Cloud accounts cannot be listed, so a cloud provider says true. */
  hasAccounts(): Promise<boolean>;
  signUp(email: string, password: string, name?: string): Promise<SignUpResult>;
  signIn(email: string, password: string): Promise<Session>;
  resolve(token: string): Promise<PublicAccount | null>;
  refresh(refreshToken: string): Promise<Session | null>;
  signOut(token: string): Promise<void>;
}

/** The on-machine store, behind the same interface. */
export class LocalProvider implements AccountProvider {
  readonly kind = 'local' as const;
  constructor(private readonly store: AccountStore) {}
  async hasAccounts() { return this.store.hasAccounts(); }
  async signUp(email: string, password: string, name?: string): Promise<SignUpResult> {
    return { confirmed: true, ...this.store.signUp(email, password, name) };
  }
  async signIn(email: string, password: string): Promise<Session> { return this.store.signIn(email, password); }
  async resolve(token: string) { return this.store.resolve(token); }
  async refresh(): Promise<Session | null> { return null; }
  async signOut(token: string) { this.store.signOut(token); }
}

let provider: AccountProvider | null = null;

/** Supabase when its URL and public key are configured, otherwise the local store. */
export function accountProvider(): AccountProvider {
  if (provider) return provider;
  // Supabase is switched off for now (owner's decision): accounts stay on this machine.
  const cfg = SUPABASE_ENABLED ? loadSupabaseConfig(process.env, homePath('supabase.json')) : null;
  provider = cfg ? new SupabaseAccounts(cfg) : new LocalProvider(new AccountStore(homePath('accounts.json')));
  return provider;
}
