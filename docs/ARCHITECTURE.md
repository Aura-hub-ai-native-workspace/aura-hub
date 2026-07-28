# AURA Hub — Architecture

> This foundation must support years of development. Every decision below
> optimises for **scalability and clarity over short-term speed.**

## 1. Philosophy → structure

AURA is an *operating environment*, so the app is modelled as a **fixed frame**
(the shell) hosting **interchangeable surfaces** (screens/modules). The frame
never re-renders on navigation; only the stage inside it changes. This is why
navigation is **store state, not URL routing** — an environment has locations,
not pages.

## 2. Monorepo & dependency direction

```
apps/desktop ──▶ @aura/ui ──▶ @aura/core
                    │             ▲
                    └─────────────┘
```

- **`@aura/core`** — zero UI. Design tokens, motion presets, domain types,
  the global store, the navigation model, mock data. Depends on nothing but
  `zustand`. This is the contract every other layer builds on.
- **`@aura/ui`** — the design system. Pure, reusable, presentational
  components + hooks. Depends only on `core`. Knows nothing about screens.
- **`apps/desktop`** — composition layer. Wires the design system and store
  into the actual environment (shell + screens).

Dependencies point **inward only**. A feature module added tomorrow depends on
`ui` + `core`, never the other way around — so the foundation can never be
broken by a feature.

**Why source-consumed packages?** Packages export raw `.ts`; Vite and the TS
compiler resolve them via aliases. No build/watch step per package → instant
HMR across the whole monorepo, while still enforcing real module boundaries.

## 3. State architecture

A single, small **`useAppStore`** (Zustand) holds *shell* state only:
active location, chrome visibility, theme, palette. It is deliberately **not a
god store** — domain/feature state should live beside its module in its own
store. This keeps the shell's state surface tiny and predictable.

## 4. The extension points (where intelligence plugs in)

The shell was designed around the seams AI will need:

| Seam | Where | How a future module extends it |
| --- | --- | --- |
| **Command registry** | `apps/desktop/src/shell/useCommands.ts` | Modules contribute `Command[]`; the palette renders them for free. |
| **Navigation model** | `packages/core/src/navigation.ts` | Add a `NavItem` / `ProjectTab`; the rails render it automatically. |
| **Screen router** | `apps/desktop/src/screens/ScreenRouter.tsx` | Map a `NavKey` to a component. |
| **Context panel** | `apps/desktop/src/shell/RightPanel.tsx` | Add a case keyed by location for bespoke context. |
| **Domain types** | `packages/core/src/types.ts` | Real services produce/consume these exact shapes; mock data swaps out behind them. |
| **Native OS bridge** | `apps/desktop/src-tauri/src/lib.rs` | Add scoped `#[tauri::command]`s (file access, local runners, system hooks). |

Nothing here imports an AI SDK. Wiring one in is additive — a new module, a few
commands, a screen — never a refactor.

## 5. Theming

All colour/elevation is expressed as **CSS custom properties** in
`styles/global.css` and mapped into Tailwind (`tailwind.config.ts`). Components
consume *semantic* tokens (`bg-surface`, `text-muted`, `bg-accent`) — never raw
hex. Switching theme = swapping a variable block on `<html data-theme>`; no
rebuild, and future "ambient" themes are trivial.

## 6. Motion

Motion is a **shared vocabulary** (`packages/core/src/motion.ts`): spring
presets + reusable Framer variants. Components pick a word from it; they never
invent timings. Everything degrades under `prefers-reduced-motion`.

## 7. Native runtime (Tauri v2)

Tauri was chosen over Electron to match the "second operating system" feel:
a tiny Rust core, low memory, native windowing, small binaries. The Rust side
is intentionally thin — its only current job is to host the web environment.
The web layer has **no hard dependency** on Tauri, so it also runs in a plain
browser, keeping the dev loop fast and the UI portable.

## 8. Conventions

- Components are presentational and reusable; screens compose them.
- One component per file; barrel exports in each package's `index.ts`.
- No raw hex in components — tokens only.
- New destinations are data (`navigation.ts`), not hard-coded JSX.
- Accessibility: focus-visible rings, `aria-*` on interactive chrome, keyboard
  paths for the palette and dialogs.

## 9. Transitions — never gate content behind an exit

A top-level route/screen switch must render its incoming content
**synchronously**. We animate screens with a *keyed* `motion.div`
(enter-only): when the route changes React unmounts the old subtree and
mounts the new one in the same commit, and the fresh element plays its
enter/immersion animation on mount. The outgoing screen is not animated
out — animation is decoration, never a precondition for content.

**Rule: never nest `AnimatePresence` with `mode="wait"`.** `mode="wait"`
defers mounting the next child until the previous child's exit completes.
If that exiting subtree contains its *own* `mode="wait"` presence (e.g. a
project workspace's tab switcher), the descendant exit can fail to signal
completion, the parent's `onExitComplete` never fires, and the deferred
screen is never mounted — a permanently blank region. This was the root
cause of the "blank workspace after leaving a project" bug. `ScreenRouter`
and `RightPanel` therefore use enter-only keyed transitions; overlay
presences (palette, dialog, toast) remain single-level and are fine.
