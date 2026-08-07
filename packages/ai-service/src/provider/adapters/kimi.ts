import { BaseOpenAICompatible } from './base';
import type { Runtime } from '@aura/runtime';

export class KimiAdapter extends BaseOpenAICompatible {
  readonly metadata = { id: 'kimi', name: 'Kimi', description: 'Moonshot AI models', docsUrl: 'https://platform.moonshot.cn/console/api-keys', defaultModel: 'kimi-latest' };
  protected baseUrl = 'https://api.moonshot.cn/v1';

  detect(_apiKey: string): boolean { return false; }

  createRuntime(apiKey: string, model?: string): Runtime {
    return this.makeRuntime({ baseUrl: this.baseUrl, apiKey, defaultModel: model || this.metadata.defaultModel });
  }
}
