/**
 * local — shared ground for providers that run ON this machine.
 * ==================================================================
 * Twelve cloud adapters existed and not one local one, so AURA had no AI
 * at all without internet and a third-party key. That is an availability
 * problem and a privacy problem in the same sentence: work that must not
 * leave the machine had nowhere to go.
 *
 * Ollama and LM Studio were already *detected* by the connected-environment
 * catalogue and reachable by no adapter. This file is what the two local
 * adapters share.
 *
 * The credential slot carries an ENDPOINT, not a secret
 * ----------------------------------------------------
 * `ProviderAdapter` has exactly one string to configure a provider with,
 * and the existing plumbing (credential store → `getKey()` →
 * `switchToProvider`) is built around it. A local server has no API key
 * but does have an address, so that address is what goes in the slot.
 *
 * This is a deliberate reuse rather than a new configuration authority:
 * one store, one lookup, one activation path, and a local provider is
 * connected/disconnected exactly like every other one. The value is
 * still encrypted at rest, which costs nothing and means the store has
 * no second code path.
 */

import type {
  Runtime, GenerateRequest, GenerateResponse, StreamChunk, ModelInfo, HealthStatus, RuntimeMessage,
} from '@aura/runtime';
import type { ProviderAdapter, DiscoveredModel, ProviderHealth, ProviderHealthState } from '../types';

/** Loopback and link-local only. A "local" provider that is not local is a lie. */
const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/i;

export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Turn whatever the user (or an env var) supplied into a base URL.
 *
 * Accepts a bare host:port, a full URL, or nothing at all — an empty
 * value means "the server's documented default port on this machine",
 * which is the case that lets AURA connect a local model with the user
 * typing no configuration whatsoever.
 */
export function resolveLocalBaseUrl(raw: string, fallback: string): string {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  try {
    const url = new URL(withScheme);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return fallback;
  }
}

export interface LocalProbe {
  ok: boolean;
  state: ProviderHealthState;
  latencyMs: number;
  error?: string;
}

/**
 * One GET, classified.
 *
 * A local server that is not running gives `ECONNREFUSED` immediately —
 * which is a *different* problem from a bad key and must not be reported
 * as one. `unreachable` is the honest answer and the message says how to
 * fix it, because "start the server" is something the user can actually do.
 */
export async function probeLocal(url: string, label: string, timeoutMs = 4000): Promise<LocalProbe> {
  const start = performance.now();
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    const latencyMs = Math.round(performance.now() - start);
    if (res.ok) return { ok: true, state: 'connected', latencyMs };
    return { ok: false, state: 'error', latencyMs, error: `${label} answered HTTP ${res.status}` };
  } catch (e) {
    return {
      ok: false,
      state: 'unreachable',
      latencyMs: Math.round(performance.now() - start),
      error: `Could not reach ${label} at ${url} — ${(e as Error).message}. Start ${label} and try again.`,
    };
  }
}

export function healthFrom(probe: LocalProbe): ProviderHealth {
  return {
    ok: probe.ok,
    latencyMs: probe.latencyMs,
    error: probe.error,
    lastChecked: new Date().toISOString(),
    state: probe.state,
  };
}

/* ══════════════════════════════════════════════════════════════════
   Ollama's native runtime
   ══════════════════════════════════════════════════════════════════ */

interface OllamaChatResponse {
  model: string;
  message?: { role: string; content: string };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Ollama speaks its own protocol on `/api/chat`, not OpenAI's.
 *
 * It is worth adapting natively rather than through Ollama's OpenAI
 * compatibility shim for one concrete reason: the native response
 * carries `prompt_eval_count` and `eval_count`, which are the model's
 * OWN token counts. That is a real tokenizer's answer for a local model,
 * and it is what `tokenizer/` uses instead of estimating.
 *
 * Streaming is newline-delimited JSON objects, not SSE frames.
 */
export class OllamaRuntime implements Runtime {
  private ac: AbortController | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly defaultModel: string,
    private readonly timeoutMs = 120000,
  ) {}

  cancel(): void { this.ac?.abort(); this.ac = null; }

