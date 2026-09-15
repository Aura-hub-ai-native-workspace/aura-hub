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

/**
 * The case that trapped a real user, written down so it cannot come back.
 *
 * `providerGate` is a pure decision about the FIRST render. It cannot
 * express "onboarding just finished", and the bug was asking it to: the
 * gate was recomputed only when `onboarded` changed, so a user who had
 * onboarded before — and was sent back through setup because their saved
 * server no longer answered — finished the flow with nothing changing,
 * and sat on the final screen indefinitely.
 */
describe('re-onboarding, the stuck case', () => {
  it('a user who was already onboarded gets no gate change when they finish again', () => {
    // Launch: flag set from a previous run, saved server does not validate.
    const onboardedAtLaunch = true;
    expect(providerGate(onboardedAtLaunch, onboardedAtLaunch)).toBe('checking');
    // …the async check then lands on 'needs-setup' and setup is shown.

    // They complete setup. `onboarded` was already true, so it does not
    // change — and re-running the same pure rule returns the same answer.
    // Nothing here can rescue them, which is why completion must signal
    // the gate explicitly rather than be inferred from this input.
    expect(providerGate(true, true)).toBe('checking');
  });

  it('a first-time user is rescued by the flag flipping', () => {
    // This is the path that worked, and the reason the bug hid: a clean
    // profile starts false, so completion changes the input.
    expect(providerGate(false, false)).toBe('needs-setup');
    expect(providerGate(true, false)).toBe('ready');
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
