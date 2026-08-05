import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Icon, Skeleton, type IconName } from '@aura/ui';
import { aiClient, type ProviderInfo } from '../ai/aiClient';
import { ProviderCard } from './ProviderCard';
import { ApiKeyInput, type KeyStatus } from './ApiKeyInput';
import { detectProviderId } from './detectProviderId';

const PROVIDER_ICON: Record<string, IconName> = {
  groq: 'activity',
  nvidia: 'cpu',
  openai: 'spark',
  anthropic: 'spark',
  gemini: 'spark',
  mistral: 'spark',
  cerebras: 'cpu',
  kimi: 'spark',
  openrouter: 'link',
  qwen: 'spark',
};
const PROVIDER_ACCENT: Record<string, string> = {
  groq: '#f97316',
  nvidia: '#22c55e',
  openai: '#38bdf8',
  anthropic: '#f472b6',
  gemini: '#a78bfa',
  mistral: '#fbbf24',
  cerebras: '#ef4444',
  openrouter: '#60a5fa',
  kimi: '#2dd4bf',
  qwen: '#818cf8',
};
const FALLBACK_ACCENT = '#8892a6';
const PROVIDER_BADGES: Record<string, string[]> = {
  groq: ['Free', 'Ultra Fast', 'Recommended'],
  nvidia: ['Free', 'High Performance'],
  mistral: ['Free Tier', 'EU-Based'],
  cerebras: ['Ultra Fast', 'High Throughput'],
  qwen: ['Multilingual', 'Alibaba Cloud'],
};

