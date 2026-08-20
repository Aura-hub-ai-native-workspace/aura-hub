/**
 * provider/credentialStore — where a user's API keys actually live.
 * ==================================================================
 * This file used to encrypt provider keys with AES-256-GCM and write the
 * decryption key beside the ciphertext: a random seed in the same JSON
 * file, run through an unsalted SHA-256. Anyone able to read
 * `providers.json` could decrypt it by reading `providers.json`. That is
 * obfuscation, not encryption, and it is worse than storing the keys in
 * the clear would have been — because a user told their keys are
 * encrypted will store keys they would otherwise keep elsewhere.
 *
 * There are now three protections, tried in order, and each one is
 * recorded on the credential so the UI can say which is in force:
 *
 *   1. `os-keychain` — the key is in the operating system's own secret
 *      store, guarded by the user's login session. Nothing sensitive is
 *      in `providers.json` at all. See `keychain.ts`.
 *
 *   2. `passphrase` — no keychain here, but the user supplied
 *      `AURA_PROVIDER_SECRET`. The key is derived with **scrypt** over a
 *      random per-credential salt, so the file yields nothing without a
 *      secret that is not in it. The salt is stored beside the
 *      ciphertext, which is what salts are for.
 *
 *   3. Neither — and then AURA REFUSES TO STORE THE KEY, saying so, and
 *      naming both remedies.
 *
 * The third is the important one. The old code's failure mode was to
 * quietly do something that looked like protection; the new one is to
 * decline and explain. A user who cannot store a key knows they cannot;
 * a user whose key is obfuscated does not know that either.
 *
 * ── Migration ──────────────────────────────────────────────────────
 *
 * Credentials written by the old scheme are still READABLE, and are
 * re-protected in place the first time they are read on a machine that
 * has a keychain or a passphrase. The legacy seed is deleted from the
 * file as soon as no credential depends on it, so an upgraded install
 * stops carrying its own decryption key around.
 */

import crypto from 'node:crypto';
import {
  dpapiBlobFor,
  keychainDelete,
  keychainGet,
  keychainSet,
  probeKeychain,
  restoreDpapiBlob,
} from './keychain';
import { homePath, readJsonFile, writeJsonFile } from '../persist';
import type { ProviderHealth, DiscoveredModel } from './types';

const ALGORITHM = 'aes-256-gcm';
const STORE_PATH = homePath('providers.json');

/**
 * scrypt parameters.
 *
 * N = 2^15 with r = 8 is the interactive-login profile: roughly 100ms and
 * 32 MB on a current laptop. That cost is paid once per store and once
 * per read, which is negligible for an operation a person triggers, and
 * it is the difference between a stolen file being brute-forceable at
 * billions of guesses per second (unsalted SHA-256, what this replaced)
 * and at a few thousand.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 };

/** How a stored credential is protected. Recorded, and shown to the user. */
export type CredentialProtection = 'os-keychain' | 'passphrase' | 'legacy-obfuscated';

interface StoredCredential {
  protection: CredentialProtection;
  fingerprint: string;
  createdAt: string;
  lastValidated: string | null;
  /** `passphrase` and `legacy-obfuscated` only. */
  encryptedKey?: string;
  iv?: string;
  tag?: string;
  /** `passphrase` only. Random per credential. Not secret. */
  salt?: string;
  /**
   * `os-keychain` on Windows only: the DPAPI-protected blob.
   *
   * DPAPI protects a value but does not store it, so unlike libsecret and
   * the macOS keychain the ciphertext has to live somewhere. Here is
   * safe in the way the old scheme was not — the key is held by the OS
   * under the user's login and is nowhere in this file.
   */
  dpapi?: string;
}

interface PersistedStore {
  /**
   * The legacy seed. Read for migration, never written again, and
   * deleted as soon as no credential still needs it.
   */
  secret?: string;
  credentials: Record<string, StoredCredential>;
  models: Record<string, DiscoveredModel[]>;
  health: Record<string, ProviderHealth | null>;
  active: string | null;
  activeModel: string;
}

/** Thrown when there is nowhere safe to put a key. Never swallowed. */
export class NoCredentialProtectionError extends Error {}

/**
 * The strongest protection available on this machine, right now.
 *
 * Probed rather than assumed, and the probe is a real keychain round
 * trip — see `keychain.ts` for why a `which` is not enough.
 */
export function availableProtection(): CredentialProtection | null {
  if (probeKeychain().available) return 'os-keychain';
  if (process.env.AURA_PROVIDER_SECRET) return 'passphrase';
  return null;
}

