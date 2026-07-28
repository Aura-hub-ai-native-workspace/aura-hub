import { useEffect } from 'react';
import { useWorkflows } from '../../data/useWorkflows';
import { WorkflowLibrary } from './WorkflowLibrary';
import { WorkflowEditor } from './WorkflowEditor';
import { EmptyState } from '../../components/EmptyState';

/**
 * Workflows — the Production Workflow Engine.
 * Library of persistent, AI-native automations; the editor is a live
 * visual canvas that executes against the currently open project.
 */
export function Workflows() {
  const { loaded, reachable, editingId, def, init } = useWorkflows();

  useEffect(() => {
    void init();
  }, [init]);

  if (!loaded) return null;
  if (!reachable) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState icon="workflows" title="AURA service unreachable" description="Start the local service (npm run ai) to build and run workflows." />
      </div>
    );
  }
  if (editingId && def) return <WorkflowEditor />;
  return <WorkflowLibrary />;
}
