import { Icon } from '@aura/ui';
import type { AgentEvidenceBundle } from '../../../ai/centralAgentClient';

/**
 * EvidencePanel — assembled proof for a completed run.
 *
 * Every value shown here comes from the EvidenceBundle the backend built:
 * audit record count, approval IDs, model identity, artifact paths.
 * Nothing is inferred or composed here. A field that the backend did not
 * populate is simply not drawn.
 *
 * Security: API keys and provider credentials NEVER enter this struct —
 * the backend keeps those server-side. modelProvider/modelName are model
 * identity strings (e.g. "ollama" / "llama3.2"), not access tokens.
 */
export function EvidencePanel({
  evidence,
  sessionId,
}: {
  evidence: AgentEvidenceBundle;
  sessionId: string | null;
}) {
  const artifacts = evidence.artifactPaths ?? [];
  const hasModel = !!evidence.modelProvider || !!evidence.modelName;
  const hasContent =
    evidence.auditRecordIds.length > 0 ||
    artifacts.length > 0 ||
    hasModel ||
    !!evidence.planId;

  if (!hasContent) return null;

  return (
    <section
      data-testid="evidence-panel"
      aria-label="Mission evidence"
      className="rounded-xl border border-[rgba(31,211,138,0.25)] bg-[rgba(9,13,26,0.75)] px-4 py-3"
    >
      <div className="mb-2.5 flex items-center gap-2">
        <Icon name="shield" size={12} className="text-neon-success" />
        <h3 className="text-[10.5px] font-semibold uppercase tracking-widest text-neon-success">
          Evidence
        </h3>
      </div>

      <dl className="space-y-1.5">
        {hasModel && (
          <EvidenceRow
            label="Runtime"
            value={
              evidence.modelProvider && evidence.modelName
                ? `${evidence.modelProvider} / ${evidence.modelName}`
                : (evidence.modelProvider ?? evidence.modelName ?? '')
            }
            testId="evidence-runtime"
          />
        )}
        {evidence.auditRecordIds.length > 0 && (
          <EvidenceRow
            label="Audit records"
            value={String(evidence.auditRecordIds.length)}
            testId="evidence-audit-count"
          />
        )}
        {evidence.approvalIds.length > 0 && (
          <EvidenceRow
            label="Approvals"
            value={String(evidence.approvalIds.length)}
            testId="evidence-approval-count"
          />
        )}
        {evidence.planId && (
          <EvidenceRow
            label="Plan"
            value={evidence.planId}
            testId="evidence-plan-id"
            mono
          />
        )}
      </dl>

      {artifacts.length > 0 && (
        <div className="mt-2">
          <p className="mb-1 text-[10.5px] font-semibold text-text-subtle">
            Artifacts ({artifacts.length})
          </p>
          <ul className="space-y-0.5">
            {artifacts.map((p: string) => (
              <li
                key={p}
                data-testid="evidence-artifact"
                className="flex items-center gap-1.5"
              >
                <Icon name="file" size={10} className="shrink-0 text-text-subtle" />
                <span className="min-w-0 truncate font-mono text-[10px] text-text-muted">
                  {p}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {evidence.summary && (
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-text-muted">
          {evidence.summary}
        </p>
      )}

      {sessionId && (
        <p className="mt-1.5 truncate text-[9px] text-text-subtle" data-testid="evidence-session-id">
          session {sessionId}
        </p>
      )}
    </section>
  );
}

function EvidenceRow({
  label,
  value,
  testId,
  mono,
}: {
  label: string;
  value: string;
  testId?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-28 shrink-0 text-[10px] font-semibold text-text-subtle">{label}</dt>
      <dd
        data-testid={testId}
        className={`min-w-0 truncate text-[11px] text-text ${mono ? 'font-mono' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}
