import { BaseOpenAICompatible } from './base';
import type { Runtime } from '@aura/runtime';

/**
 * ScaleMax — OpenAI-compatible gateway, consumed as a normal BYOAK provider.
 * ==================================================================
 * ScaleMax exposes two billing surfaces on the same host with the same
 * OpenAI-compatible protocol (`GET /models`, `POST /chat/completions`
 * with Bearer auth — verified against ScaleMax's own docs at
 * https://scalemax.pro/api and https://docs.scalemax.pro/docs):
 *
 *   • Token budget (default here): `https://api.scalemax.pro/token/v1`
 *   • API credit:                  `https://api.scalemax.pro/v1`
 *
 * The two surfaces deliberately reject each other's keys, so the base URL
 * is configuration (`SCALEMAX_BASE_URL`), not a second adapter. The
 * default is the token-budget surface — the URL this connector was added
 * for — overridable without touching code for credit keys.
 *
 * Model availability is key-scoped (a Claude-only token key does not open
 * OpenAI-family models and vice versa), so no model id is hardcoded:
 * whatever the key's authenticated `/models` catalog lists is what AURA
 * offers. `resolveModel()` already falls back to the first discovered
 * model, which is the honest answer — the same choice Kage7 makes.
 */
const DEFAULT_BASE_URL = 'https://api.scalemax.pro/token/v1';

/** The configured ScaleMax base URL, without a trailing slash. */
export function scalemaxBaseUrl(): string {
  const raw = (process.env.SCALEMAX_BASE_URL ?? '').trim().replace(/\/+$/, '');
  return raw || DEFAULT_BASE_URL;
}

export class ScaleMaxAdapter extends BaseOpenAICompatible {
  readonly metadata = {
    id: 'scalemax',
    name: 'ScaleMax',
    description: 'OpenAI-compatible gateway — token-budget and credit keys',
    docsUrl: 'https://dashboard.scalemax.pro/dashboard',
    /**
     * Intentionally empty. The catalog is scoped per key (Claude-only,
     * OpenAI-only, Gemini/Grok/Qwen, or exact-model entitlements), so
     * naming one here would be a guess that fails for most keys.
     * `resolveModel()` falls back to the first discovered model.
     */
    defaultModel: '',
  };

  /**
   * Resolved per access rather than captured once, so changing
   * `SCALEMAX_BASE_URL` and reconnecting points at the new surface
   * without a restart. The base class reads this for validate,
   * discovery and health.
   */
  protected get baseUrl(): string {
    return scalemaxBaseUrl();
  }

  detect(apiKey: string): boolean {
    // ScaleMax issues `sm_live_…` keys (see the quick-start examples).
    // Prefix match is a hint only — validation against `/models` decides.
    return apiKey.startsWith('sm_');
  }

  createRuntime(apiKey: string, model?: string): Runtime {
    return this.makeRuntime({ baseUrl: this.baseUrl, apiKey, defaultModel: model || this.metadata.defaultModel });
  }
}
