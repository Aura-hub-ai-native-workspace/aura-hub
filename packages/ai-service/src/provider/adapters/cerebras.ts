import { BaseOpenAICompatible } from './base';
import type { Runtime } from '@aura/runtime';

export class CerebrasAdapter extends BaseOpenAICompatible {
  readonly metadata = { id: 'cerebras', name: 'Cerebras', description: 'Fastest inference for Llama models', docsUrl: 'https://cloud.cerebras.ai/platform/api-keys' };
  protected baseUrl = 'https://api.cerebras.ai/v1';

  detect(apiKey: string): boolean { return apiKey.startsWith('csk_'); }

  createRuntime(apiKey: string, model?: string): Runtime {
    return this.makeRuntime({ baseUrl: this.baseUrl, apiKey, defaultModel: model || 'llama3.3-70b' });
  }
}
