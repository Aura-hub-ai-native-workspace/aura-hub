import { Suspense, lazy } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { SETTINGS_TABS, cn, spring, useAppStore, type SettingsTab } from '@aura/core';
import { IconButton, Skeleton, Tooltip } from '@aura/ui';
import { ErrorBoundary } from '../ErrorBoundary';
import { PageBlock, PageContainer } from '../PageContainer';
import { UpdatePanel } from '../../updater/UpdatePanel';
import { AppImageInstallPanel } from '../../components/AppImageInstallPanel';

const AiSettings = lazy(() => import('../ai/AiSettings').then((m) => ({ default: m.AiSettings })));
const AiRuntime = lazy(() => import('../ai/AiRuntime').then((m) => ({ default: m.AiRuntime })));
const ConnectedToolsTab = lazy(() => import('./ConnectedToolsTab').then((m) => ({ default: m.ConnectedToolsTab })));

function TabLoading() {
  return (
    <div className="mx-auto w-full max-w-[1180px] px-8 py-10">
      <Skeleton variant="line" className="w-48" />
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    </div>
  );
}

function UpdatesTab() {
  return (
    <PageContainer title="Updates" subtitle="What copy of AURA Hub you are running, and whether a newer one is available.">
      <div className="grid grid-cols-12 gap-5">
        <PageBlock className="col-span-12 lg:col-span-7"><UpdatePanel /></PageBlock>
        {/* Renders nothing unless there is an AppImage installation to act on. */}
        <PageBlock className="col-span-12 lg:col-span-5"><AppImageInstallPanel /></PageBlock>
      </div>
    </PageContainer>
  );
}

const TAB_BODY: Record<SettingsTab, { title: string; render: () => ReactNode }> = {
  connections: { title: 'Connections', render: () => <AiSettings /> },
  tools: { title: 'Connected tools', render: () => <ConnectedToolsTab /> },
  runtime: { title: 'AI Runtime', render: () => <AiRuntime /> },
  updates: { title: 'Updates', render: () => <UpdatesTab /> },
};

/**
 * Settings — four tabs, one active at a time. The tab strip is fixed; the
 * active tab's body scrolls inside its own region, so the strip never moves.
 */
export function SettingsScreen() {
  const tab = useAppStore((s) => s.settingsTab);
  const setTab = useAppStore((s) => s.setSettingsTab);
  const body = TAB_BODY[tab] ?? TAB_BODY.connections;
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);

  return (
    <div className="flex h-full min-h-full flex-col">
      <div className="relative flex shrink-0 justify-center px-4 pb-1 pt-3">
        <div className="absolute right-5 top-4">
          <Tooltip content={theme === 'light' ? 'Switch to dark' : 'Switch to light'}>
            <IconButton icon={theme === 'light' ? 'moon' : 'sun'} label="Toggle theme" size="sm" onClick={toggleTheme} />
          </Tooltip>
        </div>
        <div className="relative flex max-w-full gap-1 overflow-x-auto rounded-full border border-line bg-surface/70 p-1 backdrop-blur-sm" role="tablist" aria-label="Settings">
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn('relative z-10 shrink-0 rounded-full px-5 py-2 text-[13px] font-medium transition-colors', tab === t.key ? 'text-on-accent' : 'text-text-muted hover:text-text')}
            >
              {tab === t.key && <motion.span layoutId="settings-tab-pill" transition={spring.smooth} className="absolute inset-0 -z-10 rounded-full bg-accent shadow-[0_0_18px_var(--accent)]" />}
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ErrorBoundary key={tab} title={`Unable to load ${body.title}`}>
          <Suspense fallback={<TabLoading />}>{body.render()}</Suspense>
        </ErrorBoundary>
      </div>
    </div>
  );
}
