/**
 * providerGroups — Add Provider dialog shows SELF-HOSTED primary vs
 * FALLBACK cloud, never cloud-as-primary.
 *
 * The dialog's contract with the service is the `selfHosted` flag:
 * addressed servers are the primary inference path, every key-based
 * cloud provider is fallback-only. These tests pin the partition —
 * including the fail-closed default (a flag-less entry is cloud).
 *
 * Run with `npm run test:front` from the repo root.
 */
import { describe, expect, it } from 'vitest';
import type { ProviderInfo } from '../../ai/aiClient';
import { splitProviders } from './AiSettings';

function info(id: string, selfHosted?: boolean): ProviderInfo {
  return { id, name: id, description: `${id} provider`, selfHosted };
}

describe('splitProviders', () => {
  it('puts the self-hosted server in primary and cloud keys in fallback', () => {
    const { served, cloud } = splitProviders([
      info('openai'), info('ollama', true), info('groq'),
    ]);
    expect(served.map((p) => p.id)).toEqual(['ollama']);
    expect(cloud.map((p) => p.id)).toEqual(['openai', 'groq']);
  });

  it('treats a missing flag as cloud, never as primary', () => {
    const { served, cloud } = splitProviders([
      { id: 'mystery', name: 'Mystery', description: 'no flag' },
    ]);
    expect(served).toEqual([]);
    expect(cloud.map((p) => p.id)).toEqual(['mystery']);
  });

  it('handles an empty catalog without a primary', () => {
    expect(splitProviders([])).toEqual({ served: [], cloud: [] });
  });
});
