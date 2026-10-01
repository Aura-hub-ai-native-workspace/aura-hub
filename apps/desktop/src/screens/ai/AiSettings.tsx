import { useCallback, useEffect, useState } from 'react';
import { cn } from '@aura/core';
import { Badge, Button, Card, CardHeader, Dialog, Dropdown, Icon, Input } from '@aura/ui';
import { PageContainer, PageBlock } from '../PageContainer';
import { UpdatePanel } from '../../updater/UpdatePanel';
import { AppImageInstallPanel } from '../../components/AppImageInstallPanel';
import { aiClient, type AiSettings as Settings, type ProviderInfo, type ConnectedProvider, type ProviderStatus } from '../../ai/aiClient';

interface DialogState {
  open: boolean;
  step: 'provider' | 'key' | 'connecting';
  providerId: string;
  providerName: string;
  /** The chosen provider is addressed by URL, not authenticated by key. */
  addressed: boolean;
  /** Prefilled address for a self-hosted entry; the key field otherwise. */
  apiKey: string;
  /** Placeholder shown in the address/key field. */
  placeholder: string;
  showKey: boolean;
  error: string;
}

const EMPTY_DIALOG: DialogState = { open: false, step: 'provider', providerId: '', providerName: '', addressed: false, apiKey: '', placeholder: '', showKey: false, error: '' };

/**
 * PRIMARY vs FALLBACK, from the service's own `selfHosted` flag.
 *
 * Self-hosted entries (addressed servers) are the primary inference
 * path; every key-based cloud provider is fallback-only. The dialog
 * renders the two groups under those exact headings, so a cloud
 * provider can never visually pass as the primary path.
 */
export function splitProviders(known: ProviderInfo[]): { served: ProviderInfo[]; cloud: ProviderInfo[] } {
  return {
    served: known.filter((p) => p.selfHosted === true),
    cloud: known.filter((p) => p.selfHosted !== true),
  };
}

function providerIcon(id: string): 'spark' | 'cpu' {
  const icons: Record<string, 'spark' | 'cpu'> = {
    openai: 'spark', anthropic: 'spark', groq: 'cpu', gemini: 'spark',
    mistral: 'spark', kimi: 'spark', openrouter: 'cpu', nvidia: 'cpu', cerebras: 'cpu',
    novita: 'cpu', qwen: 'spark', scalemax: 'spark', kage7: 'cpu',
  };
  return icons[id] ?? 'cpu';
}

