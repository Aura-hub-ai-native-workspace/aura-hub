/**
 * Agent Workspace v2 — left panel, user conversation surface.
 * =====================================================================
 * Everything the user does in the v2 workspace happens here:
 *   • read AURA's replies
 *   • see attached files as removable previews
 *   • toggle public-web research ON/OFF (honestly)
 *   • send a message
 *
 * The right panel is the agent's execution observability: no user
 * composer, no user keyboard input. Two composers on one screen means
 * two agents pretending — the spec forbids it, and so does this file.
 *
 * Design language matches the neon workspace: dark navy canvas, violet
 * and cyan glow, glass cards. Uses the ws-* tailwind tokens — no
 * hardcoded surface colors. `workspaceTheme.test.tsx` pins the contract
 * for the shared tokens; this panel composes them rather than defining
 * them.
 */
import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import { Icon, useHotkey, type IconName } from '@aura/ui';
import { AuraLogo } from '../../brand/AuraLogo';
import type { V2Attachment } from './types';

/* ── AURA identity strip ────────────────────────────────────────────── */

/** The visual identity of the Central Agent. Every line is derived from
 *  a backend answer: `connectedProviders` from `modelStatus()`,
 *  `availableTools` from `capability.discovery`, `agentPhase` from the
 *  live event stream the run is already driving. Nothing here is
 *  fabricated; an empty host reads as "not yet reported". */
export function IdentityStrip({
  connectedProviders,
  availableTools,
  agentPhase,
  agentBusy,
  modelName,
}: {
  connectedProviders: string[];
  availableTools: string[];
  agentPhase: string | null;
  agentBusy: boolean;
  /** Optional: the model this host is currently pointed at. */
  modelName: string | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="relative grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-[rgba(122,92,255,0.45)] bg-[rgba(122,92,255,0.14)] shadow-glow-violet">
          <AuraLogo size={26} />
          {agentBusy && (
            <span aria-hidden className="absolute -bottom-0.5 -right-0.5 grid h-3.5 w-3.5 place-items-center rounded-full border-2 border-ws-panel">
              <span className="h-2 w-2 rounded-full bg-neon-cyan aura-breathe" />
            </span>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <div className="text-[15px] font-semibold leading-tight tracking-[-0.01em] text-text">
              AURA Central Agent
            </div>
            {modelName && (
              <span className="min-w-0 truncate rounded-full border border-[rgba(122,92,255,0.32)] bg-ws-soft px-2 py-0.5 text-[10px] uppercase tracking-wide text-ws-ink-violet">
                {modelName}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] uppercase tracking-[0.18em] text-text-subtle">
            {agentPhase ?? 'One prompt · multiple minds'}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" data-testid="v2-connected">
        <ProviderChip
          label={`${connectedProviders.length} provider${connectedProviders.length === 1 ? '' : 's'}`}
          sub={
            connectedProviders.length
              ? connectedProviders.slice(0, 3).join(', ') + (connectedProviders.length > 3 ? '…' : '')
              : 'not yet reported'
          }
          icon="cpu"
          tone={connectedProviders.length > 0 ? 'ok' : 'muted'}
        />
        <ProviderChip
          label={`${availableTools.length} tool${availableTools.length === 1 ? '' : 's'}`}
          sub={
            availableTools.length
              ? availableTools.slice(0, 3).join(', ') + (availableTools.length > 3 ? '…' : '')
              : 'none seen this run'
          }
          icon="command"
          tone={availableTools.length > 0 ? 'ok' : 'muted'}
        />
      </div>
    </div>
  );
}

function ProviderChip({
  label,
  sub,
  icon,
  tone,
}: {
  label: string;
  sub: string;
  icon: IconName;
  tone: 'ok' | 'muted';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] leading-tight',
        tone === 'ok' ? 'border-[rgba(122,92,255,0.32)] bg-ws-soft text-text-muted'
                      : 'border-line bg-ws-soft text-text-subtle',
      )}
      data-testid={`v2-chip-${icon}`}
    >
      <Icon name={icon} size={12} />
      <span className="font-medium text-text">{label}</span>
      <span aria-hidden className="text-text-subtle">·</span>
      <span className="truncate">{sub}</span>
    </span>
  );
}

/* ── Web search toggle ─────────────────────────────────────────────── */

export type GatewayProbeState =
  | { state: 'ready'; endpoint: string }
  | { state: 'unavailable'; reason: 'GATEWAY_NOT_IMPLEMENTED' }
  | { state: 'error'; message: string }
  | null;

