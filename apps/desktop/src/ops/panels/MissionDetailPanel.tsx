/**
 * MissionDetailPanel — the workspace panel for the Planner.
 * ------------------------------------------------------------------
 * The old "focused mission detail" surface was the Mission Control detail
 * view, which has been replaced by the Planner. This panel now just hosts
 * the Planner, which owns its own list and selection.
 */
import { Planner } from '../../screens/missions/Planner';

export default function MissionDetailPanel() {
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <Planner />
    </div>
  );
}
