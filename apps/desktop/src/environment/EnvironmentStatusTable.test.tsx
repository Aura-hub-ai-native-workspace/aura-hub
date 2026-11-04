import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { machineStatus, statusRows, unprobedCount, type StatusRow } from './environmentStatus';
import { EnvironmentStatusTable } from './EnvironmentStatusTable';

describe('machine status words', () => {
  it('maps what a probe established, and only that', () => {
    expect(machineStatus('connected')).toBe('Installed and available');
    expect(machineStatus('available')).toBe('Installed but not connected');
    expect(machineStatus('needs-auth')).toBe('Installed but not connected');
    expect(machineStatus('degraded')).toBe('Installed but unhealthy');
    expect(machineStatus('not-installed', 'not-found')).toBe('Not installed');
    expect(machineStatus('unknown')).toBe('Unknown');
    expect(machineStatus('no-connector')).toBe('Unknown');
  });
  it('never reports absence when the probe could not tell', () => {
    for (const p of ['timeout', 'failed', 'blocked', 'tampered', 'internal'] as const) {
      expect(machineStatus('not-installed', p)).toBe('Detection incomplete');
    }
    expect(machineStatus('installing')).toBe('Detection incomplete');
  });
});

const rows: StatusRow[] = [
  { id: 'git', name: 'Git', category: 'source-control', status: 'Installed and available', detail: 'git 2.45', version: '2.45', checkedAt: '2026-10-20T10:00:00Z', connectable: true },
  { id: 'docker', name: 'Docker', category: 'devops', status: 'Not installed', detail: 'No docker executable on PATH', version: null, checkedAt: '2026-10-20T10:00:00Z', connectable: false },
];

describe('the Connected Environment table', () => {
  const html = renderToStaticMarkup(<EnvironmentStatusTable rows={rows} scanning={false} lastScanAt="2026-10-20T10:00:00Z" error={null} onRecheck={() => undefined} />);
  it('shows tool and machine status, and when it was checked', () => {
    expect(html).toContain('Tool / capability');
    expect(html).toContain('Machine status');
    expect(html).toContain('Installed and available');
    expect(html).toContain('Not installed');
    expect(html).toContain('Last checked:');
  });
  it('has no install, connect, uninstall or catalog controls', () => {
    expect(html).not.toMatch(/>\s*(Install|Connect|Disconnect|Uninstall|Add|Get)\b/i);
    expect(html).not.toMatch(/catalog|Known AURA Capabilities|Search software/i);
    // the only button besides the filters is a re-check, which reads and changes nothing
    expect((html.match(/<button/g) ?? []).length).toBe(1 + 1 + 2); // Re-check, All, + one per present status
  });
  it('the source never installs, uninstalls or disconnects, and reaches the connector only through the store', () => {
    const src = readFileSync(new URL('./EnvironmentStatusTable.tsx', import.meta.url), 'utf8');
    for (const f of ['s.install', 's.disconnect', 'environmentClient', 'uninstall']) expect(src).not.toContain(f);
    expect(src).toContain('state.connect');
  });
  it('offers Connect only on a detected, connectable tool that is not yet connected', () => {
    const avail: StatusRow[] = [
      { id: 'bash', name: 'Bash', category: 'development', status: 'Installed but not connected', detail: 'Found Bash', version: '5.3', checkedAt: null, connectable: true },
      { id: 'claude-code', name: 'Claude Code', category: 'development', status: 'Installed but not connected', detail: 'Found Claude Code', version: null, checkedAt: null, connectable: false },
    ];
    const withConnect = renderToStaticMarkup(<EnvironmentStatusTable rows={avail} scanning={false} lastScanAt={null} error={null} onRecheck={() => undefined} onConnect={() => undefined} />);
    expect(withConnect).toContain('aria-label="Connect Bash"');
    expect(withConnect).not.toContain('aria-label="Connect Claude Code"');
    const readOnly = renderToStaticMarkup(<EnvironmentStatusTable rows={avail} scanning={false} lastScanAt={null} error={null} onRecheck={() => undefined} />);
    expect(readOnly).not.toContain('aria-label="Connect Bash"');
  });
});

const node = (id: string, status: string, probeStatus?: string) => ({
  id, entry: { name: id, category: 'development' },
  health: { status, detail: `${id} detail`, checkedAt: '2026-10-20T10:00:00Z', probeStatus },
}) as never;

describe('which nodes become rows', () => {
  it('leaves out catalogue-only entries that no probe can report on', () => {
    const rows = statusRows([node('git', 'connected'), node('adobe-photoshop', 'no-connector'), node('docker', 'not-installed', 'not-found')]);
    expect(rows.map((r) => r.id)).toEqual(['git', 'docker']);
  });
  it('lists installed-and-available first, then by how much attention they need, unknown last', () => {
    const rows = statusRows([node('c', 'unknown', 'failed'), node('b', 'not-installed', 'not-found'), node('a', 'connected'), node('d', 'degraded')]);
    expect(rows.map((r) => r.status)).toEqual(['Installed and available', 'Installed but unhealthy', 'Not installed', 'Unknown']);
  });
  it('shows no checked time for an unknown result', () => {
    expect(statusRows([node('x', 'unknown', 'failed')])[0].checkedAt).toBeNull();
  });
  it('leaves out entries no probe ever reported on, and counts them for the footnote', () => {
    const nodes = [node('git', 'connected'), node('openai', 'unknown'), node('anthropic', 'unknown'), node('adobe', 'no-connector')];
    expect(statusRows(nodes).map((r) => r.id)).toEqual(['git']);
    expect(unprobedCount(nodes)).toBe(3);
  });
});
