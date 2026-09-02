/**
 * AURA Icons — a bespoke, geometric line set.
 * ------------------------------------------------------------------
 * Deliberately NOT Material / Fluent / SF Symbols. Every glyph is
 * drawn on a 24×24 grid with a 1.7 stroke, round caps and round
 * joins — soft, calm, unmistakably AURA. One <Icon> component,
 * one registry, so the whole environment shares a single hand.
 */

import { forwardRef, type SVGProps } from 'react';
import { cn } from '@aura/core';

export type IconName =
  | 'home' | 'projects' | 'knowledge' | 'spark' | 'workflows' | 'marketplace' | 'settings'
  | 'grid' | 'architecture' | 'layout' | 'server' | 'database' | 'research' | 'doc'
  | 'memory' | 'deploy' | 'plus' | 'command' | 'search' | 'bell' | 'check' | 'dot'
  | 'sun' | 'moon' | 'cpu' | 'activity' | 'pin' | 'link' | 'note' | 'arrow-right'
  | 'more' | 'folder' | 'sidebar' | 'panel' | 'chevron-right' | 'chevron-down' | 'close'
  | 'code' | 'terminal' | 'git-branch' | 'bookmark' | 'file' | 'refresh'
  | 'eye' | 'eye-off' | 'clipboard' | 'bug' | 'shield' | 'flask'
  | 'minimize' | 'maximize' | 'restore';

