/**
 * Which model becomes active — on connect, reconnect and repair.
 *
 * Regression pinned here: `connectProvider` / `connectVerifiedProvider`
 * activated `models[0]`, i.e. whatever the vendor's `/models` catalog
 * happened to list first. Because `resolveModel` honours a request that
 * is in the list, that pre-empted the adapter's declared default every
 * time — a gateway listing hundreds of checkpoints decided the user's
 * model by catalog order.
 *
 * Offline: `fetch` is stubbed, nothing leaves the process, and the
 * credential store lives in a throwaway AURA_HOME (see ISOLATION below).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiscoveredModel } from './types';

/**
 * ISOLATION (do not regress): the credential store resolves its file path
 * once at module import, so AURA_HOME is set first and every provider
 * module is re-imported fresh per test.
 */
let resolveModel: typeof import('./modelValidation').resolveModel;
let previousSelectionFor: typeof import('./modelValidation').previousSelectionFor;
let registry: typeof import('./registry');
let store: typeof import('./credentialStore');
let WorkspaceManager: typeof import('../workspace').WorkspaceManager;

beforeEach(async () => {
  process.env.AURA_HOME = mkdtempSync(join(tmpdir(), 'aura-model-selection-test-'));
  vi.resetModules();
  ({ resolveModel, previousSelectionFor } = await import('./modelValidation'));
  registry = await import('./registry');
  store = await import('./credentialStore');
  ({ WorkspaceManager } = await import('../workspace'));
}, 30_000);

afterEach(() => { vi.unstubAllGlobals(); });

const list = (...ids: string[]): DiscoveredModel[] => ids.map((id) => ({ id, name: id, capabilities: { streaming: true } }));

describe('resolveModel — the single selection rule', () => {
  it('configured default: chosen even when the catalog lists it last', () => {
    expect(resolveModel('openai', undefined, list('o1-mini', 'gpt-3.5-turbo', 'gpt-4o'))).toBe('gpt-4o');
  });

  it('unordered catalog: every ordering of the same catalog resolves to the same model', () => {
    const ids = ['o1-mini', 'gpt-4o', 'gpt-3.5-turbo', 'gpt-4.1'];
    const orders = [ids, [...ids].reverse(), [ids[2], ids[0], ids[3], ids[1]], [ids[1], ids[3], ids[0], ids[2]]];
    for (const order of orders) expect(resolveModel('openai', undefined, list(...order))).toBe('gpt-4o');
  });

  it('existing user-selected model: kept when the provider still lists it, over the default', () => {
    expect(resolveModel('openai', 'gpt-3.5-turbo', list('gpt-4o', 'gpt-3.5-turbo'))).toBe('gpt-3.5-turbo');
  });

  it('a selection the provider no longer lists falls back to the default, never kept', () => {
    expect(resolveModel('openai', 'retired-model', list('o1-mini', 'gpt-4o'))).toBe('gpt-4o');
  });

  it('missing configured default: falls back to the first listed model', () => {
    expect(resolveModel('openai', undefined, list('o1-mini', 'gpt-4.1'))).toBe('o1-mini');
    expect(resolveModel('openai', 'retired-model', list('o1-mini', 'gpt-4.1'))).toBe('o1-mini');
  });

  it('provider without an explicit default: first listed model, request still honoured', () => {
    expect(registry.getAdapter('scalemax')!.metadata.defaultModel).toBe('');
    expect(resolveModel('scalemax', undefined, list('claude-x', 'gpt-y'))).toBe('claude-x');
    expect(resolveModel('scalemax', 'gpt-y', list('claude-x', 'gpt-y'))).toBe('gpt-y');
    expect(resolveModel('scalemax', 'nope', list('claude-x', 'gpt-y'))).toBe('claude-x');
  });

  it('empty catalog: no grounds to reject a selection; else declared default; else empty', () => {
    expect(resolveModel('openai', undefined, [])).toBe('gpt-4o');
    expect(resolveModel('openai', 'gpt-3.5-turbo', [])).toBe('gpt-3.5-turbo');
    expect(resolveModel('scalemax', undefined, [])).toBe('');
    expect(resolveModel('scalemax', 'gpt-y', [])).toBe('gpt-y');
  });

  it('unknown provider id: never throws, still picks from the list', () => {
    expect(resolveModel('no-such-provider', undefined, list('a', 'b'))).toBe('a');
    expect(resolveModel('no-such-provider', undefined, [])).toBe('');
  });

  it('for every registered provider, a non-empty catalog always yields one of its ids', () => {
    for (const adapter of registry.getAllAdapters()) {
      const id = adapter.metadata.id;
      const catalogs = [
        list('zzz-first', 'mmm-second'),
        list('zzz-first', ...(adapter.metadata.defaultModel ? [adapter.metadata.defaultModel] : []), 'aaa-last'),
      ];
      for (const catalog of catalogs) {
        for (const requested of [undefined, 'not-listed', 'mmm-second']) {
          const chosen = resolveModel(id, requested, catalog);
          expect(catalog.map((m) => m.id), `${id} requested=${requested}`).toContain(chosen);
        }
      }
    }
  });
});

