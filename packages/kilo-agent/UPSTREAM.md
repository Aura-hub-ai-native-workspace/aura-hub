# Upstream — Kilo-Org/kilocode

- Upstream URL: https://github.com/Kilo-Org/kilocode.git
- Upstream default branch: `main`
- Vendored on: 2026-09-23 (UTC)
- Upstream `package.json` (main, fetched 2026-09-23): name `@kilocode/kilo`, version `7.7.7`, private, `bun@1.3.14`, workspaces `packages/*`, license MIT.
- Vendoring method: offline-first wrapper (same pattern as `packages/coding-agent` for opencode).
  Full `git clone --depth 1 https://github.com/Kilo-Org/kilocode.git` was NOT attempted here because the
  sst/opencode shallow clone on this same machine stalled at ~10–20 KiB/s and reset twice — same
  throughput risk applies (Kilo is a larger monorepo: vscode extension + jetbrains + cli + webview-ui).
  Small-file fetch (raw.githubusercontent.com) WORKS.
- To complete a full vendor copy when network allows:
  ```powershell
  Remove-Item -Recurse -Force packages/kilo-agent-upstream
  git clone --depth 1 https://github.com/Kilo-Org/kilocode.git packages/kilo-agent-upstream
  node packages/kilo-agent/scripts/strip-cloud.cjs --target packages/kilo-agent-upstream
  node packages/kilo-agent/scripts/verify-offline.cjs --target packages/kilo-agent-upstream
  ```
- License note: upstream is MIT. This wrapper is Apache-2.0 (AURA Hub). Keep upstream LICENSE when vendoring full source.
- Kilo is an opencode-descended codebase (scripts reference `packages/opencode`, `@opencode-ai/*`), so the
  offline strategy mirrors `packages/coding-agent`: local Ollama default, cloud endpoints neutralised.
