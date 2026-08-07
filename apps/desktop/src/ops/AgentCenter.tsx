/**
 * AgentCenter — the Autonomous Engineering Agent's control room.
 * ==================================================================
 * Renders the agent's live state (ops/agentStore.ts) and the actions
 * the human is allowed to take at each gate:
 *
 *   • Approval queue — improvement proposals awaiting human approval.
 *     Approving lets the agent create a real improvement mission;
 *     dismissing stops that campaign permanently.
 *   • Action queue — approved campaigns now executing as missions
 *     (each mission task proposal still needs per-task acceptance in
 *     Mission Control).
 *   • Verification queue — completed missions being measured against
 *     their verify target.
 *   • Timeline — every agent/human/system transition, replayable.
 *
 * The agent itself never edits code: it only observes, reasons, plans,
 * proposes and — after approval — creates missions.
 *
 * `variant="screen"` renders the full landing; `variant="panel"`
 * renders the compact workspace-panel form.
 */
import { useState } from 'react';
import { Badge, Button, Icon } from '@aura/ui';
import type { IconName } from '@aura/ui';
import { cn } from '@aura/core';
import { useWorkspace } from '../data/useWorkspace';
import { relTime } from '../screens/missions/missionMeta';
import { useLayoutStore } from './layoutStore';
import { useLearningEngine } from './learningEngine';
import {
  AGENT_SIGNAL_META,
  actionQueue,
  agentStatusSummary,
  approvalQueue,
  useAgentStore,
  verificationQueue,
  type AgentCampaign,
  type AgentCampaignStatus,
  type AgentSeverity,
} from './agentStore';
import { runAgentObservation } from './agentEngine';

type AgentView = 'queues' | 'campaigns' | 'timeline';

const VIEWS: { key: AgentView; label: string; icon: IconName }[] = [
  { key: 'queues', label: 'Queues', icon: 'clipboard' },
  { key: 'campaigns', label: 'Campaigns', icon: 'git-branch' },
  { key: 'timeline', label: 'Timeline', icon: 'activity' },
];

const SEVERITY_TONE: Record<AgentSeverity, 'positive' | 'attention' | 'critical' | 'info' | 'neutral'> = {
  low: 'neutral',
  medium: 'info',
  high: 'attention',
  critical: 'critical',
};

const STATUS_META: Record<AgentCampaignStatus, { label: string; tone: 'positive' | 'attention' | 'critical' | 'info' | 'neutral' }> = {
  observed: { label: 'Observed', tone: 'neutral' },
  planned: { label: 'Planned', tone: 'neutral' },
  'awaiting-approval': { label: 'Awaiting approval', tone: 'attention' },
  approved: { label: 'Approved', tone: 'info' },
  executing: { label: 'Executing', tone: 'info' },
  verifying: { label: 'Verifying', tone: 'attention' },
  verified: { label: 'Verified', tone: 'positive' },
  failed: { label: 'Failed', tone: 'critical' },
  dismissed: { label: 'Dismissed', tone: 'neutral' },
};

