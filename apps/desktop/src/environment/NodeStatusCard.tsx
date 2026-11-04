/** NodeStatusCard — read-only: what the machine reports about one tool. */
import type { EnvironmentNode } from '@aura/connected-environment';
import { machineStatus } from './environmentStatus';

export function NodeStatusCard({ node }: { node: EnvironmentNode }) {
  const status = machineStatus(node.health.status, node.health.probeStatus);
  const checked = node.health.status === 'unknown' ? 'not checked' : new Date(node.health.checkedAt).toLocaleString();
  return (
    <dl className="space-y-2 p-4 text-[12px]" data-testid="node-status">
      <Row k="Status" v={status} />
      {node.health.version && <Row k="Version" v={node.health.version} />}
      {node.health.executable && <Row k="Found at" v={node.health.executable} mono />}
      <Row k="Details" v={node.health.detail} />
      <Row k="Last checked" v={checked} />
    </dl>
  );
}
const Row = ({ k, v, mono }: { k: string; v: string; mono?: boolean }) => (
  <div className="flex gap-3"><dt className="w-24 shrink-0 text-text-subtle">{k}</dt><dd className={`min-w-0 break-words text-text-muted ${mono ? 'font-mono text-[11px]' : ''}`}>{v}</dd></div>
);
