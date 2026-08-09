/**
 * AuraBugPanel — results surface for the AuraBug scan.
 * ------------------------------------------------------------------
 * Honest by construction: every row names its source (editor
 * diagnostics / static scan / AI), never invents findings, shows a
 * clear "no issues detected" state when the file is genuinely clean,
 * and applies fixes as a deterministic line-range edit the user can
 * confirm or ignore. Fixes land in the live editor buffer (never
 * auto-saved); clicking a row jumps the editor to it with a pulsing
 * line highlight.
 */
import { Badge, Button, Dialog, Icon } from '@aura/ui';
import { cn } from '@aura/core';
import { useEditorStore } from '../editorStore';
import type { AuraBugController } from './useAuraBug';
import type { AuraBugIssue, AuraBugSource } from './types';

const SOURCE_LABEL: Record<AuraBugSource, string> = {
  'language-service': 'Diagnostics',
  heuristic: 'Static scan',
  ai: 'AI scan',
};
const SOURCE_TONE: Record<AuraBugSource, 'info' | 'neutral' | 'attention'> = {
  'language-service': 'info',
  heuristic: 'neutral',
  ai: 'attention',
};

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
  const fileName = useEditorStore((s) => (s.activePath ? s.openFiles[s.activePath]?.name : undefined));
  const { phase, issues, aiStatus, aiEnabled, setAiEnabled, selectedId, rescan, applyFix, navigateTo } = aura;
  const scanning = phase === 'scanning';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      className="max-w-[720px]"
      title={
        <span className="flex items-center gap-2">
          <Icon name="bug" size={16} />
          AuraBug
          {fileName && <span className="font-normal text-text-subtle">— {fileName}</span>}
          {phase === 'done' && issues.length > 0 && (
            <span className="ml-1 font-normal text-text-subtle">
              · {issues.length} {issues.length === 1 ? 'finding' : 'findings'}
            </span>
          )}
        </span>
      }
      footer={
        <div className="flex w-full items-center justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        </div>
      }
    >
      <div className="min-h-[200px] space-y-3">
        {/* Controls */}
        <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
          <div className="flex items-center gap-2 text-[12px] text-text-muted">
            {scanning ? (
              <>
                <Icon name="refresh" size={13} className="animate-spin text-accent" />
                Scanning the current file…
              </>
            ) : (
              <span className="flex items-center gap-1.5">
                <Icon name="shield" size={13} className="text-text-subtle" />
                {issues.length === 0 ? 'File looks clean' : `${issues.length} finding${issues.length === 1 ? '' : 's'} in this file`}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
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
            <Button variant="secondary" size="sm" icon="refresh" disabled={scanning} onClick={rescan}>
              Scan Again
            </Button>
          </div>
        </div>

        {scanning && aiEnabled && (
          <div className="flex items-center gap-2 text-[11.5px] text-text-muted">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            {aiStatus === 'pending' ? 'AI analysis running…' : 'Waiting on AI analysis…'}
          </div>
        )}

        {phase === 'idle' && (
          <div className="py-8 text-center text-[12.5px] text-text-muted">
            Open a file to scan it for bugs, errors and risky code.
          </div>
        )}

        {phase === 'done' && issues.length === 0 && (
          <div className="grid place-items-center py-8">
            <div className="max-w-[260px] text-center">
              <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-2xl border border-line bg-surface text-positive">
                <Icon name="check" size={20} />
              </div>
              <div className="text-[13px] font-semibold text-text">No issues detected</div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">
                The editor's language diagnostics and static scan found nothing in this file. Run again after editing or saving.
              </p>
            </div>
          </div>
        )}

        {issues.length > 0 && (
          <ul className="max-h-[400px] space-y-2 overflow-y-auto pr-1">
            {issues.map((issue) => {
              const vis = severityIcon(issue);
              const selected = issue.id === selectedId;
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
                        {issue.applied && <Badge tone="positive">Applied</Badge>}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-text-subtle">
                        {issue.code && <span className="font-mono">{issue.code}</span>}
                        {issue.line !== undefined && <span className="font-mono">line {issue.line}{issue.column ? `:${issue.column}` : ''}</span>}
                      </div>
                      <p className="mt-1 text-[12px] leading-relaxed text-text-muted">{issue.explanation}</p>
                      {issue.suggestedFix && (
                        <p className="mt-1 text-[12px] leading-relaxed text-text-subtle">
                          <span className="font-medium text-text-muted">Fix:</span> {issue.suggestedFix}
                        </p>
                      )}
                    </div>
                    {issue.fix && !issue.applied && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          applyFix(issue.id);
                        }}
                        className="shrink-0"
                      >
                        Apply Fix
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
