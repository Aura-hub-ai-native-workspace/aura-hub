import { useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import { centralAgentClient } from '../../../ai/centralAgentClient';

/**
 * AuraComposer — the one place a person talks to AURA.
 *
 * It sits at the foot of the Hub rail, directly beneath the orchestration
 * graph it drives, so the thing you address is visibly the agent that
 * commands the workers rather than any single worker. The workspace to the
 * right shows what that request became; it takes no input of its own,
 * because two prompts on one screen make the user guess who is listening.
 *
 * The composer owns its own controls. The attachment button ingests a
 * document into the knowledge base the agent retrieves from, the
 * send/stop switch sits beside it, and the web-research switch states
 * plainly whether AURA may leave this machine for this request — all
 * three inside this box, in normal flow, never positioned against
 * anything outside the composer. The rail above stays a pure view over
 * workspace state, which is a guarded boundary (see `addToolFlow.test.ts`).
 *
 * Web research is OFF until the person turns it on, and the switch says so
 * in words rather than by colour alone. It is request-scoped: the value at
 * the moment of sending is what travels with that request, and the screen
 * resets it so the next message starts from the safe default again.
 *
 * Focus reads through the container: the box's `focus-within` border is
 * the intentional focus state, and the textarea itself carries no ring —
 * the global `:focus-visible` box-shadow would otherwise draw a second,
 * bright rectangle inside the already-bordered composer.
 */
export function AuraComposer({
  text,
  onTextChange,
  onSend,
  onStop,
  busy,
  webResearch,
  onWebResearchChange,
}: {
  text: string;
  onTextChange: (text: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  /** True while AURA is executing — switches send → stop. */
  busy: boolean;
  /** Whether this request may reach the web. False unless asked. */
  webResearch: boolean;
  onWebResearchChange: (next: boolean) => void;
}) {
  /* ── Attachment state ────────────────────────────────────────────
     Local to the composer — ingestion sends the file to the knowledge
     base; the agent's retrieval picks it up from there. No need to
     thread attachment state through WorkspaceScreen. */
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachState, setAttachState] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const [attachName, setAttachName] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachName(file.name);
    setAttachError(null);
    setAttachState('uploading');
    try {
      await centralAgentClient.ingestDocument(file);
      setAttachState('done');
    } catch (err) {
      setAttachState('error');
      setAttachError(err instanceof Error ? err.message : 'Upload failed');
    }
    // Allow re-selecting the same file
    e.target.value = '';
  };

  const clearAttach = () => {
    setAttachState('idle');
    setAttachName(null);
    setAttachError(null);
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    onTextChange('');
    onSend(trimmed);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="shrink-0 border-t border-[rgba(125,146,255,0.22)] p-4 pt-3">
      <div
        data-testid="composer-container"
        className={cn(
          'rounded-2xl border bg-[var(--ws-surface)] p-3 transition-colors',
          busy
            ? 'border-[rgba(32,211,255,0.35)]'
            : 'border-[rgba(125,146,255,0.32)] focus-within:border-[rgba(125,146,255,0.6)]',
        )}
      >
        <label htmlFor="aura-composer" className="sr-only">
          Message AURA
        </label>
        <textarea
          id="aura-composer"
          rows={3}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={onKeyDown}
          data-testid="agent-composer"
          placeholder="Type your message..."
          className="w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-text outline-none focus-visible:shadow-none placeholder:text-text-subtle"
        />

        {/* Attachment status badge — only shown while a file is in flight or done */}
        {attachState !== 'idle' && attachName && (
          <div
            className={cn(
              'mb-2 flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px]',
              attachState === 'error'
                ? 'border border-[rgba(255,93,122,0.4)] bg-[rgba(255,93,122,0.08)] text-neon-danger'
                : attachState === 'uploading'
                  ? 'border border-[rgba(125,146,255,0.3)] bg-[rgba(125,146,255,0.08)] text-text-muted'
                  : 'border border-[rgba(31,211,138,0.3)] bg-[rgba(31,211,138,0.07)] text-neon-success',
            )}
          >
            <Icon
              name={attachState === 'error' ? 'close' : attachState === 'uploading' ? 'refresh' : 'check'}
              size={11}
            />
            <span className="min-w-0 flex-1 truncate">
              {attachState === 'uploading'
                ? `Uploading ${attachName}…`
                : attachState === 'done'
                  ? attachName
                  : attachError ?? 'Upload failed'}
            </span>
            {attachState !== 'uploading' && (
              <button
                type="button"
                onClick={clearAttach}
                aria-label="Dismiss attachment"
                className="ml-auto shrink-0 rounded p-0.5 transition-opacity hover:opacity-70"
              >
                <Icon name="close" size={10} />
              </button>
            )}
          </div>
        )}

        {/* Toolbar: attachment + web research on the left, send/stop on the
            right. Kept in normal flow — never positioned relative to the page. */}
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-1">
            {/* Attachment button — triggers the hidden file input */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || attachState === 'uploading'}
              data-testid="composer-attach"
              aria-label="Attach a document to the knowledge base"
              title="Attach a document"
              className="neon-focus inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] text-text-subtle transition-colors hover:bg-[rgba(125,146,255,0.1)] hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="doc" size={13} />
              <span>Attach</span>
            </button>
            {/* Hidden file input — accessible via the button above */}
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              aria-label="File to attach"
              onChange={(e) => void handleFileSelect(e)}
            />
            {/* Web research — off by default, and the label always says which
                it is. Turning this on lets AURA fetch public sources for THIS
                request; it does not open the machine up generally, and it
                resets when the request is sent. */}
            <button
              type="button"
              onClick={() => onWebResearchChange(!webResearch)}
              disabled={busy}
              data-testid="composer-web-research"
              aria-pressed={webResearch}
              aria-label="Allow web research for this request"
              title={
                webResearch
                  ? 'Web research is ON for this request. AURA may fetch public sources to answer it.'
                  : 'Web research is OFF. AURA answers from this machine and your files only.'
              }
              className={cn(
                'neon-focus inline-flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                webResearch
                  // Theme-aware accent, NOT --neon-cyan: that token is the
                  // same #20d3ff in both themes, which is ~1.7:1 on the light
                  // surface and would make "ON" unreadable in light mode.
                  // --accent-700 flips with the theme and stays legible in both.
                  ? 'border-accent-200 bg-accent-50 text-accent-700'
                  : 'border-transparent text-text-subtle hover:bg-accent-50 hover:text-text',
              )}
            >
              <Icon name="research" size={13} />
              <span>Web Research {webResearch ? 'ON' : 'OFF'}</span>
            </button>
          </div>

          {/* Send / Stop */}
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              data-testid="agent-stop"
              aria-label="Stop"
              className="neon-focus grid h-8 w-8 place-items-center rounded-xl border border-[rgba(125,146,255,0.4)] text-text-muted transition-colors hover:text-text"
            >
              <Icon name="minimize" size={14} />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!text.trim()}
              data-testid="agent-submit"
              aria-label="Send to AURA"
              className="neon-focus grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-neon-blue to-neon-violet text-white shadow-glow-blue transition-opacity disabled:opacity-40"
            >
              <Icon name="arrow-right" size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
