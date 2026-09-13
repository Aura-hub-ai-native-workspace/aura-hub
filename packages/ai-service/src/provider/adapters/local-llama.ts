/**
 * Local LLaMA — a self-hosted llama-server consumed as a normal BYOAK provider.
 * ==================================================================
 * A llama-server is a *provider*, nothing more: it is not an execution
 * node, not a Fabric capability, not a Workspace node. It therefore rides
 * the existing provider abstraction end to end — `BaseOpenAICompatible`
 * already speaks `GET {baseUrl}/models` with a Bearer key and owns the
 * `/chat/completions` transport (streaming, usage, cancellation,
 * timeouts), so nothing about requests or responses is reimplemented here.
 *
 * Only two things genuinely differ from the cloud gateways in this folder,
 * and both are properties of a self-hosted deployment rather than of AURA:
 *
 *   1. **The endpoint is deployment-specific.** Every other adapter points
 *      at one vendor URL that is the same for all users. A llama-server
 *      runs on the operator's own machine (e.g. an NVIDIA L40S box on the
 *      private network), so the URL is configuration
 *      (`AURA_LOCAL_LLM_BASE_URL`), not a constant. The default below is a
 *      loopback convenience, overridable without touching code. No server
 *      address, model name, credential or key is hardcoded anywhere here.
 *
 *   2. **Authentication is optional.** A llama-server may or may not
 *      require an API key. When no key is configured the adapter sends no
 *      `Authorization` header at all (rather than an empty `Bearer `, which
 *      some servers reject); when one is configured it is sent as a Bearer
 *      token through the existing encrypted credential store. See
 *      `authOptional` below and `omitEmptyAuth` in `./base`.
 *
 * Model capabilities are deliberately conservative: llama-server advertises
 * no capability metadata, so discovery reports `streaming: true` only.
 * Capability fields are left unknown rather than inferred from model-name
 * keywords.
 *
 * No model id is hardcoded anywhere in this file. Whatever the server
 * lists via `/v1/models` is what AURA offers; load or unload a model there
 * and AURA follows on the next discovery.
 */

import { BaseOpenAICompatible } from './base';
import type { Runtime } from '@aura/runtime';
import type { DiscoveredModel, ModelCapabilities, ProviderHealth } from '../types';

/**
 * The endpoint used when nothing is configured.
 *
 * Deliberately a loopback default and not a constant of the architecture:
 * a llama-server is deployed per operator, so `AURA_LOCAL_LLM_BASE_URL`
 * overrides this and no other layer of AURA knows this string exists.
 * Never a college, cloud or otherwise real deployment address.
 */
export const DEFAULT_LOCAL_LLAMA_ORIGIN = 'http://127.0.0.1:8080';

/** Result of validating a user- or env-supplied llama-server URL. */
export type LocalLlamaUrl =
  | { ok: true; origin: string }
  | { ok: false; error: string };

/**
 * Reduce a user-supplied llama-server URL to its origin.
 *
 * People paste the thing they were given, which is as often
 * `http://host:8080/v1/` as `http://host:8080`. Appending `/v1` to the
 * former would produce `/v1/v1/models` and a 404 that looks like a broken
 * deployment rather than a typo, so the suffix is stripped first.
 *
 * Rejects anything that is not an `http(s)` origin without embedded
 * credentials: a base URL is configuration, never a place to smuggle a
 * second credential, and non-HTTP schemes can never serve the
 * OpenAI-compatible API this adapter speaks.
 *
 * Exported so the verification script can drive every shape without a
 * network round trip — URL handling is the part most likely to meet a
 * creative paste, so it is testable on its own.
 */
