import { BaseOpenAICompatible } from './base';
import type { Runtime } from '@aura/runtime';
import type { DiscoveredModel, ProviderHealth } from '../types';

/**
 * Ollama — a model server the user runs, on hardware the user owns.
 *
 * ## Why the connect value is an address, not a key
 *
 * Every other adapter here is bring-your-own-key: the thing the user
 * supplies is a secret, and the endpoint is a constant baked into the
 * adapter. A local server inverts both halves. There is no secret — it
 * listens on loopback and asks nothing of callers — and the endpoint is
 * the only thing AURA cannot know in advance, because it is wherever the
 * user decided to run it.
 *
 * So the value that travels through the connect path IS the base URL, and
 * it is stored in the same slot a key would occupy. That slot is
 * encrypted at rest, which is harmless for a value that is not secret,
 * and it means connect, disconnect, switch, health and model discovery
 * all keep working without a second storage shape to maintain. The
 * fingerprint the UI shows becomes the address, which is more useful to a
 * user debugging a local server than four characters of a key ever were.
 *
 * ## Why not autodetect and be done
 *
 * 11434 on localhost is the common case, and it is the default offered.
 * It is not the only case: Ollama is routinely run on another machine on
 * the LAN, behind a reverse proxy, or on a non-default port because
 * something else took that one. Asking is one field, and it is the
 * difference between "works for most people" and "works".
 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

/** Accept what people actually type, and produce what the API needs. */
export function normaliseOllamaUrl(raw: string): string {
  let value = (raw || '').trim();
  if (!value) value = DEFAULT_BASE_URL;
  // A bare host or host:port is the commonest thing to paste out of a
  // terminal, and it is unambiguous here — there is no scheme-less URL a
  // model server could be reached at.
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  value = value.replace(/\/+$/, '');
  // The OpenAI-compatible surface lives under /v1, and a user reading
  // Ollama's own documentation may well paste the path with it already
  // there. Both spellings should mean the same server.
  value = value.replace(/\/v1$/i, '');
  return value;
}

export class OllamaAdapter extends BaseOpenAICompatible {
  readonly metadata = {
    id: 'ollama',
    name: 'Ollama',
    description: 'A model server you run yourself. Nothing leaves your machine.',
    docsUrl: 'https://ollama.com/download',
    // Deliberately empty: there is no model every installation has. The
    // user names one they have pulled, and `modelValidation` reads this
    // same field, so a wrong guess here would become a wrong default
    // everywhere rather than an honest "tell me which one".
    defaultModel: '',
    local: true as const,
    defaultBaseUrl: DEFAULT_BASE_URL,
  };

  /** Only a fallback; every call below resolves the address it was given. */
  protected baseUrl = `${DEFAULT_BASE_URL}/v1`;

  private api(endpoint: string): string {
    return `${normaliseOllamaUrl(endpoint)}/v1`;
  }

  /** Nothing to detect — a local address is never mistaken for a key. */
  detect(): boolean {
    return false;
  }

  async validate(endpoint: string): Promise<{ ok: boolean; error?: string }> {
    const base = normaliseOllamaUrl(endpoint);
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        return { ok: false, error: `${base} answered HTTP ${res.status}. Is that an Ollama server?` };
      }
      const body = await res.json() as { models?: unknown[] };
      if (!Array.isArray(body.models) || body.models.length === 0) {
        // Reachable and empty is a different problem from unreachable, and
        // it has a different fix — one the user can act on immediately.
        return { ok: false, error: `Ollama is running at ${base} but has no models. Pull one first, for example: ollama pull qwen2.5-coder` };
      }
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        error: `Could not reach Ollama at ${base} (${(e as Error).message}). Start it with \`ollama serve\`, or correct the address.`,
      };
    }
  }

  /**
   * Ollama's native listing, not the OpenAI-compatible one.
   *
   * `/api/tags` returns the parameter size and quantisation alongside the
   * name, and on a local server that is the information that decides
   * whether a model will actually run on this machine. `/v1/models`
   * returns names only.
   */
  async discoverModels(endpoint: string): Promise<DiscoveredModel[]> {
    const base = normaliseOllamaUrl(endpoint);
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return [];
      const body = await res.json() as {
        models?: { name?: string; details?: { parameter_size?: string; quantization_level?: string } }[];
      };
      return (body.models ?? [])
        .filter((m): m is { name: string; details?: { parameter_size?: string; quantization_level?: string } } => typeof m.name === 'string')
        .map((m) => {
          const facts = [m.details?.parameter_size, m.details?.quantization_level].filter(Boolean);
          return {
            id: m.name,
            name: facts.length ? `${m.name} (${facts.join(', ')})` : m.name,
            capabilities: { streaming: true },
          };
        });
    } catch {
      return [];
    }
  }

  createRuntime(endpoint: string, model?: string): Runtime {
    return this.makeRuntime({
      baseUrl: this.api(endpoint),
      // Ollama ignores Authorization. An empty string keeps the header
      // well-formed for any reverse proxy sitting in front of it.
      apiKey: '',
      defaultModel: model || this.metadata.defaultModel,
    });
  }

  async checkHealth(endpoint: string): Promise<ProviderHealth> {
    const base = normaliseOllamaUrl(endpoint);
    const start = performance.now();
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
      return {
        ok: res.ok,
        latencyMs: Math.round(performance.now() - start),
        error: res.ok ? undefined : `HTTP ${res.status} from ${base}`,
        lastChecked: new Date().toISOString(),
      };
    } catch (e) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - start),
        error: `Could not reach Ollama at ${base} (${(e as Error).message})`,
        lastChecked: new Date().toISOString(),
      };
    }
  }
}
