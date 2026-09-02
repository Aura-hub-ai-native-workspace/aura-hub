# Demo Assets — Status

Honest inventory of what exists versus what's still needed, so this
package doesn't imply assets that aren't real yet.

## Exists today (real, checkable)

| Asset | Where |
|---|---|
| Public source repository | `github.com/Aura-hub-ai-native-workspace/aura-hub` |
| Green CI badge (typecheck + build, live) | Repo README, top badge row |
| Five grounded demo scripts (AI Chat, Code Generation, Workflow Automation, Engineering Analysis, Knowledge Graph) — talk tracks tied to real, runnable features | `docs/QWEN_DEMOS.md` |
| 10 real, importable workflow templates (JSON, directly exported from shipped source) | `examples/` |
| Full architecture documentation | `docs/architecture/PROVIDER_INTEGRATION.md`, `docs/ARCHITECTURE.md` |
| Qwen setup/API key/model selection/troubleshooting guide | `docs/QWEN_GUIDE.md` |
| A complete, specced (not yet shot) screenshot list | `docs/assets/screenshots/SCREENSHOT_GUIDE.md` |

## Does not exist yet (flagged, not faked)

- **Hosted/live demo.** The app currently runs locally only
  (`npm run dev` + `npm run ai`, or a Tauri desktop build). There is no
  public URL to click.
- **Captured screenshots.** The shot list above is fully specified
  (exact panels, window states, filenames) but no images have been taken
  — the gallery slots in the README are currently unpopulated.
- **Recorded demo video.** None yet.
- **Live, authenticated Qwen inference recording.** The integration is
  verified end-to-end for connectivity and error handling (real 401
  against the real endpoint), but a recording of a successful,
  authenticated chat completion doesn't exist yet — we don't have a
  DashScope key provisioned in our build environment.

## What would close this gap fastest

API access/credits (see
[`01-partnership-proposal.md`](01-partnership-proposal.md)) would let us
record the missing authenticated-inference demo and capture the
screenshot set with Qwen genuinely connected and active — the more
credible path than staging assets around a key we don't yet have.
