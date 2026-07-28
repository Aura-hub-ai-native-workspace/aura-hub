import { BaseOpenAICompatible } from './base';
import type { Runtime } from '@aura/runtime';

export class OpenRouterAdapter extends BaseOpenAICompatible {
  readonly metadata = { id: 'openrouter', name: 'OpenRouter', description: 'Multi-provider AI router', docsUrl: 'https://openrouter.ai/keys' };
  protected baseUrl = 'https://openrouter.ai/api/v1';

  detect(_apiKey: string): boolean { return false; }

  createRuntime(apiKey: string, model?: string): Runtime {
    return this.makeRuntime({ baseUrl: this.baseUrl, apiKey, defaultModel: model || 'openai/gpt-4o' });
  }
}
