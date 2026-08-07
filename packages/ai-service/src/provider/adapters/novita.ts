import { BaseOpenAICompatible } from './base';
import type { Runtime } from '@aura/runtime';

/**
 * Novita AI — OpenAI-compatible inference cloud (DeepSeek, Llama, Qwen and
 * more). Base URL, auth scheme and streaming support verified against
 * Novita's own API reference, not assumed: `https://api.novita.ai/openai/v1`,
 * `Authorization: Bearer <key>`, standard `/chat/completions` with
 * `stream: true`. No documented key-prefix convention, so `detect()`
 * returns false — the same honest choice already made for NVIDIA/
 * OpenRouter rather than fabricating a pattern.
 */
export class NovitaAdapter extends BaseOpenAICompatible {
  readonly metadata = {
    id: 'novita',
    name: 'Novita AI',
    description: 'Open-model inference cloud — DeepSeek, Llama, Qwen and more',
    docsUrl: 'https://novita.ai/docs/api-reference/basic-authentication',
    defaultModel: 'deepseek/deepseek-r1',
  };
  protected baseUrl = 'https://api.novita.ai/openai/v1';

  detect(_apiKey: string): boolean { return false; }

  createRuntime(apiKey: string, model?: string): Runtime {
    return this.makeRuntime({ baseUrl: this.baseUrl, apiKey, defaultModel: model || this.metadata.defaultModel });
  }
}