export function AiSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [health, setHealth] = useState<{ ok: boolean; latencyMs: number } | null>(null);
  const [testing, setTesting] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [reindexMsg, setReindexMsg] = useState('');
  const [knownProviders, setKnownProviders] = useState<ProviderInfo[]>([]);
  const [connected, setConnected] = useState<ConnectedProvider[]>([]);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [dialog, setDialog] = useState<DialogState>(EMPTY_DIALOG);
  /** The FALLBACK catalog is a single collapsed entry until opened: cloud
      providers are reachable, never presented alongside the primary path. */
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [switchingProvider, setSwitchingProvider] = useState<string | null>(null);
  const [switchingModel, setSwitchingModel] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [s, h, r] = await Promise.all([
          aiClient.getSettings().catch(() => null),
          aiClient.health().catch(() => null),
          aiClient.getProviders().catch(() => null),
        ]);
        if (!alive) return;
        if (s?.settings) setSettings(s.settings);
        if (h?.health) setHealth(h.health);
        if (r) {
          setKnownProviders(Array.isArray(r.providers) ? r.providers : []);
          setConnected(Array.isArray(r.connected) ? r.connected : []);
          setActiveProvider(typeof r.active === 'string' ? r.active : null);
          setStatus(r.status ?? null);
        }
        if (!s?.settings) setError('Could not load settings from the local AI service.');
      } catch {
        if (alive) setError('Failed to contact the local AI service.');
      }
    };
    load();
    return () => { alive = false; };
  }, []);

  const refreshProviderState = useCallback(async () => {
    const [r, h] = await Promise.all([aiClient.getProviders().catch(() => null), aiClient.health().catch(() => null)]);
    if (r) {
      setConnected(Array.isArray(r.connected) ? r.connected : []);
      setActiveProvider(typeof r.active === 'string' ? r.active : null);
      setStatus(r.status ?? null);
    }
    if (h?.health) setHealth(h.health);
  }, []);

  const patch = useCallback(async (p: Partial<Settings>) => {
    setSettings((cur) => (cur ? { ...cur, ...p } : cur));
    const r = await aiClient.setSettings(p).catch(() => null);
    if (r?.settings) setSettings(r.settings);
  }, []);

  const test = useCallback(async () => {
    setTesting(true);
    const h = await aiClient.health().catch(() => null);
    setHealth(h?.health ?? null);
    setTesting(false);
  }, []);

  const clearCache = useCallback(async () => {
    setReindexing(true);
    const r = await aiClient.reindex().catch(() => null);
    setReindexMsg(r ? `Re-indexed · ${r.coding?.chunks ?? 0} chunks · ${r.fullstack?.entities ?? 0} entities` : 'Failed');
    setReindexing(false);
  }, []);

  const openConnect = () => { setActionError(null); setFallbackOpen(false); setDialog({ ...EMPTY_DIALOG, open: true }); };
  const closeDialog = () => { setFallbackOpen(false); setDialog(EMPTY_DIALOG); };

  const selectProvider = (id: string, opts?: { addressPrefill?: string; name?: string; placeholder?: string }) => {
    const p = knownProviders.find((k) => k.id === id);
    const addressed = p?.selfHosted === true;
    // A self-hosted provider is configured by address, so the field starts
    // from whatever default the deployment configured rather than waiting
    // for a secret that does not exist. Local prefills the loopback (or
    // deployment) default; Remote starts empty for a private address.
    setDialog((d) => ({
      ...d,
      step: 'key',
      providerId: id,
      providerName: opts?.name ?? p?.name ?? id,
      addressed,
      apiKey: addressed ? (opts?.addressPrefill ?? p?.defaultBaseUrl ?? '') : '',
      placeholder: opts?.placeholder ?? (addressed ? 'http://gpu-server.example.edu:11434' : 'Paste your API key…'),
      error: '',
    }));
  };

  const connectProvider = async () => {
    if (!dialog.providerId || !dialog.apiKey.trim()) return;
    setDialog((d) => ({ ...d, step: 'connecting', error: '' }));
    try {
      const r = dialog.addressed
        ? await aiClient.connectServerProvider(dialog.providerId, dialog.apiKey.trim())
        : await aiClient.connectProvider(dialog.providerId, dialog.apiKey.trim());
      if (r?.ok) {
        setDialog(EMPTY_DIALOG);
        await refreshProviderState();
      } else {
        setDialog((d) => ({ ...d, step: 'key', error: r?.error ?? 'Connection failed' }));
      }
    } catch (e) {
      setDialog((d) => ({ ...d, step: 'key', error: (e as Error)?.message ?? 'Unknown error' }));
    }
  };

  const disconnectProvider = async (id: string) => {
    await aiClient.disconnectProvider(id).catch(() => {});
    await refreshProviderState();
  };

  const activateProvider = async (id: string) => {
    setActionError(null);
    setSwitchingProvider(id);
    try {
      const r = await aiClient.switchProvider(id).catch(() => null);
      if (r?.ok) { await refreshProviderState(); if (r.error) setActionError(r.error); }
      else setActionError(r?.error ?? 'Could not activate provider');
    } finally {
      setSwitchingProvider(null);
    }
  };

  const changeModel = async (id: string) => {
    if (!activeProvider || !id) return;
    setActionError(null);
    setSwitchingModel(true);
    try {
      const r = await aiClient.switchProvider(activeProvider, id).catch(() => null);
      if (r?.ok) { await refreshProviderState(); if (r.error) setActionError(r.error); }
      else setActionError(r?.error ?? 'Could not switch model');
    } finally {
      setSwitchingModel(false);
    }
  };

  const hasProvider = status?.type === 'byoak' && Boolean(activeProvider);
  const activeInfo = connected.find((c) => c.id === activeProvider);
  const models = activeInfo?.models?.length
    ? activeInfo.models.map((m) => m.id ?? '')
    : (status?.model ? [status.model] : []);

  if (error && !settings) {
    return (
      <PageContainer title="AI Provider" subtitle="Unable to load settings">
        <Card>
          <div className="py-8 text-center">
            <Icon name="cpu" size={24} className="mx-auto text-text-subtle" />
            <p className="mt-3 text-[13px] text-text-muted">{error}</p>
            <Button variant="secondary" className="mt-4" onClick={() => window.location.reload()}>Retry</Button>
          </div>
        </Card>
      </PageContainer>
    );
  }

  if (!settings) {
    return (
      <PageContainer title="AI Provider" subtitle="Connecting to the local AI service…">
        <Card><div className="py-8 text-center text-[13px] text-text-muted">Waiting for the local AI service…</div></Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer title="AI Provider" subtitle="AURA has no built-in model. Connect your own model server — a cloud key is only ever an explicitly activated fallback.">
      <div className="grid grid-cols-12 gap-5">
        {/* Providers — the primary section */}
        <PageBlock className="col-span-12 lg:col-span-8">
          <Card>
            <div className="flex items-center justify-between">
              <CardHeader title="Providers" subtitle="Your own server first — cloud keys live under Fallback." />
              <Button icon="plus" variant="secondary" onClick={openConnect} disabled={dialog.open}>Connect Provider</Button>
            </div>
            {actionError && <div className="mt-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-2.5 text-[12px] text-danger">{actionError}</div>}

            {connected.length === 0 ? (
              <div className="mt-4 rounded-2xl border border-dashed border-line px-6 py-10 text-center">
                <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-accent/10 text-accent"><Icon name="spark" size={22} /></span>
                <p className="mt-3 text-[14px] font-semibold text-text">Connect a provider to enable AURA</p>
                <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-text-muted">
                  The assistant, project intelligence and workflows all need a model. Point AURA at your own server address to get started — a cloud fallback key can be added later under Fallback.
                </p>
                <Button icon="plus" className="mt-4" onClick={openConnect}>Connect your first provider</Button>
              </div>
            ) : (
              <div className="mt-4 space-y-2">
                {connected.map((c) => {
                  const isActive = activeProvider === c.id;
                  return (
                    <div key={c.id} className={cn('flex items-center justify-between gap-4 rounded-xl border px-4 py-3 transition-colors', isActive ? 'border-accent bg-accent/5' : 'border-line')}>
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                        <input type="radio" name="provider" checked={isActive} onChange={() => activateProvider(c.id)} disabled={switchingProvider !== null} className="accent-[var(--accent)]" />
                        {switchingProvider === c.id && <Icon name="activity" size={13} className="shrink-0 animate-pulse text-accent" />}
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-active text-text-muted"><Icon name={providerIcon(c.id)} size={15} /></span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[13.5px] font-semibold text-text">{c.name ?? c.id}</span>
                            <Badge tone={isActive ? 'positive' : 'neutral'} dot={isActive}>{isActive ? 'Active' : 'Inactive'}</Badge>
                            <Badge tone="neutral">{c.selfHosted ? 'Primary · Self-hosted' : 'Fallback · Cloud'}</Badge>
                          </div>
                          <p className="truncate text-[11.5px] text-text-muted">Key: {c.fingerprint ?? '…'}</p>
                        </div>
                      </label>
                      <Button size="sm" variant="ghost" icon="close" onClick={() => disconnectProvider(c.id)} className="shrink-0 text-danger">Disconnect</Button>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </PageBlock>

        {/* Active provider status + connection test */}
        <PageBlock className="col-span-12 lg:col-span-4">
          <Card className="h-full">
            <CardHeader title="Status" action={<Badge tone={hasProvider && health?.ok ? 'positive' : hasProvider ? 'attention' : 'neutral'} dot>{!hasProvider ? 'No provider' : health?.ok ? 'Online' : 'Offline'}</Badge>} />
            <div className="mt-3 space-y-2 rounded-xl bg-surface-active/50 px-4 py-3 text-[12px]">
              <div className="flex items-center justify-between"><span className="text-text-muted">Provider</span><span className="font-medium text-text">{status?.label ?? 'Not connected'}</span></div>
              <div className="flex items-center justify-between"><span className="text-text-muted">Source</span><span className="font-medium text-text">{!activeInfo ? '—' : activeInfo.selfHosted ? 'Self-hosted · primary' : 'Cloud · fallback'}</span></div>
              <div className="flex items-center justify-between"><span className="text-text-muted">Model</span><span className="font-medium text-text">{status?.model || '—'}</span></div>
              <div className="flex items-center justify-between"><span className="text-text-muted">Latency</span><span className="font-medium text-text">{hasProvider && health ? `${health.latencyMs ?? '—'}ms` : '—'}</span></div>
              <div className="flex items-center justify-between"><span className="text-text-muted">Last validation</span><span className="font-medium text-text">{activeInfo?.health?.lastChecked ? new Date(activeInfo.health.lastChecked).toLocaleString() : '—'}</span></div>
            </div>
            <Button variant="secondary" icon="activity" onClick={test} loading={testing} block className="mt-3" disabled={!hasProvider}>Test connection</Button>
            {hasProvider && health ? (
              <div className={cn('mt-3 rounded-xl border px-3 py-2.5 text-[12px]', health.ok ? 'border-positive/30 bg-positive/5' : 'border-danger/30 bg-danger/5')}>
                <div className={cn('flex items-center gap-1.5 font-medium', health.ok ? 'text-positive' : 'text-danger')}>
                  <Icon name={health.ok ? 'check' : 'close'} size={13} /> {health.ok ? `Healthy · ${health.latencyMs ?? '?'}ms` : 'Unavailable — check your API key'}
                </div>
              </div>
            ) : null}
          </Card>
        </PageBlock>

        {/* Sovereign Mode */}
        <PageBlock className="col-span-12">
          <Card>
            <div className="flex items-start justify-between gap-6">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <CardHeader title="Sovereign Mode" subtitle="Block cloud AI inference — only local and private servers may process prompts." />
                  {settings.sovereignMode && (
                    <Badge tone="attention" dot className="shrink-0 self-start mt-1">Active</Badge>
                  )}
                </div>
                <div className="mt-3 rounded-xl border border-line bg-surface-active/40 px-4 py-3 text-[12px] space-y-1.5">
                  <div className="flex items-center gap-2 text-text-muted">
                    <Icon name="check" size={12} className="shrink-0 text-positive" />
                    <span>When ON — cloud providers (OpenAI, Anthropic, Gemini, etc.) are blocked at the routing layer.</span>
                  </div>
                  <div className="flex items-center gap-2 text-text-muted">
                    <Icon name="check" size={12} className="shrink-0 text-positive" />
                    <span>AURA uses only self-hosted servers. If none is available, AURA reports the gap honestly.</span>
                  </div>
                  <div className="flex items-center gap-2 text-text-muted">
                    <Icon name="cpu" size={12} className="shrink-0 text-text-subtle" />
                    <span className="font-medium text-text-subtle">APPLICATION ENFORCED — software policy, not a physical air-gap. Physical isolation requires separate infrastructure controls.</span>
                  </div>
                </div>
              </div>
              <div className="shrink-0 pt-1">
                <Toggle on={settings.sovereignMode ?? false} onChange={(v) => patch({ sovereignMode: v })} />
              </div>
            </div>
          </Card>
        </PageBlock>

        {/* Generation */}
        <PageBlock className="col-span-12 lg:col-span-7">
          <Card>
            <CardHeader title="Generation" />
            <div className="mt-4 space-y-4">
              <Row label="Model" hint={!hasProvider ? 'Connect a provider first' : undefined}>
                <Dropdown value={status?.model ?? ''} options={models.map((m) => ({ value: m, label: m }))} onChange={changeModel} disabled={!hasProvider || switchingModel} className="w-64" />
              </Row>
              <Row label="Streaming" hint="Stream tokens as they generate">
                <Toggle on={settings.streaming ?? true} onChange={(v) => patch({ streaming: v })} />
              </Row>
              <Row label="Temperature" hint={String(settings.temperature?.toFixed(2) ?? '0.40')}>
                <input type="range" min={0} max={1} step={0.05} value={settings.temperature ?? 0.4} onChange={(e) => patch({ temperature: Number(e.target.value) })} className="w-48 accent-[var(--accent)]" />
              </Row>
              <Row label="Max tokens">
                <NumberField value={settings.maxTokens ?? 4096} step={128} min={128} max={8192} onChange={(v) => patch({ maxTokens: v })} />
              </Row>
            </div>
          </Card>
        </PageBlock>

        {/* Reliability + cache */}
        <PageBlock className="col-span-12 lg:col-span-5">
          <div className="flex h-full flex-col gap-5">
            <Card>
              <CardHeader title="Reliability" />
              <div className="mt-4 space-y-4">
                <Row label="Timeout" hint="seconds"><NumberField value={Math.round((settings.timeoutMs ?? 30000) / 1000)} step={5} min={5} max={120} onChange={(v) => patch({ timeoutMs: v * 1000 })} /></Row>
                <Row label="Retries"><NumberField value={settings.maxRetries ?? 2} step={1} min={0} max={5} onChange={(v) => patch({ maxRetries: v })} /></Row>
              </div>
            </Card>
            <Card>
              <CardHeader title="Knowledge cache" />
              <p className="mt-2 text-[12px] text-text-muted">Rebuild the Coding + FullStack indexes from the current project.</p>
              <Button variant="secondary" icon="knowledge" onClick={clearCache} loading={reindexing} className="mt-3" block>Clear cache & re-index</Button>
              {reindexMsg && <div className="mt-2 text-[11.5px] text-text-subtle">{reindexMsg}</div>}
            </Card>
          </div>
        </PageBlock>

        {/* Application updates. Its own block rather than a nested card:
            upgrading the app is not an AI-provider setting. */}
        <PageBlock className="col-span-12 lg:col-span-7">
          <UpdatePanel />
        </PageBlock>

        {/* The installation itself, for the same reason — and beside Updates
            because both answer "what copy of AURA Hub am I running, and what
            can I do about it?". Renders nothing unless there is an AppImage
            installation to act on. */}
        <PageBlock className="col-span-12 lg:col-span-5">
          <AppImageInstallPanel />
        </PageBlock>
      </div>

      {/* Connect Provider Dialog */}
      <Dialog open={dialog.open} onClose={closeDialog} title="Connect Provider" size="sm"
        footer={
          dialog.step === 'key' ? (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={closeDialog}>Cancel</Button>
              <Button icon="plus" onClick={connectProvider} disabled={!dialog.apiKey.trim()}>Connect</Button>
            </div>
          ) : dialog.step === 'connecting' ? (
            <div className="flex justify-end"><Button loading disabled>Connecting…</Button></div>
          ) : undefined
        }>
        {dialog.step === 'provider' && (
          <div className="space-y-2">
            <p className="text-[13px] text-text-muted">Choose a provider to connect:</p>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {/*
                A server you control first, third-party services below it.

                AURA's default is an Ollama server — which may be on this
                machine or on a shared one somebody else administers. The
                cloud providers are still here, one click away, for anyone
                who wants one. Demoting them states what AURA reaches for
                by default; it does not remove them.
              */}
              {(() => {
                const { served, cloud } = splitProviders(knownProviders);
                const selfHosted = served[0] ?? null;
                const row = (p: ProviderInfo, name?: string, prefill?: { addressPrefill?: string; placeholder?: string }) => (
                  <button key={`${p.id}-${name ?? p.name}`} onClick={() => selectProvider(p.id, { ...prefill, name })}
                    className="flex w-full items-center gap-3 rounded-xl border border-line px-3.5 py-3 text-left transition-colors hover:border-accent/40 hover:bg-accent/5">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-active text-text-muted"><Icon name={providerIcon(p.id)} size={16} /></span>
                    <div className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-text">{name ?? p.name ?? p.id}</span>
                      {p.description && <span className="block text-[11.5px] text-text-subtle">{p.description}</span>}
                    </div>
                    <Icon name="arrow-right" size={16} className="text-text-subtle" />
                  </button>
                );
                return (
                  <>
                    {/*
                      SELF-HOSTED is the primary inference path: a model
                      server somebody runs, on this machine (Local) or
                      another (Remote — a lab, college or private GPU box
                      is still self-hosted, never "cloud"). Both entries
                      drive the same addressed connect flow; only the
                      starting address differs.
                    */}
                    <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-text-subtle">
                      Self-hosted · Primary
                    </p>
                    <p className="px-1 pb-2 text-[11.5px] leading-relaxed text-text-subtle">
                      Primary inference. Your prompts stay on hardware you control.
                    </p>
                    {selfHosted ? (
                      <div className="space-y-2">
                        {row(selfHosted, 'Local Server', { addressPrefill: selfHosted.defaultBaseUrl ?? '', placeholder: 'http://127.0.0.1:11434' })}
                        {row(selfHosted, 'Remote Server', { addressPrefill: '', placeholder: 'http://gpu-server.example.edu:11434' })}
                      </div>
                    ) : (
                      <p className="px-1 pb-2 text-[11.5px] text-text-subtle">No self-hosted provider offered by the service.</p>
                    )}
                    {cloud.length > 0 && (
                      <>
                        <p className="px-1 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wide text-text-subtle">
                          Fallback · Optional
                        </p>
                        <p className="px-1 pb-2 text-[11.5px] leading-relaxed text-text-subtle">
                          Optional cloud inference when explicitly enabled. Connecting a key never activates it — activation is always your choice, and nothing is sent to a third party until then.
                        </p>
                        <button onClick={() => setFallbackOpen((v) => !v)}
                          aria-expanded={fallbackOpen}
                          className="flex w-full items-center gap-3 rounded-xl border border-line px-3.5 py-3 text-left transition-colors hover:border-accent/40 hover:bg-accent/5">
                          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-active text-text-muted"><Icon name="spark" size={16} /></span>
                          <div className="min-w-0 flex-1">
                            <span className="block text-[13px] font-medium text-text">Add Fallback Provider</span>
                            <span className="block text-[11.5px] text-text-subtle">{cloud.length} cloud providers · API key · used only if activated</span>
                          </div>
                          <Icon name={fallbackOpen ? 'chevron-down' : 'arrow-right'} size={16} className="text-text-subtle" />
                        </button>
                        {fallbackOpen && (
                          <div className="space-y-2 pt-2 opacity-70 transition-opacity hover:opacity-100">
                            {cloud.map((p) => row(p))}
                          </div>
                        )}
                      </>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        )}
        {dialog.step === 'key' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl bg-surface-active px-4 py-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-active text-text-muted"><Icon name={providerIcon(dialog.providerId)} size={15} /></span>
              <span className="text-[14px] font-semibold text-text">{dialog.providerName}</span>
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-text-muted">
                {dialog.addressed ? 'Server address' : 'API Key'}
              </label>
              <div className="flex gap-2">
                <Input
                  // An address is not a secret, so it is never masked —
                  // hiding it would only stop the user checking their own
                  // typing on the one field most likely to have a typo.
                  type={dialog.addressed || dialog.showKey ? 'text' : 'password'}
                  placeholder={dialog.placeholder || (dialog.addressed ? 'http://gpu-server.example.edu:11434' : 'Paste your API key…')}
                  value={dialog.apiKey}
                  onChange={(e) => setDialog((d) => ({ ...d, apiKey: (e as React.ChangeEvent<HTMLInputElement>).target.value, error: '' }))}
                  className="flex-1"
                  autoFocus
                />
                {!dialog.addressed && (
                  <button onClick={() => setDialog((d) => ({ ...d, showKey: !d.showKey }))} className="grid h-9 w-9 place-items-center rounded-lg border border-line text-text-muted hover:text-text">
                    <Icon name={dialog.showKey ? 'close' : 'activity'} size={14} />
                  </button>
                )}
              </div>
              {dialog.error && <p className="mt-1.5 text-[12px] text-danger">{dialog.error}</p>}
            </div>
          </div>
        )}
        {dialog.step === 'connecting' && (
          <div className="py-8 text-center"><p className="text-[13px] text-text-muted">Validating key and discovering models…</p></div>
        )}
      </Dialog>
    </PageContainer>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div><div className="text-[13px] font-medium text-text">{label}</div>{hint && <div className="text-[11px] text-text-subtle">{hint}</div>}</div>
      {children}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className={cn('relative h-6 w-11 rounded-full transition-colors', on ? 'bg-accent' : 'bg-surface-active')}>
      <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all', on ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}

function NumberField({ value, onChange, step, min, max }: { value: number; onChange: (v: number) => void; step: number; min: number; max: number }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface">
      <button className="grid h-8 w-8 place-items-center text-text-muted hover:text-text" onClick={() => onChange(Math.max(min, value - step))}>−</button>
      <span className="w-12 text-center text-[13px] font-medium tabular-nums text-text">{value}</span>
      <button className="grid h-8 w-8 place-items-center text-text-muted hover:text-text" onClick={() => onChange(Math.min(max, value + step))}>+</button>
    </div>
  );
}
