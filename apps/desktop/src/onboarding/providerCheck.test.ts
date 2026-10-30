/**
 * decideProviderCheck — a service that has not answered is not "setup needed".
 */
import { describe, expect, it } from 'vitest';
import { decideProviderCheck } from './providerCheck';

const configured = { active: 'ollama', activeModel: 'qwen2.5-coder:1.5b' };

describe('decideProviderCheck', () => {
  it('is ready when a provider, a model and a healthy service are all present', () => {
    expect(decideProviderCheck({ providers: configured, healthOk: true })).toBe('ready');
  });

  it('retries while the service has not answered yet (boot race), instead of asking for setup', () => {
    expect(decideProviderCheck({ providers: null, healthOk: null })).toBe('retry');
    expect(decideProviderCheck({ providers: configured, healthOk: null })).toBe('retry');
    expect(decideProviderCheck({ providers: null, healthOk: true })).toBe('retry');
  });

  it('asks for setup only when the services answered and the configuration is missing', () => {
    expect(decideProviderCheck({ providers: { active: null, activeModel: '' }, healthOk: true })).toBe('needs-setup');
    expect(decideProviderCheck({ providers: { active: 'ollama', activeModel: '' }, healthOk: true })).toBe('needs-setup');
    expect(decideProviderCheck({ providers: configured, healthOk: false })).toBe('needs-setup');
  });
});
