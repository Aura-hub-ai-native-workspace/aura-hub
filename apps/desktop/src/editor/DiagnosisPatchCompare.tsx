/**
 * DiagnosisPatchCompare — the Patch Evolution A/B/C view. Each tab is a
 * real Monaco `DiffEditor` (same splice-reconstruction as
 * `AIActionDialog.tsx`) plus that candidate's real limiter decision,
 * impact report, reviewer verdict, and confidence — never a bare
 * "trust me" recommendation. The comparison writeup is clearly labeled
 * as AI-written; the recommended tab is pre-selected but never hidden
 * from the others, including auto-rejected ones (shown, grayed out,
 * with their real rejection reason).
 */
import { useEffect, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { Badge, Icon, Tab, Tabs } from '@aura/ui';
import type { StatusTone } from '@aura/core';
import type { DiagnosisComparison, PatchCandidate, PatchDecision } from '../ai/diagnosisClient';

const DECISION_TONE: Record<PatchDecision, StatusTone> = {
  'auto-approved': 'positive',
  'requires-manual-approval': 'attention',
  'auto-rejected': 'critical',
};
const DECISION_LABEL: Record<PatchDecision, string> = {
  'auto-approved': 'Passed safety gates',
  'requires-manual-approval': 'Requires manual approval',
  'auto-rejected': 'Auto-rejected',
};

function pct(n: number): string {
  return `${Math.floor(Math.min(0.99, Math.max(0, n)) * 100)}%`;
}

function splicePatch(originalText: string, range: { startLine: number; endLine: number }, newText: string): string {
  const lines = originalText.split('\n');
  const before = lines.slice(0, range.startLine - 1);
  const after = lines.slice(range.endLine);
  return [...before, ...newText.split('\n'), ...after].join('\n');
}

export function DiagnosisPatchCompare({
  candidates,
  comparison,
  originalContent,
  language,
  theme,
  selectedId,
  onSelect,
}: {
  candidates: PatchCandidate[];
  comparison: DiagnosisComparison | null;
  originalContent: string;
  language: string;
  theme: 'dark' | 'light';
  selectedId: 'A' | 'B' | 'C' | null;
  onSelect: (id: 'A' | 'B' | 'C') => void;
}) {
  const [active, setActive] = useState<'A' | 'B' | 'C'>(comparison?.recommended ?? candidates[0]?.id ?? 'A');

  useEffect(() => {
    if (comparison?.recommended) setActive(comparison.recommended);
  }, [comparison?.recommended]);

  const current = candidates.find((c) => c.id === active);
  const rejected = current?.limiter.decision === 'auto-rejected';

  if (!candidates.length) return null;

  return (
    <div className="space-y-3">
      {comparison && (
        <div className="rounded-xl border border-line bg-canvas px-3.5 py-2.5 text-[12px] leading-relaxed text-text-muted">
          <span className="mr-1.5 font-medium text-text">AI-written comparison:</span>
          {comparison.writeup}
        </div>
      )}

      <Tabs value={active} onChange={(v) => setActive(v as 'A' | 'B' | 'C')} layoutId="diagnosis-patch-tabs">
        {candidates.map((c) => (
          <Tab key={c.id} value={c.id}>
            {c.id} {c.limiter.decision === 'auto-rejected' ? '(rejected)' : comparison?.recommended === c.id ? '(recommended)' : ''}
          </Tab>
        ))}
      </Tabs>

      {current && (
        <div className={rejected ? 'opacity-60' : ''}>
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <Badge tone="neutral">{current.strategy}</Badge>
            <Badge tone={DECISION_TONE[current.limiter.decision]}>{DECISION_LABEL[current.limiter.decision]}</Badge>
            <Badge tone={current.reviewer.verdict === 'reject' ? 'critical' : 'positive'}>
              Reviewer: {current.reviewer.verdict === 'reject' ? 'rejected' : 'passed'}
            </Badge>
          </div>

          <p className="mb-2 text-[12.5px] leading-relaxed text-text">{current.explanation}</p>

          {current.limiter.reasons.length > 0 && (
            <div className="mb-2 rounded-lg border border-line bg-canvas px-3 py-2 text-[11.5px] text-text-muted">
              {current.limiter.reasons.join('; ')}
            </div>
          )}
          {current.reviewer.flaws.length > 0 && (
            <div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[11.5px] text-danger">
              {current.reviewer.flaws.join('; ')}
            </div>
          )}

          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <Badge tone="neutral">diagnosis {pct(current.confidence.diagnosis)}</Badge>
            <Badge tone="neutral">patch {pct(current.confidence.patch)}</Badge>
            <Badge tone="neutral">architecture {pct(current.confidence.architecture)}</Badge>
            <Badge tone="neutral">simulation {pct(current.confidence.simulation)}</Badge>
            <Badge tone="info">overall {pct(current.confidence.overall)}</Badge>
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-3 text-[11.5px] text-text-muted">
            <span className="flex items-center gap-1">
              <Icon name={current.impact.compiled ? 'check' : 'bug'} size={12} />
              {current.impact.compiled ? 'Compiles (syntax/local only)' : 'Compile diagnostics found'}
            </span>
            <span>{current.impact.categoryStillPresent ? 'Category still present after patch' : 'Category no longer detected'}</span>
            <span>{current.impact.referencesBroken.length} broken reference(s)</span>
            <span>{current.impact.testsFound ? `${current.impact.testFilePaths.length} related test file(s) found (not run)` : 'No related tests found'}</span>
          </div>

          <div className="overflow-hidden rounded-xl border border-line">
            <DiffEditor
              height="360px"
              language={language}
              original={originalContent}
              modified={splicePatch(originalContent, current.targetRange, current.newText)}
              theme={theme === 'dark' ? 'aura-dark' : 'aura-light'}
              options={{ fontSize: 12.5, readOnly: true, renderSideBySide: true, minimap: { enabled: false }, scrollBeyondLastLine: false }}
            />
          </div>

          <button
            type="button"
            disabled={rejected}
            onClick={() => onSelect(current.id)}
            className="mt-2 text-[12px] font-medium text-accent disabled:cursor-not-allowed disabled:text-text-subtle"
          >
            {selectedId === current.id ? '✓ Selected for review' : rejected ? 'Cannot select — auto-rejected' : 'Select this candidate'}
          </button>
        </div>
      )}
    </div>
  );
}
