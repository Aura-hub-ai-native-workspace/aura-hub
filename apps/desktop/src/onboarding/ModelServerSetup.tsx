import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Icon } from '@aura/ui';
import { aiClient, type ProviderInfo } from '../ai/aiClient';
import { detectConnection } from './detectConnection';
import { canVerify, type SetupPhase } from './gateRules';

/**
 * The first screen: where Ollama is, and which model to use.
 *
 * It replaces a screen that asked for an API key and offered twelve hosted
 * providers to buy one from. Two fields, no account, and — the part that
 * matters — no way into the workspace until the configured server has
 * actually answered a prompt with the exact model requested.
 *
 * ## Why verification is the gate, not the connection
 *
 * Reaching an address proves a socket opened. `/api/tags` answering proves
 * something Ollama-shaped is there. Neither proves the model will load, and
 * a workspace that opens and then fails on its first question is worse than
 * one that explains the problem while it can still be fixed. So "Verify and
 * Continue" runs the whole path and only then saves anything.
 *
 * ## Where the server is, is the user's business
 *
 * It may be this machine, a box on the LAN, or a college GPU server behind
 * HTTPS. The address is classified as it is typed purely to reflect what
 * AURA read back — it never restricts what may be entered, and a hostname
 * whose location cannot be known from the URL says exactly that.
 */
type Phase = SetupPhase;

/** The steps the gate walks, in the order the user sees them. */
const STEPS = [
  { id: 'url', label: 'Address looks valid' },
  { id: 'reach', label: 'Server reachable and speaking Ollama' },
  { id: 'models', label: 'Model list retrieved' },
  { id: 'model', label: 'Requested model is served there' },
  { id: 'generate', label: 'Model answered a real prompt' },
  { id: 'save', label: 'Configuration saved' },
] as const;

type StageId = typeof STEPS[number]['id'] | 'timeout';

