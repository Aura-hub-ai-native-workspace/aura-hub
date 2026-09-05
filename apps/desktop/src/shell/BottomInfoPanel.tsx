import { useState, useMemo } from 'react';
import { cn } from '@aura/core';

interface Metric {
  label: string;
  value: number;
  status: 'connected' | 'available' | 'missing' | 'unscanned' | 'error';
  suffix?: string;
}

interface RecentActivityItem {
  id: string;
  description: string;
  timestamp: string;
  success: boolean;
}

interface QuickInsight {
  id: string;
  title: string;
  description: string;
  action?: () => void;
}

/**
 * Bottom information panel displaying environment metrics, recent activity,
 * system health, and quick insights for the workspace.
 * @param envSummary Environment scan summary with node counts
 * @param onScanEnvironment Callback to trigger environment scan
 * @param activeProjectId Currently selected project ID
 * @param projects List of available projects
 */
export function BottomInfoPanel({
  envSummary,
  onScanEnvironment,
  activeProjectId,
  projects,
}: {
  envSummary: {
    connected: number;
    available: number;
    missing: number;
    unscanned: number;
    lastScanAt: string | null;
  } | null;
  onScanEnvironment: () => void;
  activeProjectId: string | null;
  projects: any[];
}) {
  const [scanning, setScanning] = useState(false);

  const metrics: Metric[] = [
    { label: 'Connected', value: envSummary?.connected ?? 0, status: 'connected' },
    { label: 'Found', value: envSummary?.available ?? 0, status: 'available' },
    { label: 'Missing', value: envSummary?.missing ?? 0, status: 'missing' },
    { label: 'Unscanned', value: envSummary?.unscanned ?? 0, status: 'unscanned' },
  ];

  const recentActivity: RecentActivityItem[] = [
    { id: '1', description: 'Environment scanned', timestamp: '2 min ago', success: true },
    { id: '2', description: 'Node.js detected', timestamp: '5 min ago', success: true },
    { id: '3', description: 'Git detected', timestamp: '8 min ago', success: true },
    { id: '4', description: 'Docker not found', timestamp: '12 min ago', success: false },
    { id: '5', description: 'Project selected', timestamp: '15 min ago', success: true },
    { id: '6', description: 'Mission created', timestamp: '20 min ago', success: true },
    { id: '7', description: 'Workflow completed', timestamp: '25 min ago', success: true },
  ];

  const quickInsights: QuickInsight[] = [
    { id: '1', title: '2 capabilities need your attention', description: 'Consider installing Docker for full functionality', action: undefined },
    { id: '2', title: 'Git is ready to use', description: '', action: undefined },
    { id: '3', title: 'Select a project to begin creating missions', description: '', action: undefined },
  ];

  return (
    <div className="border-t border-border/20 bg-surface/30 backdrop-blur-sm px-4 py-2">
      <div className="max-w-7xl mx-auto grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* Metrics */}
        {metrics.map((metric) => (
          <div
            key={metric.label}
            className={cn(
              'rounded-lg bg-surface-active/50 px-3 py-2 text-center transition-colors hover:bg-surface/30',
              `text-${metric.status === 'connected' ? 'positive' : metric.status === 'available' ? 'accent' : metric.status === 'missing' ? 'attention' : 'subtle'}-600`,
            )}
          >
            <div className="text-[12px] font-medium tabular-nums">{metric.value}</div>
            <div className="text-[9px] uppercase tracking-wider">{metric.label}</div>
            {metric.suffix && <div className="text-[8px] text-text-subtle mt-0.5">{metric.suffix}</div>}
          </div>
        ))}

        {/* Recent Activity */}
        <div key="recent" className="rounded-xl bg-surface-active/50 p-3">
          <div className="text-xs uppercase tracking-wider text-text-subtle">Recent Activity</div>
          <div className="space-y-2 pt-2 overflow-y-auto max-h-40">
            {recentActivity.map((item) => (
              <div
                key={item.id}
                className={cn(
                  'flex items-start gap-2 px-1.5 py-1.5 rounded border border-border/20 hover:bg-surface/30 transition-colors',
                )}
              >
                <span
                  className={cn(
                    'flex-shrink-0 h-3.5 w-3.5 rounded-full',
                    item.success ? 'bg-positive' : 'bg-attention',
                  )}
                />
                <span className="flex-1 text-[10.5px] text-truncate">
                  {item.description}
                </span>
                <span className="text-[8.5px] text-text-subtle">{item.timestamp}</span>
              </div>
            ))}
          </div>
        </div>

        {/* System Health */}
        <div key="system" className="rounded-xl bg-surface-active/50 p-3">
          <div className="text-xs uppercase tracking-wider text-text-subtle">System Health</div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-positive"></span>
              <span className="text-[10.5px] text-text">Connected {envSummary?.connected ?? 0}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-accent"></span>
              <span className="text-[10.5px] text-text">Found {envSummary?.available ?? 0}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-attention"></span>
              <span className="text-[10.5px] text-text">Missing {envSummary?.missing ?? 0}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-gray-600/50"></span>
              <span className="text-[10.5px] text-text">Unscanned {envSummary?.unscanned ?? 0}</span>
            </div>
          </div>
        </div>

        {/* Quick Insights */}
        <div key="insights" className="rounded-xl bg-surface-active/50 p-3">
          <div className="text-xs uppercase tracking-wider text-text-subtle">Quick Insights</div>
          <div className="space-y-1.5 pt-1 border-t border-border/20">
            {quickInsights.map((insight) => (
              <div key={insight.id} className="flex items-start gap-1.5 px-1.5 py-1.5 rounded border-border/20 hover:bg-surface/30 transition-colors">
                <span
                  className="flex-shrink-0 h-3 w-3 rounded-full mt-px"
                  style={{ background: insight.title.includes('need') ? '#f59e0b' : insight.title.includes('ready') ? '#22c55e' : '#6b7280' }}
                />
                <span className="flex-1 text-[10.5px] text-truncate">
                  {insight.title}
                </span>
                {insight.action ? (
                  <button
                    onClick={insight.action}
                    className="text-[8.5px] font-medium text-accent hover:underline"
                  >
                    Take action
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Scan Environment button */}
      <div className="mt-2 flex justify-end">
        <button
          onClick={onScanEnvironment}
          disabled={scanning}
          className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-[10.5px] font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
        >
          {scanning ? (
            <span className="animate-spin h-2.5 w-2.5" />
          ) : null}
          {scanning ? 'Scanning environment…' : 'Scan Environment'}
        </button>
      </div>
    </div>
  );
}