export function AgentCenter({ variant = 'screen' }: { variant?: 'screen' | 'panel' }) {
  const openId = useWorkspace((s) => s.openId);
  const analysis = useLearningEngine(openId);
  const enabled = useAgentStore((s) => s.enabled);
  const setEnabled = useAgentStore((s) => s.setEnabled);
  const clear = useAgentStore((s) => s.clear);
  const campaigns = useAgentStore((s) => s.campaigns);
  const openPanel = useLayoutStore((s) => s.openPanel);
  const [view, setView] = useState<AgentView>('queues');

  const waiting = approvalQueue(campaigns);
  const active = actionQueue(campaigns);
  const verifying = verificationQueue(campaigns);
  const summary = agentStatusSummary(campaigns);

  return (
    <div className={cn('flex min-h-0 flex-col', variant === 'screen' ? 'mx-auto w-full max-w-[1360px] px-6 py-7 sm:px-10' : '')}>
      {/* header */}
      <div className={cn('flex flex-wrap items-end justify-between gap-3', variant === 'screen' ? 'mb-5' : 'px-3 pt-3')}>
        <div>
          <div className="flex items-center gap-2">
            <h2 className={cn('font-semibold tracking-[-0.01em] text-text', variant === 'screen' ? 'text-[19px]' : 'text-[13px]')}>
              Engineering Agent
            </h2>
            <Badge tone={enabled ? 'info' : 'neutral'}>{enabled ? 'watching' : 'paused'}</Badge>
          </div>
          <p className="mt-1 text-[12.5px] text-text-muted">
            {enabled
              ? `Observes ${analysis.records} real records — proposes improvements, waits for approval, executes as missions, then verifies.`
              : 'Paused — no new signals are observed or executed.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" icon="refresh" onClick={runAgentObservation}>
            Observe now
          </Button>
          <Button size="sm" variant="secondary" icon={enabled ? 'eye-off' : 'activity'} onClick={() => setEnabled(!enabled)}>
            {enabled ? 'Pause' : 'Resume'}
          </Button>
          {variant === 'screen' && (
            <Button size="sm" variant="secondary" icon="clipboard" onClick={() => openPanel('missions')}>
              Mission Control
            </Button>
          )}
        </div>
      </div>

      {/* summary strip */}
      <div className={cn('flex flex-wrap items-center gap-2', variant === 'screen' ? 'mb-4' : 'px-3 pb-2')}>
        <SummaryChip label="Awaiting approval" count={summary.waiting} tone="attention" />
        <SummaryChip label="Executing" count={summary.active} tone="info" />
        <SummaryChip label="Verifying" count={summary.verifying} tone="attention" />
        <SummaryChip label="Verified" count={summary.verified} tone="positive" />
        <SummaryChip label="Failed" count={summary.failed} tone="critical" />
        <button
          onClick={() => clear()}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-subtle transition-colors hover:bg-surface-hover hover:text-text"
        >
          <Icon name="refresh" size={12} />
          Clear history
        </button>
      </div>

      {/* view tabs */}
      <div className={cn('flex gap-1', variant === 'screen' ? 'mb-4' : 'px-3 pb-2')}>
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors',
              view === v.key ? 'bg-accent-50 text-accent-700 dark:bg-accent/15 dark:text-accent-200' : 'text-text-muted hover:bg-surface-hover hover:text-text',
            )}
          >
            <Icon name={v.icon} size={13} />
            {v.label}
            {v.key === 'queues' && waiting.length + active.length + verifying.length > 0 && <Badge tone="attention">{waiting.length + active.length + verifying.length}</Badge>}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {view === 'queues' && (
          <>
            <QueueSection
              title="Approval queue"
              hint="The agent never acts until you approve its improvement plan."
              empty="No improvement proposals right now. Real signals (repeated bugs, unstable modules, rejected AI proposals, high-risk predictions) appear here."
            >
              {waiting.map((c) => (
                <ApprovalCard key={c.id} campaign={c} />
              ))}
            </QueueSection>

            <QueueSection
              title="Action queue"
              hint="Approved campaigns now run as real missions — every task proposal still needs your acceptance in Mission Control."
              empty="No approved campaigns executing."
            >
              {active.map((c) => (
                <CampaignCard key={c.id} campaign={c} />
              ))}
            </QueueSection>

            <QueueSection
              title="Verification queue"
              hint="Completed missions are measured against their verify target."
              empty="Nothing waiting for verification."
            >
              {verifying.map((c) => (
                <CampaignCard key={c.id} campaign={c} />
              ))}
            </QueueSection>
          </>
        )}

        {view === 'campaigns' && (
          <div className="grid gap-2.5 lg:grid-cols-2">
            {campaigns.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-line p-6 text-center text-[12.5px] text-text-subtle lg:col-span-2">
                No campaigns yet. As real engineering events accumulate, the agent will observe signals and propose improvements here.
              </p>
            ) : (
              campaigns.map((c) => <CampaignCard key={c.id} campaign={c} />)
            )}
          </div>
        )}

        {view === 'timeline' && <TimelineView />}
      </div>
    </div>
  );
}

/* ── header pieces ─────────────────────────────────────────────────── */

function SummaryChip({ label, count, tone }: { label: string; count: number; tone: 'positive' | 'attention' | 'critical' | 'info' | 'neutral' }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg bg-surface px-2.5 py-1 text-[11px] text-text-subtle">
      <span className={cn('h-1.5 w-1.5 rounded-full', tone === 'positive' ? 'bg-positive' : tone === 'attention' ? 'bg-attention' : tone === 'critical' ? 'bg-danger' : tone === 'info' ? 'bg-accent' : 'bg-text-muted')} />
      {label}
      <span className="font-semibold tabular-nums text-text">{count}</span>
    </span>
  );
}

/* ── queue sections ────────────────────────────────────────────────── */

function QueueSection({ title, hint, empty, children }: { title: string; hint: string; empty: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-3.5">
      <div className="mb-2.5">
        <div className="text-[12.5px] font-semibold text-text">{title}</div>
        <p className="mt-0.5 text-[11px] text-text-muted">{hint}</p>
      </div>
      {children === null || (Array.isArray(children) && children.length === 0) ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-[11.5px] text-text-subtle">{empty}</p>
      ) : (
        <div className="space-y-2.5">{children}</div>
      )}
    </section>
  );
}

/* ── approval card ─────────────────────────────────────────────────── */

