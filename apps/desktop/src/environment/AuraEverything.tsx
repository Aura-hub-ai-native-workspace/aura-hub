import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import {
  environmentClient,
  type SoftwareResult,
  type SoftwareSearchResponse,
} from './environmentClient';

/**
 * AURA Everything — search for software, wherever you found it.
 *
 * The point of this surface is that a person who read about a tool on
 * the internet should not then have to learn which package manager ships
 * it, what the executable is called, or how to connect it. They type the
 * name; AURA answers with what it can actually prove.
 *
 * What it will NOT do is offer to install something it cannot vouch for.
 * The Install control is bound to one backend field — `installable` —
 * which is true only when the resolved identity matches a curated
 * catalogue entry whose existing InstallSpec produces a real command on
 * this machine. A package existing on npm, having a repository, a
 * homepage or a declared executable is identity evidence; it is not
 * permission, and this component never treats it as such. Everything
 * else gets an honest state and a link to the source.
 *
 * Opening this panel performs no machine scan. Search consults local
 * inventory and AURA's catalogue first, and reaches a registry only when
 * neither had an answer.
 *
 * "Add to workspace" is layout, not machinery. It appears only on a
 * result the backend resolved to a real catalogue id — the same identity
 * the environment scanner probes — and all it does is put that id in one
 * of the workspace's three tool slots. It installs nothing, connects
 * nothing, and changes nothing about the machine. When all three slots
 * are taken it says so instead of pretending to add a fourth.
 *
 * Opened from a slot's Replace control, the same surface swaps that one
 * slot instead of filling a free one. The only difference is which slot
 * the chosen id lands in: the result still carries no status of its own,
 * and what the slot then reports comes from the environment's next real
 * answer about that id, never from the act of choosing it.
 */

/** The slot an open surface is swapping, when it was opened to replace. */
export interface ReplaceContext {
  /** 0-based slot position. */
  index: number;
  /** What currently occupies it, for the user to recognise. */
  name: string;
}

const STATE_TONE: Record<string, string> = {
  AURA_READY: 'border-[rgba(31,211,138,0.5)] bg-[rgba(31,211,138,0.12)] text-neon-success',
  CONNECTED: 'border-[rgba(31,211,138,0.5)] bg-[rgba(31,211,138,0.12)] text-neon-success',
  VERIFIED: 'border-[rgba(31,211,138,0.45)] bg-[rgba(31,211,138,0.1)] text-neon-success',
  INSTALLED: 'border-[rgba(77,124,255,0.5)] bg-[rgba(77,124,255,0.12)] text-[#8fb0ff]',
  INSTALLABLE: 'border-[rgba(122,92,255,0.5)] bg-[rgba(122,92,255,0.12)] text-[#b7a6ff]',
  CATALOGUE: 'border-white/12 bg-white/5 text-text-muted',
  DISCOVERED: 'border-white/12 bg-white/5 text-text-muted',
  UNTRUSTED: 'border-[rgba(255,181,71,0.45)] bg-[rgba(255,181,71,0.1)] text-neon-warning',
  UNSUPPORTED: 'border-[rgba(255,181,71,0.45)] bg-[rgba(255,181,71,0.1)] text-neon-warning',
  UNKNOWN: 'border-white/12 bg-white/5 text-text-subtle',
};

const STATE_LABEL: Record<string, string> = {
  AURA_READY: 'Available to AURA',
  CONNECTED: 'Connected',
  VERIFIED: 'Verified',
  INSTALLED: 'Installed',
  INSTALLABLE: 'Not installed',
  CATALOGUE: 'Known to AURA',
  DISCOVERED: 'Discovered',
  UNTRUSTED: 'Not verified',
  UNSUPPORTED: 'Unsupported here',
  UNKNOWN: 'Unknown',
};

const SOURCE_LABEL: Record<string, string> = {
  inventory: 'this machine',
  catalog: 'AURA catalogue',
  npm: 'npm',
  pypi: 'PyPI',
  cache: 'cached',
};

