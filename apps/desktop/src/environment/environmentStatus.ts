/**
 * environmentStatus — what the Connected Environment screen may say about a
 * tool, and nothing more.
 * ------------------------------------------------------------------
 * The screen is a status table, not a control surface. Each row says what the
 * machine reports for a capability, in one of six words. The mapping is from
 * what a probe actually established: a timeout or a failed probe is
 * "Detection incomplete", never "Not installed" — absence is only claimed when
 * the probe looked and found nothing.
 */
import type { EnvironmentNode, NodeStatus, ProbeStatus } from '@aura/connected-environment';

export type MachineStatus =
  | 'Installed and available'
  | 'Installed but not connected'
  | 'Installed but unhealthy'
  | 'Not installed'
  | 'Detection incomplete'
  | 'Unknown';

export const MACHINE_STATUSES: MachineStatus[] = [
  'Installed and available', 'Installed but not connected', 'Installed but unhealthy',
  'Not installed', 'Detection incomplete', 'Unknown',
];

/** Probe outcomes that mean "we could not tell", as opposed to "it is not there". */
const INCONCLUSIVE: ProbeStatus[] = ['failed', 'timeout', 'blocked', 'tampered', 'internal', 'unsupported', 'unverified'];

export function machineStatus(status: NodeStatus, probe?: ProbeStatus): MachineStatus {
  switch (status) {
    case 'connected': return 'Installed and available';
    case 'available':
    case 'needs-auth': return 'Installed but not connected';
    case 'degraded': return 'Installed but unhealthy';
    case 'not-installed': return probe && INCONCLUSIVE.includes(probe) ? 'Detection incomplete' : 'Not installed';
    case 'installing':
    case 'uninstalling': return 'Detection incomplete'; // a change is in progress; the probe afterwards decides
    default: return 'Unknown'; // unknown, no-connector
  }
}

export interface StatusRow {
  id: string;
  name: string;
  category: string;
  status: MachineStatus;
  detail: string;
  version: string | null;
  checkedAt: string | null;
  /**
   * May a person connect this tool from the table? Only a local program that
   * a probe can verify. AI coding agents are connected through their own
   * readiness handshake, never by a version probe, so they are not offered here.
   */
  connectable: boolean;
}

/**
 * A node no probe has reported on: catalogued with nothing behind it (no
 * connector), or never probed at all (for example a cloud provider that needs a
 * key and is managed in Settings). There is no detection evidence to show.
 */
export function hasNoEvidence(n: EnvironmentNode): boolean {
  return n.health.status === 'no-connector' || (n.health.status === 'unknown' && !n.health.probeStatus);
}

/** How many catalogued entries were left out for want of evidence (shown as a footnote). */
export function unprobedCount(nodes: EnvironmentNode[]): number {
  return nodes.filter(hasNoEvidence).length;
}

export function statusRows(nodes: EnvironmentNode[]): StatusRow[] {
  return nodes
    // Only what a probe actually reported on is a row. "Unknown" stays for a
    // probe that ran and could not classify; it is not a place to park the catalogue.
    .filter((n) => !hasNoEvidence(n))
    .map((n) => ({
      id: n.id,
      name: n.entry.name,
      category: n.entry.category,
      status: machineStatus(n.health.status, n.health.probeStatus),
      detail: n.health.detail,
      version: n.health.version ?? null,
      checkedAt: n.health.status === 'unknown' ? null : n.health.checkedAt,
      connectable: n.entry.transport === 'local-process' && !n.entry.capabilities.includes('coding-agent'),
    }))
    .sort((a, b) => MACHINE_STATUSES.indexOf(a.status) - MACHINE_STATUSES.indexOf(b.status) || a.name.localeCompare(b.name));
}

export function statusCounts(rows: StatusRow[]): Record<MachineStatus, number> {
  const out = Object.fromEntries(MACHINE_STATUSES.map((s) => [s, 0])) as Record<MachineStatus, number>;
  for (const r of rows) out[r.status] += 1;
  return out;
}
