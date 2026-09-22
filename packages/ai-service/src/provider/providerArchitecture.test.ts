import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAdapter, getAllAdapters, ENV_VAR_BY_PROVIDER } from './registry';
import { detectByKeyPrefix } from './detector';
import { normaliseOllamaUrl, defaultOllamaBaseUrl, OllamaAdapter } from './adapters/ollama';

/**
 * Provider architecture — SELF-HOSTED = PRIMARY, CLOUD = FALLBACK.
 *
 * AURA Hub is a self-hosted AI system. One addressed server adapter
 * (Ollama, this machine or another) is the primary inference path;
 * every key-based cloud provider lives under Fallback and can only
 * ever become active through an explicit switch — never silently,
 * never by racing, never by failing over.
 *
 * Each test maps to the correction brief's required behaviors.
 *
 * ISOLATION WARNING (do not regress this): the credential store
 * resolves its file path ONCE at module import, so setting AURA_HOME
 * in `beforeEach` alone does NOT isolate — the modules must be
 * re-imported fresh per test (see below), or the suite reads and
 * WRITES the developer's real `~/.aura/providers.json`. That exact
 * failure happened here once; the dynamic imports below are the fix.
 *
 * Run with `npm run test:service` from the repo root.
 */
let provider: typeof import('./index');
let store: typeof import('./credentialStore');

beforeEach(async () => {
  process.env.AURA_HOME = mkdtempSync(join(tmpdir(), 'aura-provider-arch-test-'));
  delete process.env.AURA_OLLAMA_BASE_URL;
  vi.resetModules();
  provider = await import('./index');
  store = await import('./credentialStore');
});

const CLOUD_IDS = ['openai', 'anthropic', 'gemini', 'openrouter', 'groq', 'nvidia', 'cerebras', 'mistral'];

describe('primary: self-hosted servers', () => {
  it('TEST 1 — the local server adapter is classified self-hosted primary', () => {
    const ollama = getAdapter('ollama');
    expect(ollama).toBeInstanceOf(OllamaAdapter);
    expect((ollama!.metadata as { selfHosted?: boolean }).selfHosted).toBe(true);
    const listed = provider.listProviders();
    expect(listed[0].id).toBe('ollama');
    expect(listed[0].selfHosted).toBe(true);
  });

  it('TEST 2 — a remote private server is the same self-hosted path, never cloud', () => {
    // Local and remote are one adapter with different addresses: there
    // is no separate "remote" provider to drift, and a college GPU box
    // is never classified as cloud AI.
    expect(normaliseOllamaUrl('http://gpu-server.example.edu:11434')).toBe('http://gpu-server.example.edu:11434');
    expect(normaliseOllamaUrl('https://ai.college.edu/ollama/v1')).toBe('https://ai.college.edu/ollama');
    expect(getAllAdapters().filter((a) => a.metadata.id === 'ollama')).toHaveLength(1);
  });

  it('TEST 8/9 — Ollama behavior unchanged: loopback default, exact addresses kept', () => {
    expect(defaultOllamaBaseUrl()).toBe('http://127.0.0.1:11434');
    expect(normaliseOllamaUrl('192.168.1.50:11434')).toBe('http://192.168.1.50:11434');
    // Deliberately empty: no cloud model may become the default, and no
    // guess may stand in for a model the user's server actually serves.
    expect(getAdapter('ollama')!.metadata.defaultModel).toBe('');
  });
});

