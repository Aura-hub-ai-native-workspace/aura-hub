/**
 * Client-side "which provider does this key look like" heuristic — purely
 * a UX nicety (instant icon/label feedback while typing). It never decides
 * whether a key actually works; only the real backend call
 * (`aiClient.connectProvider`) does that. Ordered longest-prefix-first so
 * e.g. `sk-ant-…` matches Anthropic before the bare `sk-` OpenAI rule.
 */
const RULES: { prefix: string; providerId: string }[] = [
  { prefix: 'sk-ant-', providerId: 'anthropic' },
  { prefix: 'sk-or-', providerId: 'openrouter' },
  { prefix: 'gsk_', providerId: 'groq' },
  { prefix: 'nvapi-', providerId: 'nvidia' },
  { prefix: 'AIza', providerId: 'gemini' },
  { prefix: 'sk-', providerId: 'openai' },
];

export function detectProviderId(apiKey: string): string | null {
  const key = apiKey.trim();
  if (!key) return null;
  for (const rule of RULES) {
    if (key.startsWith(rule.prefix)) return rule.providerId;
  }
  return null;
}