describe('previousSelectionFor', () => {
  it('returns the active model only for the active provider', () => {
    expect(previousSelectionFor('openai')).toBeUndefined();
    store.storeKey('openai', 'sk-test-not-real');
    store.setActive('openai', 'gpt-3.5-turbo');
    expect(previousSelectionFor('openai')).toBe('gpt-3.5-turbo');
    expect(previousSelectionFor('mistral')).toBeUndefined();
  });
});

/** Stub every provider HTTP call: `/models` serves `catalog`, nothing else exists. */
function stubCatalog(catalog: () => string[]): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: catalog().map((id) => ({ id })) }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }));
  return urls;
}

describe('connectProvider — the activated model', () => {
  it('activates the declared default, not the first catalog entry (the regression)', async () => {
    const urls = stubCatalog(() => ['o1-mini', 'gpt-3.5-turbo', 'gpt-4o']);
    const manager = new WorkspaceManager({});
    const r = await manager.connectProvider('openai', 'sk-test-not-real');
    expect(r.ok).toBe(true);
    expect(store.getActive()).toEqual({ providerId: 'openai', model: 'gpt-4o' });
    expect(manager.pipeline.runtimeManager.getModel()).toBe('gpt-4o');
    // Offline proof: every request went to the stubbed vendor URL.
    expect(urls.every((u) => u.startsWith('https://api.openai.com/v1/'))).toBe(true);
  });

  it('activates the first listed model when the default is not offered', async () => {
    stubCatalog(() => ['o1-mini', 'gpt-4.1']);
    const manager = new WorkspaceManager({});
    await manager.connectProvider('openai', 'sk-test-not-real');
    expect(store.getActive()).toEqual({ providerId: 'openai', model: 'o1-mini' });
  });

  it('empty catalog: activates the declared default (nothing to validate against)', async () => {
    stubCatalog(() => []);
    const manager = new WorkspaceManager({});
    const r = await manager.connectProvider('openai', 'sk-test-not-real');
    expect(r.ok).toBe(true);
    expect(r.models).toEqual([]);
    expect(store.getActive()).toEqual({ providerId: 'openai', model: 'gpt-4o' });
  });

  it('provider without a default: activates its first listed model', async () => {
    stubCatalog(() => ['claude-x', 'gpt-y']);
    const manager = new WorkspaceManager({});
    await manager.connectProvider('scalemax', 'sm_live_test_not_real');
    expect(store.getActive()).toEqual({ providerId: 'scalemax', model: 'claude-x' });
  });

  it('reconnect (rotated key) keeps the model the user had selected', async () => {
    stubCatalog(() => ['o1-mini', 'gpt-3.5-turbo', 'gpt-4o']);
    const manager = new WorkspaceManager({});
    await manager.connectProvider('openai', 'sk-test-old');
    const sw = await manager.switchToProvider('openai', 'gpt-3.5-turbo');
    expect(sw.ok).toBe(true);
    await manager.connectProvider('openai', 'sk-test-rotated');
    expect(store.getActive()).toEqual({ providerId: 'openai', model: 'gpt-3.5-turbo' });
    expect(manager.pipeline.runtimeManager.getModel()).toBe('gpt-3.5-turbo');
  });

  it('reconnect when the selected model was retired falls back to the default', async () => {
    let catalog = ['o1-mini', 'gpt-3.5-turbo', 'gpt-4o'];
    stubCatalog(() => catalog);
    const manager = new WorkspaceManager({});
    await manager.connectProvider('openai', 'sk-test-old');
    await manager.switchToProvider('openai', 'gpt-3.5-turbo');
    catalog = ['o1-mini', 'gpt-4o'];
    await manager.connectProvider('openai', 'sk-test-rotated');
    expect(store.getActive()).toEqual({ providerId: 'openai', model: 'gpt-4o' });
  });

  it("another provider's selection never carries over", async () => {
    stubCatalog(() => ['gpt-3.5-turbo', 'gpt-4o', 'mistral-small', 'mistral-large-latest']);
    const manager = new WorkspaceManager({});
    await manager.connectProvider('openai', 'sk-test-not-real');
    await manager.switchToProvider('openai', 'gpt-3.5-turbo');
    await manager.connectProvider('mistral', 'mistral-test-not-real');
    expect(store.getActive()).toEqual({ providerId: 'mistral', model: 'mistral-large-latest' });
  });
});
