/**
 * AutomationScreen — the rules half of the Automation catalogue.
 * ==================================================================
 * Three states, one at a time: the library, the builder, and a rule's run
 * history. Kept as local state rather than a route because AURA has no
 * URL router — navigation here is store state, like everywhere else.
 */

import { useEffect, useState } from 'react';
import { useAutomation } from '../../data/useAutomation';
import { useWorkflows } from '../../data/useWorkflows';
import { AutomationLibrary } from './AutomationLibrary';
import { RuleBuilder } from './RuleBuilder';
import { AutomationRunView } from './AutomationRunView';

type View =
  | { kind: 'library' }
  | { kind: 'builder'; ruleId: string | null }
  | { kind: 'runs'; ruleId: string };

export function AutomationScreen() {
  const init = useAutomation((s) => s.init);
  const loaded = useAutomation((s) => s.loaded);
  // The builder picks workflows from the real library, so make sure it is
  // loaded even when the user came straight to Rules.
  const initWorkflows = useWorkflows((s) => s.init);
  const [view, setView] = useState<View>({ kind: 'library' });

  useEffect(() => {
    void init();
    void initWorkflows();
  }, [init, initWorkflows]);

  if (!loaded) return null;

  if (view.kind === 'builder') {
    return (
      <RuleBuilder
        ruleId={view.ruleId}
        onClose={() => setView({ kind: 'library' })}
        onSaved={(id) => setView({ kind: 'runs', ruleId: id })}
      />
    );
  }

  if (view.kind === 'runs') {
    return <AutomationRunView ruleId={view.ruleId} onBack={() => setView({ kind: 'library' })} />;
  }

  return (
    <AutomationLibrary
      onOpenRule={(id) => setView({ kind: 'builder', ruleId: id })}
      onNewRule={() => setView({ kind: 'builder', ruleId: null })}
      onOpenRuns={(id) => setView({ kind: 'runs', ruleId: id })}
    />
  );
}