export function WebSearchToggle({
  enabled,
  onToggle,
  probe,
  busy,
}: {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  probe: GatewayProbeState;
  busy: boolean;
}) {
  const disabled = busy;
  const icon: IconName = enabled ? 'globe' : 'globe-off';
  const notYet = probe?.state === 'unavailable' || probe?.state === 'error';
  const label = enabled
    ? (notYet ? 'Web research ON · gateway pending' : 'Web research ON')
    : 'Web research OFF';
  const subtitle =
    enabled
      ? notYet
        ? 'Enabled for this request. The private gateway route is not implemented on this host yet — AURA will report honestly if no public query may leave the machine.'
        : 'Only a minimal public query leaves the machine; the redacted response comes back through the gateway.'
      : 'No public-web egress for this request. AURA stays on private links and local knowledge.';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      data-testid="v2-web-search-toggle"
      disabled={disabled}
      onClick={() => onToggle(!enabled)}
      className={cn(
        'neon-focus inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] leading-tight transition-colors',
        enabled
          ? 'border-[rgba(32,211,255,0.55)] bg-[rgba(32,211,255,0.12)] text-ws-ink-cyan'
          : 'border-line bg-ws-soft text-text-muted',
        disabled && 'cursor-not-allowed opacity-55',
      )}
      title={subtitle}
    >
      <Icon name={icon} size={14} />
      <span className="font-medium">{label}</span>
      <span
        aria-hidden
        className={cn('h-1.5 w-1.5 rounded-full', enabled ? 'bg-neon-cyan' : 'bg-text-subtle')}
      />
    </button>
  );
}

/* ── Attachments panel ─────────────────────────────────────────────── */

/** The accepted types match the backend's existing document engine —
 *  NOT a parallel list; `centralAgentClient.ingestDocument` is the
 *  one backend that decides whether a file is ingested. */
export const ATTACH_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,image/svg+xml,' +
  'application/pdf, application/msword,' +
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
  'text/plain,text/markdown,text/csv';

