/**
 * UniversalSearch — the workspace search surface.
 * ------------------------------------------------------------------
 * One input that searches across every public surface of the
 * environment (files, symbols, knowledge, missions, diagnoses,
 * documentation, architecture, memory), grouped by scope. Every result
 * runs a real navigation action — it never mutates data. The palette
 * opens this panel pre-scoped via ops/layoutStore.setSearchScope.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon, Input } from '@aura/ui';
import type { IconName } from '@aura/ui';
import { useLayoutStore, type SearchScope } from './layoutStore';
import { runSearch, SEARCH_SCOPE_META, type SearchSection } from './searchService';

const SCOPES: SearchScope[] = ['all', 'files', 'symbols', 'knowledge', 'missions', 'diagnoses', 'documentation', 'architecture', 'memory'];

export function UniversalSearch() {
  const storeScope = useLayoutStore((s) => s.searchScope);
  const searchOpen = useLayoutStore((s) => s.searchOpen);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<SearchScope>('all');
  const [sections, setSections] = useState<SearchSection[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounce = useRef<number | null>(null);

  // Palette-scoped searches arrive via the store; mirror them here.
  useEffect(() => {
    if (storeScope && searchOpen) {
      setScope(storeScope);
      setSearched(false);
    }
  }, [storeScope, searchOpen]);

  useEffect(() => {
    if (debounce.current) window.clearTimeout(debounce.current);
    const query = q.trim();
    if (!query) {
      setSections([]);
      setLoading(false);
      setSearched(false);
      return;
    }
    setLoading(true);
    debounce.current = window.setTimeout(async () => {
      try {
        const res = await runSearch(query, scope);
        setSections(res);
        setSearched(true);
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => {
      if (debounce.current) window.clearTimeout(debounce.current);
    };
  }, [q, scope]);

  const total = sections.reduce((acc, s) => acc + s.hits.length, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-3 pb-0">
        <Input
          icon="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search files, symbols, missions, knowledge…"
          inputSize="sm"
          autoFocus
          suffix={loading ? <span className="h-3 w-3 animate-spin rounded-full border border-accent border-t-transparent" /> : undefined}
        />
        <div className="mt-2 flex flex-wrap gap-1">
          {SCOPES.map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-colors ${
                scope === s ? 'bg-accent text-white' : 'bg-surface-active text-text-muted hover:bg-surface-hover hover:text-text'
              }`}
            >
              <Icon name={SEARCH_SCOPE_META[s].icon as IconName} size={11} />
              {SEARCH_SCOPE_META[s].label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!searched && !loading && (
          <p className="px-2 py-8 text-center text-[12px] text-text-subtle">
            Type to search across the whole operating environment.
          </p>
        )}
        {searched && total === 0 && (
          <p className="px-2 py-8 text-center text-[12px] text-text-subtle">
            No results for “{q.trim()}”.
          </p>
        )}
        {searched &&
          sections.map((s) => (
            <div key={s.scope} className="mb-3">
              <div className="mb-1 flex items-center gap-1.5 px-2 text-[10.5px] font-semibold uppercase tracking-wider text-text-subtle">
                <Icon name={SEARCH_SCOPE_META[s.scope].icon as IconName} size={12} />
                {s.label}
                <span className="text-[9.5px] font-normal text-text-subtle">· {s.hits.length}</span>
              </div>
              <div className="space-y-0.5">
                {s.hits.map((h) => (
                  <button
                    key={h.id}
                    onClick={h.action}
                    className="flex w-full items-start gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
                  >
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-active text-text-muted">
                      <Icon name={h.icon} size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-text">{h.title}</span>
                      <span className="block truncate text-[10.5px] text-text-subtle">{h.subtitle}</span>
                    </span>
                    <Icon name="arrow-right" size={13} className="mt-1.5 shrink-0 text-text-subtle" />
                  </button>
                ))}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
