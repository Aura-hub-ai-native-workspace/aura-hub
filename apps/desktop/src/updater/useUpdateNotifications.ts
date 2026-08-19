/**
 * Background update discovery, and the one notification it may raise.
 * ==================================================================
 * Two responsibilities, both deliberately quiet:
 *
 *   1. Start ONE background check per session, well after the application
 *      is already usable. Startup never waits for the update server.
 *
 *   2. Raise at most one notification per discovered version, through the
 *      existing notification store. Dedupe is by version, so a check that
 *      runs again finds the key already present and stays silent.
 *
 * It never installs, never restarts, and never interrupts with a modal.
 */

import { useEffect } from 'react';
import { useAppStore } from '@aura/core';
import { useNotificationsStore } from '../ops/notificationsStore';
import { startBackgroundUpdateCheck, useUpdateState, isDesktopRuntime } from './useUpdater';

/**
 * Versions already announced in this session.
 *
 * Module-level so that dismissing the notification and remounting the
 * shell does not bring it back — "dismissed" has to outlive the
 * component that raised it, or dismissal means nothing.
 */
const announced = new Set<string>();

export function resetAnnouncedForTests(): void {
  announced.clear();
}

export function useUpdateNotifications(): void {
  const state = useUpdateState();
  const autoUpdateCheck = useAppStore((s) => s.autoUpdateCheck);
  const notify = useNotificationsStore((s) => s.notify);

  /* The background check. Fires once, only in the desktop shell, only
     when the user has left automatic checks on, and only after a delay
     so it never competes with first paint or project restore. */
  useEffect(() => {
    if (!autoUpdateCheck || !isDesktopRuntime()) return;
    return startBackgroundUpdateCheck();
  }, [autoUpdateCheck]);

  /* One notification per version. `notify` is itself deduplicated by key
     in the store, so this is belt and braces — the local set also stops
     a dismissed notification from being recreated by the next check. */
  useEffect(() => {
    if (state.kind !== 'update-available') return;
    const version = state.candidate.version;
    if (announced.has(version)) return;
    announced.add(version);

    notify({
      key: `update-available:${version}`,
      kind: 'update-available',
      title: 'AURA Hub update available',
      detail: `Version ${version} is ready to install. Open Settings to upgrade.`,
    });
  }, [state, notify]);
}
