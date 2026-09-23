# Upstream — sst/opencode

- Upstream URL: https://github.com/sst/opencode.git
- Upstream default branch: `dev`
- Vendored on: 2026-09-23 (UTC)
- Vendoring method: shallow clone attempted (`git clone --depth 1 https://github.com/sst/opencode.git packages/coding-agent`)
  - Full clone did NOT complete on this machine: network to github.com stalled at ~10-20 KiB/s during `Receiving objects` (7235 objects, ~6k compressed) and reset twice (5-min and 10-min timeouts).
  - Small-file fetch WORKS (e.g. `package.json` via raw.githubusercontent.com), so the failure is throughput, not DNS/auth.
  - This folder is therefore an **offline-first vendor wrapper**, not a byte copy: default config + strip/verify scripts + docs. It is the correct base for `feature/coding-agent`.
- Upstream `package.json` (dev, fetched 2026-09-23): name `opencode`, private, `bun@1.3.14`, workspaces `packages/*`, license MIT.
- To complete a full vendor copy when network allows:
  ```powershell
  Remove-Item -Recurse -Force packages/coding-agent-upstream
  git clone --depth 1 https://github.com/sst/opencode.git packages/coding-agent-upstream
  node packages/coding-agent/scripts/strip-cloud.cjs --target packages/coding-agent-upstream
  node packages/coding-agent/scripts/verify-offline.cjs --target packages/coding-agent-upstream
  ```
- License note: upstream is MIT. This wrapper is Apache-2.0 (AURA Hub). Keep upstream LICENSE when vendoring full source.
