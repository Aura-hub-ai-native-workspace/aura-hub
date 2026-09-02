# AURA Hub × Qwen — Executive Summary

**What:** AURA Hub is an open-source, AI-native engineering workspace
(Tauri desktop app + local orchestration service) with no built-in AI —
developers bring their own key across 11 supported providers behind one
shared adapter interface. Qwen (Alibaba Cloud Model Studio) is now one
of them, integrated as a fully first-class provider.

**Why Qwen:** technical fit (Qwen's OpenAI-compatible API proved AURA's
provider abstraction genuinely holds against an independent, real API),
model breadth (multiple capability/latency tiers matching AURA's
per-task model-switching), and reach (a serious, non-Western-centric
model choice for developers already inside Alibaba Cloud's ecosystem).

**What was verified:** base URL, auth, and default model against
Alibaba's own docs; a live 401 from the real DashScope endpoint
(unauthenticated); a full connect-flow round trip through AURA's real
server producing a real classified error response from Alibaba's actual
servers. Typecheck, build, and CI are green.

**What wasn't verified:** live, authenticated chat completion — no
DashScope key was available in the build environment. Everything
downstream of a valid key is shared, already-proven code six other
providers use in production.

**Stage:** early. Public repo created 2026-07-28, single maintainer,
Apache-2.0. This work is real, committed, and CI-green, on a feature
branch not yet merged to `main`. No hosted demo or captured screenshots
yet.

**The ask:** a small API credit grant (on the order of a few hundred
calls) to close the verification gap above and produce real demo
material; a technical contact to sanity-check the integration; early
access to new Qwen releases; a channel for engineering feedback;
consideration for any relevant developer program.

**Repository:** `github.com/Aura-hub-ai-native-workspace/aura-hub`

**Contact:** [Your name] · [Your email]
