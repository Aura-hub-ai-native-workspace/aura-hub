/**
 * AuraBugPanel — results surface for the Bug Bot scan.
 * ------------------------------------------------------------------
 * Honest by construction: every row names its source (editor
 * diagnostics / static scan / AI), never invents findings, shows a
 * clear "no issues detected" state when the file is genuinely clean.
 *
 * The Bug Bot lifecycle is surfaced here end-to-end:
 *   scope    → current file / all open tabs / bounded project walk
 *   status   → detected → analyzed → fix-proposed → awaiting-approval →
 *              approved → fixing → verifying → verified | verification-failed
 *   review   → a fix is never applied before the user reviews it and
 *              explicitly approves; approval writes through the editor's
 *              own save authority and the result is verified by a real
 *              deterministic re-scan (a failed verification offers Revert).
 */
import { useState } from 'react';
import { Badge, Button, Dialog, Icon } from '@aura/ui';
import { cn, type StatusTone } from '@aura/core';
import { useEditorStore } from '../editorStore';
import type { AuraBugController } from './useAuraBug';
import { STATUS_LABEL } from './useAuraBug';
import type { AuraBugIssue, AuraBugScope, AuraBugSource } from './types';

const SOURCE_LABEL: Record<AuraBugSource, string> = {
  'language-service': 'Diagnostics',
  heuristic: 'Static scan',
  ai: 'AI scan',
};
const SOURCE_TONE: Record<AuraBugSource, StatusTone> = {
  'language-service': 'info',
  heuristic: 'neutral',
  ai: 'attention',
};

const SCOPE_LABEL: Record<AuraBugScope, string> = {
  file: 'Current file',
  open: 'Open files',
  project: 'Whole project',
};

const STATUS_TONE: Record<AuraBugIssue['status'], StatusTone> = {
  detected: 'neutral',
  analyzing: 'info',
  analyzed: 'neutral',
  'fix-proposed': 'info',
  'awaiting-approval': 'attention',
  approved: 'info',
  fixing: 'info',
  verifying: 'info',
  verified: 'positive',
  'verification-failed': 'critical',
  reverted: 'neutral',
  rejected: 'neutral',
  failed: 'critical',
};

const SCOPES: AuraBugScope[] = ['file', 'open', 'project'];

function severityIcon(issue: AuraBugIssue): { icon: 'close' | 'bug' | 'dot'; className: string } {
  if (issue.severity === 'error') return { icon: 'close', className: 'text-danger' };
  if (issue.severity === 'bug') return { icon: 'bug', className: 'text-attention' };
  return { icon: 'dot', className: 'text-text-subtle' };
}

