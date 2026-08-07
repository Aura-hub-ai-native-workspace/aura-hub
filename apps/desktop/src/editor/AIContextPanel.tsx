import { useMemo } from 'react';
import { Badge, Icon, PanelSection, PropertyRow } from '@aura/ui';
import { useEditorStore } from './editorStore';
import { labelForLanguage } from './fileIcons';
import { contextForSelection } from './aiContext';
import { useProjectData } from '../screens/project/sections/shared';

/**
 * Right Sidebar — AI Context Panel. NOT a chatbot: a live, read-only
 * summary of exactly what an AI action would see right now (project,
 * file, language, cursor, selection, and — real, not placeholder —
 * dependencies/references/architecture from the knowledge graph). Every
 * AI code action (see actionSpecs.ts/useAiAction.ts) reads this exact
 * same context — this panel is that context made visible.
 */

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fileLabel(path: string): string {
  return path.split('/').pop() ?? path;
}

export function AIContextPanel({ projectName, projectId }: { projectName: string; projectId: string }) {
  const activePath = useEditorStore((s) => s.activePath);
  const file = useEditorStore((s) => (activePath ? s.openFiles[activePath] : undefined));
  const openFile = useEditorStore((s) => s.openFile);
  const { graph, kg } = useProjectData(projectId);

  // Recomputed only when the graph, the open file, or the cursor's line
  // actually changes — not on every keystroke — so this stays responsive
  // even on large projects.
  const ctx = useMemo(
    () => (activePath && file ? contextForSelection(graph, activePath, file.cursor.line) : null),
    [graph, activePath, file?.cursor.line],
  );

  const symbolLayer = useMemo(() => {
    if (!ctx?.symbol || !graph) return null;
    return graph.entities.find((e) => e.id === ctx.symbol!.id)?.layer ?? null;
  }, [ctx, graph]);

  const relatedFiles = useMemo(() => {
    if (!ctx || !activePath) return [];
    const set = new Set<string>();
    for (const r of [...ctx.dependencies, ...ctx.dependents]) if (r.relPath !== activePath) set.add(r.relPath);
    return [...set];
  }, [ctx, activePath]);

  return (
    <div className="flex h-full flex-col divide-y divide-line overflow-y-auto">
      <PanelSection title="Project" icon="folder">
        <PropertyRow label="Name" value={projectName} />
      </PanelSection>

      <PanelSection title="Current File" icon="file">
        {file ? (
          <div className="space-y-0.5">
            <PropertyRow label="File" value={file.name} />
            <PropertyRow label="Language" value={labelForLanguage(file.language)} />
            <PropertyRow label="Size" value={formatBytes(new Blob([file.content]).size)} />
            <PropertyRow label="Cursor" value={`Ln ${file.cursor.line}, Col ${file.cursor.column}`} />
            <PropertyRow
              label="Selection"
              value={file.selection ? `${file.selection.endLine - file.selection.startLine + 1} lines` : '—'}
            />
            <PropertyRow label="Status" value={file.dirty ? <Badge tone="attention" dot>Unsaved</Badge> : <Badge tone="positive" dot>Saved</Badge>} />
          </div>
        ) : (
          <p className="text-[12px] text-text-subtle">No file open.</p>
        )}
      </PanelSection>

      {file && (
        <>
          <PanelSection title="Current Symbol" icon="code">
            {ctx?.symbol ? (
              <div className="space-y-0.5">
                <PropertyRow label="Nearest symbol" value={ctx.symbol.name} />
                <PropertyRow label="Kind" value={ctx.symbol.kind} />
                <PropertyRow label="Line" value={String(ctx.symbol.line)} />
                {symbolLayer && <PropertyRow label="Architecture layer" value={symbolLayer} />}
              </div>
            ) : (
              <p className="text-[12px] text-text-subtle">
                No enclosing symbol resolved at the cursor — this is a nearest-line heuristic, not AST scoping.
              </p>
            )}
          </PanelSection>

          <PanelSection title="Dependencies" icon="link">
            {ctx && ctx.dependencies.length > 0 ? (
              <div className="space-y-1">
                {ctx.dependencies.slice(0, 8).map((d) => (
                  <button
                    key={d.id}
                    onClick={() => void openFile({ path: d.relPath, name: fileLabel(d.relPath) })}
                    className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-surface-hover"
                  >
                    <Icon name="arrow-right" size={12} className="shrink-0 text-text-subtle" />
                    <span className="truncate text-[12px] text-text">{d.name}</span>
                    <span className="ml-auto shrink-0 text-[10.5px] text-text-subtle">{d.kind}</span>
                  </button>
                ))}
                {ctx.dependencies.length > 8 && <p className="px-1 text-[11px] text-text-subtle">+{ctx.dependencies.length - 8} more</p>}
              </div>
            ) : (
              <p className="text-[12px] text-text-subtle">No dependencies detected.</p>
            )}
          </PanelSection>

          <PanelSection title="Referenced By" icon="search">
            {ctx && ctx.dependents.length > 0 ? (
              <div className="space-y-1">
                <p className="px-1 text-[11px] text-text-subtle">
                  {ctx.referenceCount} reference{ctx.referenceCount === 1 ? '' : 's'} across {ctx.dependentFileCount} file
                  {ctx.dependentFileCount === 1 ? '' : 's'}
                </p>
                {ctx.dependents.slice(0, 8).map((d) => (
                  <button
                    key={d.id}
                    onClick={() => void openFile({ path: d.relPath, name: fileLabel(d.relPath) })}
                    className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-surface-hover"
                  >
                    <Icon name="arrow-right" size={12} className="shrink-0 rotate-180 text-text-subtle" />
                    <span className="truncate text-[12px] text-text">{d.name}</span>
                    <span className="ml-auto shrink-0 text-[10.5px] text-text-subtle">{d.kind}</span>
                  </button>
                ))}
                {ctx.dependents.length > 8 && <p className="px-1 text-[11px] text-text-subtle">+{ctx.dependents.length - 8} more</p>}
              </div>
            ) : (
              <p className="text-[12px] text-text-subtle">Not referenced elsewhere.</p>
            )}
          </PanelSection>

          <PanelSection title="Related Files" icon="doc">
            {relatedFiles.length > 0 ? (
              <div className="space-y-0.5">
                {relatedFiles.slice(0, 8).map((path) => (
                  <button
                    key={path}
                    onClick={() => void openFile({ path, name: fileLabel(path) })}
                    className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left transition-colors hover:bg-surface-hover"
                  >
                    <Icon name="file" size={13} className="shrink-0 text-text-subtle" />
                    <span className="truncate text-[12px] text-text">{path}</span>
                  </button>
                ))}
                {relatedFiles.length > 8 && <p className="px-1 text-[11px] text-text-subtle">+{relatedFiles.length - 8} more</p>}
              </div>
            ) : (
              <p className="text-[12px] text-text-subtle">No related files detected.</p>
            )}
          </PanelSection>
        </>
      )}

      <PanelSection title="Source Control" icon="git-branch">
        <PropertyRow label="Branch" value={<Badge tone="neutral">Not connected</Badge>} />
      </PanelSection>

      <PanelSection title="Knowledge Graph" icon="knowledge">
        <div className="space-y-0.5">
          <PropertyRow label="Entities" value={String(graph?.entities.length ?? 0)} />
          <PropertyRow label="Relations" value={String(graph?.relations.length ?? 0)} />
          {kg && Object.entries(kg.counts).slice(0, 4).map(([k, v]) => (
            <PropertyRow key={k} label={k} value={String(v)} />
          ))}
        </div>
      </PanelSection>
    </div>
  );
}
