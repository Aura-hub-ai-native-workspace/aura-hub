# AURA Code Style

Conventions contributors are expected to follow. This document covers
style and process conventions only — it does not change or dictate
application logic.

## TypeScript

- Strict mode is on (`tsconfig.base.json`); don't weaken it locally.
- No `any` unless interfacing with an untyped third-party API — narrow
  it at the boundary.
- Prefer named exports; one primary export per file for components.
- Packages are source-consumed (no build step) — see
  [ARCHITECTURE.md](ARCHITECTURE.md) §2. Don't add a bundler step to a
  package without discussing it with the owner first.

## React

- Function components + hooks only.
- Keep components presentational where possible; push state into
  `@aura/core`'s store or a package-local hook, not component state,
  when it needs to outlive a single screen.
- Co-locate a screen's small helper components in the same folder
  (see `apps/desktop/src/screens/project/sections`).

## Formatting

- Follow the existing formatting in the file you're editing (indentation,
  quote style, trailing commas). Don't run a repo-wide reformatter in a
  feature PR — it makes review impossible and will be rejected.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>
```

Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `style`, `perf`.
Scope should match your team's area (`ui`, `backend`, `database`,
`runtime`, `knowledge-fabric`, `workflow`, `core`) where practical.

Examples:

```
feat(ui): add code editor sidebar
feat(database): add workflow schema
fix(runtime): repair streaming
refactor(core): simplify editor state
docs(readme): improve installation
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for branch naming and the full
PR workflow.
