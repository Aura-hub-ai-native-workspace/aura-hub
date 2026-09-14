import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Icon } from '@aura/ui';
import { aiClient, type ProviderInfo } from '../ai/aiClient';

/**
 * The only thing AURA asks for before it will work: where the model
 * server is, and which model to use.
 *
 * This replaces a screen that asked for an API key and offered twelve
 * hosted providers to buy one from. Two fields, and no account.
 *
 * ## The server is not assumed to be here
 *
 * It may be on this machine, and it may just as well be a shared GPU
 * server somebody else administers — which is the deployment this was
 * written for. On those laptops there is no Ollama, no model and no GPU;
 * the client posts to an address and renders what comes back. So the
 * address is asked for rather than detected, the prefill is a suggestion
 * an institution can override with `AURA_OLLAMA_BASE_URL`, and none of
 * the copy here tells anyone to install a runtime they do not need.
 *
 * Neither field is guessed at silently: the address is CHECKED against
 * the server, and the model list is whatever that server reports — so
 * "the server has no models" is a distinct, fixable message rather than
 * an empty dropdown.
 */
type Probe = 'idle' | 'checking' | 'reachable' | 'unreachable';

export function ModelServerSetup({ onActivated, onOffline }: { onActivated: () => void; onOffline: () => void }) {
  const [provider, setProvider] = useState<ProviderInfo | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [probe, setProbe] = useState<Probe>('idle');
  const [probeError, setProbeError] = useState<string>();
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [model, setModel] = useState('');
  const [activating, setActivating] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let alive = true;
    aiClient.getProviders()
      .then((r) => {
        if (!alive) return;
        const served = (r.providers ?? []).find((x) => x.selfHosted) ?? null;
        setProvider(served);
        setBaseUrl(served?.defaultBaseUrl ?? '');
      })
      .catch(() => {
        if (alive) setServiceError('Could not reach AURA’s local service. Give it a moment to finish starting, or continue offline.');
      });
    return () => { alive = false; };
  }, []);

  /*
   * Checked as it is typed, against the real server.
   *
   * Debounced because every keystroke of a hostname would otherwise be a
   * connection attempt, and the intermediate states of "127.0.0.1:114" are
   * all failures that mean nothing.
   */
  useEffect(() => {
    if (!provider || !baseUrl.trim()) { setProbe('idle'); return; }
    if (debounce.current) clearTimeout(debounce.current);
    setProbe('checking');
    setProbeError(undefined);
    debounce.current = setTimeout(async () => {
      try {
        const r = await aiClient.connectServerProvider(provider.id, baseUrl.trim());
        if (r?.ok) {
          setProbe('reachable');
          const found = r.models ?? [];
          setModels(found);
          // Pre-select only when the user has not already chosen. A list
          // that reorders under a typed model id would be maddening.
          setModel((m) => (m || found[0]?.id || ''));
        } else {
          setProbe('unreachable');
          setProbeError(r?.error ?? 'That address did not answer as a model server.');
          setModels([]);
        }
      } catch {
        setProbe('unreachable');
        setProbeError('Could not reach AURA’s local service.');
      }
    }, 600);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [baseUrl, provider]);

  const ready = probe === 'reachable' && model.trim().length > 0 && !activating;

  const activate = async () => {
    if (!provider || !ready) return;
    setActivating(true);
    try {
      await aiClient.switchProvider(provider.id, model.trim());
      onActivated();
    } catch {
      setActivating(false);
      setProbeError('The model could not be activated. Check that it is pulled on your server.');
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -14 }}
      transition={{ type: 'spring', stiffness: 200, damping: 28 }}
      className="flex max-h-[86vh] w-full max-w-[620px] flex-col overflow-y-auto px-1 pb-2"
    >
      <div className="text-center">
        <h1 className="text-[32px] font-semibold tracking-[-0.02em] text-white">Connect your model server</h1>
        <p className="mx-auto mt-3 max-w-lg text-[14px] leading-relaxed text-white/60">
          AURA talks to an Ollama server over HTTP — your own machine, or a shared one such as a
          lab or GPU server. The model runs there, not here. No account, no API key.
        </p>
      </div>

      {serviceError && (
        <div className="mt-6 rounded-xl border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-[13px] text-amber-200/90">
          {serviceError}
        </div>
      )}

      <div className="mt-8 space-y-5">
        <label className="block">
          <span className="text-[12.5px] font-medium uppercase tracking-wide text-white/45">Server address</span>
          <div className="relative mt-2">
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              spellCheck={false}
              autoFocus
              placeholder="http://gpu-server.example.edu:11434"
              className="w-full rounded-xl border border-white/12 bg-white/[0.04] px-4 py-3 pr-11 font-mono text-[13.5px] text-white outline-none transition focus:border-white/30"
            />
            <span className="absolute right-3.5 top-1/2 -translate-y-1/2">
              {probe === 'checking' && <Icon name="refresh" size={15} className="animate-spin text-white/40" />}
              {probe === 'reachable' && <Icon name="check" size={15} className="text-emerald-400" />}
              {probe === 'unreachable' && <Icon name="close" size={15} className="text-rose-400" />}
            </span>
          </div>
          {probe === 'unreachable' && probeError && (
            <p className="mt-2 text-[12.5px] leading-relaxed text-rose-300/90">{probeError}</p>
          )}
          {probe === 'reachable' && (
            <p className="mt-2 text-[12.5px] text-emerald-300/80">
              Reachable — {models.length} model{models.length === 1 ? '' : 's'} served there.
            </p>
          )}
        </label>

        <label className="block">
          <span className="text-[12.5px] font-medium uppercase tracking-wide text-white/45">Model</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            spellCheck={false}
            list="aura-local-models"
            placeholder="the model id served there, e.g. qwen3:4b"
            className="mt-2 w-full rounded-xl border border-white/12 bg-white/[0.04] px-4 py-3 font-mono text-[13.5px] text-white outline-none transition focus:border-white/30"
          />
          {/*
            A datalist rather than a select: the server's own list is the
            useful default, but a model pulled a second ago — or one served
            by something that does not list models at all — must still be
            typeable.
          */}
          <datalist id="aura-local-models">
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </datalist>
          {models.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {models.slice(0, 6).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setModel(m.id)}
                  className={`rounded-lg border px-2.5 py-1 font-mono text-[11.5px] transition ${
                    model === m.id
                      ? 'border-white/35 bg-white/10 text-white'
                      : 'border-white/10 bg-white/[0.03] text-white/55 hover:text-white/80'
                  }`}
                >
                  {m.name}
                </button>
              ))}
            </div>
          )}
        </label>
      </div>

      <div className="mt-9 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={onOffline}
          className="text-[13px] text-white/40 transition hover:text-white/70"
        >
          Skip for now
        </button>
        <button
          type="button"
          disabled={!ready}
          onClick={activate}
          className="rounded-xl bg-white px-6 py-3 text-[13.5px] font-medium text-black transition disabled:cursor-not-allowed disabled:bg-white/20 disabled:text-white/40"
        >
          {activating ? 'Activating…' : 'Activate workspace'}
        </button>
      </div>

      <p className="mt-6 text-center text-[12px] leading-relaxed text-white/30">
        Using a shared server? Ask whoever runs it for the address and a model id — nothing needs
        installing here. Running one yourself instead? Install Ollama on that machine and start it
        with <span className="font-mono">ollama serve</span>. A hosted provider can be connected
        later from Settings.
      </p>
    </motion.div>
  );
}
