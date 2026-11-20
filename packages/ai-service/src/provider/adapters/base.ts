import type {
  Runtime, GenerateRequest, GenerateResponse, StreamChunk, ModelInfo, HealthStatus, RuntimeMessage,
} from '@aura/runtime';
import type { ProviderAdapter, DiscoveredModel, ProviderHealth, ModelCapabilities } from '../types';
import { ProviderHttpError } from '../errorTranslator';
import { pinnedFetch } from '../redirectGuard';

/** The longest any single non-streaming call may be given, whatever a caller asks for. */
export const MAX_CALL_TIMEOUT_MS = 600_000;

/** Classify an OpenAI-compatible HTTP status into a user-facing validation state. */
function classifyError(status: number): string {
  if (status === 401) return 'Invalid API key (401)';
  if (status === 403) return 'Unauthorized (403)';
  if (status === 429) return 'Rate limited (429)';
  return `HTTP ${status}`;
}

export abstract class BaseOpenAICompatible implements ProviderAdapter {
  abstract readonly metadata: { id: string; name: string; description: string; docsUrl?: string; defaultModel: string };

  protected abstract baseUrl: string;

  detect(_apiKey: string): boolean {
    return false;
  }

  async validate(apiKey: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      return res.ok ? { ok: true } : { ok: false, error: classifyError(res.status) };
    } catch (e) {
      return { ok: false, error: `Network error — could not reach ${this.metadata.name} (${(e as Error).message})` };
    }
  }

  async discoverModels(apiKey: string): Promise<DiscoveredModel[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return [];
      const json = await res.json() as { data?: { id: string; object?: string; created?: number; owned_by?: string }[] };
      if (!json.data) return [];
      return json.data
        .map((m) => {
          const caps: ModelCapabilities = {};
          if (m.id.includes('vision') || m.id.includes('turbo')) caps.vision = true;
          if (m.id.startsWith('gpt-4') || m.id.startsWith('o1') || m.id.startsWith('o3')) caps.reasoning = true;
          caps.streaming = true;
          return { id: m.id, name: m.id, capabilities: caps };
        });
    } catch { return []; }
  }

  abstract createRuntime(apiKey: string, model?: string): Runtime;

  async checkHealth(apiKey: string): Promise<ProviderHealth> {
    const start = performance.now();
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return { ok: res.ok, latencyMs: Math.round(performance.now() - start), error: res.ok ? undefined : classifyError(res.status), lastChecked: new Date().toISOString() };
    } catch (e) {
      return { ok: false, latencyMs: Math.round(performance.now() - start), error: `Network error — could not reach ${this.metadata.name} (${(e as Error).message})`, lastChecked: new Date().toISOString() };
    }
  }

  /**
   * `timeoutMs` bounds silence on the wire — see the note in `stream()`.
   * `guardRedirects` pins requests to the configured destination, for
   * providers whose endpoint the user chose rather than this code.
   */
  protected makeRuntime(config: { baseUrl: string; apiKey: string; defaultModel?: string; timeoutMs?: number; guardRedirects?: boolean }): Runtime {
    return new OpenAICompatibleRuntime({ ...config, providerName: this.metadata.name });
  }
}

/**
 * After a stream has signalled the end of its answer (`finish_reason`, or
 * a usage-only chunk), how long to wait for the trailing usage chunk and
 * `[DONE]` before treating what arrived as complete. Every compliant
 * server sends both immediately; this only bounds a server that finishes
 * and then holds the connection open.
 */
export const STREAM_TRAILER_GRACE_MS = 2_000;

type SseEvent = { delta: string; finishReason?: string; usage?: StreamChunk['usage']; usageOnly: boolean };

/**
 * One SSE line → what it means. `null` for anything that is not a usable
 * `data:` event (comments, `event:`/`id:` fields, blank separators, and
 * malformed JSON — skipped, never fatal, as before).
 */
function parseSseLine(raw: string): SseEvent | 'done' | null {
  const line = raw.trimEnd(); // tolerate CRLF framing
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (data === '[DONE]') return 'done';
  let p: {
    choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  };
  try { p = JSON.parse(data); } catch { return null; }
  if (!p || typeof p !== 'object') return null;
  const c = p.choices?.[0];
  const u = p.usage;
  return {
    delta: c?.delta?.content ?? '',
    finishReason: c?.finish_reason ?? undefined,
    usage: u ? { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, totalTokens: u.total_tokens ?? 0 } : undefined,
    usageOnly: Boolean(u) && !c,
  };
}

