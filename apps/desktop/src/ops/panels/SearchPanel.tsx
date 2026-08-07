import { PanelBody } from '../panelFrame';
import { UniversalSearch } from '../UniversalSearch';

export default function SearchPanel() {
  return (
    <PanelBody padded={false} className="flex flex-col">
      <UniversalSearch />
    </PanelBody>
  );
}
