import { BaseOpenAICompatible } from './base';
import type { Runtime } from '@aura/runtime';

export class OpenAIAdapter extends BaseOpenAICompatible {
  readonly metadata = { id: 'openai', name: 'OpenAI', description: 'GPT models by OpenAI', docsUrl: 'https://platform.openai.com/api-keys', defaultModel: 'gpt-4o' };
  protected baseUrl = 'https://api.openai.com/v1';

  detect(apiKey: string): boolean { return apiKey.startsWith('sk-'); }

  createRuntime(apiKey: string, model?: string): Runtime {
    return this.makeRuntime({ baseUrl: this.baseUrl, apiKey, defaultModel: model || this.metadata.defaultModel });
  }
}
