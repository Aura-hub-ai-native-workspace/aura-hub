/**
 * The two decisions that decide whether a user can leave this screen.
 *
 * Extracted because both were got wrong once and the mistakes were the
 * same shape: a condition that looked reasonable in place and could not be
 * exercised without running the whole app. Tests against a restatement of
 * the logic would have agreed with the bug.
 */
export type SetupPhase = 'idle' | 'verifying' | 'failed' | 'passed';
export type ProviderGate = 'checking' | 'ready' | 'needs-setup';

/**
 * Whether "Verify and Continue" may be pressed.
 *
 * Deliberately does NOT depend on the provider listing having loaded.
 * AURA's service starts behind this screen, and gating the button on a
 * request the user can neither see nor retry meant a lost race disabled
 * the only way forward for the rest of the session — with a filled-in
 * address, a correct model, and no explanation on screen.
 */
export function canVerify(input: {
  baseUrl: string;
  model: string;
  detectedKind: string;
  phase: SetupPhase;
}): boolean {
  return input.baseUrl.trim().length > 0
    && input.model.trim().length > 0
    && input.detectedKind !== 'invalid'
    && input.phase !== 'verifying'
    && input.phase !== 'passed';
}

/**
 * Whether a saved configuration should be re-challenged on this render.
 *
 * `completedEarlier` is the onboarding flag as it stood when the app
 * started. A setup finished during THIS session was just proved by a real
 * streamed generation, so re-asking can only produce a wrong answer — and
 * when it did, it threw the user back onto the screen they had finished.
 */
export function providerGate(onboarded: boolean, completedEarlier: boolean): ProviderGate {
  if (!onboarded) return 'needs-setup';
  if (!completedEarlier) return 'ready';
  return 'checking';
}