export function ModelServerSetup({ onActivated, onOffline }: { onActivated: () => void; onOffline: () => void }) {
  const [provider, setProvider] = useState<ProviderInfo | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [failedAt, setFailedAt] = useState<StageId | null>(null);
  const [error, setError] = useState<string>();
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [sample, setSample] = useState<string>();
  /**
   * True when a server configuration was saved on an earlier run but is
   * not healthy now. The fields are prefilled from it and the copy says
   * "unavailable" rather than "configure" — and nothing here erases the
   * saved configuration: a failed health check edits no store.
   */
  const [hadSaved, setHadSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;

    const ask = async () => {
      if (!alive) return;
      try {
        const r = await aiClient.getProviders();
        if (!alive) return;
        const served = (r.providers ?? []).find((x) => x.selfHosted) ?? null;
        if (served) {
          setProvider(served);
          setServiceError(null);
          // A self-hosted entry is fingerprinted by its address, so a
          // saved address reads back out of the connected list. Prefer
          // it over the default — returning to this screen must show
          // what was configured, not a blank form — but only ever into
          // an untouched field, never over the user's typing.
          const saved = (r.connected ?? []).find((c) => c.id === served.id) ?? null;
          const savedAddr = saved?.fingerprint || '';
          const savedModel = (r.activeModel && r.activeModel !== 'none' ? r.activeModel : '')
            || (saved?.activeModel && saved.activeModel !== 'none' ? saved.activeModel : '');
          if (savedAddr || savedModel) setHadSaved(true);
          setBaseUrl((current) => current || savedAddr || served.defaultBaseUrl || '');
          if (savedModel) setModel((current) => current || savedModel);
          return;
        }
        throw new Error('no self-hosted provider offered');
      } catch {
        if (!alive) return;
        attempt += 1;
        setServiceError('Waiting for AURA’s local service to finish starting…');
        // Backs off, but never stops: the service arriving late is the
        // normal case, not an error state to give up in.
        timer = setTimeout(ask, Math.min(500 * attempt, 3000));
      }
    };
    void ask();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  // Recomputed as the address is typed; no network, no commitment.
  const detected = useMemo(() => detectConnection(baseUrl), [baseUrl]);

  // `ollama` is the id of the self-hosted provider whether or not the
  // listing has arrived; see `gateRules.canVerify` for why the button does
  // not wait on it.
  const providerId = provider?.id ?? 'ollama';

  /**
   * Offer the server's own model list once an address looks plausible.
   *
   * Convenience only — the field stays free text, because a model pulled a
   * minute ago will not be in a list fetched before that.
   */
  useEffect(() => {
    if (detected.kind === 'invalid' || !baseUrl.trim()) { setModels([]); return; }
    let alive = true;
    const t = setTimeout(() => {
      aiClient.discoverServerModels(providerId, baseUrl.trim())
        .then((r) => { if (alive) setModels(r?.models ?? []); })
        .catch(() => { if (alive) setModels([]); });
    }, 700);
    return () => { alive = false; clearTimeout(t); };
  }, [baseUrl, providerId, detected.kind]);

  const verify = async () => {
    setPhase('verifying');
    setError(undefined);
    setFailedAt(null);
    setSample(undefined);
    try {
      const r = await aiClient.verifyServerProvider(providerId, baseUrl.trim(), model.trim());
      if (r?.ok) {
        setPhase('passed');
        setSample(r.sample);
        if (r.models?.length) setModels(r.models);
        // A short beat so the finished checklist is readable rather than
        // a flash before the workspace replaces it.
        setTimeout(onActivated, 650);
        return;
      }
      setPhase('failed');
      setFailedAt((r?.stage as StageId) ?? 'reach');
      setError(r?.error ?? 'Verification failed.');
      if (r?.models?.length) setModels(r.models);
    } catch {
      setPhase('failed');
      setFailedAt('reach');
      setError('Could not reach AURA’s local service to run the check.');
    }
  };

  const stepState = (id: string): 'done' | 'active' | 'failed' | 'todo' => {
    if (phase === 'passed') return 'done';
    if (phase !== 'failed' && phase !== 'verifying') return 'todo';
    const order = STEPS.findIndex((s) => s.id === id);
    // A timeout is a failure of the generation step.
    const failedIndex = STEPS.findIndex((s) => s.id === (failedAt === 'timeout' ? 'generate' : failedAt));
    if (phase === 'failed') {
      if (failedIndex === -1) return 'todo';
      if (order < failedIndex) return 'done';
      if (order === failedIndex) return 'failed';
      return 'todo';
    }
    return 'active';
  };

  const readyToVerify = canVerify({ baseUrl, model, detectedKind: detected.kind, phase });

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -14 }}
      transition={{ type: 'spring', stiffness: 200, damping: 28 }}
      className="flex max-h-[86vh] w-full max-w-[620px] flex-col overflow-y-auto px-1 pb-2"
    >
      <div className="text-center">
        <h1 className="text-[32px] font-semibold tracking-[-0.02em] text-white">Connect your Ollama server</h1>
        <p className="mx-auto mt-3 max-w-lg text-[14px] leading-relaxed text-white/60">
          Enter the address of the machine where Ollama is running. AURA Hub will verify the server
          and the selected model before opening the workspace.
        </p>
      </div>

      {serviceError && (
        <div className="mt-6 rounded-xl border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-[13px] text-amber-200/90">
          {serviceError}
        </div>
      )}

      {hadSaved && !serviceError && (
        <div className="mt-6 rounded-xl border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-[13px] leading-relaxed text-amber-200/90">
          Saved server unavailable — the address and model below are your saved configuration, kept as-is.
          Edit them and verify again.
        </div>
      )}

      <div className="mt-8 space-y-5">
        <label className="block">
          <span className="text-[12.5px] font-medium uppercase tracking-wide text-white/45">Ollama server</span>
          <input
            value={baseUrl}
            onChange={(e) => { setBaseUrl(e.target.value); setPhase('idle'); }}
            spellCheck={false}
            autoFocus
            placeholder="http://127.0.0.1:11434"
            className="mt-2 w-full rounded-xl border border-white/12 bg-white/[0.04] px-4 py-3 font-mono text-[13.5px] text-white outline-none transition focus:border-white/30"
          />
          <p className={`mt-2 text-[12.5px] ${detected.kind === 'invalid' ? 'text-rose-300/90' : 'text-white/45'}`}>
            <span className="text-white/30">Detected: </span>{detected.label}
          </p>
        </label>

        <label className="block">
          <span className="text-[12.5px] font-medium uppercase tracking-wide text-white/45">Model ID</span>
          <input
            value={model}
            onChange={(e) => { setModel(e.target.value); setPhase('idle'); }}
            spellCheck={false}
            list="aura-server-models"
            placeholder="qwen3:4b"
            className="mt-2 w-full rounded-xl border border-white/12 bg-white/[0.04] px-4 py-3 font-mono text-[13.5px] text-white outline-none transition focus:border-white/30"
          />
          <datalist id="aura-server-models">
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </datalist>
          {models.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {models.slice(0, 6).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { setModel(m.id); setPhase('idle'); }}
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

      {phase !== 'idle' && (
        <div className="mt-7 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3.5">
          <ul className="space-y-2">
            {STEPS.map((s) => {
              const state = stepState(s.id);
              return (
                <li key={s.id} className="flex items-center gap-2.5 text-[12.5px]">
                  <span className="grid h-4 w-4 shrink-0 place-items-center">
                    {state === 'done' && <Icon name="check" size={13} className="text-emerald-400" />}
                    {state === 'failed' && <Icon name="close" size={13} className="text-rose-400" />}
                    {state === 'active' && <Icon name="refresh" size={12} className="animate-spin text-white/50" />}
                    {state === 'todo' && <span className="h-1.5 w-1.5 rounded-full bg-white/15" />}
                  </span>
                  <span className={
                    state === 'done' ? 'text-white/70'
                      : state === 'failed' ? 'text-rose-300/90'
                        : state === 'active' ? 'text-white/70' : 'text-white/30'
                  }>
                    {s.label}
                  </span>
                </li>
              );
            })}
          </ul>
          {error && <p className="mt-3 border-t border-white/8 pt-3 text-[12.5px] leading-relaxed text-rose-300/90">{error}</p>}
          {phase === 'passed' && sample && (
            <p className="mt-3 border-t border-white/8 pt-3 font-mono text-[12px] text-emerald-300/80">{sample}</p>
          )}
        </div>
      )}

      <div className="mt-8 flex items-center justify-between gap-4">
        <button type="button" onClick={onOffline} className="text-[13px] text-white/40 transition hover:text-white/70">
          Skip for now
        </button>
        <button
          type="button"
          disabled={!readyToVerify}
          onClick={verify}
          className="rounded-xl bg-white px-6 py-3 text-[13.5px] font-medium text-black transition disabled:cursor-not-allowed disabled:bg-white/20 disabled:text-white/40"
        >
          {phase === 'verifying' ? 'Verifying…' : phase === 'passed' ? 'Opening workspace…' : 'Verify and Continue'}
        </button>
      </div>

      <p className="mt-6 text-center text-[12px] leading-relaxed text-white/30">
        Ollama can be on this machine or on another one — a lab or GPU server works the same way.
        Nothing is installed here, and the model runs wherever the server is. A hosted provider can
        be connected later from Settings.
      </p>
    </motion.div>
  );
}
