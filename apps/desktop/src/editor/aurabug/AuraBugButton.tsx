/**
 * AuraBugButton — the toolbar entry point for AuraBug.
 * ------------------------------------------------------------------
 * Rendered in the Code Workspace toolbar. The controller hook lives
 * here so scans run for the active file whenever a file opens or saves,
 * regardless of whether the results panel is open; the heavier
 * AI-augmented scan runs only while the panel is open.
 */
import { useState } from 'react';
import { IconButton } from '@aura/ui';
import { useEditorStore } from '../editorStore';
import { useProjectData } from '../../screens/project/sections/shared';
import { AuraBugPanel } from './AuraBugPanel';
import { useAuraBug } from './useAuraBug';

export function AuraBugButton({ projectId }: { projectId: string }) {
  const activePath = useEditorStore((s) => s.activePath);
  const [open, setOpen] = useState(false);
  const { graph } = useProjectData(projectId);
  const aura = useAuraBug(projectId, graph, open);

  return (
    <>
      <IconButton
        icon="bug"
        label="AuraBug — scan the open file for bugs"
        size="sm"
        active={open}
        disabled={!activePath}
        onClick={() => setOpen((o) => !o)}
        className="mr-1 shrink-0"
      />
      <AuraBugPanel open={open} onClose={() => setOpen(false)} aura={aura} />
    </>
  );
}