/** The account name a provider's key is filed under in the OS keychain. */
const accountFor = (providerId: string) => `provider:${providerId}`;

/**
 * Derive a key from the user's passphrase and a per-credential salt.
 *
 * Per-credential, not global: two credentials protected by the same
 * passphrase must not share a derived key, or a single cracked salt
 * would open all of them at once.
 */
function passphraseKey(salt: Buffer): Buffer {
  const secret = process.env.AURA_PROVIDER_SECRET;
  if (!secret) {
    throw new NoCredentialProtectionError(
      'AURA_PROVIDER_SECRET is not set, so there is no passphrase to derive a key from.',
    );
  }
  return crypto.scryptSync(secret, salt, SCRYPT.keyLength, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem,
  });
}

/**
 * Every key the legacy scheme could have used, in the order it used them.
 *
 * BOTH candidates, not one. The old `deriveKey()` preferred
 * `AURA_PROVIDER_SECRET` and fell back to the in-file seed, so a
 * credential could have been written under either, and which one is
 * decided by whether the environment variable happened to be set on the
 * day it was stored. Reading with only the current preference is how a
 * user who sets a passphrase *after* connecting a provider would find
 * their existing credentials silently unreadable — which the migration
 * test caught, and which would have been data loss in the field.
 *
 * Trying both is safe: GCM authenticates, so a wrong key fails to
 * decrypt rather than returning plausible garbage.
 *
 * For reading only. Nothing is ever written under these again.
 */
function legacyKeys(store: PersistedStore): Buffer[] {
  const seeds = [process.env.AURA_PROVIDER_SECRET, store.secret].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  return [...new Set(seeds)].map((seed) =>
    crypto.createHash('sha256').update(seed + ':aura-provider-v2').digest(),
  );
}

