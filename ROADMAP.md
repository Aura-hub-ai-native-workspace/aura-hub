# Roadmap

This is the high-level, forward-looking roadmap. For exact in-flight
scope, sequencing detail, and how work is tracked day-to-day, see
[`docs/ROADMAP.md`](docs/ROADMAP.md) and the
[project board](docs/PROJECT_BOARD.md). This file is maintained by the
repository owner and updated as priorities shift — it is a direction,
not a contract.

Status legend: ✅ Implemented · 🚧 In Progress · 📅 Planned

---

## Now

What's actively being hardened on top of the existing platform:

- 🚧 **Automation Engine UI** — the event-driven rule engine
  (`packages/automation`: triggers, conditions, retryable action chains)
  is real and wired into the backend today, but has no dedicated
  settings surface in the desktop app yet. Rules currently have to be
  authored through the API.
- 🚧 **Test coverage** — CI currently runs typecheck + build on every
  PR; there is no automated test suite yet. Verification today is
  manual (documented per-PR in the "Testing" section of every PR
  description). Adding real test coverage for the provider system,
  workflow engine, and knowledge engines is the next reliability
  investment.
- 🚧 **Screenshot gallery** — 12 of 14 real, live-captured product
  screenshots are in (see
  [`docs/assets/screenshots/SCREENSHOT_GUIDE.md`](docs/assets/screenshots/SCREENSHOT_GUIDE.md)
  for the two documented gaps); the README gallery is populated.

## Next

- 📅 **Signed desktop builds** — macOS/Windows/Linux installers via
  Tauri are already configured to bundle (`apps/desktop/src-tauri`),
  but are not yet code-signed or notarized. No signed release exists
  yet.
- 📅 **Provider breadth** — the provider abstraction
  (`packages/ai-service/src/provider`) is designed so a new adapter is
  a single ~15-line file; adding more BYOAK providers as real user
  demand appears.
- 📅 **Knowledge fabric depth** — cross-repository linking (today the
  knowledge graph is scoped to one open project at a time), plus
  surfacing god-node and community-structure detail more deeply in the
  UI beyond the current graph visualization.
- 📅 **Team onboarding** — `docs/TEAM_GUIDE.md` already defines UI-UX,
  Backend, and Database team ownership boundaries and CODEOWNERS
  routing; this activates once those teams have members beyond the
  repository owner.

## Future

Directional, not committed:

- 📅 A public, hosted version of the knowledge graph / architecture
  views for sharing a read-only project snapshot without installing
  the desktop app.
- 📅 A plugin/extension surface for third-party workflow node types,
  building on the existing node-registry pattern
  (`packages/ai-service/src/workflow/nodes.ts`).
- 📅 Multi-repository Mission Control — planning and executing work
  that spans more than one open project at once.

---

## How this roadmap is maintained

- The repository owner updates this file when priorities change.
- Day-to-day execution detail (the current milestone, issue/PR
  labeling, project board columns) lives in
  [`docs/ROADMAP.md`](docs/ROADMAP.md) and
  [`docs/PROJECT_BOARD.md`](docs/PROJECT_BOARD.md) — this file stays
  intentionally short and rarely changes shape.
- Have a request? Open a
  [feature request](.github/ISSUE_TEMPLATE/feature_request.md) — see
  [`CONTRIBUTING.md`](CONTRIBUTING.md).