/** Path data (stroke-based, 24×24). Keep every glyph optically balanced. */
const PATHS: Record<IconName, string> = {
  home: 'M4 11.5 12 4.5l8 7M6 10v9h4v-5h4v5h4v-9',
  projects: 'M4 7.5A2.5 2.5 0 0 1 6.5 5H10l2 2.5h5.5A2.5 2.5 0 0 1 20 10v6.5A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5Z',
  knowledge: 'M5 5.5A1.5 1.5 0 0 1 6.5 4H18v16H6.5A1.5 1.5 0 0 1 5 18.5ZM8 4v16M18 16H6.5A1.5 1.5 0 0 0 5 17.5',
  spark: 'M12 4v4M12 16v4M4 12h4M16 12h4M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
  workflows: 'M6 6.5a2 2 0 1 0 0-.01ZM18 6.5a2 2 0 1 0 0-.01ZM12 18.5a2 2 0 1 0 0-.01ZM6 8v3a3 3 0 0 0 3 3h1M18 8v3a3 3 0 0 1-3 3h-1',
  marketplace: 'M4 8h16l-1 3.5a3 3 0 0 1-2.9 2.2H7.9A3 3 0 0 1 5 11.5ZM4 8l1.5-3h13L20 8M9 18.5h.01M15 18.5h.01',
  settings: 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM12 3.5l1.4 2.2 2.6-.4.9 2.5 2.3 1.3-.8 2.5.8 2.5-2.3 1.3-.9 2.5-2.6-.4L12 20.5l-1.4-2.2-2.6.4-.9-2.5-2.3-1.3.8-2.5-.8-2.5 2.3-1.3.9-2.5 2.6.4Z',
  grid: 'M4.5 4.5h6v6h-6ZM13.5 4.5h6v6h-6ZM4.5 13.5h6v6h-6ZM13.5 13.5h6v6h-6Z',
  architecture: 'M9 4.5h6v4H9ZM4 15.5h6v4H4ZM14 15.5h6v4h-6ZM12 8.5v3M12 11.5H7v4M12 11.5h5v4',
  layout: 'M4.5 5.5h15v13h-15ZM4.5 9.5h15M9 9.5v9',
  server: 'M4.5 5.5h15v5h-15ZM4.5 13.5h15v5h-15ZM7.5 8h.01M7.5 16h.01',
  database: 'M12 4.5c3.9 0 7 1.1 7 2.5s-3.1 2.5-7 2.5S5 8.4 5 7s3.1-2.5 7-2.5ZM5 7v10c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V7M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5',
  research: 'M11 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12ZM15.5 15.5 20 20',
  doc: 'M7 4.5h7l4 4v11H7ZM14 4.5V9h4M9.5 12.5h6M9.5 15.5h6',
  memory: 'M8 8h8v8H8ZM10 4v4M14 4v4M10 16v4M14 16v4M4 10h4M4 14h4M16 10h4M16 14h4',
  deploy: 'M12 4.5c3 1.5 4.5 4.5 4.5 7.5 0 2-.8 3.8-2 5H9.5c-1.2-1.2-2-3-2-5 0-3 1.5-6 4.5-7.5ZM12 10.5a1.5 1.5 0 1 0 0 .01M9 19l-1.5 1.5M15 19l1.5 1.5',
  plus: 'M12 5.5v13M5.5 12h13',
  command: 'M9 4.5A2.5 2.5 0 1 1 6.5 7H9Zm0 0h6v6H9Zm6 0A2.5 2.5 0 1 1 17.5 7H15Zm0 15A2.5 2.5 0 1 0 17.5 17H15Zm-6 0A2.5 2.5 0 1 1 6.5 17H9Zm0 0h6v-6H9Z',
  search: 'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM15.5 15.5 20 20',
  bell: 'M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5s1.5-1.5 1.5-5.5ZM10 18.5a2 2 0 0 0 4 0',
  check: 'M5 12.5 10 17.5 19 6.5',
  dot: 'M12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4',
  moon: 'M19 13.5A7 7 0 0 1 10.5 5a5.5 5.5 0 1 0 8.5 8.5Z',
  cpu: 'M7 7h10v10H7ZM10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3M10.5 10.5h3v3h-3Z',
  activity: 'M4 12.5h3.5L10 6l4 12 2.5-5.5H20',
  pin: 'M9 4.5h6l-1 5 2.5 2.5H7.5L10 9.5ZM12 14v5.5',
  link: 'M9.5 14.5 14.5 9.5M8.5 12 6.5 14a3 3 0 0 0 4.2 4.2l2-2M15.5 12l2-2a3 3 0 0 0-4.2-4.2l-2 2',
  note: 'M6 4.5h9l3 3v12H6ZM15 4.5v3h3',
  'arrow-right': 'M5 12h13M12.5 6l6 6-6 6',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  folder: 'M4 7.5A1.5 1.5 0 0 1 5.5 6H9l2 2h7.5A1.5 1.5 0 0 1 20 9.5v7A1.5 1.5 0 0 1 18.5 18h-13A1.5 1.5 0 0 1 4 16.5Z',
  sidebar: 'M4.5 5.5h15v13h-15ZM9.5 5.5v13',
  panel: 'M4.5 5.5h15v13h-15ZM14.5 5.5v13',
  'chevron-right': 'M9.5 6l6 6-6 6',
  'chevron-down': 'M6 9.5l6 6 6-6',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  code: 'M9 8.5 4.5 12 9 15.5M15 8.5l4.5 3.5-4.5 3.5M13.5 5.5l-3 13',
  terminal: 'M4.5 5.5h15v13h-15Z M7 9.5l3 2.5-3 2.5M12 15h5',
  'git-branch': 'M7 4.5v9.5M7 4.5a2 2 0 1 0-.01 0ZM7 20.5a2 2 0 1 0-.01 0v-4M17 7.5a2 2 0 1 0-.01 0Zm0 0v3a4 4 0 0 1-4 4H7',
  bookmark: 'M6.5 4.5h11v15l-5.5-4-5.5 4Z',
  file: 'M7 4.5h7l4 4v11H7Z M14 4.5V9h4',
  refresh: 'M5 12a7 7 0 0 1 12-4.9M19 12a7 7 0 0 1-12 4.9M17.5 4.5v3h-3M6.5 19.5v-3h3',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  'eye-off': 'M3.5 3.5l17 17M10.6 10.7a3 3 0 0 0 4.2 4.2M7.4 7.6C5 9.2 3 12 3 12s3.5 6.5 9.5 6.5c1.6 0 3-.4 4.2-1.1M16.8 16.9C19.6 15.2 21 12 21 12s-3.5-6.5-9.5-6.5c-1 0-2 .2-2.9.5',
  clipboard: 'M9 4.5h6a1 1 0 0 1 1 1V7h1.5a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1H8V5.5a1 1 0 0 1 1-1ZM9 7h6M9.5 12h5M9.5 15.5h5',
  bug: 'M9 8.5a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0ZM10.5 5.5 9 4M13.5 5.5 15 4M6 10h3M15 10h3M6 13.5h3M15 13.5h3M7.5 17l2-1.5M16.5 17l-2-1.5',
  shield: 'M12 4 5.5 6.5v4.5c0 5 2.8 7.8 6.5 8.5 3.7-.7 6.5-3.5 6.5-8.5V6.5ZM9.5 12l2 2 3.5-4',
  flask: 'M10 4.5h4M10.5 4.5v4.2l-4.7 8.6a1.4 1.4 0 0 0 1.2 2.2h10a1.4 1.4 0 0 0 1.2-2.2l-4.7-8.6V4.5M8 15.5h8',
  minimize: 'M6 18.5h12',
  maximize: 'M5.5 5.5h13v13h-13Z',
  restore: 'M8.5 8.5h10v10h-10ZM5.5 5.5h10v3M5.5 5.5v10h3',
};

/** Glyphs that read better filled than stroked. */
const FILLED = new Set<IconName>(['dot']);

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}

export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
  { name, size = 18, strokeWidth = 1.7, className, ...rest },
  ref,
) {
  const filled = FILLED.has(name);
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('shrink-0', className)}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
});
