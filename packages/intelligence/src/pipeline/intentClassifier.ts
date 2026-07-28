/**
 * Stage 1 — Intent Classifier
 * ==================================================================
 * Decides *what the user wants*. The interface is all the upper layers
 * know; the implementation is swappable (keyword heuristic today, a
 * fine-tuned classifier or an LLM router tomorrow) with zero ripple.
 */

import type { Intent, IntelligenceRequest, IntentType } from '../types';

export interface IntentClassifier {
  readonly id: string;
  classify(request: IntelligenceRequest): Promise<Intent>;
}

/**
 * KeywordIntentClassifier — a deterministic, dependency-free placeholder.
 * It scores intents from simple lexical signals. It exists to make the
 * pipeline runnable and to document the expected output shape; it is NOT
 * meant to be accurate. Replace it via config with a real classifier.
 */
export class KeywordIntentClassifier implements IntentClassifier {
  readonly id = 'keyword-intent-classifier';

  private static readonly SIGNALS: Record<IntentType, RegExp[]> = {
    generate: [/\b(write|create|generate|draft|build|make)\b/i],
    edit: [/\b(edit|refactor|rename|change|fix|update|modify)\b/i],
    summarize: [/\b(summari[sz]e|tl;?dr|shorten|condense)\b/i],
    search: [/\b(search|find|look up|where is|locate)\b/i],
    transform: [/\b(translate|convert|reformat|transform)\b/i],
    command: [/^\s*\//, /\b(run|open|deploy|start|stop|toggle)\b/i],
    question: [/\?\s*$/, /^\s*(what|why|how|when|who|which|can|does|is|are)\b/i],
    chat: [/\b(hi|hello|hey|thanks|thank you)\b/i],
    unknown: [],
  };

  async classify(request: IntelligenceRequest): Promise<Intent> {
    const text = request.input.trim();
    const scores = new Map<IntentType, number>();

    for (const [type, patterns] of Object.entries(KeywordIntentClassifier.SIGNALS) as [IntentType, RegExp[]][]) {
      let score = 0;
      for (const re of patterns) if (re.test(text)) score += 1;
      if (score > 0) scores.set(type, score);
    }

    if (scores.size === 0) {
      return { type: 'unknown', confidence: 0.2, rationale: 'no lexical signals matched' };
    }

    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const [topType, topScore] = ranked[0];
    const totalHits = ranked.reduce((s, [, v]) => s + v, 0);

    return {
      type: topType,
      confidence: Math.min(0.95, 0.45 + (topScore / totalHits) * 0.5),
      rationale: `matched ${topScore} signal(s) for "${topType}"`,
      alternatives: ranked.slice(1, 3).map(([type, v]) => ({ type, confidence: v / totalHits })),
    };
  }
}
