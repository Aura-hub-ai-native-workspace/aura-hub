import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { spring, cn } from '@aura/core';
import { Icon, Tooltip, type IconName } from '@aura/ui';
import { PANEL_META, type PanelKind } from './layoutStore';
import type { ToolCategory } from './toolCategories';

/**
 * ToolCategoryGroup — one collapsible section of the Tools shelf.
 * ------------------------------------------------------------------
 * Presentational only: reads PANEL_META for label/icon/hint, calls
 * `onLaunch(kind)` on click. Categories with an empty `kinds` array
 * (Git, Automation today) render as a static, muted "Coming soon" row
 * rather than being hidden — an empty category is an honest signal
 * that the capability doesn't exist yet, not something to bury.
 */
export function ToolCategoryGroup({
  category,
  railExpanded,
  onLaunch,
}: {
  category: ToolCategory;
  /** Whether the parent rail is showing labels (true) or icons only (false). */
  railExpanded: boolean;
  onLaunch: (kind: PanelKind) => void;
}) {
  const [open, setOpen] = useState(true);
  const isEmpty = category.kinds.length === 0;

  if (isEmpty) {
    if (!railExpanded) return null; // nothing meaningful to show icon-only
    return (
      <div className="px-1 py-2">
        <div className="flex items-center justify-between px-2 text-[10.5px] font-semibold uppercase tracking-wider text-text-subtle">
          <span>{category.label}</span>
          <span className="rounded-full bg-surface-active px-1.5 py-0.5 text-[9.5px] font-medium normal-case tracking-normal text-text-subtle">
            Coming soon
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-1 py-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-text-subtle transition-colors hover:bg-surface-hover hover:text-text',
          !railExpanded && 'justify-center px-0',
        )}
      >
        {railExpanded && <span className="flex-1 text-left">{category.label}</span>}
        {railExpanded && (
          <motion.span animate={{ rotate: open ? 0 : -90 }} transition={spring.snappy} className="text-text-subtle">
            <Icon name="chevron-down" size={11} />
          </motion.span>
        )}
        {!railExpanded && <Icon name="chevron-down" size={11} />}
      </button>

      <AnimatePresence initial={false}>
        {(open || !railExpanded) && (
          <motion.div
            initial={railExpanded ? { height: 0, opacity: 0 } : false}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={spring.smooth}
            className="overflow-hidden"
          >
            <div className="space-y-0.5 pb-1">
              {category.kinds.map((kind) => (
                <ToolButton key={kind} kind={kind} expanded={railExpanded} onLaunch={onLaunch} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ToolButton({
  kind,
  expanded,
  onLaunch,
}: {
  kind: PanelKind;
  expanded: boolean;
  onLaunch: (kind: PanelKind) => void;
}) {
  const meta = PANEL_META[kind];
  const body = (
    <motion.button
      onClick={() => onLaunch(kind)}
      whileTap={{ scale: 0.97 }}
      transition={spring.snappy}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg py-1.5 text-[12px] text-text-muted outline-none transition-colors hover:bg-surface-hover hover:text-text',
        expanded ? 'px-2' : 'justify-center px-0',
      )}
    >
      <Icon name={meta.icon as IconName} size={15} />
      {expanded && (
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate font-medium">{meta.label}</span>
          <span className="block truncate text-[10.5px] text-text-subtle">{meta.hint}</span>
        </span>
      )}
    </motion.button>
  );
  return expanded ? body : <Tooltip content={meta.label} side="right">{body}</Tooltip>;
}