function ApprovalCard({ campaign }: { campaign: AgentCampaign }) {
  const approve = useAgentStore((s) => s.approve);
  const dismiss = useAgentStore((s) => s.dismiss);
  const meta = AGENT_SIGNAL_META[campaign.kind];

  return (
    <div className="rounded-xl border border-attention/25 bg-surface-active/60 p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-active text-attention">
          <Icon name={meta.icon as IconName} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] font-semibold text-text">{campaign.signalLabel}</span>
            <Badge tone={SEVERITY_TONE[campaign.severity]}>{campaign.severity}</Badge>
            <span className="text-[10.5px] text-text-subtle">{relTime(campaign.createdAt)}</span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-text-muted">{campaign.rationale}</p>

          <div className="mt-2 rounded-lg bg-surface px-2.5 py-2">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle">Plan</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-text">{campaign.plan}</p>
            <div className="mt-1.5 text-[10.5px] text-text-subtle">
              <span className="font-medium text-text">Expected outcome:</span> {campaign.expectedOutcome}
            </div>
          </div>

          {campaign.evidence.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {campaign.evidence.slice(0, 3).map((e, i) => (
                <span key={i} className="inline-flex max-w-full items-center gap-1 truncate rounded-md bg-surface-active px-2 py-0.5 text-[10.5px] text-text-subtle">
                  <Icon name="link" size={10} />
                  <span className="truncate">{e}</span>
                </span>
              ))}
            </div>
          )}

          <div className="mt-2.5 flex items-center gap-2">
            <Button size="sm" variant="primary" icon="check" onClick={() => approve(campaign.id)}>
              Approve
            </Button>
            <Button size="sm" variant="ghost" icon="eye-off" onClick={() => dismiss(campaign.id)}>
              Dismiss
            </Button>
            <span className="ml-auto text-[10.5px] text-text-subtle">The agent will create a real improvement mission in Mission Control.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── generic campaign card ─────────────────────────────────────────── */

function CampaignCard({ campaign }: { campaign: AgentCampaign }) {
  const meta = AGENT_SIGNAL_META[campaign.kind];
  const status = STATUS_META[campaign.status];

  return (
    <div className="rounded-2xl border border-line bg-surface p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-active text-text-subtle">
          <Icon name={meta.icon as IconName} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-text">{campaign.target}</span>
            <Badge tone={status.tone}>{status.label}</Badge>
            <Badge tone={SEVERITY_TONE[campaign.severity]}>{campaign.severity}</Badge>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-text-muted">{campaign.signalLabel}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-text-subtle">
            <span className="inline-flex items-center gap-1"><Icon name="clipboard" size={10} />{campaign.plan.length > 70 ? `${campaign.plan.slice(0, 70)}…` : campaign.plan}</span>
            {campaign.missionId && <span className="inline-flex items-center gap-1"><Icon name="deploy" size={10} />mission {campaign.missionId.slice(0, 8)}</span>}
            {campaign.verify && (
              <span className="inline-flex items-center gap-1">
                <Icon name="check" size={10} />
                {campaign.verify.kind === 'diagnosis-count' ? `≤ ${campaign.verify.before} diagnoses` : 'mission completed'}
              </span>
            )}
            <span className="inline-flex items-center gap-1"><Icon name="activity" size={10} />{relTime(campaign.updatedAt)}</span>
          </div>
          {campaign.note && <p className="mt-1.5 text-[11.5px] text-text-muted">{campaign.note}</p>}
        </div>
      </div>
    </div>
  );
}

/* ── timeline ──────────────────────────────────────────────────────── */

function TimelineView() {
  const timeline = useAgentStore((s) => s.timeline);
  if (timeline.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-line p-8 text-center">
        <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl bg-surface-active text-text-muted">
          <Icon name="activity" size={18} />
        </span>
        <div className="text-[13px] font-semibold text-text">No activity yet</div>
        <p className="mx-auto mt-1 max-w-md text-[12px] leading-relaxed text-text-muted">
          Every agent transition — observation, proposal, approval, execution, verification — lands here for a full, replayable audit trail.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {timeline.slice().reverse().map((t) => (
        <div key={t.id} className="flex items-start gap-3 rounded-xl px-2 py-1.5 transition-colors hover:bg-surface-hover">
          <span
            className={cn(
              'mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-md',
              t.actor === 'human' ? 'bg-accent/15 text-accent' : t.actor === 'system' ? 'bg-positive/15 text-positive' : 'bg-surface-active text-text-muted',
            )}
          >
            <Icon name={t.actor === 'human' ? 'check' : t.actor === 'system' ? 'activity' : 'spark'} size={11} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-medium text-text">{t.label}</span>
              <span className="text-[10px] uppercase tracking-wide text-text-muted/70">{t.stage}</span>
              <span className="ml-auto text-[10.5px] tabular-nums text-text-muted">{relTime(t.at)}</span>
            </div>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-text-muted">{t.detail}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
