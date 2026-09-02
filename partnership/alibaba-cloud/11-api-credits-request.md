Subject: API credits request — AURA Hub / Qwen integration

Hi [Name],

A specific, scoped ask following up on the integration overview I sent
over.

**What we'd use credits for**, concretely:

1. **Close our one honest verification gap.** Our Qwen adapter is
   verified live for connectivity and error handling (a real 401 from
   your international endpoint), but we have not yet run a real,
   authenticated chat completion — we don't have a provisioned DashScope
   key in our build environment. A small credit grant lets us do that
   and confirm generation, streaming, and usage-reporting all behave as
   expected end-to-end.
2. **Produce real demo material.** We have five demo scripts already
   written (`docs/QWEN_DEMOS.md` in the repo) that are ready to record
   the moment Qwen is actually connected and running — AI Chat, in-editor
   code generation, natural-language workflow automation, engineering
   diagnosis, and knowledge-graph-grounded explanation.
3. **Capture screenshots with Qwen active.** Our screenshot spec
   (`docs/assets/screenshots/SCREENSHOT_GUIDE.md`) calls for at least one
   shot of AI Settings with Qwen connected and active — we'd rather that
   be a real screenshot than staged.

**Scale expectation:** on the order of a few hundred API calls total —
enough to run all five demo scripts a handful of times each, plus
verification and screenshot capture, not a production workload. AURA is
bring-your-own-key by design; we are not asking to subsidize end-user
usage, only the verification and demo work a small maintainer team can't
otherwise afford to run against a paid API. If a specific credit amount
or program has a minimum/standard grant size, we're happy to work within
that rather than name a number ourselves.

Let me know what information you need from us (repo access, more detail
on request volume, a specific program to apply through) and I'll turn it
around quickly.

Thanks,
[Your name]
