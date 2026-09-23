# @aura/kilo-agent — offline coding agent (Kilo Code, local-only)

AURA Hub package. Upstream is [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode.git)
(`main` branch), vendored here as **offline-first**: local Ollama provider only,
no cloud. Same pattern as `@aura/coding-agent` (opencode).

## What lives here

- `kilo.json` — THE default. `ollama/qwen3-coder:30b`, baseURL `http://127.0.0.1:11434/v1`,
  `tool_call: true`, `limit.context: 32768`. No Gateway / BYOK / account.
- `config/aura-providers.json` — same endpoint in AURA central-agent shape.
- `scripts/strip-cloud.cjs` — applies the offline transformation to a full kilocode clone.
- `scripts/verify-offline.cjs` — asserts the offline contract (config + no cloud endpoints).
- `docs/OFFLINE-PROVIDER.md` — run Ollama, num_ctx ≥ 32k, local-vs-cloud boundary.
- `UPSTREAM.md` — upstream pin + how to complete a full vendor copy.

## Cloud removal (what "completely remove" means)

Removed / neutralised, not just hidden:

- Providers: Kilo Gateway (500+ hosted models, `kilo-auto/*`), Ollama Cloud hosted path,
  and all BYOK cloud providers deleted from default config; only local `ollama` remains.
- Endpoints: `api.kilo.ai`, gateway/auth, sign-in/billing, telemetry/analytics rewritten
  to loopback by `strip-cloud.cjs`.
- Surfaces: Cloud Agents, hosted review, remote MCP defaults, auto-update — no code path
  in this package calls them; the strip script neutralises them in a full clone.

Verify any time:

```powershell
node packages/kilo-agent/scripts/verify-offline.cjs
```

## Full clone note

A full clone was deliberately not attempted here: the sst/opencode shallow clone on this
same machine stalled (~10–20 KiB/s, connection reset), and kilocode is larger. Small-file
fetch works. When network allows, clone to `packages/kilo-agent-upstream` (NOT over this
folder), then run `strip-cloud.cjs --target` + `verify-offline.cjs --target`. See `UPSTREAM.md`.

## License

Wrapper: Apache-2.0 (AURA Hub). Upstream Kilo Code is MIT — keep its LICENSE when
vendoring full source.
