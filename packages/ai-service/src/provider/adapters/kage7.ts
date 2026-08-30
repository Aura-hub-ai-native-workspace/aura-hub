/**
 * Kage7 — an OpenAI-compatible gateway, consumed as a normal BYOAK provider.
 * ==================================================================
 * Kage7 is a *provider*, nothing more: it is not an execution node, not a
 * Fabric capability, not a Workspace node. It therefore rides the existing
 * provider abstraction end to end — `BaseOpenAICompatible` already speaks
 * `GET {baseUrl}/models` with a Bearer key and owns the
 * `/chat/completions` transport (streaming, usage, cancellation,
 * timeouts), so nothing about requests or responses is reimplemented here.
 *
 * Only two things genuinely differ from the other gateways in this folder,
 * and both are properties of Kage7 rather than of AURA:
 *
 *   1. **The endpoint is deployment-specific.** Every other adapter points
 *      at one vendor URL that is the same for all users. A Kage7 gateway is
 *      something an operator deploys, so the URL is configuration
 *      (`KAGE7_BASE_URL`), not a constant. The default below is a
 *      convenience for the current deployment, overridable without
 *      touching code.
 *
 *   2. **Its `/v1/models` payload is not strictly OpenAI-shaped.** The base
 *      class reads `{ data: [...] }` and takes the id as the name. Kage7
 *      gateways may answer `{ data }`, `{ models }` or a bare array, with
 *      entries that are objects *or* plain strings, and they advertise real
 *      context/output limits. Those limits are worth keeping, so discovery
 *      is widened — see `parseModels`.
 *
 * No model id is hardcoded anywhere in this file. Whatever the gateway
 * lists is what AURA offers; add or remove a model there and AURA follows
 * on the next discovery.
 */

import { BaseOpenAICompatible } from './base';
import type { Runtime } from '@aura/runtime';
import type { DiscoveredModel, ModelCapabilities, ProviderHealth } from '../types';

/**
 * The gateway used when nothing is configured.
 *
 * Deliberately a default and not a constant of the architecture: a Kage7
 * gateway is deployed per operator, so `KAGE7_BASE_URL` overrides this and
 * no other layer of AURA knows this string exists.
 */
const DEFAULT_GATEWAY = 'https://group-74221.up.railway.app';

/**
 * Limits assumed only when the gateway does not advertise its own. They
 * are a display fallback, never a claim about a specific model — the
 * gateway's numbers always win when present.
 */
const FALLBACK_CONTEXT = 200_000;
const FALLBACK_OUTPUT = 65_536;

/**
 * Reduce a user-supplied gateway URL to its origin.
 *
 * People paste the thing they were given, which is as often
 * `https://host/v1/` as `https://host`. Appending `/v1` to the former
 * would produce `/v1/v1/models` and a 404 that looks like a broken
 * deployment rather than a typo, so the suffix is stripped first.
 */
export function normalizeGatewayUrl(url: string): string {
  const trimmed = (url ?? '').trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3).replace(/\/+$/, '') : trimmed;
}

/** The configured gateway origin, without the `/v1` suffix. */
export function kage7Gateway(): string {
  return normalizeGatewayUrl(process.env.KAGE7_BASE_URL?.trim() || DEFAULT_GATEWAY);
}

/** A raw entry from a gateway's model list, in any of the shapes seen. */
type RawModel = string | {
  id?: string;
  model?: string;
  context_length?: number;
  max_context?: number;
  max_output?: number;
  max_output_tokens?: number;
};

/**
 * Turn a `/v1/models` body into models AURA can offer.
 *
 * Exported so the verification script can drive every payload shape
 * without a network round trip — the parsing rules are the part most
 * likely to drift as gateways change, so they are testable on their own.
 */
export function parseModels(body: unknown): DiscoveredModel[] {
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

    const meta = typeof entry === 'string' ? undefined : entry;
    const capabilities: ModelCapabilities = {
      contextWindow: meta?.context_length ?? meta?.max_context ?? FALLBACK_CONTEXT,
      maxOutput: meta?.max_output ?? meta?.max_output_tokens ?? FALLBACK_OUTPUT,
      streaming: true,
    };
    out.push({ id, name: displayName(id), capabilities });
  }
  return out;
}

/** `glm-5.2` → `Glm 5.2`. Cosmetic only; the id stays authoritative. */
function displayName(id: string): string {
  return id
    .replace(/[-_]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export class Kage7Adapter extends BaseOpenAICompatible {
  readonly metadata = {
    id: 'kage7',
    name: 'Kage7',
    description: 'Kage7 gateway — OpenAI-compatible, models discovered from the deployment',
    docsUrl: 'https://github.com/Aura-hub-ai-native-workspace/aura-hub',
    /**
     * Intentionally empty. Every other adapter names a model it knows the
     * vendor ships; a Kage7 gateway's catalogue is whatever its operator
     * deployed, so naming one here would be a guess that outlives the
     * deployment. `resolveModel()` already falls back to the first
     * discovered model, which is the honest answer.
     */
    defaultModel: '',
  };

  /**
   * Resolved per access rather than captured once, so changing
   * `KAGE7_BASE_URL` and reconnecting points at the new gateway without a
   * restart. The base class reads this for validate, discovery and health.
   */
  protected get baseUrl(): string {
    return `${kage7Gateway()}/v1`;
  }

  detect(_apiKey: string): boolean {
    // Key prefixes are a convenience for pasting a key into a generic box.
    // Kage7 keys are issued per deployment, so there is no shape to match
    // that would not also swallow another provider's key.
    return false;
  }

  async discoverModels(apiKey: string): Promise<DiscoveredModel[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return [];
      return parseModels(await res.json());
    } catch {
      return [];
    }
  }

  /**
   * Health, with the failure actually named.
   *
   * The base class reports a boolean and an HTTP string, which cannot tell
   * "your key is wrong" from "the gateway is down" from "the gateway
   * answered but offers nothing." Those need different actions from the
   * user, so they are distinguished here — and an authenticated list that
   * comes back empty is NOT reported as connected, because a provider with
   * no models cannot answer a single request.
   */
  async checkHealth(apiKey: string): Promise<ProviderHealth> {
    const start = performance.now();
    const at = () => ({ latencyMs: Math.round(performance.now() - start), lastChecked: new Date().toISOString() });
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, state: 'unauthorized', error: `Kage7 rejected this API key (${res.status})`, ...at() };
      }
      if (!res.ok) {
        return { ok: false, state: 'error', error: `Kage7 gateway returned HTTP ${res.status}`, ...at() };
      }
      const models = parseModels(await res.json());
      if (models.length === 0) {
        return { ok: false, state: 'no-models', error: 'Kage7 authenticated but published no models — check this key\'s permissions.', ...at() };
      }
      return { ok: true, state: 'connected', ...at() };
    } catch (e) {
      return {
        ok: false,
        state: 'unreachable',
        error: `Could not reach the Kage7 gateway at ${kage7Gateway()} (${(e as Error).message})`,
        ...at(),
      };
    }
  }

  createRuntime(apiKey: string, model?: string): Runtime {
    return this.makeRuntime({ baseUrl: this.baseUrl, apiKey, defaultModel: model || this.metadata.defaultModel });
  }
}
