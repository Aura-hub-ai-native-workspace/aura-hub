/**
 * DiagnosisPanel — the Engineering Diagnosis Engine's dedicated dialog.
 * ------------------------------------------------------------------
 * Not a retrofit of `AIActionDialog` — this is a fundamentally richer,
 * multi-stage flow: stage timeline, real Stage-1 evidence, a
 * deterministic classification badge with its `checksRun` breakdown,
 * an AI-written (clearly labeled) root cause, and — only once the
 * category is real, never `'unknown'` — the Patch Evolution compare
 * view with an explicit human Accept/Reject gate.
 */
import { useState } from 'react';
import { Badge, Button, Dialog, Icon } from '@aura/ui';
import type { StatusTone } from '@aura/core';
import { useAppStore } from '@aura/core';
import { useEditorStore } from './editorStore';
import { DiagnosisPatchCompare } from './DiagnosisPatchCompare';
import type { DiagnosisState } from './useDiagnosis';
import type { BugCategory } from '../ai/diagnosisClient';

const CATEGORY_LABEL: Record<BugCategory, string> = {
  'null-bug': 'Null / undefined access',
  'dead-code': 'Dead code',
  'broken-api': 'Broken API',
  'architecture-smell': 'Architecture smell',
  unknown: 'Unknown',
};
const CATEGORY_TONE: Record<BugCategory, StatusTone> = {
  'null-bug': 'critical',
  'dead-code': 'attention',
  'broken-api': 'critical',
  'architecture-smell': 'attention',
  unknown: 'neutral',
};

const STAGE_ORDER = ['analyzing', 'diagnosing', 'patching', 'reviewing', 'done'] as const;
const STAGE_LABEL: Record<(typeof STAGE_ORDER)[number], string> = {
  analyzing: 'Failure analysis + classification',
  diagnosing: 'Root cause (AI)',
  patching: 'Patch generation, simulation + review',
  reviewing: 'Patch evolution comparison',
  done: 'Complete',
};

export function DiagnosisPanel({
  open,
  onClose,
  diagnosis,
}: {
  open: boolean;
  onClose: () => void;
  diagnosis: { state: DiagnosisState; accept: (id: 'A' | 'B' | 'C') => Promise<{ ok: boolean; error?: string }>; reject: (id?: 'A' | 'B' | 'C', reason?: string) => Promise<{ ok: boolean; error?: string }> };
}) {
  const { state, accept, reject } = diagnosis;
  const theme = useAppStore((s) => s.theme);
  const openFiles = useEditorStore((s) => s.openFiles);
  const [selected, setSelected] = useState<'A' | 'B' | 'C' | null>(null);
  const [busy, setBusy] = useState(false);

  const file = state.filePath ? openFiles[state.filePath] : undefined;
  const stageIndex = state.phase === 'idle' || state.phase === 'error' ? -1 : STAGE_ORDER.indexOf(state.phase as (typeof STAGE_ORDER)[number]);
  const decided = state.diagnosis?.decision.status !== 'pending' && state.diagnosis?.decision.status !== undefined;

  const handleAccept = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const res = await accept(selected);
      if (res.ok) setTimeout(onClose, 900);
    } finally {
      setBusy(false);
    }
  };
  const handleReject = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await reject(selected ?? undefined);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      className="max-w-[1080px]"
      title={
        <span className="flex items-center gap-2">
          <Icon name="bug" size={16} />
          Engineering Diagnosis
          {file && <span className="font-normal text-text-subtle">— {file.name}</span>}
        </span>
      }
      footer={
        state.phase === 'done' && state.classification && state.classification.category !== 'unknown' && !decided ? (
          <div className="flex w-full items-center justify-between gap-3">
            <span className="text-[11.5px] text-text-subtle">
              {selected ? `Candidate ${selected} selected` : 'Select a candidate above before accepting'}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={handleReject} loading={busy && !selected}>Reject All</Button>
              <Button variant="primary" size="sm" disabled={!selected} loading={busy} onClick={handleAccept}>
                Accept Candidate {selected ?? ''}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex w-full justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
          </div>
        )
      }
    >
      <div className="min-h-[160px] space-y-4">
        {/* Stage timeline — real, discrete stages, never a fabricated progress bar. */}
        {state.phase !== 'idle' && (
          <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-text-muted">
            {STAGE_ORDER.map((s, i) => (
              <span key={s} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-text-subtle">→</span>}
                <span className={i <= stageIndex ? 'font-medium text-text' : ''}>
                  {i < stageIndex || state.phase === 'done' ? '✓ ' : i === stageIndex ? '● ' : ''}
                  {STAGE_LABEL[s]}
                </span>
              </span>
            ))}
          </div>
        )}

        {state.errorMessage && (
          <div className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[12.5px] text-danger">{state.errorMessage}</div>
        )}

        {state.unknownMessage && (
          <div className="rounded-xl border border-line bg-canvas px-3.5 py-3 text-[12.5px] text-text-muted">{state.unknownMessage}</div>
        )}

        {state.classification && (
          <div className="rounded-xl border border-line bg-canvas px-3.5 py-3">
            <div className="flex items-center gap-2">
              <Badge tone={CATEGORY_TONE[state.classification.category]}>{CATEGORY_LABEL[state.classification.category]}</Badge>
              <span className="text-[11.5px] text-text-subtle">
                {state.classification.checksRun.filter((c) => c.fired).length}/{state.classification.checksRun.length} checks fired
              </span>
            </div>
            <ul className="mt-2 space-y-1 text-[12px] text-text-muted">
              {state.classification.checksRun.map((c, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  <Icon name={c.fired ? 'check' : 'close'} size={12} className={c.fired ? 'text-positive' : 'text-text-subtle'} />
                  {c.name}
                </li>
              ))}
            </ul>
            {state.classification.evidence.length > 0 && (
              <ul className="mt-2 space-y-1 border-t border-line pt-2 text-[12px] text-text-muted">
                {state.classification.evidence.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
          </div>
        )}

        {state.rootCause && (
          <div className="rounded-xl border border-line bg-canvas px-3.5 py-3">
            <div className="mb-1 flex items-center gap-2 text-[11.5px] font-medium text-text">
              <Icon name="spark" size={13} />
              AI-written root cause ({state.rootCause.aiStatedConfidence} self-stated confidence)
            </div>
            <p className="text-[12.5px] leading-relaxed text-text">{state.rootCause.summary}</p>
          </div>
        )}

        {state.candidates.length > 0 && file && (
          <DiagnosisPatchCompare
            candidates={state.candidates}
            comparison={state.comparison}
            originalContent={file.content}
            language={file.language}
            theme={theme === 'dark' ? 'dark' : 'light'}
            selectedId={selected}
            onSelect={setSelected}
          />
        )}

        {decided && state.diagnosis && (
          <div className="rounded-xl border border-line bg-canvas px-3.5 py-2.5 text-[12.5px] text-text-muted">
            Decision: <strong className="text-text">{state.diagnosis.decision.status}</strong>
            {state.diagnosis.decision.candidateId ? ` (candidate ${state.diagnosis.decision.candidateId})` : ''}
          </div>
        )}
      </div>
    </Dialog>
  );
}
