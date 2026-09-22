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
import { NovitaAdapter } from './adapters/novita';
import { QwenAdapter } from './adapters/qwen';
import { ScaleMaxAdapter } from './adapters/scalemax';
import { Kage7Adapter } from './adapters/kage7';
import { OllamaAdapter } from './adapters/ollama';

/*
 * Local first, cloud as a fallback.
 *
 * AURA's default is a model server the user runs: nothing leaves the
 * machine, nothing needs an account, and the only thing AURA cannot guess
 * is the address. The bring-your-own-key providers below it still work and
 * are still reachable from Settings — they are simply no longer the thing
 * a new user is asked for before the hub will do anything.
 *
 * There is still NO built-in hosted default. The hub has no AI until the
 * user points it at their own server or connects their own key.
 */
const ALL: ProviderAdapter[] = [
  new OllamaAdapter(),
  new GroqAdapter(),
  new OpenAIAdapter(),
  new AnthropicAdapter(),
  new GeminiAdapter(),
  new NvidiaAdapter(),
  new OpenRouterAdapter(),
  new MistralAdapter(),
  new CerebrasAdapter(),
  new KimiAdapter(),
  new NovitaAdapter(),
  new QwenAdapter(),
  new ScaleMaxAdapter(),
  new Kage7Adapter(),
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
  // The gateway URL is separate configuration (KAGE7_BASE_URL, read by the
  // adapter) — only the key belongs here, and only ever from the
  // environment: it is encrypted into the credential store on connect and
  // never written to source, config or logs.
  // ScaleMax issues `sm_live_…` keys; the billing surface (token-budget
  // `/token/v1` vs credit `/v1`) is separate configuration
  // (SCALEMAX_BASE_URL, read by the adapter) — only the key belongs here,
  // and only ever from the environment: it is encrypted into the
  // credential store on connect and never written to source, config or logs.
  scalemax: 'SCALEMAX_API_KEY',
  kage7: 'KAGE7_API_KEY',
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
