/**
 * AgentWorkspaceScreen — the next-generation Agent Workspace (v2).
 * =====================================================================
 * Two panels, one split, exactly one composer:
 *
 *   ┌───────────────────────────┬───────────────────────────────────────┐
 *   │ LEFT — user interaction   │  RIGHT — agent execution timeline     │
 *   │  • AURA identity+provider │  • AURA → worker → AURA → worker      │
 *   │  • removable attachments  │  • status pills (11-state vocab)      │
 *   │  • one composer           │  • expandable evidence per card       │
 *   │     [+]  [globe]  [Send]  │  • honest empty / offline states      │
 *   └───────────────────────────┴───────────────────────────────────────┘
 *
 *   • 30 / 70 wide split (spec §8); below lg it stacks with the
 *     composer first — the user never loses the interaction surface.
 *   • The right panel takes NO input; it renders the real run that
 *     `useAgentWorkspaceV2` drives through the existing Central Agent
 *     session (`useAgentRun` → `centralAgentClient` → SSE).
 *   • Reduced motion is handled globally (global.css disables the
 *     breathe/drift animations); this screen uses the same tokens.
 */
import { useEffect, useRef } from 'react';
import { cn, useAppStore } from '@aura/core';
import { useMediaQuery } from '@aura/ui';
import { useWorkspace } from '../data/useWorkspace';
import { IdentityStrip, AttachPanel, MessageComposer } from './agentWorkspaceV2/LeftPanel';
import { V2TimelinePanel } from './agentWorkspaceV2/TimelinePanel';
import { useAgentWorkspaceV2 } from './agentWorkspaceV2/useAgentWorkspaceV2';

export function AgentWorkspaceScreen() {
  const isWide = !useMediaQuery('(max-width: 1024px)');

  /* The working project — same source the neon workspace reads, so the
     two surfaces can never disagree about which directory AURA works
     in. A project is needed for file work, not for talking. */
  const projectId = useAppStore((s) => s.activeProjectId);
  const projects = useWorkspace((s) => s.projects);
  const refreshProjects = useWorkspace((s) => s.refresh);
  useEffect(() => { void refreshProjects(); }, [refreshProjects]);
  const projectPath = projects.find((p) => p.id === projectId)?.path ?? null;

  const s = useAgentWorkspaceV2({ projectId, projectPath });

  /* The + button triggers this hidden input; `value` reset after each
     pick lets the user re-select the same file on a follow-up send. */
  const fileInputRef = useRef<HTMLInputElement>(null);
  const openAttachPicker = () => {
    const el = fileInputRef.current;
    if (!el) return;
    el.value = '';
    el.click();
  };

  const onPickFiles = (files: FileList | null) => {
    if (files && files.length > 0) void s.attachments.add(files);
  };

  return (
    <div
      className="neon-shell relative h-full min-h-0"
      data-testid="agent-workspace-screen"
    >
      {/* Ambient texture — same helper classes the existing neon workspace
          uses (see WorkspaceShell/StatusPill). */}
      <div aria-hidden className="neon-grid pointer-events-none absolute inset-0" />

      <div
        className={cn(
          'relative mx-auto grid min-h-0 w-full max-w-[1760px] flex-1 gap-4 p-4',
          isWide
            ? 'grid-cols-[minmax(340px,30%)_minmax(0,1fr)] overflow-hidden'
            : 'grid-cols-1 gap-3 overflow-y-auto',
        )}
        data-testid="agent-workspace-split"
      >
        {/* LEFT: the user's conversation surface — the ONE composer. */}
        <div
          className="flex min-h-0 flex-col gap-3"
          data-testid="v2-left-panel"
          aria-label="User interaction — talk to AURA Central Agent"
        >
          <div className="rounded-2xl border border-[rgba(125,146,255,0.28)] bg-[rgba(9,13,26,0.82)] p-4 shadow-card">
            <IdentityStrip
              connectedProviders={s.connectedProviders}
              availableTools={s.availableTools}
              agentPhase={s.agentPhase}
              agentBusy={s.busy}
              modelName={s.modelName}
            />
          </div>

          <AttachPanel
            attachments={s.attachments.attachments}
            onRemove={(id) => s.attachments.remove(id)}
            onPick={(files) => void s.attachments.add(files)}
          />

          <MessageComposer
            value={s.text}
            onChange={s.setText}
            onSubmit={s.onSend}
            onPickFiles={openAttachPicker}
            webSearchEnabled={s.webSearchEnabled}
            onWebSearchToggle={() => s.setWebSearchEnabled(!s.webSearchEnabled)}
            probe={s.gatewayProbe}
            busy={s.busy}
            hint={
              projectId
                ? (s.gatewayProbe.state === 'unavailable'
                    ? 'AURA stays private unless you enable web research.'
                    : '⌘J focuses this box · Enter sends')
                : 'Pick a working project on the left for file work — or just talk.'
            }
          />
        </div>

        {/* RIGHT: the agent execution timeline — no user composer here. */}
        <div
          className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[rgba(125,146,255,0.28)] bg-[rgba(9,13,26,0.82)] shadow-card"
          data-testid="v2-right-panel"
          aria-label="AURA agent execution timeline"
        >
          {/* Web-research state — PASSED (not a second control; the
              sole toggle lives in the left composer per spec §3).
              The user sees at a glance whether public-web egress is
              enabled for this request (spec §7). */}
          <div
            className="flex shrink-0 items-center gap-2 border-b border-[rgba(125,146,255,0.16)] px-5 py-2"
            data-testid="v2-web-search-status"
            role="status"
            aria-live="polite"
          >
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold leading-tight',
                s.webSearchEnabled
                  ? 'border-[rgba(32,211,255,0.55)] bg-[rgba(32,211,255,0.12)] text-neon-cyan'
                  : 'border-line bg-[rgba(13,19,38,0.55)] text-text-muted',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  s.webSearchEnabled ? 'bg-neon-cyan' : 'bg-text-subtle',
                )}
              />
              Web research {s.webSearchEnabled ? 'ON' : 'OFF'} for this request
            </span>
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-text-subtle">
              {s.webSearchEnabled
                ? s.gatewayProbe.state === 'ready'
                  ? `Gateway live at ${s.gatewayProbe.endpoint || 'the agent host'} — only a redacted query leaves the machine.`
                  : 'No public query will leave this host until the gateway route exists on the backend; AURA will say so, honestly.'
                : 'Private by default — no public-web egress for this request.'}
            </span>
          </div>

          <V2TimelinePanel
            timeline={s.timeline}
            agentUp={s.agentUp}
            streamPaused={s.streamPaused}
          />
        </div>
      </div>

      {/* Hidden native file input — the single source of the file
          picker for the + button. Kept one instance per screen so
          re-selecting the same file works. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,application/pdf,.doc,.docx,.txt,.md,.csv"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => onPickFiles(e.target.files)}
      />
    </div>
  );
}

export default AgentWorkspaceScreen;