export function WorkspaceActivation({ onActivated, onOffline }: { onActivated: () => void; onOffline: () => void }) {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [keyStatus, setKeyStatus] = useState<KeyStatus>('idle');
  const [keyError, setKeyError] = useState<string>();
  const [connectedIds, setConnectedIds] = useState<Set<string>>(new Set());
  const [otherOpen, setOtherOpen] = useState(false);
  const [activating, setActivating] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let alive = true;
    aiClient
      .getProviders()
      .then((r) => {
        if (!alive) return;
        setProviders(r.providers ?? []);
      })
      .catch(() => {
        if (alive) setProvidersError('Could not reach the local AI service. Make sure AURA finished starting up, or continue in Offline Mode.');
      });
    return () => { alive = false; };
  }, []);

  const groq = providers?.find((p) => p.id === 'groq');
  const nvidia = providers?.find((p) => p.id === 'nvidia');
  const mistral = providers?.find((p) => p.id === 'mistral');
  const cerebras = providers?.find((p) => p.id === 'cerebras');
  const qwen = providers?.find((p) => p.id === 'qwen');
  const others = providers?.filter((p) => p.id !== 'groq' && p.id !== 'nvidia' && p.id !== 'mistral' && p.id !== 'cerebras' && p.id !== 'qwen') ?? [];

  // Live "auto-detect provider" from key prefix — never overrides an
  // explicit manual card selection unless the key clearly belongs to a
  // *different* known provider.
  useEffect(() => {
    const detected = detectProviderId(apiKey);
    if (detected && detected !== selectedId) {
      setSelectedId(detected);
    }
  }, [apiKey, selectedId]);

  const selectProvider = (id: string) => {
    setSelectedId(id);
    setKeyStatus('idle');
    setKeyError(undefined);
  };

  // Debounced live validation — a real call to the local AI service, not
  // a fabricated check.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!selectedId || apiKey.trim().length < 8) {
      setKeyStatus('idle');
      return;
    }
    setKeyStatus('validating');
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await aiClient.connectProvider(selectedId, apiKey.trim());
        if (r?.ok) {
          setKeyStatus('valid');
          setConnectedIds((s) => new Set(s).add(selectedId));
        } else {
          setKeyStatus('invalid');
          setKeyError(r?.error ?? 'This key was rejected by the provider.');
        }
      } catch {
        setKeyStatus('invalid');
        setKeyError('Could not reach the local AI service.');
      }
    }, 700);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, selectedId]);

  const activate = async () => {
    if (!selectedId || keyStatus !== 'valid') return;
    setActivating(true);
    try {
      await aiClient.switchProvider(selectedId);
    } finally {
      onActivated();
    }
  };

  const openExternal = (url?: string) => {
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const selectedInfo = providers?.find((p) => p.id === selectedId);
  const canActivate = keyStatus === 'valid' && !activating;

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -14 }}
      transition={{ type: 'spring', stiffness: 200, damping: 28 }}
      className="flex max-h-[86vh] w-full max-w-[720px] flex-col overflow-y-auto px-1 pb-2"
    >
      <div className="text-center">
        <h1 className="text-[32px] font-semibold tracking-[-0.02em] text-white">Prepare your AI Workspace</h1>
        <p className="mx-auto mt-3 max-w-lg text-[14px] leading-relaxed text-white/60">
          Paste your API key to activate your AI Workspace.
        </p>
        <p className="mx-auto mt-1.5 max-w-lg text-[12.5px] leading-relaxed text-white/35">
          AURA uses your own AI providers, giving you complete control over your models, privacy, and usage.
        </p>
      </div>

      {providersError ? (
        <div className="mt-8 rounded-2xl border border-red-400/25 bg-red-400/5 px-5 py-4 text-center text-[13px] text-red-200/90">
          {providersError}
        </div>
      ) : !providers ? (
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Skeleton className="h-28 bg-white/10" />
          <Skeleton className="h-28 bg-white/10" />
        </div>
      ) : (
        <>
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {groq && (
              <ProviderCard
                icon={PROVIDER_ICON.groq}
                name={groq.name}
                description={groq.description || 'Perfect for daily development and fast AI interactions.'}
                badges={PROVIDER_BADGES.groq}
                accent={PROVIDER_ACCENT.groq}
                selected={selectedId === 'groq'}
                connected={connectedIds.has('groq')}
                onSelect={() => selectProvider('groq')}
                onGetKey={() => openExternal(groq.docsUrl)}
              />
            )}
            {nvidia && (
              <ProviderCard
                icon={PROVIDER_ICON.nvidia}
                name={nvidia.name}
                description={nvidia.description || 'Excellent quality models with generous free access.'}
                badges={PROVIDER_BADGES.nvidia}
                accent={PROVIDER_ACCENT.nvidia}
                selected={selectedId === 'nvidia'}
                connected={connectedIds.has('nvidia')}
                onSelect={() => selectProvider('nvidia')}
                onGetKey={() => openExternal(nvidia.docsUrl)}
              />
            )}
            {mistral && (
              <ProviderCard
                icon={PROVIDER_ICON.mistral}
                name={mistral.name}
                description={mistral.description || 'Powerful open-weight and frontier models with a free tier.'}
                badges={PROVIDER_BADGES.mistral}
                accent={PROVIDER_ACCENT.mistral}
                selected={selectedId === 'mistral'}
                connected={connectedIds.has('mistral')}
                onSelect={() => selectProvider('mistral')}
                onGetKey={() => openExternal(mistral.docsUrl)}
              />
            )}
            {cerebras && (
              <ProviderCard
                icon={PROVIDER_ICON.cerebras}
                name={cerebras.name}
                description={cerebras.description || 'Blazing-fast inference on purpose-built silicon.'}
                badges={PROVIDER_BADGES.cerebras}
                accent={PROVIDER_ACCENT.cerebras}
                selected={selectedId === 'cerebras'}
                connected={connectedIds.has('cerebras')}
                onSelect={() => selectProvider('cerebras')}
                onGetKey={() => openExternal(cerebras.docsUrl)}
              />
            )}
            {qwen && (
              <ProviderCard
                icon={PROVIDER_ICON.qwen}
                name={qwen.name}
                description={qwen.description || 'Alibaba Cloud’s flagship model family, strong at multilingual tasks.'}
                badges={PROVIDER_BADGES.qwen}
                accent={PROVIDER_ACCENT.qwen}
                selected={selectedId === 'qwen'}
                connected={connectedIds.has('qwen')}
                onSelect={() => selectProvider('qwen')}
                onGetKey={() => openExternal(qwen.docsUrl)}
              />
            )}
          </div>

          {others.length > 0 && (
            <div className="mt-4">
              <button
                onClick={() => setOtherOpen((v) => !v)}
                className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-[13px] font-medium text-white/70 transition-colors hover:text-white"
              >
                Other Providers
                <Icon name="chevron-down" size={15} className={otherOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
              </button>
              <AnimatePresence initial={false}>
                {otherOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                    className="overflow-hidden"
                  >
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {others.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => selectProvider(p.id)}
                          className="flex items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors"
                          style={{
                            borderColor: selectedId === p.id ? (PROVIDER_ACCENT[p.id] ?? FALLBACK_ACCENT) : 'rgba(255,255,255,0.08)',
                            background: selectedId === p.id ? `${PROVIDER_ACCENT[p.id] ?? FALLBACK_ACCENT}14` : 'rgba(255,255,255,0.02)',
                          }}
                        >
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[0.06]" style={{ color: PROVIDER_ACCENT[p.id] ?? FALLBACK_ACCENT }}>
                            <Icon name={PROVIDER_ICON[p.id] ?? 'cpu'} size={15} />
                          </span>
                          <div className="min-w-0">
                            <div className="text-[13px] font-medium text-white">{p.name}</div>
                            <div className="truncate text-[11px] text-white/40">{p.description}</div>
                          </div>
                          {connectedIds.has(p.id) && <Icon name="check" size={14} className="ml-auto shrink-0 text-emerald-300" />}
                        </button>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* API key input */}
          <div className="mt-6">
            <ApiKeyInput
              value={apiKey}
              onChange={setApiKey}
              onSubmit={activate}
              status={keyStatus}
              detectedName={selectedInfo?.name}
              detectedIcon={selectedId ? PROVIDER_ICON[selectedId] : undefined}
              errorMessage={keyError}
            />
          </div>

          {/* Help card */}
          <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4">
            <div className="flex items-start gap-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-amber-400/15 text-amber-300">💡</span>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-white">New to AI providers?</div>
                <p className="mt-1 text-[12px] leading-relaxed text-white/50">
                  Groq, NVIDIA, Mistral and Cerebras all offer fast API access for many users. Connect one to get started in minutes.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button onClick={() => openExternal(groq?.docsUrl)} className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11.5px] font-medium text-white/70 hover:text-white">
                    Get Groq API Key
                  </button>
                  <button onClick={() => openExternal(nvidia?.docsUrl)} className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11.5px] font-medium text-white/70 hover:text-white">
                    Get NVIDIA API Key
                  </button>
                  <button onClick={() => openExternal(mistral?.docsUrl)} className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11.5px] font-medium text-white/70 hover:text-white">
                    Get Mistral API Key
                  </button>
                  <button onClick={() => openExternal(cerebras?.docsUrl)} className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11.5px] font-medium text-white/70 hover:text-white">
                    Get Cerebras API Key
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Primary + secondary actions */}
      <div className="mt-7 flex flex-col items-center gap-4">
        <motion.button
          onClick={activate}
          disabled={!canActivate}
          whileHover={canActivate ? { scale: 1.02, boxShadow: '0 0 36px -8px rgba(52,211,153,0.6)' } : {}}
          whileTap={canActivate ? { scale: 0.97 } : {}}
          transition={{ type: 'spring', stiffness: 420, damping: 28 }}
          className="w-full max-w-xs rounded-2xl py-3.5 text-[14.5px] font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-35"
          style={{ background: canActivate ? 'linear-gradient(180deg, #4ade80, #22c55e)' : 'rgba(255,255,255,0.08)' }}
        >
          {activating ? 'Activating…' : 'Activate AI Workspace'}
        </motion.button>

        <button onClick={onOffline} className="text-[12.5px] font-medium text-white/45 underline-offset-4 hover:text-white/75 hover:underline">
          Continue in Offline Mode
        </button>
        <p className="max-w-sm text-center text-[11px] leading-relaxed text-white/30">
          Explore AURA without AI features. You can connect an AI provider later from Settings.
        </p>
      </div>
    </motion.div>
  );
}
