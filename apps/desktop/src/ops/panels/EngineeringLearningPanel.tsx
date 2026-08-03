/**
 * EngineeringLearningPanel — the Engineering Learning engine as a
 * dockable workspace panel (compact form of ops/EngineeringLearning).
 */
import { PanelBody } from '../panelFrame';
import { EngineeringLearning } from '../EngineeringLearning';

export default function EngineeringLearningPanel() {
  return (
    <PanelBody padded={false} className="flex flex-col">
      <EngineeringLearning variant="panel" />
    </PanelBody>
  );
}