/** Evidence lines, each shown only when the backend actually proved it. */
function evidence(r: SoftwareResult): { ok: boolean; text: string }[] {
  const lines: { ok: boolean; text: string }[] = [];
  if (r.catalogId) lines.push({ ok: true, text: 'Known to AURA' });
  if (r.sources.some((s) => s === 'npm' || s === 'pypi')) {
    lines.push({ ok: true, text: `Found on ${r.sources.filter((s) => s === 'npm' || s === 'pypi').map((s) => SOURCE_LABEL[s]).join(', ')}` });
  }
  if (r.installed) lines.push({ ok: true, text: 'Installed on this machine' });
  if (r.verified) lines.push({ ok: true, text: 'Executable verified' });
  if (r.connected) lines.push({ ok: true, text: 'Connected to AURA' });
  if (r.installable) lines.push({ ok: true, text: 'Trusted installation available' });
  else if (!r.installed) lines.push({ ok: false, text: 'No verified installation path' });
  return lines;
}

function ResultCard({
  result,
  busy,
  onInstall,
  onAddToWorkspace,
  inWorkspace,
  hasFreeSlot,
  replacing,
}: {
  result: SoftwareResult;
  busy: boolean;
  onInstall: (catalogId: string) => void;
  onAddToWorkspace?: (catalogId: string) => void;
  inWorkspace: boolean;
  hasFreeSlot: boolean;
  replacing: ReplaceContext | null;
}) {
  const [open, setOpen] = useState(false);
  const tone = STATE_TONE[result.state] ?? STATE_TONE.UNKNOWN;

  return (
    <li
      data-testid="software-result"
      data-canonical-id={result.canonicalId}
      data-state={result.state}
      data-installable={result.installable}
      className="rounded-xl border border-[rgba(125,146,255,0.22)] bg-[rgba(13,19,38,0.6)] px-4 py-3"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[rgba(125,146,255,0.28)] bg-[rgba(10,16,34,0.9)] text-[13px] font-semibold text-[#8fb0ff]">
          {result.displayName.slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate text-[14px] font-semibold text-text">
              {result.displayName}
            </span>
            <span className="text-[11px] text-text-subtle">{result.kind.replace('-', ' ')}</span>
            {result.latestVersion && (
              <span className="text-[11px] text-text-subtle">v{result.latestVersion}</span>
            )}
          </span>
          {result.summary && (
            <p className="mt-0.5 line-clamp-2 text-[12px] text-text-muted">{result.summary}</p>
          )}
        </span>
        <span
          className={cn(
            'shrink-0 rounded-full border px-2.5 py-1 text-[10.5px] font-semibold',
            tone,
          )}
        >
          {STATE_LABEL[result.state] ?? result.state}
        </span>
      </div>

      <ul className="mt-2 space-y-0.5">
        {evidence(result).map((e) => (
          <li key={e.text} className="flex items-baseline gap-1.5 text-[11.5px]">
            <span className={e.ok ? 'text-neon-success' : 'text-neon-warning'}>
              {e.ok ? '✓' : '⚠'}
            </span>
            <span className="text-text-muted">{e.text}</span>
          </li>
        ))}
      </ul>

      {!result.installable && !result.installed && result.reason && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-text-subtle">{result.reason}</p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {/* The install control exists ONLY on the backend's word. There is
            deliberately no fallback branch that renders it optimistically. */}
        {result.installable && result.catalogId && (
          <button
            type="button"
            onClick={() => onInstall(result.catalogId!)}
            disabled={busy}
            data-testid="software-install"
            className="neon-focus rounded-lg border border-[rgba(122,92,255,0.5)] bg-[rgba(122,92,255,0.14)] px-3 py-1.5 text-[12px] font-semibold text-[#c9bcff] transition-colors hover:bg-[rgba(122,92,255,0.22)] disabled:opacity-50"
          >
            {busy ? 'Installing…' : 'Install'}
          </button>
        )}
        {/* Layout only — no install, no connect, no scan. Replacing needs
            no free slot: it swaps the one it was opened from. */}
        {onAddToWorkspace && result.catalogId && (
          <button
            type="button"
            onClick={() => onAddToWorkspace(result.catalogId!)}
            disabled={inWorkspace || (!hasFreeSlot && !replacing)}
            data-testid="software-add-to-workspace"
            data-catalog-id={result.catalogId}
            data-replacing-slot={replacing ? replacing.index : undefined}
            title={
              inWorkspace
                ? 'Already one of this workspace\u2019s tools.'
                : replacing
                  ? `Put this tool in slot ${replacing.index + 1}, in place of ${replacing.name}. Nothing is installed or uninstalled.`
                  : hasFreeSlot
                    ? 'Put this tool in a workspace slot. Nothing is installed.'
                    : 'All three tool slots are taken. Replace one from the graph instead.'
            }
            className="neon-focus rounded-lg border border-[rgba(32,211,255,0.4)] bg-[rgba(32,211,255,0.1)] px-3 py-1.5 text-[12px] font-semibold text-neon-cyan transition-colors hover:bg-[rgba(32,211,255,0.18)] disabled:opacity-45"
          >
            {inWorkspace
              ? 'In workspace'
              : replacing
                ? `Use in slot ${replacing.index + 1}`
                : hasFreeSlot
                  ? 'Add to workspace'
                  : 'Slots full'}
          </button>
        )}
        {(result.homepage || result.provenance[0]?.url) && (
          <a
            href={result.homepage || result.provenance[0]?.url}
            target="_blank"
            rel="noreferrer noopener"
            data-testid="software-view-source"
            className="neon-focus inline-flex items-center gap-1.5 rounded-lg border border-[rgba(125,146,255,0.3)] px-3 py-1.5 text-[12px] text-text-muted transition-colors hover:text-text"
          >
            <Icon name="link" size={13} />
            View source
          </a>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="neon-focus ml-auto text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle transition-colors hover:text-text"
        >
          {open ? 'Hide details' : 'Details'}
        </button>
      </div>

      {open && (
        <dl className="mt-2 space-y-1 border-t border-[rgba(125,146,255,0.18)] pt-2 text-[11px]">
          <Row label="Identity" value={result.canonicalId} />
          {result.aliases.length > 0 && <Row label="Also called" value={result.aliases.join(', ')} />}
          {result.executables.length > 0 && (
            <Row label="Commands" value={result.executables.join(', ')} />
          )}
          <Row
            label="Sources"
            value={result.sources.map((s) => SOURCE_LABEL[s] ?? s).join(' · ')}
          />
          {result.catalogId && <Row label="Catalogue id" value={result.catalogId} />}
          {result.installedVersion && <Row label="Installed" value={`v${result.installedVersion}`} />}
        </dl>
      )}
    </li>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-[86px] shrink-0 text-text-subtle">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-text-muted">{value}</dd>
    </div>
  );
}

export function AuraEverything({
  onInstall,
  installing,
  onAddToWorkspace,
  inWorkspace = [],
  hasFreeSlot = false,
  replacing = null,
}: {
  /** Routes to the EXISTING governed install path, by catalogue id. */
  onInstall: (catalogId: string) => void;
  installing: string[];
  /** Places a catalogue id in a workspace tool slot. Layout only. */
  onAddToWorkspace?: (catalogId: string) => void;
  /** Catalogue ids already holding a slot. */
  inWorkspace?: string[];
  /** False once all three slots are taken. */
  hasFreeSlot?: boolean;
  /** Set when the surface was opened from a slot's Replace control. */
  replacing?: ReplaceContext | null;
}) {
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState<SoftwareSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const run = useCallback(async (text: string) => {
    const term = text.trim();
    if (!term) {
      setResponse(null);
      setError(null);
      return;
    }
    const ticket = ++latest.current;
    setSearching(true);
    setError(null);
    const outcome = await environmentClient.search(term);
    if (ticket !== latest.current) return;   // a newer search superseded this
    setSearching(false);
    if (!outcome.ok) {
      setError(outcome.reason);
      setResponse(null);
      return;
    }
    setResponse(outcome.response);
  }, []);

  // Debounced so typing does not fire a search per keystroke.
  useEffect(() => {
    const id = setTimeout(() => void run(query), 350);
    return () => clearTimeout(id);
  }, [query, run]);

  const results = response?.results ?? [];

  return (
    <section aria-label="AURA Everything" data-testid="aura-everything" className="flex min-h-0 flex-col gap-3">
      <div>
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-text">AURA Everything</h2>
        <p className="text-[11.5px] text-text-muted">
          Search software AURA knows, this machine has, or trusted sources publish.
        </p>
      </div>

      {/* Opened to replace: say which slot, so the next click is not a
          guess. Nothing else about the surface changes. */}
      {replacing && (
        <p
          data-testid="everything-replacing"
          data-replacing-slot={replacing.index}
          className="rounded-lg border border-[rgba(32,211,255,0.35)] bg-[rgba(32,211,255,0.08)] px-3 py-2 text-[11.5px] text-neon-cyan"
        >
          Replacing {replacing.name} in slot {replacing.index + 1}. Choosing a tool swaps that
          slot only.
        </p>
      )}

      {/* At capacity, say so once at the top rather than letting the user
          find out one disabled button at a time. Searching and installing
          still work — it is only the workspace slots that are full. */}
      {onAddToWorkspace && !hasFreeSlot && !replacing && (
        <p
          data-testid="everything-slots-full"
          className="rounded-lg border border-[rgba(255,181,71,0.4)] bg-[rgba(255,181,71,0.09)] px-3 py-2 text-[11.5px] text-neon-warning"
        >
          All 3 workspace tool slots are occupied. Replace one from the graph to change it.
        </p>
      )}

      <label className="flex items-center gap-2 rounded-xl border border-[rgba(125,146,255,0.32)] bg-[rgba(13,19,38,0.85)] px-3 py-2.5 focus-within:border-[rgba(125,146,255,0.6)]">
        <Icon name="search" size={15} className="shrink-0 text-text-subtle" />
        <span className="sr-only">Search software</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="everything-search"
          placeholder="Search tools, runtimes, agents, applications…"
          className="neon-focus min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-subtle"
        />
        {searching && <span className="shrink-0 text-[11px] text-neon-cyan">Searching…</span>}
      </label>

      {/* The trail, from the layers the backend actually consulted. */}
      {response && response.consulted.length > 0 && (
        <p className="text-[11px] text-text-subtle" data-testid="everything-trail">
          Searched {response.consulted.map((c) => SOURCE_LABEL[c] ?? c).join(' → ')}
          {response.stale && ' · showing cached information'}
          {response.offline && ' · trusted sources unreachable'}
        </p>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-[rgba(255,93,122,0.45)] bg-[rgba(255,93,122,0.1)] px-3 py-2 text-[12px] text-neon-danger">
          {error}
        </p>
      )}

      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto" data-testid="everything-results">
        {results.map((r) => (
          <ResultCard
            key={r.canonicalId}
            result={r}
            busy={r.catalogId ? installing.includes(r.catalogId) : false}
            onInstall={onInstall}
            onAddToWorkspace={onAddToWorkspace}
            inWorkspace={r.catalogId ? inWorkspace.includes(r.catalogId) : false}
            hasFreeSlot={hasFreeSlot}
            replacing={replacing}
          />
        ))}
      </ul>

      {!searching && query.trim() && results.length === 0 && (
        <p className="py-6 text-center text-[12px] text-text-muted" data-testid="everything-empty">
          {response?.detail || 'AURA could not verify this software.'}
        </p>
      )}

      {!query.trim() && (
        <p className="py-6 text-center text-[12px] text-text-subtle">
          Type the name of a tool you found anywhere — AURA resolves it against
          this machine, its own catalogue, and trusted software sources.
        </p>
      )}
    </section>
  );
}