function decryptWith(key: Buffer, entry: StoredCredential): string | null {
  if (!entry.encryptedKey || !entry.iv || !entry.tag) return null;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(entry.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
    return decipher.update(entry.encryptedKey, 'hex', 'utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}

const fingerprintOf = (apiKey: string) =>
  apiKey.length >= 8 ? `${apiKey.slice(0, 4)}\u2026${apiKey.slice(-4)}` : '****';

/**
 * Write one credential under the best protection this machine offers.
 *
 * Returns the record to persist. Throws rather than falling back to
 * something weaker: silently degrading protection is how the old scheme
 * came to be described as encryption.
 */
function protect(providerId: string, apiKey: string): StoredCredential {
  const base = {
    fingerprint: fingerprintOf(apiKey),
    createdAt: new Date().toISOString(),
    lastValidated: null,
  };

  const protection = availableProtection();

  if (protection === 'os-keychain') {
    if (!keychainSet(accountFor(providerId), apiKey)) {
      throw new NoCredentialProtectionError(
        'The OS keychain reported it was available but then refused to store the key. Nothing was written.',
      );
    }
    const dpapi = dpapiBlobFor(accountFor(providerId));
    return { ...base, protection: 'os-keychain', ...(dpapi ? { dpapi } : {}) };
  }

  if (protection === 'passphrase') {
    const salt = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, passphraseKey(salt), iv);
    const encryptedKey = cipher.update(apiKey, 'utf8', 'hex') + cipher.final('hex');
    return {
      ...base,
      protection: 'passphrase',
      encryptedKey,
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      salt: salt.toString('hex'),
    };
  }

  throw new NoCredentialProtectionError(
    'AURA will not store this API key, because there is nowhere safe on this machine to put it. ' +
    'Either start an OS secret service (gnome-keyring or kwallet on Linux; the login keychain on macOS; DPAPI is always present on Windows), ' +
    'or set AURA_PROVIDER_SECRET to a passphrase and AURA will derive a key from it with scrypt. ' +
    'It will not write the key obfuscated and call it encrypted.',
  );
}

const DEFAULT_STORE: PersistedStore = { secret: undefined, credentials: {}, models: {}, health: {}, active: null, activeModel: '' };

function load(): PersistedStore {
  return { ...DEFAULT_STORE, ...readJsonFile<Partial<PersistedStore>>(STORE_PATH, DEFAULT_STORE) };
}

function save(store: PersistedStore): void {
  writeJsonFile(STORE_PATH, store);
}

/**
 * Store an API key under the strongest protection this machine offers.
 *
 * Throws `NoCredentialProtectionError` when there is none. That is the
 * whole behavioural change: a failure the user can see and act on,
 * instead of a success that was never one.
 */
export function storeKey(providerId: string, apiKey: string): { fingerprint: string; protection: CredentialProtection } {
  const credential = protect(providerId, apiKey);
  const store = load();
  store.credentials[providerId] = credential;
  forgetLegacySeedIfUnused(store);
  save(store);
  return { fingerprint: credential.fingerprint, protection: credential.protection };
}

/**
 * The legacy seed is this file's own decryption key. Once nothing needs
 * it, carrying it is pure liability, so it is deleted the moment the
 * last legacy credential is gone.
 */
function forgetLegacySeedIfUnused(store: PersistedStore): void {
  const stillLegacy = Object.values(store.credentials).some((c) => c.protection === 'legacy-obfuscated');
  if (!stillLegacy && store.secret !== undefined) delete store.secret;
}

/**
 * Read a key back, migrating it off the legacy scheme on the way.
 *
 * Migration happens on READ rather than at startup because reading is
 * when the plaintext is legitimately in hand: re-protecting it costs
 * nothing extra and needs no separate pass that would have to decrypt
 * every credential just in case.
 */
export function getKey(providerId: string): string | null {
  const store = load();
  const entry = store.credentials[providerId];
  if (!entry) return null;

  if (entry.protection === 'os-keychain') {
    // Windows keeps its DPAPI ciphertext in this file, so it has to be
    // handed back to the backend after a restart before a read can work.
    if (entry.dpapi) restoreDpapiBlob(accountFor(providerId), entry.dpapi);
    return keychainGet(accountFor(providerId));
  }

  if (entry.protection === 'passphrase') {
    if (!entry.salt) return null;
    try {
      return decryptWith(passphraseKey(Buffer.from(entry.salt, 'hex')), entry);
    } catch {
      // A missing or changed AURA_PROVIDER_SECRET. Null, not an
      // exception: the caller's question was "is there a usable key",
      // and the answer is no.
      return null;
    }
  }

  /* Legacy. Read it, then move it somewhere better if we can. */
  let plaintext: string | null = null;
  for (const key of legacyKeys(store)) {
    plaintext = decryptWith(key, entry);
    if (plaintext !== null) break;
  }
  if (plaintext === null) return null;

  if (availableProtection()) {
    try {
      const migrated = protect(providerId, plaintext);
      // Preserve the history: when the credential was first added and
      // when it last worked are facts about the credential, not about
      // the protection scheme it happens to be under.
      store.credentials[providerId] = {
        ...migrated,
        createdAt: entry.createdAt,
        lastValidated: entry.lastValidated,
      };
      forgetLegacySeedIfUnused(store);
      save(store);
    } catch {
      // Migration is an improvement, never a precondition for reading.
      // A failure here leaves the credential exactly as it was.
    }
  }
  return plaintext;
}

export function removeKey(providerId: string): void {
  const store = load();
  // Remove it from the OS keychain too, or the key would outlive the
  // record that pointed at it and there would be no way left to find it.
  if (store.credentials[providerId]?.protection === 'os-keychain') {
    keychainDelete(accountFor(providerId));
  }
  delete store.credentials[providerId];
  delete store.models[providerId];
  delete store.health[providerId];
  if (store.active === providerId) { store.active = null; store.activeModel = ''; }
  forgetLegacySeedIfUnused(store);
  save(store);
}

/** How each stored credential is protected. For the settings UI. */
export function protectionOf(providerId: string): CredentialProtection | null {
  return load().credentials[providerId]?.protection ?? null;
}

export function storeModels(providerId: string, models: DiscoveredModel[]): void {
  const store = load();
  store.models[providerId] = models;
  if (!store.health[providerId]) store.health[providerId] = null;
  save(store);
}

export function storeHealth(providerId: string, health: ProviderHealth): void {
  const store = load();
  store.health[providerId] = health;
  const entry = store.credentials[providerId];
  if (entry) entry.lastValidated = new Date().toISOString();
  save(store);
}

export function getFingerprint(providerId: string): string | null {
  return load().credentials[providerId]?.fingerprint ?? null;
}

export function setActive(providerId: string | null, model?: string): void {
  const store = load();
  store.active = providerId;
  if (model !== undefined) store.activeModel = model;
  save(store);
}

export function getActive(): { providerId: string | null; model: string } {
  const store = load();
  return { providerId: store.active, model: store.activeModel };
}

export function isConnected(providerId: string): boolean {
  return !!load().credentials[providerId];
}

export function getAllProviderStores(): { id: string; fingerprint: string; models: DiscoveredModel[]; health: ProviderHealth | null }[] {
  const store = load();
  return Object.entries(store.credentials).map(([id, cred]) => ({
    id,
    fingerprint: cred.fingerprint,
    models: store.models[id] ?? [],
    health: store.health[id] ?? null,
  }));
}