describe('fallback: cloud providers', () => {
  it('TEST 3 — every cloud provider is classified fallback, none primary', () => {
    for (const adapter of getAllAdapters()) {
      if (adapter.metadata.id === 'ollama') continue;
      expect((adapter.metadata as { selfHosted?: boolean }).selfHosted ?? false).toBe(false);
    }
  });

  it('TEST 13 — existing cloud providers remain connectable through the fallback path', () => {
    for (const id of CLOUD_IDS) {
      const adapter = getAdapter(id);
      expect(adapter).toBeDefined();
      expect(typeof adapter!.validate).toBe('function');
      expect(typeof adapter!.discoverModels).toBe('function');
    }
  });

  it('TEST 12 — no Grok/xAI primary provider exists', () => {
    expect(getAdapter('xai')).toBeUndefined();
    expect('xai' in ENV_VAR_BY_PROVIDER).toBe(false);
    expect(Object.values(ENV_VAR_BY_PROVIDER)).not.toContain('XAI_API_KEY');
    expect(detectByKeyPrefix('xai-abc123')).toBeNull();
    expect(getAllAdapters().some((a) => /xai|grok/i.test(a.metadata.id))).toBe(false);
  });
});

describe('explicit routing: no silent takeover', () => {
  it('TEST 4 — a cloud provider cannot silently become primary', async () => {
    const manager = new provider.RuntimeManager();
    expect(manager.hasRuntime).toBe(false);
    // No stored key: the switch refuses BEFORE any network, and the
    // active pointer stays empty — there is nothing to fail over to.
    expect(await manager.switchToProvider('openai')).toBe(false);
    expect(manager.hasRuntime).toBe(false);
    expect(manager.getProviderId()).toBeNull();
    expect(store.getActive().providerId).toBeNull();
  });

  it('TEST 5 — fallback disabled + self-hosted unavailable is an honest failure', () => {
    const manager = new provider.RuntimeManager();
    expect(manager.runtime).toBeNull();
    expect(manager.providerLabel).toBe('Not connected');
    // Cloud adapters exist but none is activated by their existence.
    expect(store.getActive()).toEqual({ providerId: null, model: '' });
  });

  it('TEST 6/10 — an explicitly enabled fallback is selectable and survives restart', async () => {
    store.storeKey('groq', 'gsk_test_key_12345678');
    store.storeModels('groq', [{ id: 'llama-3.3-70b-versatile', name: 'llama-3.3-70b-versatile', capabilities: {} }]);
    store.setActive('groq', 'llama-3.3-70b-versatile');
    // A new manager is a restart: the persisted EXPLICIT choice restores
    // with cached model data and no network call.
    vi.resetModules();
    const fresh = await import('./index');
    const restarted = new fresh.RuntimeManager();
    expect(restarted.getProviderId()).toBe('groq');
    expect(restarted.getModel()).toBe('llama-3.3-70b-versatile');
    // …and switching away stays explicit too.
    restarted.deactivate();
    expect(restarted.hasRuntime).toBe(false);
    const store2 = await import('./credentialStore');
    expect(store2.getActive().providerId).toBeNull();
  });
});

describe('secret hygiene', () => {
  it('TEST 7 — no API key leaks into listings, fingerprints, or status', () => {
    const secret = 'gsk-SECRET-XYZ-12345678';
    store.storeKey('openai', secret);
    const blob = JSON.stringify({
      providers: provider.listProviders(),
      connected: provider.getConnectedProviders(),
      fingerprint: provider.getFingerprint('openai'),
      active: store.getActive(),
    });
    expect(blob).not.toContain(secret);
    const fp = provider.getFingerprint('openai');
    expect(fp).toBeTruthy();
    expect(fp).not.toBe(secret);
    expect(secret.length - (fp as string).length).toBeGreaterThan(8);
    // Functionally the key still round-trips for the runtime itself.
    expect(store.getKey('openai')).toBe(secret);
  });
});

describe('onboarding stays self-hosted-first', () => {
  it('TEST 11 — the first offered provider is self-hosted', () => {
    const listed = provider.listProviders();
    expect(listed.length).toBeGreaterThan(0);
    expect(listed[0].selfHosted).toBe(true);
    // The onboarding lookup (first self-hosted entry) always resolves.
    expect(listed.find((p) => p.selfHosted)).toBeDefined();
  });
});
