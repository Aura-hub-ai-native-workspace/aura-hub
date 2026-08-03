import type { ProviderAdapter, DiscoveredModel, ProviderHealth, ModelCapabilities } from '../types';
import type { Runtime, GenerateRequest, GenerateResponse, StreamChunk, ModelInfo, HealthStatus } from '@aura/runtime';

const ANTHROPIC_MODELS: { id: string; name: string; caps: Partial<ModelCapabilities> }[] = [
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', caps: { contextWindow: 200000, vision: true, reasoning: true, streaming: true, toolCalling: true, jsonMode: true } },
  { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', caps: { contextWindow: 200000, vision: true, reasoning: true, streaming: true, toolCalling: true, jsonMode: true } },
  { id: 'claude-sonnet-4-20241022', name: 'Claude Sonnet 4 (Legacy)', caps: { contextWindow: 200000, vision: true, reasoning: true, streaming: true, toolCalling: true, jsonMode: true } },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', caps: { contextWindow: 200000, vision: true, streaming: true, toolCalling: true, jsonMode: true } },
];

export class AnthropicAdapter implements ProviderAdapter {
  readonly metadata = { id: 'anthropic', name: 'Anthropic', description: 'Claude models by Anthropic', docsUrl: 'https://console.anthropic.com/settings/keys' };

  detect(apiKey: string): boolean { return apiKey.startsWith('sk-ant-'); }

  async validate(apiKey: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(10000),
      });
      return res.status === 200 || res.status === 400 ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  async discoverModels(_apiKey: string): Promise<DiscoveredModel[]> {
    return ANTHROPIC_MODELS.map((m) => ({ id: m.id, name: m.name, capabilities: m.caps as ModelCapabilities }));
  }

  createRuntime(apiKey: string, model?: string): Runtime {
    return new AnthropicRuntime(apiKey, model || 'claude-sonnet-4-20250514');
  }

  async checkHealth(apiKey: string): Promise<ProviderHealth> {
    const start = performance.now();
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(10000),
      });
      return { ok: res.ok || res.status === 400, latencyMs: Math.round(performance.now() - start), lastChecked: new Date().toISOString() };
    } catch (e) { return { ok: false, latencyMs: Math.round(performance.now() - start), error: (e as Error).message, lastChecked: new Date().toISOString() }; }
  }
}

class AnthropicRuntime implements Runtime {
  private apiKey: string;
  private defaultModel: string;
  private timeoutMs = 30000;
  private ac: AbortController | null = null;

  constructor(apiKey: string, defaultModel: string) { this.apiKey = apiKey; this.defaultModel = defaultModel; }
  cancel(): void { this.ac?.abort(); this.ac = null; }

  private headers() { return { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }; }

  private buildBody(messages: { role: string; content: string }[], opts: { model?: string; temperature?: number; maxTokens?: number; stream: boolean }) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const msgs = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'assistant' as const : 'user' as const, content: m.content }));
    const model = opts.model || this.defaultModel;
    const p: Record<string, unknown> = { model, messages: msgs, max_tokens: opts.maxTokens ?? 4096, stream: opts.stream };
    if (system) p.system = system;
    if (opts.temperature !== undefined) p.temperature = opts.temperature;
    return JSON.stringify(p);
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const msgs = [...(request.system ? [{ role: 'system', content: request.system }] : []), ...request.messages];
    const body = this.buildBody(msgs, { model: request.model, temperature: request.temperature, maxTokens: request.maxTokens, stream: false });
    this.ac?.abort();
    this.ac = new AbortController();
    const signal = AbortSignal.any([this.ac.signal, AbortSignal.timeout(this.timeoutMs)]);
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: this.headers(), body, signal });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Anthropic error ${res.status}: ${t || res.statusText}`); }
    const json = await res.json() as { content: { text: string }[]; model: string; usage?: { input_tokens: number; output_tokens: number } };
    const usage = json.usage;
    return {
      content: json.content?.map((c) => c.text).join('') ?? '',
      model: json.model ?? this.defaultModel,
      usage: usage
        ? { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens, totalTokens: usage.input_tokens + usage.output_tokens }
        : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const msgs = [...(request.system ? [{ role: 'system', content: request.system }] : []), ...request.messages];
    const body = this.buildBody(msgs, { model: request.model, temperature: request.temperature, maxTokens: request.maxTokens, stream: true });
    this.ac?.abort();
    this.ac = new AbortController();
    const signal = AbortSignal.any([this.ac.signal, AbortSignal.timeout(this.timeoutMs)]);
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: this.headers(), body, signal });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Anthropic error ${res.status}: ${t || res.statusText}`); }
    const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
    if (!reader) throw new Error('No stream body');
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') { yield { delta: '', done: true }; return; }
          try {
            const ev = JSON.parse(data) as { type: string; delta?: { text?: string }; content_block?: { text: string }; message?: { stop_reason?: string } };
            if (ev.type === 'content_block_delta' && ev.delta?.text) yield { delta: ev.delta.text, done: false };
            if (ev.type === 'message_stop' || ev.type === 'message_delta') { yield { delta: '', done: true, finishReason: 'stop' }; return; }
          } catch { /* skip */ }
        }
      }
    } finally { try { reader.cancel(); } catch { /* ignore */ } }
  }

  async listModels(): Promise<ModelInfo[]> { return []; }
  async health(): Promise<HealthStatus> { return { ok: true, status: 'connected', latencyMs: 0 }; }
}
