import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@aura/ui';
import { useWorkflows } from '../../data/useWorkflows';
import { pendingApprovals, useFabric } from '../../data/useFabric';
import { WorkflowLibrary } from './WorkflowLibrary';
import { WorkflowEditor } from './WorkflowEditor';
import { AllRuns } from './AllRuns';
import { ApprovalsInbox } from './ApprovalsInbox';
import { AutomationScreen } from '../automation/AutomationScreen';
import { AllAutomationRuns } from '../automation/AllAutomationRuns';
import { EmptyState } from '../../components/EmptyState';

/**
 * Workflows — the Automation domain.
 * ==================================================================
 * Three standing surfaces, because the product has three questions and
 * a library only answers one:
 *
 *   Automations — what can run?  (workflows you start, rules that start
 *                 themselves — one catalogue, two kinds)
 *   Runs        — what happened?
 *   Approvals   — what needs me?
 *
 * These are tabs inside one screen, not new nav keys: the left rail's
 * five destinations are one of the calmest things about AURA and adding
 * to them costs more than it buys.
 *
 * Opening a workflow replaces all of it with the editor, which carries
 * its own workflow-scoped views.
 */

type Surface = 'automations' | 'runs' | 'approvals';
/** Within Automations: what you build, and what builds on it. */
type Kind = 'workflows' | 'rules';
/** Within Runs: what a person started, and what a rule started. */
type RunKind = 'workflow' | 'automation';

export function Workflows() {
  const { loaded, reachable, editingId, def, init, specs, open } = useWorkflows();
  const approvals = useFabric((s) => s.approvals);
  const watchApprovals = useFabric((s) => s.watchApprovals);
  const loadCatalogue = useFabric((s) => s.loadCatalogue);
  const [surface, setSurface] = useState<Surface>('automations');
  const [kind, setKind] = useState<Kind>('workflows');
  const [runKind, setRunKind] = useState<RunKind>('workflow');

  useEffect(() => {
    void init();
    void loadCatalogue();
  }, [init, loadCatalogue]);

  // Poll approvals while the domain is open, so the tab badge is honest
  // even when the user is looking at the library.
  useEffect(() => watchApprovals(), [watchApprovals]);

  const specOf = useMemo(() => new Map(specs.map((s) => [s.type, s])), [specs]);
  const waiting = pendingApprovals(approvals).length;

  if (!loaded) return null;

  if (!reachable) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon="workflows"
          title="AURA service unreachable"
          description="Start the local service (npm run ai) to build and run workflows."
        />
      </div>
    );
  }

  if (editingId && def) return <WorkflowEditor />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav className="flex shrink-0 items-center gap-1 border-b border-line px-4 py-2" role="tablist">
        <Tab id="automations" surface={surface} setSurface={setSurface} icon="workflows" label="Automations" />
        <Tab id="runs" surface={surface} setSurface={setSurface} icon="activity" label="Runs" />
        <Tab
          id="approvals"
          surface={surface}
          setSurface={setSurface}
          icon="shield"
          label="Approvals"
          badge={waiting || undefined}
        />
      </nav>

      {surface === 'automations' && (
        <div className="flex shrink-0 items-center gap-1 border-b border-line px-4 py-1.5">
          {(['workflows', 'rules'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`rounded-lg px-2.5 py-1 text-[11.5px] font-medium capitalize transition-colors ${
                kind === k ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text'
              }`}
            >
              {k === 'workflows' ? 'Workflows' : 'Rules'}
            </button>
          ))}
          <span className="ml-2 text-[10.5px] text-text-subtle">
            {kind === 'workflows' ? 'graphs you start' : 'rules that start them for you'}
          </span>
        </div>
      )}

      {surface === 'runs' && (
        <div className="flex shrink-0 items-center gap-1 border-b border-line px-4 py-1.5">
          {(['workflow', 'automation'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setRunKind(k)}
              className={`rounded-lg px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                runKind === k ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text'
              }`}
            >
              {k === 'workflow' ? 'Workflow runs' : 'Automation runs'}
            </button>
          ))}
          <span className="ml-2 text-[10.5px] text-text-subtle">
            {runKind === 'workflow' ? 'every execution of a graph' : 'every time a rule fired'}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {surface === 'automations' && kind === 'workflows' && <WorkflowLibrary />}
        {surface === 'automations' && kind === 'rules' && <AutomationScreen />}
        {surface === 'runs' && runKind === 'workflow' && <AllRuns specs={specOf} onOpenWorkflow={(id) => void open(id)} />}
        {surface === 'runs' && runKind === 'automation' && (
          <AllAutomationRuns
            specs={specOf}
            onOpenRule={() => { setSurface('automations'); setKind('rules'); }}
          />
        )}
        {surface === 'approvals' && <ApprovalsInbox />}
      </div>
    </div>
  );
}

function Tab({
  id,
  surface,
  setSurface,
  icon,
  label,
  badge,
}: {
  id: Surface;
  surface: Surface;
  setSurface: (s: Surface) => void;
  icon: 'workflows' | 'activity' | 'shield';
  label: string;
  badge?: number;
}) {
  const active = surface === id;
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={() => setSurface(id)}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
        active ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text'
      }`}
    >
      <Icon name={icon} size={13} />
      {label}
      {badge !== undefined && (
        <span className="rounded-full bg-attention/15 px-1.5 py-px text-[10px] font-semibold text-attention">
          {badge}
        </span>
      )}
    </button>
  );
}
