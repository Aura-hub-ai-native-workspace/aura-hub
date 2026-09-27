import { useState } from 'react';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';

/**
 * AutonomyToggle — the explicit per-project opt-in to autonomous mode.
 *
 * Off (the only default) changes nothing: every gated action parks for
 * approval exactly as before. On, routine scope-confined work inside
 * THIS project — delegation with project-bound scopePaths, in-project
 * file writes, approved dev commands — auto-executes under the
 * `workspace-autonomy` policy rule. Destructive, credential,
 * out-of-project and publishing actions still ask; the toggle cannot
 * lift those, and the copy below says so rather than promising
 * blanket autonomy.
 */
export function AutonomyToggle({
  projectId,
  projectName,
  autonomous,
  busy,
  onToggle,
}: {
  projectId: string | null;
  projectName: string | null;
  autonomous: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  if (!projectId) return null;

  const flip = async () => {
    setError(null);
    try {
      await onToggle(!autonomous);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not change autonomous mode');
    }
  };

  return (
    <span className="inline-flex items-center gap-2" data-testid="autonomy-toggle-wrap">
      <button
        type="button"
        role="switch"
        aria-checked={autonomous}
        aria-label={`Autonomous mode for ${projectName ?? 'this project'}`}
        title={
          autonomous
            ? 'Autonomous mode is ON: routine scoped work runs without asking. Destructive, credential, out-of-project and publishing actions still ask.'
            : 'Turn on autonomous mode: routine scoped work inside this project runs without asking. Destructive, credential, out-of-project and publishing actions still ask.'
        }
        disabled={busy}
        onClick={() => void flip()}
        data-testid="autonomy-toggle"
        className={cn(
          'neon-focus relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50',
          autonomous
            ? 'border-[rgba(31,211,138,0.6)] bg-[rgba(31,211,138,0.35)]'
            : 'border-[rgba(125,146,255,0.4)] bg-ws-soft',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'inline-block h-3.5 w-3.5 transform rounded-full transition-transform',
            autonomous ? 'translate-x-4 bg-ws-ok' : 'translate-x-0.5 bg-text-subtle',
          )}
        />
      </button>
      <span className="inline-flex items-center gap-1 text-[11px] text-text-subtle">
        <Icon name="spark" size={11} />
        {autonomous ? 'Autonomous' : 'Ask me'}
      </span>
      {error && (
        <span role="alert" className="text-[11px] text-ws-bad">
          {error}
        </span>
      )}
    </span>
  );
}
