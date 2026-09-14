import { BaseOpenAICompatible } from './base';
import type { Runtime } from '@aura/runtime';
import type { DiscoveredModel, ProviderHealth } from '../types';

/**
 * Ollama — a model server somebody runs, addressed over HTTP.
 *
 * ## Where the server is, is not this adapter's business
 *
 * It may be on this machine. It may equally be a GPU box in a lab, a
 * shared institutional server, or anything else reachable over HTTP. The
 * client does the same thing in every case: POST to an address. Nothing
 * here should assume, prefer, or require loopback — the deployment this
 * was written for is a shared college GPU server that many laptops talk
 * to, and on those laptops there is no Ollama, no model, and no GPU.
 *
 * That is why the address is asked for rather than detected, and why
 * `AURA_OLLAMA_BASE_URL` exists: an institution can ship a default that
 * points at its own server, and nobody has to type it.
 *
 * ## Why the connect value is an address, not a key
 *
 * Every other adapter here is bring-your-own-key: the user supplies a
 * secret and the endpoint is a constant baked in. A self-hosted server
 * inverts both halves. A trusted internal server asks nothing of callers,
 * and its address is the one thing AURA cannot know in advance.
 *
 * So the value that travels through the connect path IS the base URL, and
 * it occupies the slot a key would. Connect, disconnect, switch, health
 * and model discovery then need no second code path, and the fingerprint
 * the UI shows becomes the address — which is what someone debugging a
 * server on another machine actually needs to see.
 */

/**
 * The address offered before the user types one.
 *
 * `AURA_OLLAMA_BASE_URL` wins so a deployment can point every install at
 * its own server. Loopback is the fallback SUGGESTION, not a constraint:
 * any reachable host is equally valid, and the field it prefills is an
 * ordinary editable text box.
 */
export function defaultOllamaBaseUrl(): string {
  const configured = process.env.AURA_OLLAMA_BASE_URL?.trim();
  return configured ? normaliseOllamaUrl(configured) : 'http://127.0.0.1:11434';
}

/** How long to wait on a server that may be across a campus network. */
const REACH_TIMEOUT_MS = 10_000;

/**
 * Accept what people actually type; never change which host they meant.
 *
 * The only rewrites are a missing scheme, a trailing slash, and a
 * trailing `/v1` — the last because Ollama's own documentation shows the
 * OpenAI-compatible path with it, and both spellings name the same
 * server. Host, port and any path in front of `/v1` are left exactly as
 * given, so a reverse proxy at `https://ai.college.edu/ollama/v1` stays
 * pointed at `https://ai.college.edu/ollama`.
 */
export function normaliseOllamaUrl(raw: string): string {
  let value = (raw || '').trim();
  if (!value) return '';
  // A bare host or host:port is the commonest thing to paste out of a
  // terminal or a wiki page, and it is unambiguous here.
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  value = value.replace(/\/+$/, '');
  value = value.replace(/\/v1$/i, '');
  return value;
}

/*
 * One sentence naming the failure, then the context needed to fix it.
 *
 * The leading sentence is fixed per failure so the same condition always
 * reads the same way, and the address is appended because a connection
 * DESTINATION is not a secret — it is the single most useful thing to see
 * when a server on another machine will not answer.
 */
function reachError(base: string, e: unknown): string {
  const err = e as { name?: string; message?: string };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return `Cannot reach the configured Ollama server: ${base} did not respond within ${REACH_TIMEOUT_MS / 1000}s. It may be busy, or unreachable from this network.`;
  }
  return `Cannot reach the configured Ollama server at ${base} (${err?.message ?? 'network error'}). Check the address, and that the server is running and reachable from this machine.`;
}

/** An HTTP answer that is not a model list still tells us what went wrong. */
function statusError(base: string, status: number): string {
  if (status === 401 || status === 403 || status === 407) {
    return `The configured server rejected the request (HTTP ${status} from ${base}).`;
  }
  if (status >= 500) {
    return `The Ollama server returned an error (HTTP ${status} from ${base}).`;
  }
  return `This address is reachable but is not an Ollama server (${base} answered HTTP ${status}).`;
}

export class OllamaAdapter extends BaseOpenAICompatible {
  readonly metadata = {
    id: 'ollama',
    name: 'Ollama (self-hosted)',
    description: 'A model server you or your institution runs — on this machine or another. No account, no API key.',
    docsUrl: 'https://docs.ollama.com/api',
    // Deliberately empty: there is no model every server has. The user
    // names one their server offers, and `modelValidation` reads this same
    // field, so a guess here would become a wrong default everywhere.
    defaultModel: '',
    /** Addressed, not keyed. Used for ordering and for asking the right question. */
    selfHosted: true as const,
    get defaultBaseUrl() { return defaultOllamaBaseUrl(); },
  };

  /** Only a fallback; every call below uses the address it was given. */
  protected baseUrl = 'http://127.0.0.1:11434/v1';

  private api(endpoint: string): string {
    return `${normaliseOllamaUrl(endpoint) || 'http://127.0.0.1:11434'}/v1`;
  }

  /** Nothing to detect — an address is never mistaken for a key. */
  detect(): boolean {
    return false;
  }

  async validate(endpoint: string): Promise<{ ok: boolean; error?: string }> {
    const base = normaliseOllamaUrl(endpoint);
    if (!base) return { ok: false, error: 'Enter your Ollama server address.' };
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(REACH_TIMEOUT_MS) });
      if (!res.ok) return { ok: false, error: statusError(base, res.status) };
      const body = await res.json() as { models?: unknown[] };
      // An Ollama model list is an object with a `models` array. Anything
      // else answered 200 without being the service we need.
      if (!body || !Array.isArray(body.models)) {
        return { ok: false, error: `This address is reachable but is not an Ollama server (${base} did not return a model list).` };
      }
      if (body.models.length === 0) {
        // Reachable and empty is a different problem from unreachable, and
        // the fix is on the SERVER, which may not be this machine.
        return { ok: false, error: `Ollama is running, but no models are available at ${base}. Pull one on the server, for example: ollama pull qwen3:4b` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: reachError(base, e) };
    }
  }

  /**
   * Ollama's native listing, not the OpenAI-compatible one.
   *
   * `/api/tags` reports parameter size and quantisation alongside the
   * name, which is what tells a user whether the server is offering the
   * 4B or the 70B. `/v1/models` returns names only.
   */
  async discoverModels(endpoint: string): Promise<DiscoveredModel[]> {
    const base = normaliseOllamaUrl(endpoint);
    if (!base) return [];
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(REACH_TIMEOUT_MS) });
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
      // A trusted internal server authenticates nobody. An empty string
      // keeps the header well-formed for any reverse proxy in front of it.
      apiKey: '',
      defaultModel: model || this.metadata.defaultModel,
      /*
       * Generous, because this budget now bounds SILENCE rather than the
       * length of an answer. The first request to a shared server usually
       * pays for loading the model into VRAM, and on a busy GPU that can
       * take a while with nothing on the wire. Once tokens start arriving
       * the clock resets on every one, so a long answer never trips it.
       */
      timeoutMs: 120_000,
    });
  }

  async checkHealth(endpoint: string): Promise<ProviderHealth> {
    const base = normaliseOllamaUrl(endpoint);
    const start = performance.now();
    if (!base) {
      return { ok: false, latencyMs: 0, error: 'No server address configured.', lastChecked: new Date().toISOString() };
    }
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
        error: reachError(base, e),
        lastChecked: new Date().toISOString(),
      };
    }
  }
}
