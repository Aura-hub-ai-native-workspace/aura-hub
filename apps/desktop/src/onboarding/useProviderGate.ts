import { useEffect, useState } from 'react';
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

export function useProviderGate(enabled: boolean): ProviderGate {
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

  useEffect(() => {
    const decision = providerGate(enabled, checkedAtStart);
    if (decision !== 'checking') { setGate(decision); return; }
    let alive = true;
    setGate('checking');
    (async () => {
      try {
        const [providers, health] = await Promise.all([
          aiClient.getProviders().catch(() => null),
          aiClient.health().catch(() => null),
        ]);
        if (!alive) return;
        const active = providers?.active ?? null;
        const model = providers?.activeModel ?? '';
        const ok = health?.health?.ok === true;
        // All three, because any one alone can be true of a broken setup:
        // an active pointer with no model, or a model with a server that
        // stopped answering.
        setGate(active && model && ok ? 'ready' : 'needs-setup');
      } catch {
        if (alive) setGate('needs-setup');
      }
    })();
    return () => { alive = false; };
  }, [enabled, checkedAtStart]);

  return gate;
}
