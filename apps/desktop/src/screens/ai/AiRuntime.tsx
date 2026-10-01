import { useCallback, useEffect, useState } from 'react';
import { cn } from '@aura/core';
import { Badge, Button, Card, CardHeader, Icon, Input } from '@aura/ui';
import { PageContainer, PageBlock } from '../PageContainer';
import {
  centralAgentClient,
  type AgentRuntimeConfig,
  type AgentRuntimeSummary,
  type AgentRecord,
  type AgentConfigChange,
} from '../../ai/centralAgentClient';

function statusTone(s: AgentRecord['status']): 'positive' | 'attention' | 'critical' | 'neutral' {
  if (s === 'ok') return 'positive';
  if (s === 'partial' || s === 'incompatible') return 'attention';
  if (s === 'error') return 'critical';
  return 'neutral';
}

function statusLabel(s: AgentRecord['status']): string {
  const map: Record<AgentRecord['status'], string> = {
    ok: 'Configured',
    partial: 'Partial',
    not_installed: 'Not installed',
    incompatible: 'Incompatible',
    error: 'Error',
  };
  return map[s] ?? s;
}

function driftTone(d: AgentRecord['drift']): 'positive' | 'attention' | 'neutral' {
  if (d === 'in_sync') return 'positive';
  if (d === 'drifted') return 'attention';
  return 'neutral';
}

