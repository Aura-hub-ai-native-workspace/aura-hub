/**
 * LMStudioAdapter — local models over LM Studio's OpenAI-compatible API.
 * ==================================================================
 * LM Studio serves `/v1/models` and `/v1/chat/completions` exactly as
 * OpenAI does, so the adapter is `BaseOpenAICompatible` with a different
 * base URL and no key — which is why it is short, and why keeping it
 * short matters: there is one OpenAI-compatible client in this repo and
 * this reuses it rather than growing a second.
 *
 * The credential slot holds the base URL (see `local.ts`), default
 * `http://127.0.0.1:1234/v1`, overridable with `LMSTUDIO_BASE_URL`.
 */

import type { Runtime } from '@aura/runtime';
import { BaseOpenAICompatible } from './base';
import type { DiscoveredModel, ProviderHealth } from '../types';
import {
  healthFrom, isLoopbackUrl, probeLocal, resolveLocalBaseUrl,
  type LocalAdapter, type LocalProviderMetadata,
} from './local';
import { capabilitiesForLocalModel } from '../modelCatalog';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:1234/v1';

export class LMStudioAdapter extends BaseOpenAICompatible implements LocalAdapter {
  readonly local = true as const;

  readonly metadata: LocalProviderMetadata = {
    id: 'lmstudio',
    name: 'LM Studio',
    description: 'Local models served by LM Studio on this machine. No API key, no network.',
    docsUrl: 'https://lmstudio.ai/docs/local-server',
    // LM Studio serves whatever the user has loaded; `discoverModels()` is
    // the authority. This literal only names the shape of an id.
    defaultModel: 'local-model',
    defaultEndpoint: DEFAULT_ENDPOINT,
  };

  /** Required by the base class; the per-call URL below is what is used. */
  protected baseUrl = DEFAULT_ENDPOINT;

  private url(value: string): string {
    const resolved = resolveLocalBaseUrl(value, DEFAULT_ENDPOINT);
    // LM Studio's OpenAI surface lives under /v1. A user who pastes the
    // bare host:port means the server, not a different API root.
    return /\/v\d+$/.test(resolved) ? resolved : `${resolved}/v1`;
  }

  detect(value: string): boolean {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return false;
    if (/^lm ?studio$/i.test(trimmed)) return true;
    const resolved = this.url(trimmed);
    return isLoopbackUrl(resolved) && /:1234\//.test(resolved);
  }

  async validate(value: string): Promise<{ ok: boolean; error?: string }> {
    const base = this.url(value);
    const probe = await probeLocal(`${base}/models`, 'LM Studio');
    if (!probe.ok) return { ok: false, error: probe.error };
    const models = await this.discoverModels(value);
    if (!models.length) {
      return {
        ok: false,
        error: `LM Studio is running at ${base} but has no model loaded. Load a model in LM Studio's Developer tab and connect again.`,
      };
    }
    return { ok: true };
  }

  async discoverModels(value: string): Promise<DiscoveredModel[]> {
    const base = this.url(value);
    /* LM Studio's own REST surface (`/api/v0/models`, a sibling of the
       OpenAI one) reports `max_context_length` and whether the model is
       currently loaded. That is the real context window, from the server
       that will run the model — so it is preferred, and the OpenAI list
       is the fallback for older builds that do not serve it. */
    const native = await this.nativeModels(base);
    if (native.length) return native;
    try {
      const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return [];
      const json = await res.json() as { data?: { id: string }[] };
      return (json.data ?? []).map((m): DiscoveredModel => ({
        id: m.id,
        name: m.id,
        capabilities: capabilitiesForLocalModel(m.id),
      }));
    } catch { return []; }
  }

  private async nativeModels(base: string): Promise<DiscoveredModel[]> {
    const root = base.replace(/\/v\d+$/, '');
    try {
      const res = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return [];
      const json = await res.json() as {
        data?: { id: string; type?: string; max_context_length?: number; loaded_context_length?: number }[];
      };
      return (json.data ?? [])
        // Embedding models are not chat models; offering one as a chat
        // target produces a confusing failure at generate time.
        .filter((m) => m.type !== 'embeddings')
        .map((m): DiscoveredModel => {
          const capabilities = capabilitiesForLocalModel(m.id);
          const window = m.loaded_context_length ?? m.max_context_length;
          if (typeof window === 'number' && window > 0) capabilities.contextWindow = window;
          return { id: m.id, name: m.id, capabilities };
        });
    } catch { return []; }
  }

  createRuntime(value: string, model?: string): Runtime {
    /* No key: LM Studio ignores the Authorization header, and sending a
       placeholder is honest about there being no secret to send. */
    return this.makeRuntime({ baseUrl: this.url(value), apiKey: 'lm-studio', defaultModel: model || this.metadata.defaultModel });
  }

  async checkHealth(value: string): Promise<ProviderHealth> {
    return healthFrom(await probeLocal(`${this.url(value)}/models`, 'LM Studio'));
  }

  async probeDefault(): Promise<{ ok: boolean; endpoint: string; models: DiscoveredModel[]; error?: string }> {
    const endpoint = process.env.LMSTUDIO_BASE_URL?.trim() ? this.url(process.env.LMSTUDIO_BASE_URL) : DEFAULT_ENDPOINT;
    const probe = await probeLocal(`${endpoint}/models`, 'LM Studio', 2000);
    if (!probe.ok) return { ok: false, endpoint, models: [], error: probe.error };
    const models = await this.discoverModels(endpoint);
    return { ok: models.length > 0, endpoint, models, error: models.length ? undefined : 'LM Studio is running but has no model loaded.' };
  }
}
