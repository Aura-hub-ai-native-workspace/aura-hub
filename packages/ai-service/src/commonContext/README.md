Vendored from https://github.com/Gokulanand-art/common-context-mcp (v3.2.0, commit 4c21c34), MIT. See LICENSE.common-context-mcp.
Only the store, log and config modules are vendored; its installer (postinstall, agents.js) is not.

`tools.ts` is AURA's own tool layer on that store: load, save, search, failures, area claims, summaries,
handoffs and broadcasts for one agent and one project folder. The AI service exposes it as
`POST /context/{load|save|search|failure|claim|release|summary|handoff|broadcast|snapshot}` with
`{ projectPath, agent, ... }`. The store is the project's `common-context.json` (mode 0600).
