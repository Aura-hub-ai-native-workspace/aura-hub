/**
 * The one file that touches Tauri's updater.
 * ==================================================================
 * Everything native is confined here: `@tauri-apps/plugin-updater` for
 * check/download/install, `@tauri-apps/plugin-process` for the relaunch.
 * `UpdateService` and the UI above it see only the `UpdaterAdapter`
 * interface, so no renderer ever learns how verification or transport
 * works — and swapping the native layer never reaches them.
 *
 * ── The security boundary runs through this file ─────────────────────
 * `check()` returns Tauri's `Update` handle. Its `downloadAndInstall`
 * verifies the minisign signature of the metadata and the artifact
 * against the public key in tauri.conf.json BEFORE installing, and
 * installs the exact bytes it verified.
 *
 * That is why this adapter exposes no URL, no byte stream and no path:
 * there is deliberately no way for a caller to obtain the artifact and
 * do something else with it. If a future change needs the download and
 * the install separated, that is a change to the security model and
 * belongs in a design discussion, not here.
 */

import { check as tauriCheck, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { platform as osPlatform, arch as osArch } from '@tauri-apps/plugin-os';
import type { AdapterUpdate, UpdaterAdapter } from './updateService';
import type { DownloadProgress } from './types';

/** Host only — a diagnostics label, never a fetchable URL. */
const SOURCE_HOST = 'github.com';

function toAdapterUpdate(update: Update): AdapterUpdate {
  return {
    // Exactly what the plugin parsed for this machine, passed through
    // unaltered. The platforms map is intentionally not reconstructed:
    // the updater has already resolved it, and synthesising one here
    // would be AURA inventing metadata it never received.
    offered: {
      version: update.version,
      releaseDate: update.date,
      notes: update.body,
    },

    async downloadAndInstall(onProgress: (p: DownloadProgress) => void) {
      let downloaded = 0;
      let total: number | null = null;

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? null;
            downloaded = 0;
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            break;
          case 'Finished':
            if (total !== null) downloaded = total;
            break;
        }
        onProgress({
          downloaded,
          total,
          // Null rather than a guess when the server declared no length —
          // a progress bar that invents a percentage is a lie about how
          // long the user is waiting.
          percent: total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null,
        });
      });
    },

    async close() {
      await update.close();
    },
  };
}

export function createTauriUpdaterAdapter(): UpdaterAdapter {
  return {
    currentVersion: () => getVersion(),

    async platform() {
      return { os: osPlatform(), arch: osArch() };
    },

    async check() {
      const update = await tauriCheck();
      return update ? toAdapterUpdate(update) : null;
    },

    relaunch: () => relaunch(),

    sourceHost: () => SOURCE_HOST,
  };
}
