# AURA Hub — Demo Video Script & Storyboard

A complete production package for a 2–3 minute product demo. Every scene
is tied to a real, already-shipped, screen-recordable surface of the app
— nothing described here needs to be built first. **No video file has
been rendered** — this is the script, shot list, and production
direction a human (or a screen-recording + voice-over pass) would follow
to make one.

**Runtime target:** 2:40. **Format:** 16:9, 1440×900 capture (the app's
native window size), screen-recorded against the `aura-hub` repository
itself as the open project — same recommendation as
[`SCREENSHOT_GUIDE.md`](assets/screenshots/SCREENSHOT_GUIDE.md), for the
same reason: real, defensible, always-accurate output.

---

## The six questions this video must answer

| Question | Where it's answered |
|---|---|
| What is AURA Hub? | Scene 1 (cold open) |
| Why does it exist? | Scene 2 (the problem) |
| What problem does it solve? | Scene 2 |
| How does it work? | Scenes 3–6 (product tour) |
| Why is it different? | Scene 7 (the seam) |
| Why should developers adopt it? | Scene 8 (close) |

---

## Scene-by-scene

### Scene 1 — Cold open (0:00–0:12)

- **Screen:** Black, then the real AURA welcome screen fades in
  (`Welcome to AURA` — dot-grid starfield, connecting nodes).
- **Camera/transition:** Slow fade-in, 1.5s. No cut.
- **Callout:** None yet — let the product breathe for a beat.
- **VO:** *"Every AI coding tool gives you a chat window. AURA gives you an environment."*
- **Animation:** The three connected nodes in the welcome graphic pulse
  once, in sync with the VO's second sentence.

### Scene 2 — The problem (0:12–0:28)

- **Screen:** Cut to a generic, muted mockup split-screen: a chat panel
  bolted onto a code editor, greyed out / desaturated to signal "generic."
- **Camera:** Static.
- **Callout (text on screen):** "Every session starts from zero."
- **VO:** *"Most tools re-derive context from whatever's in the buffer. They don't know your architecture. They don't remember yesterday's decisions. The chat window is a guest in someone else's house."*
- **Transition out:** Hard cut to full color — the real AURA Home screen.

### Scene 3 — Home & Quick Start (0:28–0:42)

- **Screen:** Real Home screen (`01-app-shell-home.png` state) — project
  list, connected provider status, "Environment ready."