export function AttachPanel({
  attachments,
  onRemove,
  onPick,
}: {
  attachments: V2Attachment[];
  onRemove: (id: string) => void;
  onPick: (files: FileList | File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      className="rounded-2xl border border-[rgba(125,146,255,0.24)] bg-ws-panel p-3"
      data-testid="v2-attachments"
    >
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-text-subtle">
          Attachments
        </p>
        {attachments.length > 0 && (
          <span className="text-[11px] tabular-nums text-text-subtle">{attachments.length}</span>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ATTACH_ACCEPT}
        multiple
        className="hidden"
        aria-label="Choose files to attach"
        data-testid="v2-attach-input"
        onChange={(e) => {
          const files = e.target.files;
          if (!files) return;
          onPick(files);
          // Reset so the user can resubmit the same file on a follow-up.
          e.target.value = '';
        }}
      />

      {attachments.length === 0 ? (
        <div className="mt-2 flex items-start justify-between gap-3">
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-text-subtle">
            Add images, PDFs, DOC(X), TXT, MD or CSV files. They are ingested into
            AURA's existing knowledge base the moment you attach them.
          </p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="neon-focus inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[rgba(125,146,255,0.4)] bg-ws-soft px-3 py-1.5 text-[12px] text-text-muted transition-colors hover:text-text"
            data-testid="v2-attach-choose"
          >
            <Icon name="plus" size={13} />
            Choose files
          </button>
        </div>
      ) : (
        <>
          <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto pr-1" role="list">
            <AnimatePresence initial={false}>
              {attachments.map((a) => (
                <AttachmentRow key={a.id} attachment={a} onRemove={onRemove} />
              ))}
            </AnimatePresence>
          </ul>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="neon-focus mt-2 inline-flex items-center gap-1.5 text-[11px] text-text-subtle transition-colors hover:text-text"
          >
            <Icon name="plus" size={12} />
            Add more
          </button>
        </>
      )}
    </div>
  );
}

function AttachmentRow({
  attachment,
  onRemove,
}: {
  attachment: V2Attachment;
  onRemove: (id: string) => void;
}) {
  const name = attachment.file.name || attachment.file.type;
  const size = attachment.file.size < 1024 * 1024
    ? `${Math.max(1, Math.ceil(attachment.file.size / 1024))} kB`
    : `${(attachment.file.size / (1024 * 1024)).toFixed(2)} MB`;
  const tone =
    attachment.status === 'ready'
      ? { border: 'border-[rgba(31,211,138,0.4)]', chip: 'text-ws-ok', chipBg: 'bg-[rgba(31,211,138,0.12)]' }
      : attachment.status === 'ingesting'
        ? { border: 'border-[rgba(32,211,255,0.42)]', chip: 'text-ws-ink-cyan', chipBg: 'bg-[rgba(32,211,255,0.12)]' }
        : { border: 'border-[rgba(255,93,122,0.42)]', chip: 'text-ws-bad', chipBg: 'bg-[rgba(255,93,122,0.12)]' };
  const statusLabel =
    attachment.status === 'ready' ? 'Ready'
    : attachment.status === 'ingesting' ? 'Parsing' : 'Failed';

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={spring.snappy}
      className={cn('flex items-center gap-2 rounded-xl border px-2.5 py-2', tone.border)}
      data-status={attachment.status}
    >
      {attachment.isImage && attachment.previewUrl ? (
        <img
          src={attachment.previewUrl}
          alt={attachment.file.name}
          className="h-9 w-9 rounded-md border border-line object-cover"
        />
      ) : (
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-[rgba(125,146,255,0.25)] bg-ws-soft text-text-muted">
          <Icon name={attachment.status === 'failed' ? 'close' : 'file'} size={16} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-medium text-text">{name}</p>
        <p className="truncate text-[10.5px] text-text-subtle">
          {size}
          {attachment.status === 'ready' && attachment.kbPath && ' · in knowledge base'}
          {attachment.error && (
            <span className="ml-1 text-ws-bad">· {attachment.error}</span>
          )}
        </p>
      </div>
      <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', tone.chip, tone.chipBg)}>
        {statusLabel}
      </span>
      <button
        type="button"
        onClick={() => onRemove(attachment.id)}
        aria-label={`Remove ${name}`}
        data-testid="v2-attach-remove"
        className="neon-focus grid h-6 w-6 place-items-center rounded-md text-text-subtle transition-colors hover:text-text"
      >
        <Icon name="close" size={12} />
      </button>
    </motion.li>
  );
}

/* ── The one composer (spec §3) ─────────────────────────────────────── */

/**
 * MessageComposer — the SOLE place the user talks to AURA in the v2
 * workspace. It lives under the identity and attachments, in the left
 * panel. Exactly TWO action buttons appear beneath the input:
 *
 *   1. [+]      — attachment picker (images / PDF / docs)
 *   2. [globe]  — web research ON/OFF
 *
 * No third action icon exists anywhere in this UI, and no composer
 * exists in the right panel. Enter submits, Shift+Enter inserts a
 * newline, ⌘/Ctrl+J focuses the input from anywhere.
 */
export function MessageComposer({
  value,
  onChange,
  onSubmit,
  onPickFiles,
  webSearchEnabled,
  onWebSearchToggle,
  probe,
  busy,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  /** Opens the native file picker; the Attachments panel above renders
      the previews once the user has chosen files. */
  onPickFiles: () => void;
  webSearchEnabled: boolean;
  onWebSearchToggle: () => void;
  probe: GatewayProbeState;
  busy: boolean;
  hint: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const canSend = !busy && value.trim().length > 0;

  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSubmit();
    }
  };

  useHotkey('j', () => taRef.current?.focus(), { meta: true, allowInInput: true });

  return (
    <div
      className="rounded-2xl border border-[rgba(125,146,255,0.28)] bg-ws-panel p-3 shadow-card"
      data-testid="v2-composer"
    >
      <label htmlFor="v2-composer-input" className="sr-only">
        Message to AURA Central Agent
      </label>
      <textarea
        id="v2-composer-input"
        ref={taRef}
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        disabled={busy}
        placeholder={busy ? 'AURA is working…' : 'Describe what to build, fix or investigate…'}
        aria-label="Message to AURA"
        data-testid="v2-composer-textarea"
        className="w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-text outline-none placeholder:text-text-subtle disabled:opacity-60"
      />

      {/* Send button — INSIDE the composer (spec §3). */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-text-subtle">
          {busy ? 'AURA is planning, delegating and verifying…' : hint}
        </span>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSend}
          aria-label="Send to AURA"
          data-testid="v2-composer-send"
          className={cn(
            'neon-focus inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-br from-neon-blue to-neon-violet px-4 py-2 text-[12.5px] font-medium text-white shadow-glow-blue transition-opacity',
            !canSend && 'cursor-not-allowed opacity-50',
          )}
        >
          <Icon name="arrow-right" size={14} />
          Send
        </button>
      </div>

      {/* Exactly TWO action buttons beneath the composer (spec §3).
          1. [paperclip] attachment picker
          2. [globe]     web research ON/OFF
          Nothing else — no conflicting icons. */}
      <div className="mt-2 flex items-center gap-2" data-testid="v2-composer-actions">
        <button
          type="button"
          onClick={onPickFiles}
          disabled={busy}
          aria-label="Attach files (images, PDF or documents)"
          data-testid="v2-action-attach"
          className={cn(
            'neon-focus grid h-10 w-10 place-items-center rounded-xl border border-[rgba(125,146,255,0.3)] bg-ws-soft text-text-muted transition-colors hover:border-[rgba(125,146,255,0.55)] hover:text-text',
            busy && 'cursor-not-allowed opacity-50',
          )}
          title="Attach images, PDFs or documents — they ingest into AURA's knowledge base"
        >
          <Icon name="paperclip" size={17} strokeWidth={1.5} />
        </button>

        <WebSearchToggle
          enabled={webSearchEnabled}
          onToggle={(v) => {
            if (v === webSearchEnabled) return;
            onWebSearchToggle();
          }}
          probe={probe}
          busy={busy}
        />

        <span className="ml-auto hidden min-w-0 flex-1 truncate text-right text-[10.5px] text-text-subtle sm:block">
          ⌘J focus · Enter send
        </span>
      </div>
    </div>
  );
}
