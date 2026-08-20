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
import { Kage7Adapter } from './adapters/kage7';
import { OllamaAdapter } from './adapters/ollama';
import { LMStudioAdapter } from './adapters/lmstudio';
import { enrichCapabilities } from './modelCatalog';
import type { LocalAdapter } from './adapters/local';

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
  new NovitaAdapter(),
  new QwenAdapter(),
  new Kage7Adapter(),
  /* Local, on this machine, no key and no network. Listed last so the
     catalogue order that decides ties still prefers a provider the user
     explicitly configured, and present at all so that AURA has an answer
     when there is no internet and no third-party key. */
  new OllamaAdapter(),
  new LMStudioAdapter(),
];

/**
 * Providers whose model runs on this machine.
 *
 * The distinction is load-bearing, not cosmetic: it is what the router's
 * privacy gate tests when context is marked `secret`, and what "AURA works
 * offline" means concretely. It is asserted by the adapter itself
 * (`local: true`) rather than inferred from an id, so a new local adapter
 * is local by construction.
 */
export function isLocalAdapter(adapter: ProviderAdapter | undefined): adapter is LocalAdapter {
  return Boolean(adapter && (adapter as Partial<LocalAdapter>).local === true);
}

export function localAdapters(): LocalAdapter[] {
  return getAllAdapters().filter(isLocalAdapter);
}

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
  kage7: 'KAGE7_API_KEY',
  /* Local providers carry an ENDPOINT in the credential slot rather than
     a secret (see adapters/local.ts). These are the variable names their
     own tooling already uses, so a machine that has configured Ollama or
     LM Studio for anything else is configured for AURA too. */
  ollama: 'OLLAMA_HOST',
  lmstudio: 'LMSTUDIO_BASE_URL',
};

export function registerAdapter(adapter: ProviderAdapter): void {
  adapters.set(adapter.metadata.id, adapter);
}

/**
 * THE accessor for an adapter — and the single place published per-model
 * facts are folded in.
 *
 * `ModelCapabilities.contextWindow` / `inputCostPer1k` / `outputCostPer1k`
 * existed and were populated by nobody. Rather than teach twelve adapters
 * to look them up (twelve places to forget), the registry decorates
 * `discoverModels()` once, here, on the way out. Adapter findings win;
 * the catalogue only fills what the API did not say.
 */
export function getAdapter(id: string): ProviderAdapter | undefined {
  const adapter = adapters.get(id);
  if (!adapter) return undefined;
  const decorated = decorated_.get(adapter);
  if (decorated) return decorated;
  const wrapped: ProviderAdapter = Object.create(adapter, {
    discoverModels: {
      value: async (apiKey: string) => {
        const models = await adapter.discoverModels(apiKey);
        return models.map((m) => ({ ...m, capabilities: enrichCapabilities(adapter.metadata.id, m.id, m.capabilities) }));
      },
    },
  }) as ProviderAdapter;
  decorated_.set(adapter, wrapped);
  return wrapped;
}

/** Memoised so `getAdapter()` returns a stable object identity. */
const decorated_ = new WeakMap<ProviderAdapter, ProviderAdapter>();

export function getAllAdapters(): ProviderAdapter[] {
  return Array.from(adapters.values());
}
