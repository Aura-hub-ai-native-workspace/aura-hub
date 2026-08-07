import { useMemo, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { Badge, Button, Dialog, Icon, type IconName } from '@aura/ui';
import type { StatusTone } from '@aura/core';
import { useAppStore } from '@aura/core';
import { aiClient, type RiskLevel } from '../ai/aiClient';
import { recordAiActionMemory } from '../ops/memoryRecorder';
import { actionSpec } from './actionSpecs';
import { useEditorStore } from './editorStore';
import { spliceSelection, type AiActionState } from './useAiAction';

const RISK_TONE: Record<RiskLevel, StatusTone> = { safe: 'positive', medium: 'attention', high: 'critical' };
const RISK_LABEL: Record<RiskLevel, string> = { safe: '🟢 Safe', medium: '🟡 Medium Risk', high: '🔴 High Risk' };
const SEVERITY_TONE: Record<'info' | 'warning' | 'critical', StatusTone> = { info: 'info', warning: 'attention', critical: 'critical' };
const SEVERITY_ICON: Record<'info' | 'warning' | 'critical', IconName> = { info: 'spark', warning: 'bug', critical: 'shield' };

/**
 * The one result shell for every AI code action — two body modes
 * (`diff`/`new-file` via Monaco's real DiffEditor, `findings` via a
 * severity list), driven entirely by `useAiAction`'s state. Never writes
 * anything until Accept; "Explain Changes" just reveals the explanation
 * already fetched in the same response — no second AI call.
 */
export function AIActionDialog({
  aiAction,
}: {
  aiAction: { state: AiActionState; run: (action: import('../ai/aiClient').ActionKind, customInstruction?: string) => Promise<void>; reset: () => void };
}) {
  const { state, run, reset } = aiAction;
  const theme = useAppStore((s) => s.theme);
  const openFiles = useEditorStore((s) => s.openFiles);
  const updateContent = useEditorStore((s) => s.updateContent);
  const saveFile = useEditorStore((s) => s.saveFile);
  const createFile = useEditorStore((s) => s.createFile);

  const [showExplanation, setShowExplanation] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [askAgainOpen, setAskAgainOpen] = useState(false);
  const [refinement, setRefinement] = useState('');

  const spec = state.action ? actionSpec(state.action) : null;
  const file = state.filePath ? openFiles[state.filePath] : undefined;
  const open = state.phase !== 'idle';

  const modifiedFull = useMemo(() => {
    if (!state.response?.newCode || !file) return '';
    if (spec?.mode === 'new-file') return state.response.newCode;
    return spliceSelection(file.content, state.selection, state.response.newCode);
  }, [state.response, file, state.selection, spec]);

  const close = () => {
    setShowExplanation(false);
    setAskAgainOpen(false);
    setRefinement('');
    setAccepted(false);
    setAcceptError(null);
    reset();
  };

  const handleAccept = async () => {
    if (!state.response || !file || accepting) return;
    setAccepting(true);
    setAcceptError(null);
    try {
      if (spec?.mode === 'new-file' && state.response.newFilePath) {
        await createFile(state.response.newFilePath, state.response.newCode ?? '');
      } else {
        updateContent(file.path, modifiedFull);
        await saveFile(file.path);
        // saveFile() catches its own write errors and records them on the
        // file rather than throwing — check for that instead of assuming
        // the write succeeded just because the promise resolved.
        const written = useEditorStore.getState().openFiles[file.path];
        if (written?.saveError) throw new Error(written.saveError);
      }
      void aiClient.reindex(); // fire-and-forget — refreshes the Knowledge Fabric shortly after
      recordAiActionMemory({
        accepted: true,
        action: state.action ?? spec?.id ?? 'custom',
        filePath: file.path,
        symbolLabel: state.contextSummary?.symbolLabel ?? null,
        explanation: state.response.explanation,
        riskLevel: risk?.level ?? null,
      });
      setAccepted(true);
      setTimeout(close, 900);
    } catch (e) {
      setAcceptError((e as Error).message || 'Could not write the change to disk.');
    } finally {
      setAccepting(false);
    }
  };

  const handleReject = () => {
    if (state.response && file && state.action) {
      recordAiActionMemory({
        accepted: false,
        action: state.action,
        filePath: file.path,
        symbolLabel: state.contextSummary?.symbolLabel ?? null,
        explanation: state.response.explanation,
        riskLevel: risk?.level ?? null,
      });
    }
    close();
  };

  const handleCopy = () => {
    const text = state.response?.newCode ?? state.response?.explanation ?? '';
    void navigator.clipboard.writeText(text);
  };

  const handleAskAgain = () => {
    if (!state.action) return;
    const instruction = refinement.trim() || undefined;
    setAskAgainOpen(false);
    setRefinement('');
    setShowExplanation(false);
    void run(state.action, instruction);
  };

  if (!spec) return null;

  const analyzing = state.phase === 'context-resolved' || state.phase === 'generating';
  const risk = state.response?.risk ?? state.risk;

  return (
    <Dialog
      open={open}
      onClose={close}
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
        state.phase === 'done' && state.response?.ok ? (
          <div className="flex w-full items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" icon="clipboard" onClick={handleCopy}>Copy</Button>
              <Button variant="ghost" size="sm" icon="refresh" onClick={() => setAskAgainOpen((v) => !v)}>Ask Again</Button>
              {state.response.explanation && (
                <Button variant="ghost" size="sm" icon="spark" onClick={() => setShowExplanation((v) => !v)}>
                  {showExplanation ? 'Hide Explanation' : 'Explain Changes'}
                </Button>
              )}
            </div>
            {spec.mode !== 'findings' && (
              <div className="flex items-center gap-2">
                {acceptError && <span className="text-[12px] text-danger">{acceptError}</span>}
                <Button variant="secondary" size="sm" onClick={handleReject}>Reject</Button>
                <Button variant="primary" size="sm" icon={accepted ? 'check' : undefined} loading={accepting} onClick={handleAccept}>
                  {accepted ? 'Applied' : acceptError ? 'Retry' : 'Accept Changes'}
                </Button>
              </div>
            )}
            {spec.mode === 'findings' && <Button variant="secondary" size="sm" onClick={close}>Close</Button>}
          </div>
        ) : state.phase === 'error' ? (
          <div className="flex w-full items-center justify-between">
            <span className="text-[12px] text-danger">{state.errorMessage}</span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={close}>Close</Button>
              {state.action && <Button variant="secondary" size="sm" icon="refresh" onClick={() => void run(state.action!)}>Retry</Button>}
            </div>
          </div>
        ) : null
      }
    >
      <div className="min-h-[120px]">
        {/* Step 1 + 2 — real, honest progress: real counts first, then a real elapsed timer. No fabricated reasoning text. */}
        {analyzing && (
          <div className="space-y-3 py-4">
            <div className="flex items-center gap-2 text-[12.5px] text-text-muted">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
              {state.phase === 'context-resolved'
                ? 'Analyzing project…'
                : `${spec.promptVerb}… ${(state.elapsedMs / 1000).toFixed(1)}s`}
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
                {state.risk && (
                  <div className="mt-2">
                    <Badge tone={RISK_TONE[state.risk.level]}>{RISK_LABEL[state.risk.level]}</Badge>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {state.phase === 'done' && state.response?.ok && (
          <div className="space-y-3 pb-2">
            {risk && (
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={RISK_TONE[risk.level]}>{RISK_LABEL[risk.level]}</Badge>
                {risk.reasons.slice(0, 4).map((r, i) => (
                  <Badge key={i} tone="neutral">{r}</Badge>
                ))}
              </div>
            )}

            {spec.id === 'rename' && (state.contextSummary?.dependentFileCount ?? 0) > 0 && (
              <div className="rounded-xl border border-attention/30 bg-attention/10 px-3.5 py-2.5 text-[12px] text-attention">
                ⚠ {state.contextSummary!.referenceCount} reference(s) in {state.contextSummary!.dependentFileCount} other file(s) will not
                be updated — Phase 1 rename only edits the current file.
              </div>
            )}

            {showExplanation && state.response.explanation && (
              <div className="rounded-xl border border-line bg-canvas px-3.5 py-2.5 text-[12.5px] leading-relaxed text-text">
                {state.response.explanation}
              </div>
            )}

            {askAgainOpen && (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={refinement}
                  onChange={(e) => setRefinement(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAskAgain()}
                  placeholder="Refine the request (optional) and press Enter…"
                  className="flex-1 rounded-lg border border-line bg-canvas px-3 py-1.5 text-[12.5px] text-text outline-none placeholder:text-text-subtle focus:border-accent"
                />
                <Button size="sm" variant="primary" onClick={handleAskAgain}>Send</Button>
              </div>
            )}

            {spec.mode === 'findings' ? (
              <div className="space-y-2">
                {!state.response.findings?.length && (
                  <div className="rounded-xl border border-line bg-canvas px-3.5 py-3 text-[12.5px] text-text-muted">
                    {state.response.explanation || 'No issues found.'}
                  </div>
                )}
                {state.response.findings?.map((f, i) => (
                  <div key={i} className="flex items-start gap-2.5 rounded-xl border border-line bg-canvas px-3.5 py-3">
                    <Icon name={SEVERITY_ICON[f.severity]} size={15} className="mt-0.5 shrink-0 text-text-subtle" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-text">{f.title}</span>
                        <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge>
                        {f.line && <span className="text-[11px] text-text-subtle">Line {f.line}</span>}
                      </div>
                      <p className="mt-0.5 text-[12px] leading-relaxed text-text-muted">{f.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-line">
                <DiffEditor
                  height="420px"
                  language={file?.language ?? 'plaintext'}
                  original={spec.mode === 'new-file' ? '' : (file?.content ?? '')}
                  modified={modifiedFull}
                  theme={theme === 'dark' ? 'aura-dark' : 'aura-light'}
                  options={{ fontSize: 12.5, readOnly: true, renderSideBySide: true, minimap: { enabled: false }, scrollBeyondLastLine: false }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
