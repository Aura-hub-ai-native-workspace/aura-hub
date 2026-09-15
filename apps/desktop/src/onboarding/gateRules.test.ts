import { describe, expect, it } from 'vitest';
import { canVerify, providerGate, type SetupPhase } from './gateRules';

/**
 * These cover the two ways the first screen managed to trap a user.
 */
describe('canVerify', () => {
  const base = { baseUrl: 'http://192.168.1.50:11434', model: 'qwen3:4b', detectedKind: 'lan', phase: 'idle' as SetupPhase };

  it('allows verifying before the provider listing has arrived', () => {
    // The regression: AURA's service starts behind this screen, and the
    // button used to stay disabled for the whole session if that race was
    // lost. Nothing about the listing appears here by design.
    expect(canVerify(base)).toBe(true);
  });

  it('needs both fields', () => {
    expect(canVerify({ ...base, baseUrl: '' })).toBe(false);
    expect(canVerify({ ...base, model: '' })).toBe(false);
    expect(canVerify({ ...base, baseUrl: '   ', model: '  ' })).toBe(false);
  });

  it('refuses an address that is not a URL', () => {
    expect(canVerify({ ...base, detectedKind: 'invalid' })).toBe(false);
  });

  it('cannot be pressed twice while a check is running or done', () => {
    expect(canVerify({ ...base, phase: 'verifying' })).toBe(false);
    expect(canVerify({ ...base, phase: 'passed' })).toBe(false);
    // A failed attempt must be retryable.
    expect(canVerify({ ...base, phase: 'failed' })).toBe(true);
  });

  it('accepts every kind of server location', () => {
    for (const kind of ['this-machine', 'lan', 'remote', 'unknown']) {
      expect(canVerify({ ...base, detectedKind: kind })).toBe(true);
    }
  });
});

describe('providerGate', () => {
  it('trusts a setup completed in this session', () => {
    // Verification already proved the server with a real generation;
    // re-asking threw the user back onto the screen they had finished.
    expect(providerGate(true, false)).toBe('ready');
  });

  it('re-checks a configuration saved by an earlier run', () => {
    expect(providerGate(true, true)).toBe('checking');
  });

  it('sends a new user to setup', () => {
    expect(providerGate(false, false)).toBe('needs-setup');
    expect(providerGate(false, true)).toBe('needs-setup');
  });
});
