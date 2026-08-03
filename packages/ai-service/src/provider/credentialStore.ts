import crypto from 'node:crypto';
import { homePath, readJsonFile, writeJsonFile } from '../persist';
import type { ProviderHealth, DiscoveredModel } from './types';

const ALGORITHM = 'aes-256-gcm';
const STORE_PATH = homePath('providers.json');

interface PersistedStore {
  secret?: string;
  credentials: Record<string, {
    encryptedKey: string;
    iv: string;
    tag: string;
    fingerprint: string;
    createdAt: string;
    lastValidated: string | null;
  }>;
  models: Record<string, DiscoveredModel[]>;
  health: Record<string, ProviderHealth | null>;
  active: string | null;
  activeModel: string;
}

function deriveKey(): Buffer {
  const envSeed = process.env.AURA_PROVIDER_SECRET;
  if (envSeed) return crypto.createHash('sha256').update(envSeed + ':aura-provider-v2').digest();
  const store = load();
  let seed = store.secret;
  if (!seed) {
    seed = crypto.randomBytes(32).toString('hex');
    store.secret = seed;
    save(store);
  }
  return crypto.createHash('sha256').update(seed + ':aura-provider-v2').digest();
}

const DEFAULT_STORE: PersistedStore = { secret: undefined, credentials: {}, models: {}, health: {}, active: null, activeModel: '' };

function load(): PersistedStore {
  return { ...DEFAULT_STORE, ...readJsonFile<Partial<PersistedStore>>(STORE_PATH, DEFAULT_STORE) };
}

function save(store: PersistedStore): void {
  writeJsonFile(STORE_PATH, store);
}

export function storeKey(providerId: string, apiKey: string): { fingerprint: string } {
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(apiKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  const store = load();
  const fingerprint = apiKey.length >= 8 ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : '****';
  store.credentials[providerId] = {
    encryptedKey: encrypted, iv: iv.toString('hex'), tag, fingerprint,
    createdAt: new Date().toISOString(), lastValidated: null,
  };
  save(store);
  return { fingerprint };
}

export function getKey(providerId: string): string | null {
  const store = load();
  const entry = store.credentials[providerId];
  if (!entry) return null;
  try {
    const key = deriveKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(entry.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
    let decrypted = decipher.update(entry.encryptedKey, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch { return null; }
}

export function removeKey(providerId: string): void {
  const store = load();
  delete store.credentials[providerId];
  delete store.models[providerId];
  delete store.health[providerId];
  if (store.active === providerId) { store.active = null; store.activeModel = ''; }
  save(store);
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
