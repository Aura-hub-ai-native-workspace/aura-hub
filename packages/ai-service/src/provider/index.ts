import type { Runtime } from '@aura/runtime';
import { getAdapter, registerAdapter, getAllAdapters } from './registry';
import type { ProviderAdapter, ActiveRuntime, ProviderHealth, ModelCapabilities } from './types';
import * as credentialStore from './credentialStore';

/* ── types ──────────────────────────────────────────────────────────── */

export interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  docsUrl?: string;
}

export interface ConnectedProvider {
  id: string;
  name: string;
  fingerprint: string;
  models: { id: string; name: string; capabilities?: ModelCapabilities }[];
  health: ProviderHealth | null;
  active: boolean;
}

export interface ActiveProvider {
  providerId: string | null;
  model: string;
}

export interface ProviderAdapterFactory {
  validateKey(apiKey: string): Promise<{ ok: boolean; error?: string }>;
  listModels(apiKey: string): Promise<{ id: string; name: string }[]>;
}

export function registerProvider(adapter: ProviderAdapter): void {
  registerAdapter(adapter);
}

/* ── setup ──────────────────────────────────────────────────────────── */

export function setupProviders(): void {
  /* Registry self-initialises via the array literal in registry.ts. */
}

/* ── listing ────────────────────────────────────────────────────────── */

export function listProviders(): ProviderInfo[] {
  return getAllAdapters()
    .map((a) => ({
      id: a.metadata.id,
      name: a.metadata.name,
      description: a.metadata.description,
      docsUrl: a.metadata.docsUrl,
    }));
}

export function getProvider(providerId: string): { info: ProviderInfo & { apiEndpoint?: string }; factory: ProviderAdapterFactory } | null {
  const adapter = getAdapter(providerId);
  if (!adapter) return null;
  return {
    info: {
      id: adapter.metadata.id,
      name: adapter.metadata.name,
      description: adapter.metadata.description,
      docsUrl: adapter.metadata.docsUrl,
    },
    factory: {
      validateKey: (apiKey) => adapter.validate(apiKey),
      listModels: async (apiKey) => {
        const models = await adapter.discoverModels(apiKey);
        return models.map((m) => ({ id: m.id, name: m.name }));
      },
    },
  };
}

/* ── credential management ──────────────────────────────────────────── */

export function storeCredential(providerId: string, apiKey: string): { fingerprint: string } {
  return credentialStore.storeKey(providerId, apiKey);
}

export function getCredential(providerId: string): { fingerprint: string; createdAt: string; lastValidated: string | null } | null {
  const f = credentialStore.getFingerprint(providerId);
  if (!f) return null;
  return { fingerprint: f, createdAt: '', lastValidated: null };
}

export function removeCredential(providerId: string): void {
  credentialStore.removeKey(providerId);
}

export function getFingerprint(providerId: string): string | null {
  return credentialStore.getFingerprint(providerId);
}

export function isProviderConnected(providerId: string): boolean {
  return credentialStore.isConnected(providerId);
}

export function getConnectedProviders(): ConnectedProvider[] {
  const stores = credentialStore.getAllProviderStores();
  const activeInfo = credentialStore.getActive();
  return stores.map((s) => {
    const adapter = getAdapter(s.id);
    return {
      id: s.id,
      name: adapter ? adapter.metadata.name : s.id,
      fingerprint: s.fingerprint,
      models: s.models ?? [],
      health: s.health,
      active: s.id === activeInfo.providerId,
    };
  });
}

/* ── RuntimeManager ─────────────────────────────────────────────────── */

/**
 * RuntimeManager — BYOAK-only. There is NO built-in default runtime.
 * The hub has no AI until the user connects their own provider with an
 * API key. `runtime` is null until a provider is activated.
 */
export class RuntimeManager {
  private active: ActiveRuntime | null = null;

  constructor() {
    // Restore the previously-active provider if its key is still stored.
    const saved = credentialStore.getActive();
    if (saved.providerId) {
      try { this.switchToProvider(saved.providerId, saved.model || undefined); }
      catch { this.active = null; }
    }
  }

  get runtime(): Runtime | null { return this.active?.runtime ?? null; }
  get hasRuntime(): boolean { return this.active !== null; }
  get providerType(): 'byoak' | 'none' { return this.active ? 'byoak' : 'none'; }

  get providerLabel(): string {
    if (!this.active) return 'Not connected';
    const adapter = getAdapter(this.active.providerId);
    return adapter ? adapter.metadata.name : this.active.providerId;
  }

  getProviderId(): string | null {
    return this.active?.providerId ?? null;
  }

  getModel(): string {
    return this.active?.model ?? '';
  }

  /** Activate a connected provider. Fails (returns false) without a key. */
  switchToProvider(providerId: string, model?: string): boolean {
    const adapter = getAdapter(providerId);
    if (!adapter) return false;
    const apiKey = credentialStore.getKey(providerId);
    if (!apiKey) return false;
    this.active = {
      type: 'byoak',
      providerId,
      runtime: adapter.createRuntime(apiKey, model),
      model: model ?? '',
    };
    credentialStore.setActive(providerId, model);
    return true;
  }

  /** Turn off the active provider — the hub has no AI until one is set. */
  deactivate(): void {
    this.active = null;
    credentialStore.setActive(null);
  }

  byoakStatus(): { connected: ConnectedProvider[]; active: string | null; activeModel: string } {
    const activeInfo = credentialStore.getActive();
    return {
      connected: getConnectedProviders(),
      active: activeInfo.providerId,
      activeModel: activeInfo.model,
    };
  }
}