- **Camera:** Cursor moves to an existing project card, clicks.
- **Callout:** "No built-in model. Bring your own key — 11 providers."
- **VO:** *"AURA has no built-in AI. Connect any of eleven providers — OpenAI, Anthropic, Groq, Qwen, and more — and every feature works identically, immediately."*
- **Transition:** Smooth panel-open animation as the project workspace loads (the app's own real transition, not a video effect).

### Scene 4 — Knowledge Graph grounding (0:42–1:00)

- **Screen:** Project Overview tab → click into Architecture tab (real
  layered dependency view).
- **Camera:** Slow pan/scroll down the real architecture layers
  (Desktop → AI Service → Root), pause on real module/entity counts.
- **Callout:** "373 entities · 905 relationships — real static analysis."
- **VO:** *"Before any model is called, AURA already understands the codebase — a real knowledge graph, not a best-effort text search."*

### Scene 5 — AI Chat, grounded (1:00–1:22)

- **Screen:** Open Ask AURA panel, type a real question (e.g. *"Explain
  the provider validation architecture"*), let the real streamed answer
  render.
- **Camera:** Static, focused on the chat panel filling most of frame.
- **Callout:** As the answer completes, highlight the citation footer —
  "coding KE · fullstack KE · Groq · 2077 tok · 2117ms."
- **VO:** *"The answer is grounded — real retrieved files, real relationships, real memory recalled. Not a guess dressed up as confidence."*

### Scene 6 — AI Workflow Builder (1:22–1:50)

- **Screen:** Automation Studio → AI Builder panel. Type a natural-
  language automation request. Watch the real node graph build itself
  on the canvas.
- **Camera:** Slight zoom-out as the graph populates, framing the full
  canvas once nodes finish connecting.
- **Callout:** "Built: 6 nodes, 6 connections." (the app's own real
  confirmation message)
- **VO:** *"Describe an automation in plain language. AURA builds a real, runnable graph — against the platform's actual node registry. Nothing simulated."*
- **Transition:** Cut to Mission Control.

### Scene 7 — Mission Control & the shared seam (1:50–2:15)

- **Screen:** Mission Control detail view — checkpoints, execution
  waves, deterministic health signals (the real captured state).
- **Camera:** Static, then a quick cut to AI Settings showing the
  provider list (5 connected providers, one active).
- **Callout:** Split-screen text: "Chat. Ctrl+I. Workflows. Missions. Diagnosis." → "One pipeline."
- **VO:** *"Chat, inline code actions, workflows, missions, diagnosis — every AI feature in AURA runs through the same three entry points. Validation, retry, and error handling are implemented once, and apply everywhere. That's why switching providers is instant — and why adding a new one, like Qwen, is a single small adapter, not a rewrite."*

### Scene 8 — Close (2:15–2:40)

- **Screen:** Cut back to the Home screen, then slow zoom into the AURA
  logomark, background fading to the dot-grid starfield from Scene 1 —
  a visual bookend.
- **Camera:** Slow push-in, 3s, ending on the logomark centered.
- **Callout (final title card):**
  ```
  AURA Hub
  The AI-Native Engineering Environment

  github.com/Aura-hub-ai-native-workspace/aura-hub
  ```
- **VO:** *"AURA Hub — the AI-native engineering environment."*
- **Music/sound:** Fade out under the final VO line, silence on the
  title card for one beat before cut to black.

---

## Voice-over script (full, read-through)

> Every AI coding tool gives you a chat window. AURA gives you an
> environment.
>
> Most tools re-derive context from whatever's in the buffer. They don't
> know your architecture. They don't remember yesterday's decisions. The
> chat window is a guest in someone else's house.
>
> AURA has no built-in AI. Connect any of eleven providers — OpenAI,
> Anthropic, Groq, Qwen, and more — and every feature works identically,
> immediately.
>
> Before any model is called, AURA already understands the codebase — a
> real knowledge graph, not a best-effort text search.
>
> The answer is grounded — real retrieved files, real relationships,
> real memory recalled. Not a guess dressed up as confidence.
>
> Describe an automation in plain language. AURA builds a real, runnable
> graph — against the platform's actual node registry. Nothing
> simulated.
>
> Chat, inline code actions, workflows, missions, diagnosis — every AI
> feature in AURA runs through the same three entry points. Validation,
> retry, and error handling are implemented once, and apply everywhere.
> That's why switching providers is instant — and why adding a new one,
> like Qwen, is a single small adapter, not a rewrite.
>
> AURA Hub — the AI-native engineering environment.

**Estimated read time at a measured pace (~140 wpm): ~2:05** — leaves
room for the silent open/close beats to land the full cut at ~2:40.

---

## Production notes

- **Capture method:** Real screen recording against the running app
  (`npm run dev` + `npm run ai`), same setup used for the static
  screenshot gallery — not motion-graphics recreations of the UI.
- **No fabricated numbers.** Every stat shown on screen (entity counts,
  token counts, latency, node/connection counts) must come from an
  actual run at recording time, not the example values in this script —
  re-run each scene and use whatever the real output is.
- **Cursor:** Visible throughout except Scene 1 and Scene 8 (kept clean
  for the bookend shots).
- **Captions:** Burn in the VO as captions by default (silent-autoplay
  is the common viewing context on GitHub/social).
- **Ending screen asset:** A static title card matching Scene 8's
  callout — reuse the hero treatment from `website/index.html` for
  visual consistency between the video and the site.