  private body(request: GenerateRequest, stream: boolean): string {
    const messages: RuntimeMessage[] = [
      ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
      ...request.messages,
    ];
    return JSON.stringify({
      model: request.model || this.defaultModel,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
      options: {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
        ...(request.topP !== undefined ? { top_p: request.topP } : {}),
        ...(request.stop?.length ? { stop: request.stop } : {}),
      },
    });
  }

  /**
   * A local model on CPU can take minutes to load before it emits a
   * token, so the default timeout is generous — but it is still a
   * timeout, because a wedged server must not hang the caller forever.
   */
  private signal(): AbortSignal {
    this.ac?.abort();
    this.ac = new AbortController();
    return AbortSignal.any([this.ac.signal, AbortSignal.timeout(this.timeoutMs)]);
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: this.body(request, false),
      signal: this.signal(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama error ${res.status}: ${text || res.statusText}`);
    }
    const json = await res.json() as OllamaChatResponse;
    const promptTokens = json.prompt_eval_count ?? 0;
    const completionTokens = json.eval_count ?? 0;
    return {
      content: json.message?.content ?? '',
      model: json.model || this.defaultModel,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      finishReason: json.done_reason ?? 'stop',
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: this.body(request, true),
      signal: this.signal(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama error ${res.status}: ${text || res.statusText}`);
    }
    const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
    if (!reader) throw new Error('Ollama returned no stream body');
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let frame: OllamaChatResponse;
          try { frame = JSON.parse(trimmed) as OllamaChatResponse; } catch { continue; }
          if (frame.done) {
            const promptTokens = frame.prompt_eval_count ?? 0;
            const completionTokens = frame.eval_count ?? 0;
            yield {
              delta: frame.message?.content ?? '',
              done: true,
              finishReason: frame.done_reason ?? 'stop',
              usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
            };
            return;
          }
          const delta = frame.message?.content ?? '';
          if (delta) yield { delta, done: false };
        }
      }
    } finally {
      this.ac?.abort();
      this.ac = null;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      const json = await res.json() as { models?: { name: string; details?: { family?: string } }[] };
      return (json.models ?? []).map((m) => ({
        id: m.name, providerID: 'ollama', name: m.name, family: m.details?.family,
      }));
    } catch { return []; }
  }

  async health(): Promise<HealthStatus> {
    const probe = await probeLocal(`${this.baseUrl}/api/tags`, 'Ollama');
    return {
      ok: probe.ok,
      status: probe.ok ? 'connected' : probe.state === 'unreachable' ? 'offline' : 'error',
      latencyMs: probe.latencyMs,
      error: probe.error,
    };
  }

  /**
   * The model's own prompt token count, from the server that will run it.
   *
   * Ollama does not expose a standalone tokenize endpoint, but it does
   * report `prompt_eval_count` for a request — so asking it to evaluate
   * the prompt and produce ZERO output tokens is a genuine count, not an
   * estimate. Used by `tokenizer/` and by nothing else.
   */
  async countPromptTokens(text: string, model?: string): Promise<number | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model || this.defaultModel,
          messages: [{ role: 'user', content: text }],
          stream: false,
          options: { num_predict: 0 },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      const json = await res.json() as OllamaChatResponse;
      return typeof json.prompt_eval_count === 'number' ? json.prompt_eval_count : null;
    } catch { return null; }
  }
}

/** Shared metadata shape so both local adapters describe themselves the same way. */
export interface LocalProviderMetadata {
  id: string;
  name: string;
  description: string;
  docsUrl?: string;
  defaultModel: string;
  /** The address used when the credential slot is empty. */
  defaultEndpoint: string;
}

export type LocalAdapter = ProviderAdapter & {
  readonly metadata: LocalProviderMetadata;
  /** True — the model runs on this machine and nothing leaves it. */
  readonly local: true;
  /** Reachable right now at the default endpoint? Used by local discovery. */
  probeDefault(): Promise<{ ok: boolean; endpoint: string; models: DiscoveredModel[]; error?: string }>;
};
