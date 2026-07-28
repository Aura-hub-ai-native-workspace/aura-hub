import { BaseOpenAICompatible } from './base';
import type { Runtime } from '@aura/runtime';

export class GroqAdapter extends BaseOpenAICompatible {
  readonly metadata = { id: 'groq', name: 'Groq', description: 'Fast inference cloud (free tier available)', docsUrl: 'https://console.groq.com/keys' };
  protected baseUrl = 'https://api.groq.com/openai/v1';

  detect(apiKey: string): boolean { return apiKey.startsWith('gsk_'); }

  createRuntime(apiKey: string, model?: string): Runtime {
    return this.makeRuntime({ baseUrl: this.baseUrl, apiKey, defaultModel: model || 'llama-3.3-70b-versatile' });
  }
}
