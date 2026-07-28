import type { ProviderAdapter, DiscoveredModel, ProviderHealth, ModelCapabilities } from '../types';
import type { Runtime, GenerateRequest, GenerateResponse, StreamChunk, ModelInfo, HealthStatus, RuntimeMessage } from '@aura/runtime';

export class GeminiAdapter implements ProviderAdapter {
  readonly metadata = { id: 'gemini', name: 'Google Gemini', description: 'Gemini models by Google', docsUrl: 'https://aistudio.google.com/app/apikey' };
  private baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  detect(_apiKey: string): boolean { return false; }

  async validate(apiKey: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/models?key=${apiKey}`, { method: 'GET', signal: AbortSignal.timeout(10000) });
      return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  async discoverModels(apiKey: string): Promise<DiscoveredModel[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models?key=${apiKey}`, { method: 'GET', signal: AbortSignal.timeout(15000) });
      if (!res.ok) return [];
      const json = await res.json() as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[]; outputTokenLimit?: number; inputTokenLimit?: number }[] };
      return (json.models ?? [])
        .filter((m) => m.name.startsWith('models/gemini-') && m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => {
          const id = m.name.replace('models/', '');
          const caps: ModelCapabilities = { streaming: true, vision: true, contextWindow: m.inputTokenLimit || undefined, maxOutput: m.outputTokenLimit || undefined };
          return { id, name: m.displayName ?? id, capabilities: caps };
        });
    } catch { return []; }
  }

  createRuntime(apiKey: string, model?: string): Runtime {
    return new GeminiRuntime(apiKey, model || 'gemini-2.0-flash');
  }

  async checkHealth(apiKey: string): Promise<ProviderHealth> {
    const start = performance.now();
    try {
      const res = await fetch(`${this.baseUrl}/models?key=${apiKey}`, { method: 'GET', signal: AbortSignal.timeout(5000) });
      return { ok: res.ok, latencyMs: Math.round(performance.now() - start), lastChecked: new Date().toISOString() };
    } catch (e) { return { ok: false, latencyMs: Math.round(performance.now() - start), error: (e as Error).message, lastChecked: new Date().toISOString() }; }
  }
}

class GeminiRuntime implements Runtime {
  private apiKey: string;
  private defaultModel: string;
  private timeoutMs = 30000;
  private baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  private ac: AbortController | null = null;

  constructor(apiKey: string, defaultModel: string) { this.apiKey = apiKey; this.defaultModel = defaultModel; }
  cancel(): void { this.ac?.abort(); this.ac = null; }
  private url(m: string) { return `${this.baseUrl}/models/${m}`; }
  private auth() { return `?key=${this.apiKey}`; }

  private toMsgs(msgs: RuntimeMessage[]): { role: 'user' | 'model'; parts: { text: string }[] }[] {
    return msgs.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' as const : 'user' as const, parts: [{ text: m.content }] }));
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const model = request.model || this.defaultModel;
    const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const contents = this.toMsgs(request.messages);
    const p: Record<string, unknown> = { contents };
    if (system) p.system_instruction = { parts: [{ text: system }] };
    const gc: Record<string, unknown> = {};
    if (request.temperature !== undefined) gc.temperature = request.temperature;
    if (request.maxTokens !== undefined) gc.max_output_tokens = request.maxTokens;
    if (Object.keys(gc).length) p.generation_config = gc;
    this.ac?.abort();
    this.ac = new AbortController();
    const signal = AbortSignal.any([this.ac.signal, AbortSignal.timeout(this.timeoutMs)]);
    const res = await fetch(`${this.url(model)}:generateContent${this.auth()}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p), signal });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Gemini error ${res.status}: ${t || res.statusText}`); }
    const json = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } };
    const candidate = json.candidates?.[0];
    return { content: candidate?.content?.parts?.map((p) => p.text).join('') ?? '', model, usage: { promptTokens: json.usageMetadata?.promptTokenCount ?? 0, completionTokens: json.usageMetadata?.candidatesTokenCount ?? 0, totalTokens: json.usageMetadata?.totalTokenCount ?? 0 }, finishReason: candidate?.finishReason ?? 'stop' };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const model = request.model || this.defaultModel;
    const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const contents = this.toMsgs(request.messages);
    const p: Record<string, unknown> = { contents };
    if (system) p.system_instruction = { parts: [{ text: system }] };
    const gc: Record<string, unknown> = {};
    if (request.temperature !== undefined) gc.temperature = request.temperature;
    if (request.maxTokens !== undefined) gc.max_output_tokens = request.maxTokens;
    if (Object.keys(gc).length) p.generation_config = gc;
    this.ac?.abort();
    this.ac = new AbortController();
    const signal = AbortSignal.any([this.ac.signal, AbortSignal.timeout(this.timeoutMs)]);
    const res = await fetch(`${this.url(model)}:streamGenerateContent${this.auth()}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p), signal });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Gemini error ${res.status}: ${t || res.statusText}`); }
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
            const parsed = JSON.parse(data) as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[] };
            const candidate = parsed.candidates?.[0];
            if (!candidate) continue;
            const text = candidate.content?.parts?.map((p) => p.text).join('') ?? '';
            if (text) yield { delta: text, done: false };
            if (candidate.finishReason) { yield { delta: '', done: true, finishReason: candidate.finishReason }; return; }
          } catch { /* skip */ }
        }
      }
    } finally { try { reader.cancel(); } catch { /* ignore */ } }
  }

  async listModels(): Promise<ModelInfo[]> { return []; }
  async health(): Promise<HealthStatus> { return { ok: true, status: 'connected', latencyMs: 0 }; }
}
