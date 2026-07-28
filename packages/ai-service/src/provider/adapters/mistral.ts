import { BaseOpenAICompatible } from './base';
import type { Runtime } from '@aura/runtime';

export class MistralAdapter extends BaseOpenAICompatible {
  readonly metadata = { id: 'mistral', name: 'Mistral', description: 'Mistral AI models', docsUrl: 'https://console.mistral.ai/api-keys' };
  protected baseUrl = 'https://api.mistral.ai/v1';

  detect(_apiKey: string): boolean { return false; }

  createRuntime(apiKey: string, model?: string): Runtime {
    return this.makeRuntime({ baseUrl: this.baseUrl, apiKey, defaultModel: model || 'mistral-large-latest' });
  }
}
