import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { DEFAULT_AGENTS, reduceSetup, runAgentSetup, type AgentId, type RowState } from './agentsClient';
import { useAgentChoice } from './agentChoice';

const NAMES: Record<AgentId, string> = {
  opencode: 'OpenCode', 'kilo-code': 'Kilo Code', freebuff: 'Freebuff',
  'claude-code': 'Claude Code', 'codex-cli': 'Codex', agy: 'Antigravity CLI', pi: 'pi',
};

type Rows = Record<string, { state: RowState; detail: string }>;
const initialRows = (ids: AgentId[]): Rows => Object.fromEntries(ids.map((id) => [id, { state: 'waiting' as RowState, detail: 'Waiting' }]));

/**
 * First launch: installs the workspace's coding agents (four by default) and
 * connects common-context to each, with live progress. One agent failing never blocks the rest; Continue
 * is always possible once the run ends, and Retry reruns only the failed ones.
 */
export function AgentsSetupScreen({ onContinue }: { onContinue: () => void }) {
  const selected = useAgentChoice((s) => s.selected);
  const ids = selected.length ? selected : DEFAULT_AGENTS;
  const [rows, setRows] = useState<Rows>(() => initialRows(ids));
  const [running, setRunning] = useState(true);
  const started = useRef(false);

  const run = (only?: AgentId[]) => {
    setRunning(true);
    if (only) setRows((r) => ({ ...r, ...Object.fromEntries(only.map((id) => [id, { state: 'waiting' as RowState, detail: 'Waiting' }])) }));
    void runAgentSetup((e) => setRows((r) => reduceSetup(r, e)), only)
      .catch(() => setRows((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.state === 'ready' ? v : { state: 'failed', detail: 'AURA could not reach its setup service' }]))))
      .finally(() => setRunning(false));
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run();
  }, []);

  const failed = ids.filter((id) => rows[id]?.state === 'failed');

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="w-full max-w-lg" data-testid="agents-setup">
      <h1 className="text-[28px] font-semibold tracking-[-0.02em]">Setting up your agents</h1>
      <p className="mt-2 text-[14px] text-white/60">AURA installs your coding agents and connects each one to the shared common-context, so they all see the same work. You can add or remove agents later.</p>
      <ul className="mt-6 space-y-2">
        {ids.map((id) => {
          const r = rows[id] ?? { state: 'waiting' as RowState, detail: 'Waiting' };
          return (
            <li key={id} data-testid={`setup-row-${id}`} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3">
              <span className="text-[14px] font-medium">{NAMES[id]}</span>
              <span className={r.state === 'failed' ? 'text-[12.5px] text-red-300' : r.state === 'ready' ? 'text-[12.5px] text-emerald-300' : 'text-[12.5px] text-white/55'}>
                {r.detail}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-6 flex items-center justify-end gap-3">
        {!running && failed.length > 0 && (
          <button type="button" onClick={() => run(failed)} className="rounded-full border border-white/20 px-4 py-2 text-[13px] text-white/85 hover:bg-white/10">
            Retry {failed.length === 1 ? NAMES[failed[0]] : `${failed.length} agents`}
          </button>
        )}
        <button type="button" disabled={running} onClick={onContinue} className="rounded-full bg-white px-5 py-2 text-[13px] font-semibold text-black disabled:opacity-40">
          {running ? 'Setting up…' : 'Continue'}
        </button>
      </div>
    </motion.div>
  );
}
