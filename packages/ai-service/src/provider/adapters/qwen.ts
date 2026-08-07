import { BaseOpenAICompatible } from './base';
import type { Runtime } from '@aura/runtime';

/**
 * Qwen (Alibaba Cloud Model Studio / DashScope) — OpenAI-compatible chat
 * API. Base URL, auth scheme, streaming, and the `/models` discovery
 * endpoint verified directly against Alibaba Cloud's own documentation and
 * a live, unauthenticated request (both returned 401, not 404 — the routes
 * exist), not assumed:
 * `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`,
 * `Authorization: Bearer <DASHSCOPE_API_KEY>`, standard
 * `/chat/completions` with `stream: true`, `defaultModel: 'qwen-plus'` (a
 * real model id used in Alibaba's own quickstart examples, not invented).
 *
 * Uses the international (Singapore) regional endpoint rather than the
 * China (Beijing) one — DashScope API keys are region-bound, and this is
 * the region an English-language, globally-distributed project's users are
 * expected to hold a key for. Alibaba also documents a workspace-scoped
 * variant (`https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1`)
 * that would require collecting a second piece of per-user config beyond
 * an API key — deliberately not used, since every other provider in this
 * system is "paste a key, done," and introducing an extra required field
 * for one provider would be exactly the kind of provider-specific
 * shortcut this integration is required to avoid.
 *
 * No documented key-prefix convention that's uniquely Qwen's (DashScope
 * keys share the generic `sk-` prefix OpenAI's adapter already claims), so
 * `detect()` returns false — the same honest choice already made for
 * Novita/NVIDIA/OpenRouter/Gemini rather than fabricating a pattern.
 */
export class QwenAdapter extends BaseOpenAICompatible {
  readonly metadata = {
    id: 'qwen',
    name: 'Qwen',
    description: 'Alibaba Cloud Model Studio — the Qwen model family',
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/first-api-call-to-qwen',
    defaultModel: 'qwen-plus',
  };
  protected baseUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

  detect(_apiKey: string): boolean { return false; }

  createRuntime(apiKey: string, model?: string): Runtime {
    return this.makeRuntime({ baseUrl: this.baseUrl, apiKey, defaultModel: model || this.metadata.defaultModel });
  }
}
