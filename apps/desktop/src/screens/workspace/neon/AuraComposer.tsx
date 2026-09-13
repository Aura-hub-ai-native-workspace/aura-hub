import { Icon } from '@aura/ui';
import { cn } from '@aura/core';

/**
 * AuraComposer — the one place a person talks to AURA.
 *
 * It sits at the foot of the Hub rail, directly beneath the orchestration
 * graph it drives, so the thing you address is visibly the agent that
 * commands the workers rather than any single worker. The workspace to
 * the right shows what that request became; it takes no input of its own,
 * because two prompts on one screen make the user guess who is listening.
 */
export function AuraComposer({
  text,
  onChange,
  onSubmit,
  busy,
  disabled,
  hint,
}: {
  text: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  /** No project chosen: the agent has no directory to work in. */
  disabled?: boolean;
  hint?: string;
}) {
  const canSend = !busy && !disabled && text.trim().length > 0;
  return (
    <div className="mt-auto pt-3">
      <div
        className={cn(
          'relative rounded-2xl border bg-[rgba(13,19,38,0.85)] p-3 transition-colors',
          busy
            ? 'border-[rgba(32,211,255,0.35)]'
            : 'border-[rgba(125,146,255,0.32)] focus-within:border-[rgba(125,146,255,0.6)]',
        )}
      >
        <label htmlFor="aura-composer" className="sr-only">
          Tell AURA what you want to build
        </label>
        <textarea
          id="aura-composer"
          rows={3}
          value={text}
          disabled={busy || disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (canSend) onSubmit();
            }
          }}
          data-testid="agent-composer"
          placeholder={disabled ? 'Select a project to start building…' : 'Type your message…'}
          className="neon-focus w-full resize-none bg-transparent pr-12 text-[13.5px] leading-relaxed text-text outline-none placeholder:text-text-subtle disabled:cursor-not-allowed"
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSend}
          data-testid="agent-submit"
          aria-label="Send to AURA"
          className="neon-focus absolute bottom-3 right-3 grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-neon-blue to-neon-violet text-white shadow-glow-blue transition-opacity disabled:opacity-40"
        >
          <Icon name="arrow-right" size={17} />
        </button>
      </div>
      <p className="mt-1.5 px-1 text-[10.5px] text-text-subtle">
        {busy
          ? 'AURA is planning, delegating and verifying…'
          : hint ?? 'AURA plans the work, chooses the worker, and verifies the result.'}
      </p>
    </div>
  );
}
