import type { ProviderAdapter } from './types';
import { getAllAdapters } from './registry';

export enum DetectionStrategy {
  KeyPrefix,
  ValidationEndpoint,
}

const KEY_PREFIX_RULES: { prefix: string; providerId: string }[] = [
  { prefix: 'gsk_', providerId: 'groq' },
  { prefix: 'sk-ant-', providerId: 'anthropic' },
  { prefix: 'sk-', providerId: 'openai' },
  { prefix: 'csk_', providerId: 'cerebras' },
];

export function detectByKeyPrefix(apiKey: string): string | null {
  for (const rule of KEY_PREFIX_RULES) {
    if (apiKey.startsWith(rule.prefix)) return rule.providerId;
  }
  return null;
}

export async function detectProvider(apiKey: string): Promise<{ adapter: ProviderAdapter; strategy: DetectionStrategy } | null> {
  const prefixMatch = detectByKeyPrefix(apiKey);
  if (prefixMatch) {
    const adapters = getAllAdapters();
    const adapter = adapters.find((a) => a.metadata.id === prefixMatch);
    if (adapter) {
      const result = await adapter.validate(apiKey);
      if (result.ok) return { adapter, strategy: DetectionStrategy.KeyPrefix };
    }
  }

  const adapters = getAllAdapters();
  for (const adapter of adapters) {
    try {
      const result = await adapter.validate(apiKey);
      if (result.ok) return { adapter, strategy: DetectionStrategy.ValidationEndpoint };
    } catch {
      continue;
    }
  }

  return null;
}
