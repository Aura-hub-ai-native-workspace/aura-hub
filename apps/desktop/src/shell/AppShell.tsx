import { LeftNav } from './LeftNav';
import { ScreenRouter } from '../screens/ScreenRouter';
import { useActiveProjectSync } from '../data/useActiveProject';

/**
 * AppShell — the fixed frame of the operating environment.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ [ Left Nav ] │ Main workspace                 │
 *   │              │                                │
 *   └──────────────┴────────────────────────────────┘
 *
 * Every region is independently scrollable; the frame never moves.
 */
export function AppShell() {
  /* The shell is the one place the active project is reconciled with the
     service mount, because it is the one component always mounted. */
  useActiveProjectSync();

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden"
      style={{ background: 'var(--canvas-wash)' }}
    >
      <div className="flex min-h-0 flex-1">
        <LeftNav />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            {/* Main workspace — the stage where screens live. */}
            <main className="min-w-0 flex-1 overflow-y-auto">
              <ScreenRouter />
            </main>

          </div>
        </div>
      </div>

    </div>
  );
}