/**
 * `reader.read()` bounded by `ms`; `null` when the time runs out first.
 * The losing read stays attached to the race (so its eventual rejection
 * is handled) and is torn down with the request in the caller's `finally`.
 */
async function readWithin<T>(reader: ReadableStreamDefaultReader<T>, ms: number): Promise<ReadableStreamReadResult<T> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([reader.read(), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class OpenAICompatibleRuntime implements Runtime {
  private baseUrl: string;
  private apiKey: string;
  private defaultModel: string;
  private providerName: string;
  private timeoutMs = 30000;
  private ac: AbortController | null = null;

  /**
   * Which `fetch` to use for the chat endpoint.
   *
   * A hosted provider's endpoint is a constant this code chose, and those
   * services redirect for their own reasons; they keep the default
   * behaviour they were tested against. A self-hosted endpoint is an
   * address the USER chose, and a redirect away from it would move their
   * prompts to a machine they never configured — so those are pinned.
   */
  private send: typeof fetch;

  constructor(config: { baseUrl: string; apiKey: string; defaultModel?: string; providerName?: string; timeoutMs?: number; guardRedirects?: boolean }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel ?? '';
    this.providerName = config.providerName ?? 'The AI provider';
    this.timeoutMs = config.timeoutMs ?? 30000;
    this.send = config.guardRedirects
      ? ((input, init) => pinnedFetch(String(input), init as RequestInit))
      : fetch;
  }

  cancel(): void { this.ac?.abort(); this.ac = null; }

  private headers() { return { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` }; }

  private buildBody(messages: RuntimeMessage[], opts: { model?: string; temperature?: number; maxTokens?: number; frequencyPenalty?: number; stream: boolean }): string {
    const model = opts.model || this.defaultModel;
    const p: Record<string, unknown> = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: opts.stream,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.frequencyPenalty !== undefined ? { frequency_penalty: opts.frequencyPenalty } : {}),
      ...(opts.stream ? { stream_options: { include_usage: true } } : {}),
    };
    return JSON.stringify(p);
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const msgs = [...(request.system ? [{ role: 'system' as const, content: request.system }] : []), ...request.messages];
    const body = this.buildBody(msgs, { model: request.model, temperature: request.temperature, maxTokens: request.maxTokens, frequencyPenalty: request.frequencyPenalty, stream: false });
    this.ac?.abort();
    this.ac = new AbortController();
    const json = await this.post<{ choices: { finish_reason: string; message: { content: string | null } }[]; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; model: string }>('/chat/completions', body, request.timeoutMs);
    const choice = json.choices?.[0];
    if (!choice) throw new Error('No response choices');
    return {
      content: choice.message?.content ?? '',
      model: json.model ?? this.defaultModel,
      usage: { promptTokens: json.usage?.prompt_tokens ?? 0, completionTokens: json.usage?.completion_tokens ?? 0, totalTokens: json.usage?.total_tokens ?? 0 },
      finishReason: choice.finish_reason ?? 'stop',
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const msgs = [...(request.system ? [{ role: 'system' as const, content: request.system }] : []), ...request.messages];
    const body = this.buildBody(msgs, { model: request.model, temperature: request.temperature, maxTokens: request.maxTokens, frequencyPenalty: request.frequencyPenalty, stream: true });
    this.ac?.abort();
    this.ac = new AbortController();
    /*
     * The timeout bounds SILENCE, not the length of the answer.
     *
     * `AbortSignal.timeout()` on this fetch stays live for as long as the
     * body is being read, because the body IS the stream — so a flat
     * deadline is a cap on total generation time, and it killed working
     * requests at 30s while tokens were arriving. A self-hosted server
     * makes that obvious: a shared GPU loading a model into VRAM can be
     * quiet for a minute before the first token, and a long answer can
     * take several more.
     *
     * So the clock is reset every time the server sends anything. It
     * fires only when the connection has gone quiet for the whole budget,
     * which is the condition that actually means something is wrong.
     */
    const ac = this.ac;
    let idle: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const resetIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => { timedOut = true; ac.abort(); }, this.timeoutMs);
    };
    resetIdle();
    let response: Response;
    try {
      response = await this.send(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(), body, signal: ac.signal });
    } catch (e) {
      if (idle) clearTimeout(idle);
      if (timedOut) throw new Error(`${this.providerName} sent nothing for ${Math.round(this.timeoutMs / 1000)}s. The server may be loading the model, or may be unreachable.`);
      throw e;
    }
    if (!response.ok) { if (idle) clearTimeout(idle); const t = await response.text().catch(() => ''); throw new ProviderHttpError(this.providerName, response.status, t || response.statusText); }
    const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
    if (!reader) { if (idle) clearTimeout(idle); throw new Error('No stream body'); }
    /*
     * Completion is ONE `done` chunk, emitted when the stream really ends.
     *
     * With `stream_options.include_usage` (always sent, see buildBody) an
     * OpenAI-compatible server ends a stream as:
     *
     *   …content… → {finish_reason:"stop"} → {choices:[], usage:{…}} → [DONE]
     *
     * Stopping at `finish_reason` threw the usage chunk away, so callers
     * reported zero tokens for every streamed answer. Instead the finish
     * reason and the usage are remembered, and the single terminal chunk
     * carries both once the stream says it is over: `[DONE]`, the body
     * closing, or — for a server that stops talking after finishing but
     * holds the connection open — a short trailer grace period.
     */
    let buf = '';
    let finishReason: string | undefined;
    let usage: StreamChunk['usage'];
    let trailing = false;
    const final = (): StreamChunk => ({
      delta: '', done: true,
      ...(finishReason ? { finishReason } : {}),
      ...(usage ? { usage } : {}),
    });
    const grace = Math.min(STREAM_TRAILER_GRACE_MS, this.timeoutMs);
    try {
      while (true) {
        // Once the answer has finished, the trailer grace alone bounds the
        // wait — the silence timer must not abort what is already complete.
        if (trailing && idle) { clearTimeout(idle); idle = null; }
        let next: ReadableStreamReadResult<string> | null;
        if (trailing) {
          // The answer is already complete; only trailing metadata is
          // outstanding. A reset or cancel now must not turn a finished
          // answer into a failure — before the trailer was read at all,
          // the stream had already returned at this point.
          try { next = await readWithin(reader, grace); } catch { next = null; }
        } else {
          next = await reader.read();
          resetIdle();
        }
        if (next === null) break; // finished, then silence or a reset: what we have is complete
        let lines: string[];
        if (next.done) {
          // A last event without a trailing newline still counts.
          lines = buf.split('\n');
          buf = '';
        } else {
          buf += next.value;
          lines = buf.split('\n');
          buf = lines.pop() ?? '';
        }
        for (const line of lines) {
          const ev = parseSseLine(line);
          if (ev === null) continue;
          if (ev === 'done') { yield final(); return; }
          if (ev.delta && !finishReason) yield { delta: ev.delta, done: false };
          if (ev.usage) usage = ev.usage;
          if (ev.finishReason && !finishReason) finishReason = ev.finishReason;
          if (finishReason || ev.usageOnly) trailing = true;
        }
        if (next.done) break;
      }
      // Closed without [DONE]. Evidence of a finished answer → complete it.
      // No evidence at all (a cut-off stream) → end without claiming
      // completion, exactly as before, so a truncation is not dressed up
      // as a clean stop.
      if (finishReason || usage) yield final();
    } finally {
      if (idle) clearTimeout(idle);
      // Tear the connection down via the controller: aborting the fetch
      // cancels the body cleanly, whereas reader.cancel() mid-flight can
      // surface an undici unhandled rejection (reason undefined).
      this.ac?.abort();
      this.ac = null;
    }
  }

  async listModels(): Promise<ModelInfo[]> { return []; }
  async health(): Promise<HealthStatus> {
    const start = performance.now();
    try {
      const res = await this.send(`${this.baseUrl}/models`, { method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(5000) });
      return { ok: res.ok, status: res.ok ? 'connected' : 'error', latencyMs: Math.round(performance.now() - start) };
    } catch (e) { return { ok: false, status: 'offline', latencyMs: Math.round(performance.now() - start), error: (e as Error).message }; }
  }
  private async post<T>(path: string, body: string, callerTimeoutMs?: number): Promise<T> {
    // The caller's deadline reaches the transport itself: a wrapper that
    // gives up at 180s is pointless if this socket gives up at 120s.
    const budget = callerTimeoutMs && callerTimeoutMs > 0 ? Math.min(callerTimeoutMs, MAX_CALL_TIMEOUT_MS) : this.timeoutMs;
    const signal = AbortSignal.any([this.ac?.signal ?? new AbortController().signal, AbortSignal.timeout(budget)].filter(Boolean));
    const res = await this.send(`${this.baseUrl}${path}`, { method: 'POST', headers: this.headers(), body, signal });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new ProviderHttpError(this.providerName, res.status, t || res.statusText); }
    return res.json() as Promise<T>;
  }
}
