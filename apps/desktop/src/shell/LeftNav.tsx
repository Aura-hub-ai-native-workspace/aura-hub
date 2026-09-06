import { AnimatePresence, motion } from 'framer-motion';
import { NAV_ITEMS, spring, useAppStore, cn } from '@aura/core';
import { Icon, IconButton, Tooltip } from '@aura/ui';
import { AuraTile } from '../brand/AuraLogo';

const EXPANDED = 260;
const RAIL = 52;

/**
 * Left navigation sidebar with expandable rail design.
 * Displays primary and system navigation items with smooth width animations.
 */
export function LeftNav() {
  const expanded = useAppStore((s) => s.sidebarExpanded);
  const nav = useAppStore((s) => s.nav);
  const setNav = useAppStore((s) => s.setNav);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);

  const primary = NAV_ITEMS.filter((i) => i.group === 'primary');
  const system = NAV_ITEMS.filter((i) => i.group === 'system');

  return (
    <motion.nav
      animate={{ width: expanded ? EXPANDED : RAIL }}
      transition={spring.fluid}
      className="relative z-10 flex shrink-0 flex-col border-r border-border bg-sidebar expanded-shadow"
    >
      {/* Brand */}
      <div className={cn('flex h-14 items-center gap-3 px-4', !expanded && 'justify-center px-0')}>
        <AuraTile size={36} />
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={spring.snappy}
              className="min-w-0"
            >
              <div className="text-[13px] font-semibold leading-tight text-sidebarTitle">AURA Hub</div>
              <div className="text-xs uppercase tracking-widest text-sidebarSubtitle">One Prompt. Multiple Minds.</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Primary destinations */}
      <div className="flex flex-1 flex-col space-y-1 overflow-y-auto px-3 py-2">
        {primary.map((item) => (
          <NavItem
            key={item.key}
            icon={item.icon}
            label={item.label}
            expanded={expanded}
            active={nav === item.key}
            onClick={() => setNav(item.key)}
            item={item}
          />
        ))}
      </div>

      {/* System + collapse control */}
      <div className="flex flex-col space-y-1 border-t border-border px-3 py-3">
        {system.map((item) => (
          <NavItem
            key={item.key}
            icon={item.icon}
            label={item.label}
            expanded={expanded}
            active={nav === item.key}
            onClick={() => setNav(item.key)}
            item={item}
          />
        ))}
        <div className={cn('flex pt-1', expanded ? 'justify-end' : 'justify-center')}>
          <IconButton
            icon={expanded ? 'sidebar' : 'panel'}
            label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
            size="sm"
            onClick={toggleSidebar}
          />
        </div>
      </div>
    </motion.nav>
  );
}

/**
 * Individual navigation item with icon and optional label.
 * Shows tooltip in collapsed state, full label when expanded.
 * @param icon Icon name to display
 * @param label Item label text
 * @param expanded Whether sidebar is expanded
 * @param active Whether this item is currently active
 * @param onClick Click handler for navigation
 * @param item Full navigation item details
 */
function NavItem({
  icon,
  label,
  expanded,
  active,
  onClick,
  item,
}: {
  icon: string;
  label: string;
  expanded: boolean;
  active: boolean;
  onClick: () => void;
  item: { key: string; label: string; icon: string; group: string };
}) {
  const isSystem = item.group === 'system';

  const body = (
    <motion.button
      onClick={onClick}
      whileTap={{ scale: 0.95 }}
      transition={spring.snappy}
      // Collapsed, this button is an icon with no text, and the Tooltip is
      // a visual affordance a screen reader never sees. The label is always
      // present so the rail is navigable in either state.
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex w-full items-center gap-2.5 rounded-lg py-2 text-[12px] font-medium outline-none transition-colors',
        expanded ? 'px-3' : 'justify-center px-0',
        active
          ? 'sidebar-active bg-sidebar-active text-sidebarActive'
          : isSystem
            ? 'text-sidebarInactive hover:text-sidebarHover hover:bg-sidebarHover'
            : 'text-sidebarInactive hover:text-sidebarHover hover:bg-sidebarHover',
      )}
    >
      {active && (
        <motion.span
          layoutId="nav-active"
          transition={spring.smooth}
          className="absolute left-0 inset-y-0 rounded-lg bg-sidebar-active-subtle"
        />
      )}
      <span className="relative z-10">
        <Icon name={icon as never} size={18} />
      </span>
      <AnimatePresence>
        {expanded && (
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="relative z-10 flex-1 text-left"
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );

  return expanded ? (
    <div className="relative group-hover:bg-sidebarHover/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-0">{body}</div>
  ) : (
    <Tooltip content={label} side="right" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2">{body}</Tooltip>
  );
}