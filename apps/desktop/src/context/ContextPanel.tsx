/**
 * ContextPanel — what AURA actually knows about this project.
 * ==================================================================
 * A read of the Context Fabric, rendered in the existing right-panel
 * vocabulary (PanelSection / PropertyRow / Badge). It introduces no
 * design language and no store: the view is fetched per project, exactly
 * as `RightPanel`'s own sections fetch health and providers.
 *
 * The honesty rule this component exists to enforce: freshness is shown
 * as a WORD, never as a colour alone. "Unknown" and "Stale" are states a
 * user must be able to read, not infer from a dot — and a user who
 * cannot distinguish them will trust old understanding as current.
 */

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Icon, PanelSection, PropertyRow } from '@aura/ui';
import {
  aiClient, contextUnavailable,
  type ContextFreshness, type ContextSection, type ContextView,
} from '../ai/aiClient';

/** Freshness → the words and tone shown to the user. Never colour alone. */
const FRESHNESS_LABEL: Record<ContextFreshness, { label: string; tone: 'positive' | 'attention' | 'neutral' }> = {
  fresh: { label: 'Fresh', tone: 'positive' },
  stale: { label: 'Stale', tone: 'attention' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

function FreshnessBadge({ freshness }: { freshness: ContextFreshness }) {
  const { label, tone } = FRESHNESS_LABEL[freshness];
  return <Badge tone={tone} dot>{label}</Badge>;
}

/** One section's state, with the authority's own reason when it has one. */
function SectionRow({ label, section }: { label: string; section: ContextSection<unknown> }) {
  return (
    <div>
      <PropertyRow label={label} value={<FreshnessBadge freshness={section.freshness} />} />
      {section.reason && (
        <p className="mt-0.5 text-[10.5px] leading-snug text-text-subtle">{section.reason}</p>
      )}
    </div>
  );
}

export function ContextPanel({ projectId }: { projectId: string }) {
  const [view, setView] = useState<ContextView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await aiClient.contextView(projectId);
      if (contextUnavailable(res)) {
        setView(null);
        setError(res.reason);
      } else {
        setView(res);
        setError(null);
      }
    } catch (e) {
      setView(null);
      setError((e as Error).message || 'The AURA service is unreachable.');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  if (error) {
    return (
      <PanelSection title="Context" icon="knowledge">
        <p className="text-[11.5px] text-text-muted">{error}</p>
        <Button size="sm" variant="subtle" block icon="refresh" className="mt-3" onClick={() => void load()}>
          Try again
        </Button>
      </PanelSection>
    );
  }

  if (!view) {
    return (
      <PanelSection title="Context" icon="knowledge">
        <div className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[12px] text-text-subtle">
          {loading ? 'Reading context…' : 'No context yet'}
        </div>
      </PanelSection>
    );
  }

  const git = view.git.value;
  const env = view.environment.value;
  const caps = view.capabilities.value ?? [];
  const usable = caps.filter((c) => c.availability === 'available').length;
  const gated = caps.filter((c) => c.availability === 'approval').length;

  return (
    <>
      <PanelSection title="Context" icon="knowledge">
        <div className="space-y-2">
          <PropertyRow
            label="Understanding"
            value={<FreshnessBadge freshness={view.freshness} />}
          />
          <PropertyRow
            label="Version"
            value={view.contextVersion === null ? 'None recorded' : `v${view.contextVersion}`}
          />
          <PropertyRow label="Scope" value={view.project.name} />
        </div>
        {view.repository.reason && (
          <p className="mt-2 text-[10.5px] leading-snug text-text-subtle">{view.repository.reason}</p>
        )}
        <Button size="sm" variant="subtle" block icon="refresh" className="mt-3" onClick={() => void load()}>
          {loading ? 'Reading…' : 'Re-read context'}
        </Button>
      </PanelSection>

      <PanelSection title="What AURA knows" icon="spark">
        <div className="space-y-2">
          <SectionRow label="Repository" section={view.repository} />
          <SectionRow label="Git" section={view.git} />
          <SectionRow label="Environment" section={view.environment} />
          <SectionRow label="Capabilities" section={view.capabilities} />
          <SectionRow label="Missions" section={view.missions} />
          <SectionRow label="Activity" section={view.activity} />
        </div>
      </PanelSection>

      {git && (
        <PanelSection title="Git" icon="code">
          <div className="space-y-2">
            <PropertyRow label="Branch" value={<span className="font-mono text-[11px]">{git.branch}</span>} />
            <PropertyRow
              label="Working tree"
              value={git.dirty ? `${git.changedFiles} changed` : 'Clean'}
            />
          </div>
          {git.recentCommits.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {git.recentCommits.slice(0, 3).map((c) => (
                <li key={c.hash} className="text-[11px] leading-snug text-text-muted">
                  <span className="font-mono text-[10px] text-text-subtle">{c.hash.slice(0, 7)}</span>{' '}
                  {c.subject}
                </li>
              ))}
            </ul>
          )}
        </PanelSection>
      )}

      {env && (() => {
        // Programs on this machine only — AURA's own internal subsystems
        // are not "connected tools" the user installed.
        const installed = env.tools.filter((t) => !t.internal);
        return (
          <PanelSection title="Connected tools" icon="link">
            {installed.length === 0 ? (
              <p className="text-[11.5px] text-text-muted">No tools were detected on this machine.</p>
            ) : (
              <ul className="space-y-1.5">
                {installed.slice(0, 8).map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12px] text-text">{t.name}</span>
                    <span className="shrink-0 font-mono text-[10.5px] text-text-subtle">{t.version ?? 'present'}</span>
                  </li>
                ))}
                {installed.length > 8 && (
                  <li className="text-[11px] text-text-subtle">+{installed.length - 8} more</li>
                )}
              </ul>
            )}
          </PanelSection>
        );
      })()}

      {view.capabilities.value && (
        <PanelSection title="Agent context preview" icon="shield">
          <p className="mb-2 text-[11px] leading-snug text-text-muted">
            What an agent receives if you ask it to work on this project.
          </p>
          <div className="space-y-2">
            <PropertyRow label="Usable now" value={String(usable)} />
            <PropertyRow label="Needs approval" value={String(gated)} />
            <PropertyRow label="Constraints" value={String(view.constraints.length)} />
          </div>
          <ul className="mt-3 space-y-1.5">
            {view.constraints.map((c) => (
              <li key={c.id} className="flex gap-1.5 text-[11px] leading-snug text-text-muted">
                <Icon name="check" size={12} className="mt-0.5 shrink-0 text-text-subtle" />
                <span>{c.text}</span>
              </li>
            ))}
          </ul>
        </PanelSection>
      )}
    </>
  );
}
