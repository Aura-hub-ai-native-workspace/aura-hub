import { decideProviderCheck, PROVIDER_CHECK_ATTEMPTS, PROVIDER_CHECK_INTERVAL_MS } from './providerCheck';
import { useCallback, useEffect, useState } from 'react';
import { aiClient } from '../ai/aiClient';
import { providerGate, type ProviderGate } from './gateRules';

/**
 * Does the saved provider configuration still work?
 *
 * Onboarding is remembered in local storage, which records that the user
 * once completed it — not that the server they pointed at is still there.
 * A college GPU server goes down, a tunnel hostname rotates, a model gets
 * removed. Without this check the workspace opens against a dead provider
 * and fails on its first question.
 *
 * So the flag is treated as necessary but not sufficient: on boot the
 * service is asked whether a provider is actually active and healthy, and
 * if it is not, the connection screen comes back. It never silently picks
 * another model or another provider — the user decides what to do.
 *
 * `checking` is its own state so the workspace is not flashed before the
 * answer arrives.
 */
export type { ProviderGate };

export function useProviderGate(enabled: boolean): { gate: ProviderGate; markReady: () => void } {
  /*
   * Only a configuration that predates this session is re-challenged.
   *
   * The check exists for the NEXT launch, when the saved server may be
   * gone. Running it again the instant onboarding completes asks the same
   * question that was just answered by a real streamed generation — and if
   * the service's health had not caught up yet, it answered "no" and threw
   * the user back onto the screen they had just finished. That reads as
   * the setup refusing to end.
   */
  const [checkedAtStart] = useState(enabled);
  const [gate, setGate] = useState<ProviderGate>(enabled ? 'checking' : 'needs-setup');

  /*
   * Onboarding finishing must be able to SAY so.
   *
   * The first version inferred it: the effect below watched `enabled` and
   * treated a false→true flip as "just verified". That inference is wrong
   * for the one case it most needed to handle — a user who had onboarded
   * before, whose saved server no longer validated, and who was therefore
   * sent back through setup. For them `enabled` was already true, nothing
   * in the dependency list changed when they finished, the effect never
   * re-ran, and the gate stayed on `needs-setup` while the flow sat on
   * its final screen. The workspace never opened, and the screen showed a
   * completed progress bar because nothing was stuck except the decision.
   *
   * An explicit signal cannot be missed the way a dependency change can.
   */
  const markReady = useCallback(() => setGate('ready'), []);

  useEffect(() => {
    const decision = providerGate(enabled, checkedAtStart);
    if (decision !== 'checking') { setGate(decision); return; }
    let alive = true;
    setGate('checking');
    (async () => {
      /* Retry while the services have not answered: at boot the shell may
         still be starting them, and an unanswered check is not evidence that
         setup is needed. A definitive "no provider" ends the retries at once;
         exhausting them with no answer falls back to setup, as before. */
      for (let attempt = 0; attempt < PROVIDER_CHECK_ATTEMPTS && alive; attempt++) {
        const [providers, health] = await Promise.all([
          aiClient.getProviders().catch(() => null),
          aiClient.health().catch(() => null),
        ]);
        if (!alive) return;
        const result = decideProviderCheck({
          providers: providers
            ? { active: providers.active ?? null, activeModel: providers.activeModel ?? '' }
            : null,
          healthOk: health ? health.health?.ok === true : null,
        });
        if (result !== 'retry') { setGate(result); return; }
        await new Promise((r) => setTimeout(r, PROVIDER_CHECK_INTERVAL_MS));
      }
      if (alive) setGate('needs-setup');
    })();
    return () => { alive = false; };
  }, [enabled, checkedAtStart]);

  return { gate, markReady };
}
