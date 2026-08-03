/**
 * EngineeringMemoryPanel — the Engineering Memory Platform as a dockable
 * workspace panel (compact form of ops/MemoryCenter).
 */
import { PanelBody } from '../panelFrame';
import { MemoryCenter } from '../MemoryCenter';

export default function EngineeringMemoryPanel() {
  return (
    <PanelBody padded={false} className="flex flex-col">
      <MemoryCenter variant="panel" />
    </PanelBody>
  );
}
