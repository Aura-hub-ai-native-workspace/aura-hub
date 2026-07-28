# AURA Hub — Design Language

An original language — **not** macOS, Windows, or VS Code. The reference points
are the *feeling* of Apple HIG restraint, Arc's spatial calm, and Linear's
precision — expressed in AURA's own tokens.

## Principles

1. **Whitespace is a feature.** Generous spacing, never dense.
2. **One accent, used sparingly.** AURA Blue (`#3b6bff`) signals action and
   focus — nothing decorative.
3. **Soft, not sharp.** Large radii (14–24px), diffuse low-contrast shadows.
4. **Calm surfaces.** Pure white/near-black surfaces on a faintly washed
   canvas — the "desk" the app sits on.
5. **Glass only where it earns it** — floating chrome, overlays, the palette.
6. **Motion is physical.** Spring physics, 120fps-friendly, reduced-motion safe.

## Tokens (semantic)

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--canvas` | `#ffffff` | `#0b0d11` | app background |
| `--surface` | `#ffffff` | `#14171d` | cards, panels |
| `--surface-hover` / `-active` | grays | grays | interactive states |
| `--line` / `-strong` | `#e6e9ef` | `#232833` | borders, dividers |
| `--text` / `-muted` / `-subtle` | ink ramp | ink ramp | text hierarchy |
| `--accent` (+50/100/200/600/700) | `#3b6bff` | `#5c86ff` | the one accent |
| `--positive` `--attention` `--danger` | status | status | used sparingly |

Full raw ramps live in `packages/core/src/tokens.ts`; the runtime CSS variables
in `apps/desktop/src/styles/global.css` are the source of truth for theming.

## Type

Inter (system fallback), 13px base. Tight tracking on large headings
(`-0.01em`–`-0.02em`). Monospace reserved for code/metrics.

## Motion vocabulary

| Preset | Feel | Use |
| --- | --- | --- |
| `spring.snappy` | quick, light | buttons, toggles |
| `spring.smooth` | default | cards, tabs, panels |
| `spring.gentle` | soft, weighty | page transitions, rings |
| `spring.fluid` | elastic | sidebar / context-panel width |

Variants (`pageVariants`, `staggerContainer/Item`, `popVariants`,
`scrimVariants`) standardise page loads, list reveals, and overlays.

## Components

The system ships the full reusable set (see `packages/ui`): Button, IconButton,
Card, Input, Panel, Dialog, Menu, Dropdown, Table, Tabs, List, Badge, Progress
& Ring, Skeleton, Tooltip, Toast, and the Command Palette — plus a **bespoke,
geometric icon set** (`Icon`) drawn on a single 24×24 grid so the whole
environment shares one hand. No Material, Fluent, or SF Symbols.
