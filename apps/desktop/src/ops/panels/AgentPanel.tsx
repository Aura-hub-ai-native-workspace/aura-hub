/**
 * AgentPanel — the Autonomous Engineering Agent as a dockable
 * workspace panel (compact form of ops/AgentCenter).
 */
import { PanelBody } from '../panelFrame';
import { AgentCenter } from '../AgentCenter';

export default function AgentPanel() {
  return (
    <PanelBody padded={false} className="flex flex-col">
      <AgentCenter variant="panel" />
    </PanelBody>
  );
}
