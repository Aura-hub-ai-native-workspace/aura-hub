import { AnimatePresence, motion } from 'framer-motion';
import { NAV_ITEMS, spring, useAppStore, cn } from '@aura/core';
import { Icon, IconButton, Tooltip } from '@aura/ui';
import { AuraTile } from '../brand/AuraLogo';
import { useWorkspace } from '../data/useWorkspace';

const EXPANDED = 244;
const RAIL = 76;

/**
 * Permanent left navigation. Collapses to an icon rail or expands to
 * show labels — a spring-driven width animation, never a jump.
 */
export function LeftNav() {
  const expanded = useAppStore((s) => s.sidebarExpanded);
  const nav = useAppStore((s) => s.nav);
  const setNav = useAppStore((s) => s.setNav);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);

  const primary = NAV_ITEMS.filter((i) => i.group === 'primary');
  const system = NAV_ITEMS.filter((i) => i.group === 'system');
  // Real badge: number of projects in the library, shown on Projects.
  const projectCount = useWorkspace((s) => s.projects.length);

  return (
    <motion.nav
      animate={{ width: expanded ? EXPANDED : RAIL }}
      transition={spring.fluid}
      className="relative z-10 flex shrink-0 flex-col border-r border-line bg-surface/60 backdrop-blur-xl"
    >
      {/* Brand */}
      <div className={cn('flex h-16 items-center gap-3 px-5', !expanded && 'justify-center px-0')}>
        <AuraTile size={34} />
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -6 }}
              transition={spring.snappy}
              className="min-w-0"
            >
              <div className="text-[14px] font-semibold leading-tight text-text">AURA Hub</div>
              <div className="text-[10.5px] uppercase tracking-widest text-text-subtle">Environment</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Primary destinations */}
      <div className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {primary.map((item) => (
          <NavButton
            key={item.key}
            icon={item.icon}
            label={item.label}
            expanded={expanded}
            active={nav === item.key}
            badge={item.key === 'projects' ? projectCount : undefined}
            onClick={() => setNav(item.key)}
          />
        ))}
      </div>

      {/* System + collapse control */}
      <div className="space-y-1 border-t border-line px-3 py-3">
        {system.map((item) => (
          <NavButton
            key={item.key}
            icon={item.icon}
            label={item.label}
            expanded={expanded}
            active={nav === item.key}
            onClick={() => setNav(item.key)}
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

function NavButton({
  icon,
  label,
  expanded,
  active,
  badge,
  onClick,
}: {
  icon: string;
  label: string;
  expanded: boolean;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  const body = (
    <motion.button
      onClick={onClick}
      whileTap={{ scale: 0.97 }}
      transition={spring.snappy}
      className={cn(
        'relative flex w-full items-center gap-3 rounded-xl py-2.5 text-[13px] font-medium outline-none transition-colors',
        expanded ? 'px-3' : 'justify-center px-0',
        active ? 'text-accent-700 dark:text-accent-200' : 'text-text-muted hover:text-text hover:bg-surface-hover',
      )}
    >
      {active && (
        <motion.span
          layoutId="nav-active"
          transition={spring.smooth}
          className="absolute inset-0 rounded-xl bg-accent-50 dark:bg-accent/15"
        />
      )}
      <span className="relative z-10">
        <Icon name={icon as never} size={19} />
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
      {badge !== undefined && badge > 0 && (
        <span
          className={cn(
            'relative z-10 grid h-5 min-w-[20px] place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white',
            !expanded && 'absolute -right-0.5 -top-0.5 h-4 min-w-[16px]',
          )}
        >
          {badge}
        </span>
      )}
    </motion.button>
  );

  return expanded ? body : <Tooltip content={label} side="right">{body}</Tooltip>;
}