export function normalizeLocalLlamaUrl(raw: string): LocalLlamaUrl {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return { ok: false, error: 'A server URL is required — set AURA_LOCAL_LLM_BASE_URL or configure the Local LLaMA endpoint.' };
  // An authority (host) must be present: `http:///path` parses without
  // throwing in WHATWG URL but addresses nothing.
  if (!/^https?:\/\/[^/]+/i.test(trimmed)) {
    return { ok: false, error: `Not a valid server URL: "${trimmed.slice(0, 80)}"` };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: `Not a valid URL: "${trimmed.slice(0, 80)}"` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Only http(s) endpoints are supported (got "${parsed.protocol}//…").` };
  }
  if (!parsed.hostname) return { ok: false, error: 'The server URL must include a host.' };
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'The server URL must not embed credentials — configure the API key separately.' };
  }
  const withoutV1 = trimmed.endsWith('/v1') ? trimmed.slice(0, -3).replace(/\/+$/, '') : trimmed;
  return { ok: true, origin: withoutV1 };
}

/**
 * The configured llama-server origin, without the `/v1` suffix.
 *
 * Read per access rather than captured once, so changing
 * `AURA_LOCAL_LLM_BASE_URL` and reconnecting points at the new server
 * without a restart. Falls back to the loopback default when unset; when
 * set-but-invalid the adapter reports the configuration error instead of
 * silently talking to the wrong endpoint (see `localLlamaConfigError`).
 */
export function localLlamaOrigin(): string {
  const raw = (process.env.AURA_LOCAL_LLM_BASE_URL ?? '').trim();
  if (!raw) return DEFAULT_LOCAL_LLAMA_ORIGIN;
  const parsed = normalizeLocalLlamaUrl(raw);
  return parsed.ok ? parsed.origin : DEFAULT_LOCAL_LLAMA_ORIGIN;
}

/**
 * The configuration error to surface when `AURA_LOCAL_LLM_BASE_URL` is set
 * but invalid, or null when the configuration is usable. Checked before any
 * network call so a typo fails deterministically instead of producing a
 * misleading "unreachable" against the fallback endpoint.
 */
export function localLlamaConfigError(): string | null {
  const raw = (process.env.AURA_LOCAL_LLM_BASE_URL ?? '').trim();
  if (!raw) return null;
  const parsed = normalizeLocalLlamaUrl(raw);
  return parsed.ok ? null : parsed.error;
}

/** A raw entry from a llama-server model list, in any of the shapes seen. */
type RawModel = string | { id?: string; model?: string };

/**
 * Turn a `/v1/models` body into models AURA can offer.
 *
 * Exported so the verification script can drive every payload shape
 * without a network round trip — the parsing rules are the part most
 * likely to drift as servers change, so they are testable on their own.
 * Capabilities stay conservative: streaming is what the shared runtime
 * implements for every model, and nothing else is claimed.
 */
export function parseLocalLlamaModels(body: unknown): DiscoveredModel[] {
  const raw: RawModel[] = Array.isArray(body)
    ? body as RawModel[]
    : ((body as { data?: RawModel[]; models?: RawModel[] })?.data
      ?? (body as { models?: RawModel[] })?.models
      ?? []);
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const out: DiscoveredModel[] = [];
  for (const entry of raw) {
    const id = typeof entry === 'string' ? entry : (entry?.id ?? entry?.model ?? '');
    // A nameless entry is not a model; skipping beats offering a blank one
    // the user could select and never get a response from.
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const capabilities: ModelCapabilities = { streaming: true };
    out.push({ id, name: id, capabilities });
  }
  return out;
}

export class LocalLlamaAdapter extends BaseOpenAICompatible {
  readonly metadata = {
    id: 'local-llama',
    name: 'Local LLaMA',
    description: 'Self-hosted llama-server via OpenAI-compatible API',
    docsUrl: 'https://github.com/llama.cpp/llama.cpp',
    defaultModel: 'qwen-3.5-27b-instruct',
  };

  /**
   * This endpoint genuinely works without a key: llama-servers are commonly
   * deployed with no authentication on a trusted network. The shared
   * connect/switch paths therefore accept a stored empty key for this
   * provider — and only via this generic flag, never a provider-id branch.
   */
  readonly authOptional = true;

  /**
   * Resolved per access rather than captured once, so changing
   * `AURA_LOCAL_LLM_BASE_URL` and reconnecting points at the new server
   * without a restart. The base class reads this for validate, discovery
   * and health; `createRuntime` passes it explicitly.
   */
  protected get baseUrl(): string {
    return `${localLlamaOrigin()}/v1`;
  }

  detect(_apiKey: string): boolean {
    // Key prefixes are a convenience for pasting a key into a generic box.
    // A llama-server key (when one exists at all) has no distinctive shape,
    // so there is nothing to match that would not also swallow another
    // provider's key. The user picks Local LLaMA explicitly.
    return false;
  }

  private authHeaders(apiKey: string): Record<string, string> {
    // No `Authorization` header at all when no key is configured: an empty
    // `Bearer ` value is rejected by some servers and would turn a working
    // keyless deployment into a 401.
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    return headers;
  }

  async validate(apiKey: string): Promise<{ ok: boolean; error?: string }> {
    const configError = localLlamaConfigError();
    if (configError) return { ok: false, error: configError };
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.authHeaders(apiKey),
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: apiKey ? `Invalid API key (${res.status})` : `This server requires an API key (${res.status})` };
      }
      if (res.status === 429) return { ok: false, error: 'Rate limited (429)' };
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      let models: DiscoveredModel[] = [];
      try {
        models = parseLocalLlamaModels(await res.json());
      } catch {
        return { ok: false, error: 'The server answered but its /v1/models response was not valid JSON.' };
      }
      // A server with no loaded model cannot answer a single request, so a
      // bare 200 is not "connected". This also keeps generic key-paste
      // detection honest: an empty catalogue never claims a foreign key.
      if (models.length === 0) return { ok: false, error: 'The server answered but published no models — load a model in llama-server first.' };
      return { ok: true };
    } catch (e) {
      const err = e as Error;
      if (err?.name === 'TimeoutError') return { ok: false, error: `The request to the local llama-server timed out (${localLlamaOrigin()}).` };
      return { ok: false, error: `Network error — could not reach the local llama-server at ${localLlamaOrigin()} (${err?.message ?? 'unknown error'})` };
    }
  }

  async discoverModels(apiKey: string): Promise<DiscoveredModel[]> {
    if (localLlamaConfigError()) return [];
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.authHeaders(apiKey),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return [];
      try {
        return parseLocalLlamaModels(await res.json());
      } catch {
        return [];
      }
    } catch { return []; }
  }

  /**
   * Health, with the failure actually named.
   *
   * The base class reports a boolean and an HTTP string, which cannot tell
   * "no key configured" from "the server is down" from "the server
   * answered but offers nothing." Those need different actions from the
   * user, so they are distinguished here — and an authenticated list that
   * comes back empty is NOT reported as connected, because a provider with
   * no models cannot answer a single request.
   */
  async checkHealth(apiKey: string): Promise<ProviderHealth> {
    const start = performance.now();
    const at = () => ({ latencyMs: Math.round(performance.now() - start), lastChecked: new Date().toISOString() });
    const configError = localLlamaConfigError();
    if (configError) return { ok: false, state: 'error', error: configError, ...at() };
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.authHeaders(apiKey),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          state: 'unauthorized',
          error: apiKey ? `The local llama-server rejected this API key (${res.status})` : `The local llama-server requires an API key (${res.status}) — configure one or disable authentication server-side.`,
          ...at(),
        };
      }
      if (!res.ok) {
        return { ok: false, state: 'error', error: `The local llama-server returned HTTP ${res.status}`, ...at() };
      }
      let models: DiscoveredModel[];
      try {
        models = parseLocalLlamaModels(await res.json());
      } catch {
        return { ok: false, state: 'error', error: 'The local llama-server answered but its /v1/models response was not valid JSON.', ...at() };
      }
      if (models.length === 0) {
        return { ok: false, state: 'no-models', error: 'The local llama-server answered but published no models — load a model in llama-server first.', ...at() };
      }
      return { ok: true, state: 'connected', ...at() };
    } catch (e) {
      const err = e as Error;
      if (err?.name === 'TimeoutError') {
        return { ok: false, state: 'unreachable', error: `The request to the local llama-server timed out (${localLlamaOrigin()}).`, ...at() };
      }
      return {
        ok: false,
        state: 'unreachable',
        error: `Could not reach the local llama-server at ${localLlamaOrigin()} (${err?.message ?? 'unknown error'})`,
        ...at(),
      };
    }
  }

  createRuntime(apiKey: string, model?: string): Runtime {
    // omitEmptyAuth: with no key configured the runtime sends no
    // Authorization header at all (see ./base), matching validate /
    // discovery / health above.
    return this.makeRuntime({ baseUrl: this.baseUrl, apiKey, defaultModel: model || this.metadata.defaultModel, omitEmptyAuth: true });
  }
}
