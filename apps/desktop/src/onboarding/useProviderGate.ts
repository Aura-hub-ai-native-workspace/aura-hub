import { useEffect, useState } from 'react';
import { aiClient } from '../ai/aiClient';

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
export type ProviderGate = 'checking' | 'ready' | 'needs-setup';

export function useProviderGate(enabled: boolean): ProviderGate {
  const [gate, setGate] = useState<ProviderGate>(enabled ? 'checking' : 'needs-setup');

  useEffect(() => {
    if (!enabled) { setGate('needs-setup'); return; }
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
  }, [enabled]);

  return gate;
}