export function AuraBugPanel({
  open,
  onClose,
  aura,
}: {
  open: boolean;
  onClose: () => void;
  aura: AuraBugController;
}) {
  const openFiles = useEditorStore((s) => s.openFiles);
  const {
    phase,
    issues,
    aiStatus,
    aiEnabled,
    setAiEnabled,
    selectedId,
    scope,
    setScope,
    filesScanned,
    skippedFiles,
    scopeMessage,
    reviewing,
    clearReview,
    rescan,
    navigateTo,
    reviewFix,
    approveFix,
    rejectFix,
    revertFix,
  } = aura;
  const scanning = phase === 'scanning';
  const [busyId, setBusyId] = useState<string | null>(null);

  const bySeverity = {
    error: issues.filter((i) => i.severity === 'error').length,
    bug: issues.filter((i) => i.severity === 'bug').length,
    warning: issues.filter((i) => i.severity === 'warning').length,
  };

  const runApprove = async (issue: AuraBugIssue) => {
    setBusyId(issue.id);
    try {
      await approveFix(issue.id);
    } finally {
      setBusyId(null);
    }
  };

  const runRevert = async (issue: AuraBugIssue) => {
    setBusyId(issue.id);
    try {
      await revertFix(issue.id);
    } finally {
      setBusyId(null);
    }
  };

  const fileIsOpen = (path: string) => !!openFiles[path];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      className="max-w-[760px]"
      title={
        <span className="flex items-center gap-2">
          <Icon name="bug" size={16} />
          AuraBug
          {reviewing ? (
            <span className="font-normal text-text-subtle">— fix review</span>
          ) : (
            <>
              <span className="font-normal text-text-subtle">— {SCOPE_LABEL[scope]}</span>
              {phase === 'done' && issues.length > 0 && (
                <span className="ml-1 font-normal text-text-subtle">
                  · {issues.length} {issues.length === 1 ? 'finding' : 'findings'}
                </span>
              )}
            </>
          )}
        </span>
      }
      footer={
        <div className="flex w-full items-center justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <div className="min-h-[220px] space-y-3">
        {reviewing ? (
          <FixReview
            issue={reviewing}
            fileIsOpen={fileIsOpen}
            busyId={busyId}
            onBack={clearReview}
            onApprove={() => void runApprove(reviewing)}
            onReject={() => rejectFix(reviewing.id)}
            onRevert={() => void runRevert(reviewing)}
          />
        ) : (
          <>
            {/* Controls */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
              <div className="flex items-center gap-1 rounded-lg border border-line bg-canvas p-0.5">
                {SCOPES.map((s) => (
                  <button
                    key={s}
                    onClick={() => setScope(s)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                      scope === s ? 'bg-accent-50 text-accent-700 dark:bg-accent/15 dark:text-accent-200' : 'text-text-muted hover:text-text',
                    )}
                  >
                    {SCOPE_LABEL[s]}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3">
                {scope === 'file' && (
                  <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-text-muted select-none">
                    <input
                      type="checkbox"
                      checked={aiEnabled}
                      disabled={scanning}
                      onChange={(e) => setAiEnabled(e.target.checked)}
                      className="h-3.5 w-3.5 accent-accent disabled:opacity-45"
                    />
                    AI scan
                  </label>
                )}
                <Button variant="secondary" size="sm" icon="refresh" disabled={scanning} onClick={rescan}>
                  {scope === 'file' ? 'Scan Again' : 'Scan'}
                </Button>
              </div>
            </div>

            {scanning && (
              <div className="flex items-center gap-2 text-[11.5px] text-text-muted">
                <Icon name="refresh" size={13} className="animate-spin text-accent" />
                Scanning {SCOPE_LABEL[scope].toLowerCase()}…
              </div>
            )}
            {scanning && scope === 'file' && aiEnabled && (
              <div className="flex items-center gap-2 text-[11.5px] text-text-muted">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                {aiStatus === 'pending' ? 'AI analysis running…' : 'Waiting on AI analysis…'}
              </div>
            )}

            {scope !== 'file' && !scanning && issues.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-canvas px-3.5 py-2.5 text-[12px]">
                <span className="text-text-muted">
                  {filesScanned} file{filesScanned === 1 ? '' : 's'} scanned{skippedFiles > 0 ? ` · ${skippedFiles} skipped` : ''} · {issues.length}{' '}
                  finding{issues.length === 1 ? '' : 's'}
                </span>
                {bySeverity.error > 0 && <Badge tone="critical">{bySeverity.error} error{bySeverity.error === 1 ? '' : 's'}</Badge>}
                {bySeverity.bug > 0 && <Badge tone="attention">{bySeverity.bug} bug{bySeverity.bug === 1 ? '' : 's'}</Badge>}
                {bySeverity.warning > 0 && (
                  <Badge tone="neutral">
                    {bySeverity.warning} warning{bySeverity.warning === 1 ? '' : 's'}
                  </Badge>
                )}
              </div>
            )}
            {scopeMessage && !scanning && (
              <p className="text-[11.5px] text-text-subtle">{scopeMessage}</p>
            )}

            {phase === 'idle' && (
              <div className="py-8 text-center text-[12.5px] text-text-muted">
                {scope === 'file' ? 'Open a file to scan it for bugs, errors and risky code.' : 'Run a scan to find issues across the selected scope.'}
              </div>
            )}

            {phase === 'done' && issues.length === 0 && (
              <div className="grid place-items-center py-8">
                <div className="max-w-[280px] text-center">
                  <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-2xl border border-line bg-surface text-positive">
                    <Icon name="check" size={20} />
                  </div>
                  <div className="text-[13px] font-semibold text-text">
                    {scope === 'file' ? 'No issues detected' : 'Nothing found in this scope'}
                  </div>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">
                    {scope === 'file'
                      ? "The editor's language diagnostics and static scan found nothing in this file. Run again after editing or saving."
                      : 'No deterministic findings were produced for the selected scope. AI analysis only runs on the active file.'}
                  </p>
                </div>
              </div>
            )}

            {issues.length > 0 && (
              <ul className="max-h-[400px] space-y-2 overflow-y-auto pr-1">
                {issues.map((issue) => {
                  const vis = severityIcon(issue);
                  const selected = issue.id === selectedId;
                  const canReview =
                    !!issue.fix &&
                    (issue.status === 'fix-proposed' ||
                      issue.status === 'analyzed' ||
                      issue.status === 'verification-failed' ||
                      issue.status === 'reverted' ||
                      issue.status === 'rejected');
                  return (
                    <li
                      key={issue.id}
                      onClick={() => navigateTo(issue)}
                      className={cn(
                        'group cursor-pointer rounded-xl border px-3 py-2.5 transition-colors',
                        selected
                          ? 'border-accent/50 bg-accent-50 dark:bg-accent/10'
                          : 'border-line bg-canvas hover:border-line-strong hover:bg-surface-hover',
                      )}
                    >
                      <div className="flex items-start gap-2.5">
                        <Icon name={vis.icon} size={15} className={cn('mt-0.5 shrink-0', vis.className)} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-[12.5px] font-medium leading-snug text-text">{issue.title}</span>
                            <Badge tone={SOURCE_TONE[issue.source]}>{SOURCE_LABEL[issue.source]}</Badge>
                            <Badge tone={STATUS_TONE[issue.status]}>{STATUS_LABEL[issue.status]}</Badge>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-text-subtle">
                            <span className="font-mono">{issue.fileName}</span>
                            {issue.code && <span className="font-mono">{issue.code}</span>}
                            {issue.line !== undefined && (
                              <span className="font-mono">
                                line {issue.line}
                                {issue.column ? `:${issue.column}` : ''}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-[12px] leading-relaxed text-text-muted">{issue.explanation}</p>
                          {issue.verification && (
                            <p className="mt-1 text-[11.5px] leading-relaxed text-text-subtle">
                              <span className="font-medium text-text-muted">Verification:</span> {issue.verification.detail}
                            </p>
                          )}
                        </div>
                        {canReview && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              reviewFix(issue.id);
                            }}
                            className="shrink-0"
                          >
                            Review Fix
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

/** The governed review surface: problem, root cause, evidence, proposal,
 *  approval controls. Approval is the only path that writes to the file. */
function FixReview({
  issue,
  fileIsOpen,
  busyId,
  onBack,
  onApprove,
  onReject,
  onRevert,
}: {
  issue: AuraBugIssue;
  fileIsOpen: (path: string) => boolean;
  busyId: string | null;
  onBack: () => void;
  onApprove: () => void;
  onReject: () => void;
  onRevert: () => void;
}) {
  const open = fileIsOpen(issue.filePath);
  const busy = busyId === issue.id;
  const canApprove =
    !!issue.fix && open && !busy && (issue.status === 'awaiting-approval' || issue.status === 'fix-proposed' || issue.status === 'reverted');
  const canRevert = issue.status === 'verification-failed' && !!issue.preFixContent && open && !busy;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[issue.status]}>{STATUS_LABEL[issue.status]}</Badge>
          <Badge tone={SOURCE_TONE[issue.source]}>{SOURCE_LABEL[issue.source]}</Badge>
          {issue.code && <span className="font-mono text-[11px] text-text-subtle">{issue.code}</span>}
        </div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
      </div>

      <section className="space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Problem</h3>
        <p className="text-[13px] leading-relaxed text-text">{issue.title}</p>
        <p className="text-[12px] leading-relaxed text-text-muted">{issue.explanation}</p>
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
          Root cause <Badge tone="neutral">inference</Badge>
        </h3>
        {issue.rootCause ? (
          <p className="text-[12px] leading-relaxed text-text-muted">{issue.rootCause}</p>
        ) : (
          <p className="text-[12px] italic leading-relaxed text-text-subtle">No deterministic cause could be stated — this finding is evidence-only.</p>
        )}
      </section>

      <section className="space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Affected location</h3>
        <p className="font-mono text-[12px] text-text">
          {issue.filePath}
          {issue.line !== undefined ? `:${issue.line}${issue.column ? `:${issue.column}` : ''}` : ''}
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Suggested fix</h3>
        <p className="text-[12px] leading-relaxed text-text-muted">
          {issue.suggestedFix ?? (issue.fix ? 'A deterministic line-range edit is available.' : 'No safe fix was generated.')}
        </p>
        {issue.fix && (
          <div className="rounded-xl border border-line bg-canvas px-3.5 py-2.5">
            <p className="text-[11px] text-text-subtle">
              Replaces lines {issue.fix.startLine}–{issue.fix.endLine}
            </p>
            <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-text">
              {issue.fix.newText || '— deleted —'}
            </pre>
          </div>
        )}
      </section>

      <section className="space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Verification plan</h3>
        <p className="text-[12px] leading-relaxed text-text-muted">
          After approval the change is written to disk through the editor's own save path, then the file is re-scanned deterministically
          (language diagnostics + static scan). The finding is marked <span className="text-positive">Verified</span> only if it no longer
          appears; otherwise it is marked <span className="text-danger">Verification failed</span> and can be reverted.
        </p>
        {issue.verification && (
          <p className="text-[12px] leading-relaxed text-text-muted">
            <span className="font-medium text-text-muted">Result:</span> {issue.verification.detail}
          </p>
        )}
      </section>

      {!open && issue.fix && (
        <p className="rounded-xl border border-attention/30 bg-attention/10 px-3.5 py-2.5 text-[12px] text-attention">
          This file is not open. Open it to apply the fix — the fix writes through the editor buffer.
        </p>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
        {canRevert && (
          <Button variant="secondary" size="sm" loading={busy} onClick={onRevert}>
            Revert Fix
          </Button>
        )}
        {issue.status === 'reverted' && <Badge tone="neutral">Fix reverted — original content restored</Badge>}
        {issue.status === 'rejected' && <Badge tone="neutral">Fix declined — no change was made</Badge>}
        <Button variant="secondary" size="sm" onClick={onReject} disabled={busy || issue.status === 'rejected' || issue.status === 'reverted'}>
          Reject
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon="check"
          loading={busy}
          disabled={!canApprove}
          onClick={onApprove}
        >
          {issue.status === 'verified'
            ? 'Verified'
            : issue.status === 'verification-failed'
              ? 'Verification failed'
              : 'Approve & Apply'}
        </Button>
      </div>
    </div>
  );
}
