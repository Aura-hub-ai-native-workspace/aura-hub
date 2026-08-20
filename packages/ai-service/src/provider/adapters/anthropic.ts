import type { ProviderAdapter, DiscoveredModel, ProviderHealth, ModelCapabilities } from '../types';
import type { Runtime, GenerateRequest, GenerateResponse, StreamChunk, ModelInfo, HealthStatus, RuntimeMessage, RuntimeToolCall, RuntimeToolSpec, RuntimeToolChoice } from '@aura/runtime';
import { ProviderHttpError } from '../errorTranslator';

const ANTHROPIC_MODELS: { id: string; name: string; caps: Partial<ModelCapabilities> }[] = [
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', caps: { contextWindow: 200000, vision: true, reasoning: true, streaming: true, toolCalling: true, jsonMode: true } },
  { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', caps: { contextWindow: 200000, vision: true, reasoning: true, streaming: true, toolCalling: true, jsonMode: true } },
  { id: 'claude-sonnet-4-20241022', name: 'Claude Sonnet 4 (Legacy)', caps: { contextWindow: 200000, vision: true, reasoning: true, streaming: true, toolCalling: true, jsonMode: true } },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', caps: { contextWindow: 200000, vision: true, streaming: true, toolCalling: true, jsonMode: true } },
];

export class AnthropicAdapter implements ProviderAdapter {
  readonly metadata = { id: 'anthropic', name: 'Anthropic', description: 'Claude models by Anthropic', docsUrl: 'https://console.anthropic.com/settings/keys', defaultModel: 'claude-sonnet-4-20250514' };

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
    return new AnthropicRuntime(apiKey, model || this.metadata.defaultModel);
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

  /**
   * One message in Anthropic's wire shape.
   *
   * Anthropic has no `tool` role: a result is a `user` turn carrying a
   * `tool_result` block that names the `tool_use` it answers. Getting that
   * pairing wrong is rejected outright by the API, which is the good
   * failure mode — the bad one would be a silently dropped result.
   *
   * `arguments` is re-parsed here because the API wants `input` as an
   * object, not a string. A model that emitted malformed JSON therefore
   * cannot have its call replayed, so the raw text is sent as a single
   * unnamed field rather than being invented into a shape — the loop has
   * already refused such a call by the time it would be replayed.
   */
  private static wireMessage(m: RuntimeMessage): { role: 'user' | 'assistant'; content: unknown } {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) {
        let input: unknown;
        try { input = JSON.parse(c.arguments || '{}'); } catch { input = { _unparsed: c.arguments }; }
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input });
      }
      return { role: 'assistant', content: blocks };
    }
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }],
      };
    }
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content };
  }

  private static toolFields(tools?: RuntimeToolSpec[], choice?: RuntimeToolChoice): Record<string, unknown> {
    if (!tools?.length) return {};
    // Anthropic spells `required` as `any`; `auto` and `none` match.
    const type = choice === 'required' ? 'any' : (choice ?? 'auto');
    return {
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      tool_choice: { type },
    };
  }

  private buildBody(messages: RuntimeMessage[], opts: { model?: string; temperature?: number; maxTokens?: number; stream: boolean; tools?: RuntimeToolSpec[]; toolChoice?: RuntimeToolChoice }) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const msgs = messages.filter((m) => m.role !== 'system').map(AnthropicRuntime.wireMessage);
    const model = opts.model || this.defaultModel;
    const p: Record<string, unknown> = {
      model, messages: msgs, max_tokens: opts.maxTokens ?? 4096, stream: opts.stream,
      ...AnthropicRuntime.toolFields(opts.tools, opts.toolChoice),
    };
    if (system) p.system = system;
    if (opts.temperature !== undefined) p.temperature = opts.temperature;
    return JSON.stringify(p);
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const msgs: RuntimeMessage[] = [...(request.system ? [{ role: 'system' as const, content: request.system }] : []), ...request.messages];
    const body = this.buildBody(msgs, { model: request.model, temperature: request.temperature, maxTokens: request.maxTokens, stream: false, tools: request.tools, toolChoice: request.toolChoice });
    this.ac?.abort();
    this.ac = new AbortController();
    const signal = AbortSignal.any([this.ac.signal, AbortSignal.timeout(this.timeoutMs)]);
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: this.headers(), body, signal });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new ProviderHttpError('Anthropic', res.status, t || res.statusText); }
    const json = await res.json() as { content: { type?: string; text?: string; id?: string; name?: string; input?: unknown }[]; model: string; stop_reason?: string; usage?: { input_tokens: number; output_tokens: number } };
    const usage = json.usage;
    const blocks = json.content ?? [];
    const toolCalls: RuntimeToolCall[] = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id ?? '', name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) }));
    const response: GenerateResponse = {
      // Only text blocks are text. Before tools existed every block was a
      // text block, so `.map(c => c.text)` was correct; it would now
      // concatenate `undefined` for every tool_use block.
      content: blocks.filter((b) => b.type === undefined || b.type === 'text').map((b) => b.text ?? '').join(''),
      model: json.model ?? this.defaultModel,
      usage: usage
        ? { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens, totalTokens: usage.input_tokens + usage.output_tokens }
        : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      // Reported rather than assumed. `tool_use` is a distinct stop reason
      // and a caller that cannot see it cannot tell a finished answer from
      // one that is waiting on a tool.
      finishReason: json.stop_reason ?? 'stop',
    };
    if (toolCalls.length) response.toolCalls = toolCalls;
    return response;
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const msgs: RuntimeMessage[] = [...(request.system ? [{ role: 'system' as const, content: request.system }] : []), ...request.messages];
    const body = this.buildBody(msgs, { model: request.model, temperature: request.temperature, maxTokens: request.maxTokens, stream: true, tools: request.tools, toolChoice: request.toolChoice });
    this.ac?.abort();
    this.ac = new AbortController();
    const signal = AbortSignal.any([this.ac.signal, AbortSignal.timeout(this.timeoutMs)]);
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: this.headers(), body, signal });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new ProviderHttpError('Anthropic', res.status, t || res.statusText); }
    const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
    if (!reader) throw new Error('No stream body');
    let buf = '';
    /**
     * Anthropic streams a tool call across three events: `content_block_start`
     * carries the id and name, `input_json_delta` fragments carry the
     * arguments, and `content_block_stop` closes it. Only at the stop is
     * the call complete enough to hand on — the fragments are not valid
     * JSON on their own, and emitting one early would produce a call whose
     * arguments are a truncated object.
     */
    let open: { index: number; id: string; name: string; arguments: string } | null = null;
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
            const ev = JSON.parse(data) as {
              type: string;
              index?: number;
              delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
              content_block?: { type?: string; text?: string; id?: string; name?: string };
              message?: { stop_reason?: string };
            };
            if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
              open = { index: ev.index ?? 0, id: ev.content_block.id ?? '', name: ev.content_block.name ?? '', arguments: '' };
              continue;
            }
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta' && open) {
              open.arguments += ev.delta.partial_json ?? '';
              continue;
            }
            if (ev.type === 'content_block_stop' && open) {
              yield { delta: '', done: false, toolCall: { id: open.id, name: open.name, arguments: open.arguments || '{}' } };
              open = null;
              continue;
            }
            if (ev.type === 'content_block_delta' && ev.delta?.text) yield { delta: ev.delta.text, done: false };
            if (ev.type === 'message_stop' || ev.type === 'message_delta') {
              // The real stop reason, when the event carries one. `tool_use`
              // is what tells a caller the turn ended to ask for a tool
              // rather than because the answer was finished.
              yield { delta: '', done: true, finishReason: ev.delta?.stop_reason ?? ev.message?.stop_reason ?? 'stop' };
              return;
            }
          } catch { /* skip */ }
        }
      }
    } finally { try { reader.cancel(); } catch { /* ignore */ } }
  }

  async listModels(): Promise<ModelInfo[]> { return []; }
  async health(): Promise<HealthStatus> { return { ok: true, status: 'connected', latencyMs: 0 }; }
}
