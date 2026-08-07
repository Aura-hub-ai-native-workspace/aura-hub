# Qwen (Alibaba Cloud Model Studio) — User Guide

Qwen is a first-class, bring-your-own-key AI provider in AURA Hub — the
same standing as OpenAI, Anthropic, Groq, Mistral, Cerebras, NVIDIA,
Gemini, Kimi, OpenRouter and Novita. This guide covers setup, API keys,
model selection, troubleshooting and best practices. For the internal
architecture (how the adapter is built, what it reuses), see
[`docs/architecture/PROVIDER_INTEGRATION.md`](architecture/PROVIDER_INTEGRATION.md#11-qwen-alibaba-cloud-model-studio--first-class-provider).

---

## 1. Setup Guide

1. Open **AI Settings** in AURA Hub.
2. Click **Connect Provider**.
3. Choose **Qwen** from the provider list.
4. Paste your DashScope API key and click **Connect**.
5. AURA validates the key, discovers your account's available models, and
   activates Qwen — no restart required.

That's the entire flow. There is no extra region field, workspace ID, or
config file to edit — a pasted key is all AURA needs, exactly like every
other provider.

Once connected, Qwen is available everywhere AURA calls a model: AI Chat,
Ctrl+I inline actions, the Workflow Builder's AI node generation,
Automation Studio, Mission Control's planning/review steps, and
Engineering Intelligence's diagnosis pipeline. Nothing needs to be
configured per-feature — connecting the provider once is sufficient.

## 2. API Key Guide

Qwen access goes through **Alibaba Cloud Model Studio (DashScope)**:

1. Sign in to (or create) an Alibaba Cloud account.
2. Open [Model Studio](https://www.alibabacloud.com/help/en/model-studio/first-api-call-to-qwen)
   and create a DashScope API key.
3. Copy the key — it typically looks like `sk-...`.

**Region matters.** DashScope API keys are region-bound. AURA's Qwen
adapter talks to the **international (Singapore) endpoint**
(`dashscope-intl.aliyuncs.com`). Make sure the key you generate is an
international/Singapore-region key, not a mainland-China-only one, or
connection will fail with an authentication error even though the key is
otherwise valid.

Your key is encrypted at rest (AES-256-GCM) in AURA's local provider
store, the same as every other provider — see
[Provider Integration §4](architecture/PROVIDER_INTEGRATION.md#4-authentication--key-storage).
Only a fingerprint (first 4 / last 4 characters) is ever shown in the UI.

## 3. Model Selection Guide

AURA does not hardcode a list of Qwen model names. When you connect (or
reconnect) Qwen, it calls DashScope's Models API live and populates the
model dropdown in **AI Settings → Generation** with whatever models your
account actually has access to — that list is the authoritative source,
not this document, since Alibaba adds and retires model tiers over time.

AURA's connect-time default is **`qwen-plus`** (Alibaba's own quickstart
default) if it appears in your account's discovered list; otherwise the
first discovered model is used. Alibaba publishes multiple Qwen tiers
that broadly trade off speed against capability (a "turbo" tier for
latency/cost-sensitive work, "plus" as a balanced default, "max" for the
highest-capability tier) — check the live dropdown in **AI Settings** for
the exact names and any newer/specialized variants (vision, long-context,
coder, etc.) available to your account, and switch anytime via the same
dropdown. Switching re-resolves against your live discovered list, so a
model that's been retired on Alibaba's side is never silently kept
active.

## 4. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Invalid API key (401)" on connect | Wrong region key, typo, or expired key | Regenerate an **international/Singapore** DashScope key in Model Studio and paste it again |
| "Unauthorized (403)" | Key valid but lacks permission for the model/endpoint | Check the key's permissions/quota in your Alibaba Cloud console |
| "Rate limited (429)" | Too many requests in a short window | Wait and retry — AURA automatically retries rate-limited requests with backoff; if it persists, check your DashScope quota |
| "Network error — could not reach Qwen" | Local network/firewall blocking `dashscope-intl.aliyuncs.com`, or an outage | Check connectivity to the international endpoint; try again shortly |
| Qwen connects but the model dropdown is empty | Discovery call failed or account has zero enabled models | Re-open AI Settings to retry discovery; verify at least one Qwen model is enabled for your account in Model Studio |
| Requests seem to time out | Model Studio slow to respond for a long/complex request | Increase **Timeout** in AI Settings → Reliability (default 30s), or pick a faster model tier |

Every error above is a real, classified response from AURA's shared
error translator (see [Provider Integration §3.1](architecture/PROVIDER_INTEGRATION.md#31-error-states))
— Qwen gets no special-cased messages, it uses the exact same
auth/authorization/billing/rate-limit/network/model/server-error
categories every other provider does.

## 5. Best Practices

- **Prefer the Singapore/international key** even if you're generating it
  from a mainland-China Alibaba account — it's the endpoint AURA talks
  to, and using the matching region avoids latency and auth surprises.
- **Let AURA discover models rather than assuming a name.** Alibaba's
  Qwen lineup changes; the live dropdown in AI Settings is always
  correct, this document's tier descriptions are not.
- **Match model tier to task.** Use a lighter/faster tier for quick Ctrl+I
  edits and chat, and a higher-capability tier for Workflow Builder
  generation or Engineering Intelligence diagnosis, where output quality
  matters more than latency. Switch per-task via AI Settings — switching
  is instant and doesn't require reconnecting.
- **Watch the Status card** (AI Settings) for latency and last-validation
  time if responses feel slow — it's the same health check every provider
  exposes.
- **Set Retries/Timeout deliberately** if you're on a slower network path
  to the Singapore region — AURA's defaults (2 retries, 30s timeout) work
  for most connections but are user-adjustable in AI Settings →
  Reliability.
