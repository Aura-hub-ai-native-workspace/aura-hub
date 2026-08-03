import { useState } from 'react';
import { motion } from 'framer-motion';
import { spring, cn } from '@aura/core';
import { Icon, IconButton } from '@aura/ui';
import type { PanelKind } from './layoutStore';
import { TOOL_CATEGORIES } from './toolCategories';
import { ToolCategoryGroup } from './ToolCategoryGroup';

const EXPANDED = 232;
const RAIL = 56;

/**
 * ToolsRail — the persistent Tools shelf for the Workspace.
 * ------------------------------------------------------------------
 * A second, Workspace-scoped rail (distinct from the app's primary
 * LeftNav) that launches panels as "windows" rather than navigating.
 * Purely presentational: takes `onLaunch` and knows nothing about
 * `useLayoutStore` — the caller decides what a launch actually does
 * (Phase 3 wires this to `openPanel`). Collapse state is local to this
 * component; not yet persisted.
 */
export function ToolsRail({ onLaunch }: { onLaunch: (kind: PanelKind) => void }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <motion.nav
      animate={{ width: expanded ? EXPANDED : RAIL }}
      transition={spring.fluid}
      className="relative z-10 flex shrink-0 flex-col border-r border-line bg-surface/60 backdrop-blur-xl"
    >
      <div className={cn('flex h-10 shrink-0 items-center gap-2 border-b border-line px-2.5', !expanded && 'justify-center px-0')}>
        {expanded && <span className="flex-1 text-[11.5px] font-semibold uppercase tracking-wider text-text-subtle">Tools</span>}
        {!expanded && <Icon name="grid" size={15} className="text-text-subtle" />}
      </div>

      <div className="flex-1 space-y-0.5 overflow-y-auto py-1">
        {TOOL_CATEGORIES.map((category) => (
          <ToolCategoryGroup key={category.id} category={category} railExpanded={expanded} onLaunch={onLaunch} />
        ))}
      </div>

      <div className={cn('flex border-t border-line px-2 py-2', expanded ? 'justify-end' : 'justify-center')}>
        <IconButton
          icon={expanded ? 'sidebar' : 'panel'}
          label={expanded ? 'Collapse tools' : 'Expand tools'}
          size="sm"
          onClick={() => setExpanded((v) => !v)}
        />
      </div>
    </motion.nav>
  );
}
