import { BaseOpenAICompatible } from './base';
import type { Runtime } from '@aura/runtime';

export class NvidiaAdapter extends BaseOpenAICompatible {
  readonly metadata = { id: 'nvidia', name: 'NVIDIA', description: 'NVIDIA NIM and AI models', docsUrl: 'https://build.nvidia.com' };
  protected baseUrl = 'https://integrate.api.nvidia.com/v1';

  detect(_apiKey: string): boolean { return false; }

  async discoverModels(apiKey: string): Promise<import('../types').DiscoveredModel[]> {
    try {
      const res = await fetch('https://api.nvcf.nvidia.com/v2/nvcf/assets', {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const json = await res.json() as { assets?: { id: string; name: string; description?: string }[] };
        if (json.assets?.length) {
          return json.assets.map((a) => ({ id: a.id, name: a.name, capabilities: { streaming: true } }));
        }
      }
      return await super.discoverModels(apiKey);
    } catch { return await super.discoverModels(apiKey); }
  }

  createRuntime(apiKey: string, model?: string): Runtime {
    return this.makeRuntime({ baseUrl: this.baseUrl, apiKey, defaultModel: model || 'meta/llama-3.1-8b-instruct' });
  }
}
