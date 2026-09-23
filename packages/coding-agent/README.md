# @aura/coding-agent — offline coding agent (opencode, local-only)

AURA Hub package. Upstream is [sst/opencode](https://github.com/sst/opencode.git)
(`dev` branch), vendored here as **offline-first**: local Ollama provider only,
no cloud.

## What lives here

- `opencode.json` — THE default. `ollama/qwen3-coder:30b`, `share: disabled`,
  `autoupdate: false`, baseURL `http://127.0.0.1:11434/v1`. No cloud providers declared.
- `config/aura-providers.json` — same endpoint in AURA central-agent shape.
- `scripts/strip-cloud.cjs` — applies the offline transformation to a full opencode clone.
- `scripts/verify-offline.cjs` — asserts the offline contract (config + no cloud endpoints).
- `docs/OFFLINE-PROVIDER.md` — run Ollama, pick coder models.
- `UPSTREAM.md` — upstream pin + how to complete a full vendor copy.

## Cloud removal (what "completely remove" means)

Removed / neutralised, not just hidden:

- Providers: OpenCode Zen, OpenCode Go, and all hosted providers (Anthropic/OpenAI/Groq/…)
  deleted from default config; only `ollama` remains.
- Endpoints: `api.opencode.ai`, `opencode.ai/auth`, `share.opencode.ai` rewritten to
  loopback by `strip-cloud.cjs`; `share: disabled`, `autoupdate: false`.
- Surfaces: `/connect` cloud auth, share/console/stats, sentry/posthog analytics —
  no code path in this package calls them; the strip script neutralises them in a full clone.

Verify any time:

```powershell
node packages/coding-agent/scripts/verify-offline.cjs
```

## Full clone note

A full `git clone --depth 1 https://github.com/sst/opencode.git` was attempted on
2026-09-23 but the network stalled (~10–20 KiB/s, connection reset). Small-file
fetch works. When network allows, clone to `packages/coding-agent-upstream` (NOT
over this folder), then run `strip-cloud.cjs --target` + `verify-offline.cjs --target`.
See `UPSTREAM.md`.

## License

Wrapper: Apache-2.0 (AURA Hub). Upstream opencode is MIT — keep its LICENSE when
vendoring full source.
