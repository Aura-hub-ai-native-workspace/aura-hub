/**
 * agentView — what the Central Agent may know about the active provider.
 * ==================================================================
 * The provider store (credentialStore.ts) is the one source of truth for
 * which model AURA reasons with, and it holds encrypted credentials. The
 * Python Central Agent is a separate process that must not read, decrypt or
 * even parse that file. So after every change to the store this module
 * publishes a small, secret-free projection to `<AURA_HOME>/agent/
 * providers.settings.json`, which the agent reads (model_routing.py).
 *
 * What it carries: the active provider id, its model, and — only for a
 * self-hosted provider, whose "key" is a network address and needs no
 * authentication — the address to call. For a provider that needs an API key
 * it says `callable: false` and why; the key never leaves this process.
 *
 * Precedence is documented in docs/AURA_CENTRAL_AGENT_API.md: entries in the
 * operator's own `agent/providers.json` win over this projection.
 */
import { homePath, writeJsonFile } from '../persist';
import * as credentialStore from './credentialStore';
import { getAdapter } from './registry';
import { normaliseOllamaUrl } from './adapters/ollama';

export const AGENT_VIEW_SCHEMA = 1;

export interface AgentView {
  schema: number;
  source: 'ai-service-settings';
  updatedAt: string;
  active: null | {
    providerId: string;
    model: string;
    callable: boolean;
    /** Present when callable: the OpenAI-compatible base URL. Never a key. */
    baseUrl?: string;
    reason?: string;
  };
}

export function buildAgentView(now: Date = new Date()): AgentView {
  const view: AgentView = { schema: AGENT_VIEW_SCHEMA, source: 'ai-service-settings', updatedAt: now.toISOString(), active: null };
  const { providerId, model } = credentialStore.getActive();
  if (!providerId) return view;
  const adapter = getAdapter(providerId);
  const selfHosted = (adapter?.metadata as { selfHosted?: boolean } | undefined)?.selfHosted === true;
  if (!selfHosted) {
    view.active = { providerId, model, callable: false, reason: 'needs-api-key: the key is held by the AURA service and is not shared with the Central Agent' };
    return view;
  }
  const address = credentialStore.getKey(providerId);
  const base = address ? normaliseOllamaUrl(address) : '';
  view.active = base
    ? { providerId, model, callable: Boolean(model), baseUrl: `${base}/v1`, ...(model ? {} : { reason: 'no-model: no model is selected for this provider' }) }
    : { providerId, model, callable: false, reason: 'no-address: the saved address could not be read' };
  return view;
}

export function agentViewPath(): string {
  return homePath('agent', 'providers.settings.json');
}

export function publishAgentView(): void {
  writeJsonFile(agentViewPath(), buildAgentView());
}

/** Publish now (boot) and after every later change to the store. */
export function startAgentViewSync(): void {
  credentialStore.onStoreChanged(() => publishAgentView());
  try { publishAgentView(); } catch (e) { console.warn('[providers] could not publish the agent view:', (e as Error).message); }
}
