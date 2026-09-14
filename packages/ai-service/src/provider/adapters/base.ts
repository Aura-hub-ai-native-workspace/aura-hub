import type {
  Runtime, GenerateRequest, GenerateResponse, StreamChunk, ModelInfo, HealthStatus, RuntimeMessage,
} from '@aura/runtime';
import type { ProviderAdapter, DiscoveredModel, ProviderHealth, ModelCapabilities } from '../types';
import { ProviderHttpError } from '../errorTranslator';

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

  /** `timeoutMs` bounds silence on the wire — see the note in `stream()`. */
  protected makeRuntime(config: { baseUrl: string; apiKey: string; defaultModel?: string; timeoutMs?: number }): Runtime {
    return new OpenAICompatibleRuntime({ ...config, providerName: this.metadata.name });
  }
}

class OpenAICompatibleRuntime implements Runtime {
  private baseUrl: string;
  private apiKey: string;
  private defaultModel: string;
  private providerName: string;
  private timeoutMs = 30000;
  private ac: AbortController | null = null;

  constructor(config: { baseUrl: string; apiKey: string; defaultModel?: string; providerName?: string; timeoutMs?: number }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel ?? '';
    this.providerName = config.providerName ?? 'The AI provider';
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  cancel(): void { this.ac?.abort(); this.ac = null; }

  private headers() { return { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` }; }

  private buildBody(messages: RuntimeMessage[], opts: { model?: string; temperature?: number; maxTokens?: number; stream: boolean }): string {
    const model = opts.model || this.defaultModel;
    const p: Record<string, unknown> = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: opts.stream,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.stream ? { stream_options: { include_usage: true } } : {}),
    };
    return JSON.stringify(p);
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const msgs = [...(request.system ? [{ role: 'system' as const, content: request.system }] : []), ...request.messages];
    const body = this.buildBody(msgs, { model: request.model, temperature: request.temperature, maxTokens: request.maxTokens, stream: false });
    this.ac?.abort();
    this.ac = new AbortController();
    const json = await this.post<{ choices: { finish_reason: string; message: { content: string | null } }[]; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; model: string }>('/chat/completions', body);
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
    const body = this.buildBody(msgs, { model: request.model, temperature: request.temperature, maxTokens: request.maxTokens, stream: true });
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
      response = await fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(), body, signal: ac.signal });
    } catch (e) {
      if (idle) clearTimeout(idle);
      if (timedOut) throw new Error(`${this.providerName} sent nothing for ${Math.round(this.timeoutMs / 1000)}s. The server may be loading the model, or may be unreachable.`);
      throw e;
    }
    if (!response.ok) { if (idle) clearTimeout(idle); const t = await response.text().catch(() => ''); throw new ProviderHttpError(this.providerName, response.status, t || response.statusText); }
    const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
    if (!reader) { if (idle) clearTimeout(idle); throw new Error('No stream body'); }
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        resetIdle();
        if (done) break;
        buf += value;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') { yield { delta: '', done: true }; return; }
          try {
            const p = JSON.parse(data) as { choices?: { delta: { content?: string | null }; finish_reason?: string | null }[]; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
            if (p.usage) { yield { delta: '', done: true, usage: { promptTokens: p.usage.prompt_tokens, completionTokens: p.usage.completion_tokens, totalTokens: p.usage.total_tokens } }; return; }
            const c = p.choices?.[0];
            if (!c) continue;
            const d = c.delta?.content ?? '';
            if (d) yield { delta: d, done: false };
            if (c.finish_reason) { yield { delta: '', done: true, finishReason: c.finish_reason }; return; }
          } catch { /* skip */ }
        }
      }
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
      const res = await fetch(`${this.baseUrl}/models`, { method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(5000) });
      return { ok: res.ok, status: res.ok ? 'connected' : 'error', latencyMs: Math.round(performance.now() - start) };
    } catch (e) { return { ok: false, status: 'offline', latencyMs: Math.round(performance.now() - start), error: (e as Error).message }; }
  }
  private async post<T>(path: string, body: string): Promise<T> {
    const signal = AbortSignal.any([this.ac?.signal ?? new AbortController().signal, AbortSignal.timeout(this.timeoutMs)].filter(Boolean));
    const res = await fetch(`${this.baseUrl}${path}`, { method: 'POST', headers: this.headers(), body, signal });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new ProviderHttpError(this.providerName, res.status, t || res.statusText); }
    return res.json() as Promise<T>;
  }
}
