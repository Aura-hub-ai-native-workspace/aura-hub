import type { ProviderAdapter } from './types';
import { GroqAdapter } from './adapters/groq';
import { OpenAIAdapter } from './adapters/openai';
import { AnthropicAdapter } from './adapters/anthropic';
import { GeminiAdapter } from './adapters/gemini';
import { NvidiaAdapter } from './adapters/nvidia';
import { OpenRouterAdapter } from './adapters/openrouter';
import { MistralAdapter } from './adapters/mistral';
import { CerebrasAdapter } from './adapters/cerebras';
import { KimiAdapter } from './adapters/kimi';

// Bring-your-own-key providers. There is NO built-in default — the hub has
// no AI until the user connects one of these with their own API key.
const ALL: ProviderAdapter[] = [
  new GroqAdapter(),
  new OpenAIAdapter(),
  new AnthropicAdapter(),
  new GeminiAdapter(),
  new NvidiaAdapter(),
  new OpenRouterAdapter(),
  new MistralAdapter(),
  new CerebrasAdapter(),
  new KimiAdapter(),
];

const adapters: Map<string, ProviderAdapter> = new Map(ALL.map((a) => [a.metadata.id, a]));

/**
 * Environment variable that supplies the API key for a provider, if any.
 * A set variable auto-connects (and activates) that provider at startup —
 * e.g. MISTRAL_API_KEY configures Mistral without opening Settings.
 */
export const ENV_VAR_BY_PROVIDER: Record<string, string> = {
  mistral: 'MISTRAL_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
};

export function registerAdapter(adapter: ProviderAdapter): void {
  adapters.set(adapter.metadata.id, adapter);
}

export function getAdapter(id: string): ProviderAdapter | undefined {
  return adapters.get(id);
}

export function getAllAdapters(): ProviderAdapter[] {
  return Array.from(adapters.values());
}
