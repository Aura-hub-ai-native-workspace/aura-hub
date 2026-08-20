import type { ProviderAdapter, DiscoveredModel, ProviderHealth, ModelCapabilities } from '../types';
import type { Runtime, GenerateRequest, GenerateResponse, StreamChunk, ModelInfo, HealthStatus, RuntimeMessage, RuntimeToolCall, RuntimeToolSpec, RuntimeToolChoice } from '@aura/runtime';
import { ProviderHttpError } from '../errorTranslator';

export class GeminiAdapter implements ProviderAdapter {
  readonly metadata = { id: 'gemini', name: 'Google Gemini', description: 'Gemini models by Google', docsUrl: 'https://aistudio.google.com/app/apikey', defaultModel: 'gemini-2.0-flash' };
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
    return new GeminiRuntime(apiKey, model || this.metadata.defaultModel);
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

  /**
   * Gemini has exactly two roles — `user` and `model` — and no tool role.
   * A model turn that called a function carries `functionCall` parts; the
   * answer comes back as a `user` turn carrying `functionResponse` parts,
   * matched by function NAME rather than by call id (Gemini has no call
   * ids on the wire). That is why `toolCallId` is not used here and
   * `name` is: dropping the name would leave the response unattributable.
   */
  private toMsgs(msgs: RuntimeMessage[]): { role: 'user' | 'model'; parts: Record<string, unknown>[] }[] {
    return msgs.filter((m) => m.role !== 'system').map((m) => {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const parts: Record<string, unknown>[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const c of m.toolCalls) {
          let args: unknown;
          try { args = JSON.parse(c.arguments || '{}'); } catch { args = { _unparsed: c.arguments }; }
          parts.push({ functionCall: { name: c.name, args } });
        }
        return { role: 'model' as const, parts };
      }
      if (m.role === 'tool') {
        return {
          role: 'user' as const,
          parts: [{ functionResponse: { name: m.name ?? '', response: { result: m.content } } }],
        };
      }
      return { role: m.role === 'assistant' ? 'model' as const : 'user' as const, parts: [{ text: m.content }] };
    });
  }

  /**
   * Gemini's function declarations use the OpenAPI subset, which has no
   * `additionalProperties`. Sending it is rejected, so it is stripped —
   * and only it, because everything else in a derived input schema (type,
   * properties, required, enum, array items) is inside the subset.
   *
   * A capability with no arguments gets NO `parameters` at all: Gemini
   * refuses an OBJECT schema with an empty property set, and an empty
   * object is exactly what a no-argument capability produces.
   */
  private static declaration(t: RuntimeToolSpec): Record<string, unknown> {
    const { additionalProperties: _dropped, ...schema } = t.parameters as { additionalProperties?: unknown } & Record<string, unknown>;
    const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    const base: Record<string, unknown> = { name: t.name, description: t.description };
    if (Object.keys(properties).length > 0) base.parameters = schema;
    return base;
  }

  private static toolFields(tools?: RuntimeToolSpec[], choice?: RuntimeToolChoice): Record<string, unknown> {
    if (!tools?.length) return {};
    const mode = choice === 'required' ? 'ANY' : choice === 'none' ? 'NONE' : 'AUTO';
    return {
      tools: [{ function_declarations: tools.map(GeminiRuntime.declaration) }],
      tool_config: { function_calling_config: { mode } },
    };
  }

  /** Function calls in one candidate, in the order the model emitted them. */
  private static toolCallsOf(parts: { functionCall?: { name?: string; args?: unknown } }[] | undefined, seq: { n: number }): RuntimeToolCall[] {
    return (parts ?? [])
      .filter((p) => p.functionCall)
      .map((p) => {
        seq.n += 1;
        return {
          // Gemini sends no call id, so one is synthesised for correlation
          // inside AURA. It is never sent back to Gemini — the response is
          // matched by function name — and it is never treated as
          // meaningful by anything else.
          id: `gemini-call-${seq.n}`,
          name: p.functionCall?.name ?? '',
          arguments: JSON.stringify(p.functionCall?.args ?? {}),
        };
      });
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
    Object.assign(p, GeminiRuntime.toolFields(request.tools, request.toolChoice));
    this.ac?.abort();
    this.ac = new AbortController();
    const signal = AbortSignal.any([this.ac.signal, AbortSignal.timeout(this.timeoutMs)]);
    const res = await fetch(`${this.url(model)}:generateContent${this.auth()}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p), signal });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new ProviderHttpError('Google Gemini', res.status, t || res.statusText); }
    const json = await res.json() as { candidates?: { content?: { parts?: { text?: string; functionCall?: { name?: string; args?: unknown } }[] }; finishReason?: string }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } };
    const candidate = json.candidates?.[0];
    const parts = candidate?.content?.parts;
    const toolCalls = GeminiRuntime.toolCallsOf(parts, { n: 0 });
    const response: GenerateResponse = {
      // Only text parts are text. A functionCall part has no `text`, and
      // joining it in produced a literal "undefined" in the answer.
      content: (parts ?? []).filter((x) => typeof x.text === 'string').map((x) => x.text ?? '').join(''),
      model,
      usage: { promptTokens: json.usageMetadata?.promptTokenCount ?? 0, completionTokens: json.usageMetadata?.candidatesTokenCount ?? 0, totalTokens: json.usageMetadata?.totalTokenCount ?? 0 },
      finishReason: candidate?.finishReason ?? 'stop',
    };
    if (toolCalls.length) response.toolCalls = toolCalls;
    return response;
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
    Object.assign(p, GeminiRuntime.toolFields(request.tools, request.toolChoice));
    this.ac?.abort();
    this.ac = new AbortController();
    const signal = AbortSignal.any([this.ac.signal, AbortSignal.timeout(this.timeoutMs)]);
    const res = await fetch(`${this.url(model)}:streamGenerateContent${this.auth()}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p), signal });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new ProviderHttpError('Google Gemini', res.status, t || res.statusText); }
    const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
    if (!reader) throw new Error('No stream body');
    let buf = '';
    // Shared across the whole stream so synthesised call ids stay unique
    // within one turn — two calls to the same function must not collide.
    const seq = { n: 0 };
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
            const parsed = JSON.parse(data) as { candidates?: { content?: { parts?: { text?: string; functionCall?: { name?: string; args?: unknown } }[] }; finishReason?: string }[] };
            const candidate = parsed.candidates?.[0];
            if (!candidate) continue;
            const parts = candidate.content?.parts;
            // Gemini does not fragment a functionCall the way OpenAI and
            // Anthropic do — each streamed chunk carries whole calls — so
            // there is nothing to assemble and they are emitted as they
            // arrive.
            for (const call of GeminiRuntime.toolCallsOf(parts, seq)) {
              yield { delta: '', done: false, toolCall: call };
            }
            const text = (parts ?? []).filter((x) => typeof x.text === 'string').map((x) => x.text ?? '').join('');
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
