import { BaseOpenAICompatible } from './base';
import type { Runtime } from '@aura/runtime';

/**
 * Demon Route — OpenAI-compatible inference gateway centered on the long
 * tail of open-weight fine-tunes: abliterated/uncensored checkpoints,
 * coding merges, and roleplay/writing models the hosted catalogs do not
 * carry. Base URL, auth scheme and streaming support verified against
 * Demon Route's own documentation, not assumed:
 * `https://api.demonroute.com/v1`, `Authorization: Bearer <key>`,
 * standard `/chat/completions` with `stream: true`, plus
 * `GET /v1/models` for model discovery. No documented key-prefix
 * convention, so `detect()` returns false — the same honest choice
 * already made for Novita/NVIDIA/OpenRouter rather than fabricating a
 * pattern.
 */
export class DemonRouteAdapter extends BaseOpenAICompatible {
  readonly metadata = {
    id: 'demonroute',
    name: 'Demon Route',
    description: 'Open-weight fine-tune gateway — abliterated, coding and roleplay models',
    docsUrl: 'https://demonroute.com/docs',
    defaultModel: 'glm-5.3-flash',
  };
  protected baseUrl = 'https://api.demonroute.com/v1';

  detect(_apiKey: string): boolean { return false; }

  createRuntime(apiKey: string, model?: string): Runtime {
    return this.makeRuntime({ baseUrl: this.baseUrl, apiKey, defaultModel: model || this.metadata.defaultModel });
  }
}
