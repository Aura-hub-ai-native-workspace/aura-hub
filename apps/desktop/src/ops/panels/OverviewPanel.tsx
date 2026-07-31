import { lazy } from 'react';
import { PanelBody } from '../panelFrame';

const Overview = lazy(() => import('../EngineeringOverview').then((m) => ({ default: m.EngineeringOverview })));

export default function OverviewPanel() {
  return (
    <PanelBody padded={false}>
      <Overview variant="panel" />
    </PanelBody>
  );
}
