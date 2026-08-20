/**
 * OllamaAdapter — models that run on this machine, over Ollama's own API.
 * ==================================================================
 * Ollama is already in the connected-environment catalogue
 * (`catalog.ts`), so AURA could see it and could not use it. This is the
 * adapter that closes that gap.
 *
 * The credential slot holds Ollama's base URL (see `local.ts`), default
 * `http://127.0.0.1:11434`, overridable with `OLLAMA_HOST`.
 */

import type { Runtime } from '@aura/runtime';
import type { DiscoveredModel, ModelCapabilities, ProviderHealth } from '../types';
import {
  OllamaRuntime, healthFrom, isLoopbackUrl, probeLocal, resolveLocalBaseUrl,
  type LocalAdapter, type LocalProviderMetadata,
} from './local';
import { capabilitiesForLocalModel } from '../modelCatalog';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';

interface OllamaTag {
  name: string;
  model?: string;
  size?: number;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
}

export class OllamaAdapter implements LocalAdapter {
  readonly local = true as const;

  readonly metadata: LocalProviderMetadata = {
    id: 'ollama',
    name: 'Ollama',
    description: 'Local models served by Ollama on this machine. No API key, no network.',
    docsUrl: 'https://ollama.com/download',
    // Ollama has no fixed model list — whatever the user has pulled is what
    // exists. This is the model `ollama pull` puts on most machines first
    // and is only ever a fallback: `discoverModels()` reports the truth.
    defaultModel: 'llama3.2',
    defaultEndpoint: DEFAULT_ENDPOINT,
  };

  private url(value: string): string {
    return resolveLocalBaseUrl(value, DEFAULT_ENDPOINT);
  }

  /**
   * Recognise an ENDPOINT, not a key.
   *
   * Detection exists so the onboarding paste-box can route a value to the
   * right provider. A loopback URL is unambiguously a local server, and
   * refusing a non-loopback one keeps "local" meaning local.
   */
  detect(value: string): boolean {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return false;
    if (/^ollama$/i.test(trimmed)) return true;
    if (!isLoopbackUrl(this.url(trimmed))) return false;
    return /:11434(\/|$)/.test(this.url(trimmed));
  }

  async validate(value: string): Promise<{ ok: boolean; error?: string }> {
    const base = this.url(value);
    const probe = await probeLocal(`${base}/api/tags`, 'Ollama');
    if (!probe.ok) return { ok: false, error: probe.error };
    const models = await this.discoverModels(value);
    if (!models.length) {
      return {
        ok: false,
        error: `Ollama is running at ${base} but has no models installed. Run \`ollama pull llama3.2\` and connect again.`,
      };
    }
    return { ok: true };
  }

  async discoverModels(value: string): Promise<DiscoveredModel[]> {
    const base = this.url(value);
    let tags: OllamaTag[];
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return [];
      const json = await res.json() as { models?: OllamaTag[] };
      tags = json.models ?? [];
    } catch { return []; }

    /* The context window is the one number the router's context gate
       cannot do without, and Ollama knows it exactly: `/api/show` returns
       the model file's own `<arch>.context_length`. Asked per model, in
       parallel, and a model that will not answer simply has no window
       recorded rather than an invented one. */
    return Promise.all(tags.map(async (m): Promise<DiscoveredModel> => {
      const capabilities: ModelCapabilities = capabilitiesForLocalModel(m.name, m.details?.parameter_size);
      const shown = await this.showModel(base, m.name);
      if (shown.contextWindow) capabilities.contextWindow = shown.contextWindow;
      if (shown.toolCalling !== undefined) capabilities.toolCalling = shown.toolCalling;
      if (shown.vision !== undefined) capabilities.vision = shown.vision;
      return { id: m.name, name: m.name, capabilities };
    }));
  }

  /**
   * `POST /api/show` — the model file's own facts.
   *
   * `model_info` is keyed by architecture (`llama.context_length`,
   * `qwen2.context_length`, …), so the key is found by suffix rather than
   * assumed. Newer Ollama also returns a `capabilities` array naming
   * `tools` and `vision`, which beats guessing from the model name.
   */
  private async showModel(base: string, name: string): Promise<{ contextWindow?: number; toolCalling?: boolean; vision?: boolean }> {
    try {
      const res = await fetch(`${base}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: name }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return {};
      const json = await res.json() as { model_info?: Record<string, unknown>; capabilities?: string[] };
      const info = json.model_info ?? {};
      let contextWindow: number | undefined;
      for (const [key, raw] of Object.entries(info)) {
        if (!key.endsWith('.context_length')) continue;
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (Number.isSafeInteger(n) && n > 0) { contextWindow = n; break; }
      }
      const caps = Array.isArray(json.capabilities) ? json.capabilities : null;
      return {
        contextWindow,
        toolCalling: caps ? caps.includes('tools') : undefined,
        vision: caps ? caps.includes('vision') : undefined,
      };
    } catch { return {}; }
  }

  createRuntime(value: string, model?: string): Runtime {
    return new OllamaRuntime(this.url(value), model || this.metadata.defaultModel);
  }

  async checkHealth(value: string): Promise<ProviderHealth> {
    return healthFrom(await probeLocal(`${this.url(value)}/api/tags`, 'Ollama'));
  }

  async probeDefault(): Promise<{ ok: boolean; endpoint: string; models: DiscoveredModel[]; error?: string }> {
    const endpoint = process.env.OLLAMA_HOST?.trim() ? this.url(process.env.OLLAMA_HOST) : DEFAULT_ENDPOINT;
    const probe = await probeLocal(`${endpoint}/api/tags`, 'Ollama', 2000);
    if (!probe.ok) return { ok: false, endpoint, models: [], error: probe.error };
    const models = await this.discoverModels(endpoint);
    return { ok: models.length > 0, endpoint, models, error: models.length ? undefined : 'Ollama is running but has no models installed.' };
  }
}
