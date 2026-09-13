import { useEffect, useState } from 'react';
import { Badge, Button, Dialog, Icon } from '@aura/ui';
import { useAppStore } from '@aura/core';
import { actionSpec } from './actionSpecs';
import { useEditorStore } from './editorStore';
import type { AiActionState } from './useAiAction';
import type { ActionKind } from '../ai/aiClient';

export interface AiActionControls {
  state: AiActionState;
  run: (action: ActionKind, customInstruction?: string) => Promise<void>;
  reset: () => void;
  cancel: () => void;
  followUp: (text: string) => Promise<void>;
  decide: (granted: boolean, reason?: string) => Promise<void>;
}

const OUTCOME_TONE: Record<string, 'positive' | 'attention' | 'critical' | 'info' | 'neutral'> = {
  completed: 'positive',
  'awaiting-approval': 'attention',
  'needs-clarification': 'info',
  failed: 'critical',
  denied: 'critical',
  timeout: 'attention',
  blocked: 'attention',
  cancelled: 'neutral',
  unsupported: 'neutral',
};

/**
 * The one result shell for every AI code action, now driven by the
 * Central Agent. Read-only answers render as text; governed mutations
 * park on approval and execute server-side through the Capability
 * Fabric — this dialog NEVER writes AI-proposed code itself. After a
 * completed mutation the tab is refreshed from disk (refused when the
 * user has unsaved edits, so nothing is silently discarded).
 */