export function AiRuntime() {
  const [summary, setSummary] = useState<AgentRuntimeSummary | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyingAgent, setApplyingAgent] = useState<string | null>(null);
  const [restoringAgent, setRestoringAgent] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:11434');
  const [modelId, setModelId] = useState('');
  const [lastChanges, setLastChanges] = useState<AgentConfigChange[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const discover = useCallback(async () => {
    setDiscovering(true);
    setLoadError(null);
    try {
      const r = await centralAgentClient.agentRuntimeDiscover();
      setSummary(r);
    } catch (e) {
      setLoadError((e as Error)?.message ?? 'Discovery failed');
    } finally {
      setDiscovering(false);
    }
  }, []);

  useEffect(() => { discover(); }, [discover]);

  const applyAll = async () => {
    if (!baseUrl.trim() || !modelId.trim()) return;
    setActionError(null);
    setApplying(true);
    try {
      const runtime: AgentRuntimeConfig = { baseUrl: baseUrl.trim(), modelId: modelId.trim() };
      const r = await centralAgentClient.agentRuntimeApplyAll(runtime);
      setLastChanges(r.changes);
      await discover();
    } catch (e) {
      setActionError((e as Error)?.message ?? 'Apply failed');
    } finally {
      setApplying(false);
    }
  };

  const applyOne = async (agentId: string) => {
    if (!baseUrl.trim() || !modelId.trim()) return;
    setActionError(null);
    setApplyingAgent(agentId);
    try {
      const runtime: AgentRuntimeConfig = { baseUrl: baseUrl.trim(), modelId: modelId.trim() };
      const r = await centralAgentClient.agentRuntimeApplyOne(agentId, runtime);
      setLastChanges([r]);
      await discover();
    } catch (e) {
      setActionError((e as Error)?.message ?? 'Apply failed');
    } finally {
      setApplyingAgent(null);
    }
  };

  const restoreOne = async (agentId: string) => {
    setActionError(null);
    setRestoringAgent(agentId);
    try {
      const r = await centralAgentClient.agentRuntimeRestore(agentId);
      setLastChanges([r]);
      await discover();
    } catch (e) {
      setActionError((e as Error)?.message ?? 'Restore failed');
    } finally {
      setRestoringAgent(null);
    }
  };

  const canApply = baseUrl.trim().length > 0 && modelId.trim().length > 0;

  if (loadError && !summary) {
    return (
      <PageContainer title="AI Runtime" subtitle="Configure installed AI coding agents to use your private inference runtime.">
        <Card>
          <div className="py-8 text-center">
            <Icon name="cpu" size={24} className="mx-auto text-text-subtle" />
            <p className="mt-3 text-[13px] text-text-muted">{loadError}</p>
            <Button variant="secondary" className="mt-4" onClick={discover}>Retry</Button>
          </div>
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer
      title="AI Runtime"
      subtitle="Configure all installed AI coding agents to use one private inference runtime. Config changes are backed up before every apply."
      actions={
        <Button icon="refresh" variant="secondary" onClick={discover} loading={discovering}>
          Discover Agents
        </Button>
      }
    >
      <div className="grid grid-cols-12 gap-5">
        {/* Primary Private Runtime form */}
        <PageBlock className="col-span-12 lg:col-span-8">
          <Card>
            <CardHeader
              title="Primary Private Runtime"
              subtitle="One endpoint for every agent. Set the base URL and model once — AURA propagates it."
            />
            {actionError && (
              <div className="mt-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-2.5 text-[12px] text-danger">
                {actionError}
              </div>
            )}
            <div className="mt-4 space-y-4">
              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-text-muted">Base URL</label>
                <Input
                  type="text"
                  placeholder="http://127.0.0.1:11434"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl((e as React.ChangeEvent<HTMLInputElement>).target.value)}
                />
                <p className="mt-1 text-[11px] text-text-subtle">
                  Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible server.
                </p>
              </div>
              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-text-muted">Model ID</label>
                <Input
                  type="text"
                  placeholder="llama3.1:8b"
                  value={modelId}
                  onChange={(e) => setModelId((e as React.ChangeEvent<HTMLInputElement>).target.value)}
                />
                <p className="mt-1 text-[11px] text-text-subtle">
                  The model identifier exactly as your server knows it.
                </p>
              </div>
              <Button icon="cpu" onClick={applyAll} loading={applying} disabled={!canApply}>
                Apply to All Agents
              </Button>
            </div>
            {lastChanges.length > 0 && (
              <div className="mt-4 space-y-1.5 rounded-xl border border-line bg-surface-active/50 px-4 py-3">
                <p className="text-[11px] font-medium text-text-muted">Last operation</p>
                {lastChanges.map((c) => (
                  <div key={c.agentId} className="flex items-center justify-between gap-2 text-[11.5px]">
                    <span className="text-text">{c.agentId}</span>
                    <Badge tone={c.ok ? 'positive' : 'critical'} dot>
                      {c.ok ? (c.statusNote || 'Applied') : (c.error ?? 'Failed')}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </PageBlock>

        {/* Runtime status summary */}
        <PageBlock className="col-span-12 lg:col-span-4">
          <Card className="h-full">
            <CardHeader title="Status" />
            <div className="mt-3 space-y-2 rounded-xl bg-surface-active/50 px-4 py-3 text-[12px]">
              <div className="flex items-center justify-between">
                <span className="text-text-muted">Detected agents</span>
                <span className="font-medium text-text">{summary ? summary.installedCount : '—'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-text-muted">Configured</span>
                <span className="font-medium text-text">
                  {summary ? `${summary.configuredCount} of ${summary.installedCount}` : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-text-muted">Out of sync</span>
                {summary ? (
                  <Badge tone={summary.driftedCount > 0 ? 'attention' : 'positive'} dot>
                    {summary.driftedCount > 0 ? `${summary.driftedCount} drifted` : 'All in sync'}
                  </Badge>
                ) : (
                  <span className="font-medium text-text">—</span>
                )}
              </div>
            </div>
            <div className="mt-3 space-y-1.5 rounded-xl border border-line bg-surface-active/40 px-4 py-3 text-[12px]">
              <div className="flex items-center gap-2 text-text-muted">
                <Icon name="check" size={12} className="shrink-0 text-positive" />
                <span>Config files are backed up before every write.</span>
              </div>
              <div className="flex items-center gap-2 text-text-muted">
                <Icon name="shield" size={12} className="shrink-0 text-positive" />
                <span>Sovereign mode blocks cloud runtime configuration.</span>
              </div>
              <div className="flex items-center gap-2 text-text-muted">
                <Icon name="cpu" size={12} className="shrink-0 text-text-subtle" />
                <span className="text-text-subtle">AURA never writes to keyring or shell profiles directly.</span>
              </div>
            </div>
          </Card>
        </PageBlock>

        {/* Connected AI Agents */}
        <PageBlock className="col-span-12">
          <Card>
            <CardHeader
              title="Connected AI Agents"
              subtitle="All AI coding tools detected on this machine. Each can be pointed at your private runtime independently."
            />
            {!summary && (
              <div className="mt-4 py-8 text-center text-[13px] text-text-muted">
                {discovering ? 'Scanning for installed agents…' : 'Run discovery to see what is installed.'}
              </div>
            )}
            {summary && summary.agents.length === 0 && (
              <div className="mt-4 rounded-2xl border border-dashed border-line px-6 py-10 text-center">
                <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-accent/10 text-accent">
                  <Icon name="cpu" size={22} />
                </span>
                <p className="mt-3 text-[14px] font-semibold text-text">No AI coding agents detected</p>
                <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-text-muted">
                  Install Claude Code, Codex CLI, OpenCode, Kilo, Qwen CLI, or Gemini CLI to manage them here.
                </p>
                <Button variant="secondary" icon="refresh" className="mt-4" onClick={discover} loading={discovering}>
                  Scan Again
                </Button>
              </div>
            )}
            {summary && summary.agents.length > 0 && (
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {summary.agents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    canApply={canApply}
                    applying={applyingAgent === agent.id}
                    restoring={restoringAgent === agent.id}
                    onApply={() => applyOne(agent.id)}
                    onRestore={() => restoreOne(agent.id)}
                  />
                ))}
              </div>
            )}
          </Card>
        </PageBlock>
      </div>
    </PageContainer>
  );
}

interface AgentCardProps {
  agent: AgentRecord;
  canApply: boolean;
  applying: boolean;
  restoring: boolean;
  onApply: () => void;
  onRestore: () => void;
}

function AgentCard({ agent, canApply, applying, restoring, onApply, onRestore }: AgentCardProps) {
  const cfg = agent.currentConfig;
  const currentBase = typeof cfg?.baseUrl === 'string' ? cfg.baseUrl : null;
  const currentModel = typeof cfg?.modelId === 'string' ? cfg.modelId : (typeof cfg?.model === 'string' ? cfg.model : null);

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-2xl border p-4 transition-colors',
        agent.detected ? 'border-line' : 'border-dashed border-line opacity-60',
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface-active text-text-muted">
            <Icon name="cpu" size={16} />
          </span>
          <div>
            <span className="block text-[13px] font-semibold text-text">{agent.name}</span>
            <span className="block text-[11px] text-text-subtle">{agent.id}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge tone={agent.detected ? 'positive' : 'neutral'} dot>
            {agent.detected ? 'Detected' : 'Not found'}
          </Badge>
          {agent.detected && (
            <Badge tone={statusTone(agent.status)}>{statusLabel(agent.status)}</Badge>
          )}
        </div>
      </div>

      {/* Current config */}
      {agent.detected && (
        <div className="space-y-1.5 rounded-xl bg-surface-active/50 px-3 py-2.5 text-[11.5px]">
          <div className="flex items-center justify-between gap-2">
            <span className="shrink-0 text-text-muted">Base URL</span>
            <span className="max-w-[160px] truncate text-right font-mono text-text">
              {currentBase ?? '—'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="shrink-0 text-text-muted">Model</span>
            <span className="max-w-[160px] truncate text-right font-mono text-text">
              {currentModel ?? '—'}
            </span>
          </div>
          {agent.drift !== 'unknown' && (
            <div className="flex items-center justify-between gap-2">
              <span className="shrink-0 text-text-muted">Drift</span>
              <Badge tone={driftTone(agent.drift)} dot>
                {agent.drift === 'in_sync'
                  ? 'In sync'
                  : agent.driftFields.length > 0
                    ? `Drifted: ${agent.driftFields.join(', ')}`
                    : 'Drifted'}
              </Badge>
            </div>
          )}
        </div>
      )}

      {/* Status note */}
      {agent.detected && agent.statusNote && (
        <p className="text-[11px] text-text-subtle">{agent.statusNote}</p>
      )}

      {/* Error */}
      {agent.error && (
        <p className="text-[11px] text-danger">{agent.error}</p>
      )}

      {/* Actions */}
      {agent.detected && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon="cpu"
            onClick={onApply}
            loading={applying}
            disabled={!canApply || restoring}
            className="flex-1"
          >
            Apply
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="restore"
            onClick={onRestore}
            loading={restoring}
            disabled={applying}
            className="flex-1"
          >
            Restore
          </Button>
        </div>
      )}
    </div>
  );
}
