/**
 * Stage 2 — Prompt Enhancer
 * ==================================================================
 * Normalizes and enriches the raw prompt before context is gathered:
 * trims noise, expands intent-specific framing, and surfaces structured
 * directives. Purely transformational — no model calls.
 */

import type { EnhancedPrompt, Intent, IntelligenceRequest, IntentType } from '../types';

export interface PromptEnhancer {
  readonly id: string;
  enhance(request: IntelligenceRequest, intent: Intent): Promise<EnhancedPrompt>;
}

/**
 * TemplatePromptEnhancer — placeholder that applies per-intent framing
 * templates and light cleanup. It documents how an enhancer should shape
 * `EnhancedPrompt`; swap for a smarter rewriter later.
 */
export class TemplatePromptEnhancer implements PromptEnhancer {
  readonly id = 'template-prompt-enhancer';

  private static readonly FRAMING: Partial<Record<IntentType, string[]>> = {
    generate: ['Produce a complete, well-structured result.', 'Prefer clarity over cleverness.'],
    edit: ['Preserve intent and surrounding style.', 'Return only what changed unless asked otherwise.'],
    summarize: ['Capture the essential points faithfully.', 'Do not introduce new information.'],
    search: ['Interpret the query as a retrieval request.', 'Rank by relevance.'],
    question: ['Answer directly first, then elaborate.', 'State uncertainty explicitly.'],
    transform: ['Preserve meaning across the transformation.'],
    command: ['Treat this as an imperative action request.'],
    chat: ['Keep the tone calm, concise and helpful.'],
  };

  async enhance(request: IntelligenceRequest, intent: Intent): Promise<EnhancedPrompt> {
    const original = request.input;
    const cleaned = original.replace(/\s+/g, ' ').trim();

    const directives: Record<string, unknown> = {};
    if (/\bin (json|markdown|table|bullet points?)\b/i.test(cleaned)) {
      directives.format = /json/i.test(cleaned) ? 'json' : /table/i.test(cleaned) ? 'table' : 'markdown';
    }
    if (/\b(brief|short|concise)\b/i.test(cleaned)) directives.length = 'short';
    if (/\b(detailed|thorough|in depth)\b/i.test(cleaned)) directives.length = 'long';

    const systemHints = TemplatePromptEnhancer.FRAMING[intent.type] ?? ['Be helpful, precise and calm.'];

    return {
      original,
      enhanced: cleaned,
      systemHints,
      directives: Object.keys(directives).length ? directives : undefined,
    };
  }
}