export function AIActionDialog({ aiAction }: { aiAction: AiActionControls }) {
  const { state, reset, cancel, followUp, decide } = aiAction;
  void useAppStore((s) => s.theme);
  const openFiles = useEditorStore((s) => s.openFiles);
  const reloadFile = useEditorStore((s) => s.reloadFile);

  const [followUpText, setFollowUpText] = useState('');
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

  useEffect(() => {
    if (state.phase === 'idle') {
      setFollowUpText('');
      setSendingFollowUp(false);
      setDeciding(false);
      setRefreshNote(null);
    }
  }, [state.phase]);

  const spec = state.action ? actionSpec(state.action) : null;
  const file = state.filePath ? openFiles[state.filePath] : undefined;
  const open = state.phase !== 'idle';
  if (!spec) return null;

  const analyzing = state.phase === 'context-resolved' || state.phase === 'generating';
  const outcome = state.result?.outcome;

  const handleFollowUp = () => {
    const text = followUpText.trim();
    if (!text || sendingFollowUp) return;
    setSendingFollowUp(true);
    setFollowUpText('');
    void followUp(text).finally(() => setSendingFollowUp(false));
  };

  const handleDecide = (granted: boolean) => {
    if (deciding) return;
    setDeciding(true);
    void decide(granted).finally(() => setDeciding(false));
  };

  const handleRefresh = async () => {
    if (!state.filePath) return;
    setRefreshNote(null);
    const content = await reloadFile(state.filePath);
    if (content === null) {
      const current = useEditorStore.getState().openFiles[state.filePath];
      setRefreshNote(current?.dirty
        ? 'Tab has unsaved edits — your content was kept. Save or discard them, then refresh.'
        : (current?.saveError ?? 'Could not refresh the tab from disk.'));
    } else {
      setRefreshNote('Tab refreshed from disk.');
    }
  };

  return (
    <Dialog
      open={open}
      onClose={reset}
      size="lg"
      className="max-w-[1040px]"
      title={
        <span className="flex items-center gap-2">
          <Icon name={spec.icon} size={16} />
          {spec.label}
          {file && <span className="font-normal text-text-subtle">— {file.name}</span>}
        </span>
      }
      footer={
        analyzing ? (
          <div className="flex w-full items-center justify-between">
            <span className="text-[12px] text-text-muted">The agent is working — cancellation stops the run server-side.</span>
            <Button variant="secondary" size="sm" onClick={cancel}>Cancel</Button>
          </div>
        ) : state.phase === 'awaiting-approval' ? (
          <div className="flex w-full items-center justify-between gap-3">
            <span className="text-[12px] text-text-muted">Approval is decided in the agent ledger — the same ledger the Fabric spends from.</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={reset}>Close</Button>
              <Button variant="secondary" size="sm" loading={deciding} onClick={() => handleDecide(false)}>Deny</Button>
              <Button variant="primary" size="sm" loading={deciding} onClick={() => handleDecide(true)}>Approve & Apply</Button>
            </div>
          </div>
        ) : state.phase === 'done' ? (
          <div className="flex w-full items-center justify-between gap-3">
            <Button variant="ghost" size="sm" icon="clipboard" onClick={() => void navigator.clipboard.writeText(state.result?.summary ?? '')}>Copy answer</Button>
            <div className="flex gap-2">
              {outcome === 'completed' && state.filePath && (
                <Button variant="ghost" size="sm" icon="refresh" onClick={() => void handleRefresh()}>Refresh tab from disk</Button>
              )}
              <Button variant="secondary" size="sm" onClick={reset}>Close</Button>
            </div>
          </div>
        ) : state.phase === 'cancelled' ? (
          <div className="flex w-full items-center justify-between">
            <span className="text-[12px] text-text-muted">Cancelled — the run was stopped and will not continue in the background.</span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={reset}>Close</Button>
              {state.action && <Button variant="secondary" size="sm" icon="refresh" onClick={() => void aiAction.run(state.action!)}>Retry</Button>}
            </div>
          </div>
        ) : state.phase === 'error' ? (
          <div className="flex w-full items-center justify-between">
            <span className="text-[12px] text-danger">{state.errorMessage}</span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={reset}>Close</Button>
              {state.action && <Button variant="secondary" size="sm" icon="refresh" onClick={() => void aiAction.run(state.action!)}>Retry</Button>}
            </div>
          </div>
        ) : null
      }
    >
      <div className="min-h-[120px]">
        {analyzing && (
          <div className="space-y-3 py-4">
            <div className="flex items-center gap-2 text-[12.5px] text-text-muted">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
              {`${spec.promptVerb}… ${(state.elapsedMs / 1000).toFixed(1)}s`}
            </div>
            {state.contextSummary && (
              <div className="rounded-xl border border-line bg-canvas px-3.5 py-3 text-[12.5px] text-text">
                <div>
                  {state.contextSummary.symbolLabel ? (
                    <>Found <strong>{state.contextSummary.symbolLabel}</strong></>
                  ) : (
                    'No enclosing symbol resolved — analyzing the whole file'
                  )}
                </div>
                <div className="mt-1 text-text-muted">
                  {state.contextSummary.referenceCount} reference{state.contextSummary.referenceCount === 1 ? '' : 's'} across{' '}
                  {state.contextSummary.dependentFileCount} file{state.contextSummary.dependentFileCount === 1 ? '' : 's'} ·{' '}
                  {state.contextSummary.dependencyCount} dependenc{state.contextSummary.dependencyCount === 1 ? 'y' : 'ies'}
                </div>
                <div className="mt-1 text-text-subtle">Canonical project context is assembled server-side by the Central Agent.</div>
              </div>
            )}
            {state.progress.length > 0 && (
              <div className="space-y-1">
                {state.progress.slice(-6).map((p, i) => (
                  <div key={`${i}-${p}`} className="text-[12px] text-text-muted">· {p}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {state.phase === 'awaiting-approval' && state.result && (
          <div className="space-y-3 pb-2">
            <div className="flex items-center gap-2">
              <Badge tone="attention">Waiting for approval</Badge>
              {state.stale && <Badge tone="neutral">File changed since request</Badge>}
            </div>
            <p className="text-[12.5px] leading-relaxed text-text">{state.result.summary}</p>
            {state.planReview && state.planReview.steps.length > 0 && (
              <div className="space-y-2">
                {state.planReview.steps.map((step) => (
                  <div key={step.id} className="rounded-xl border border-line bg-canvas px-3.5 py-2.5 text-[12.5px]">
                    <div className="font-medium text-text">{step.action}</div>
                    <div className="mt-0.5 text-text-muted">
                      {step.capability ? `Capability: ${step.capability} · ` : ''}Risk: {step.risk} · {step.reversible ? 'Reversible' : 'Irreversible'} · Verify: {step.verification}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[12px] text-text-muted">
              Approving applies the change through the Capability Fabric with verification and evidence — never as a direct editor write.
            </p>
          </div>
        )}

        {state.phase === 'done' && state.result && (
          <div className="space-y-3 pb-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={OUTCOME_TONE[outcome ?? ''] ?? 'neutral'}>{outcome}</Badge>
              {state.stale && <Badge tone="neutral">File changed since request</Badge>}
              {state.result.verified.length > 0 && <Badge tone="positive">Verified: {state.result.verified.join(', ')}</Badge>}
            </div>
            <div className="whitespace-pre-wrap rounded-xl border border-line bg-canvas px-3.5 py-3 text-[12.5px] leading-relaxed text-text">
              {state.result.summary || 'The agent returned no summary.'}
            </div>
            {(state.result.performed.length > 0 || state.result.evidence) && (
              <div className="text-[12px] text-text-muted">
                {state.result.performed.length > 0 && <>Performed: {state.result.performed.join(', ')}. </>}
                {state.result.evidence && <>Evidence: {state.result.evidence.summary}</>}
              </div>
            )}
            {refreshNote && <div className="text-[12px] text-text-muted">{refreshNote}</div>}
            <div className="flex items-center gap-2">
              <input
                value={followUpText}
                onChange={(e) => setFollowUpText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleFollowUp()}
                placeholder={outcome === 'needs-clarification' ? 'Answer the question above…' : 'Ask a follow-up on the same session…'}
                className="flex-1 rounded-lg border border-line bg-canvas px-3 py-1.5 text-[12.5px] text-text outline-none placeholder:text-text-subtle focus:border-accent"
              />
              <Button size="sm" variant="primary" loading={sendingFollowUp} onClick={handleFollowUp}>Send</Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
