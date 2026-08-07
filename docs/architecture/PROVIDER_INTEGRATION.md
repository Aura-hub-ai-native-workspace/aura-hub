# AURA — Provider Integration (BYOAK Runtime)

> Internal architecture reference. This document describes systems that
> **exist and run today** in this codebase. Anything not present in the
> real source is marked **Future Extension — Architecture Planned** and
> must not be treated as built. If a future engineer cannot find the file
> path referenced next to a claim in this document, the claim is wrong —
> fix the document, not your assumptions.

---

## 1. Overview

AURA is **bring-your-own-key (BYOAK) only**. There is no built-in model
and no hidden default API account: the hub has no AI until the user
connects one of the registered providers with their own API key, either
in the onboarding flow, in **AI Settings**, or through an environment
variable at startup.

Every provider is a small **adapter** that implements one shared
interface. The rest of the system — validation, model discovery,
encrypted key storage, the runtime manager, switching, the HTTP layer
and the UI — is 100% generic and never branches on a provider id. This
is what makes adding a provider a one-file task.

Registered today (`packages/ai-service/src/provider/registry.ts`):

| id | Provider | Adapter | Default model |
|----|----------|---------|---------------|
| `groq` | Groq | `adapters/groq.ts` | `llama-3.3-70b-versatile` |
| `openai` | OpenAI | `adapters/openai.ts` | — |
| `anthropic` | Anthropic | `adapters/anthropic.ts` | — |
| `gemini` | Gemini | `adapters/gemini.ts` | — |
| `nvidia` | NVIDIA | `adapters/nvidia.ts` | `meta/llama-3.1-8b-instruct` |
| `openrouter` | OpenRouter | `adapters/openrouter.ts` | — |
| `mistral` | **Mistral AI** | `adapters/mistral.ts` | `mistral-large-latest` |
| `cerebras` | **Cerebras** | `adapters/cerebras.ts` | `llama3.3-70b` |
| `kimi` | Kimi | `adapters/kimi.ts` | — |
| `novita` | **Novita AI** | `adapters/novita.ts` | `deepseek/deepseek-r1` |
| `qwen` | **Qwen** | `adapters/qwen.ts` | `qwen-plus` |

---

## 2. Provider Registration

`packages/ai-service/src/provider/registry.ts` owns the adapter list.

```ts
const ALL: ProviderAdapter[] = [
  new GroqAdapter(),
  /* … */
  new MistralAdapter(),
  /* … */
];
const adapters: Map<string, ProviderAdapter> = new Map(ALL.map((a) => [a.metadata.id, a]));
```

- `registerAdapter(adapter)` inserts/replaces an adapter by `metadata.id`
  (used by tests and by `registerProvider` in `provider/index.ts`).
- `getAdapter(id)`, `getAllAdapters()`, `getAdapterIds()` are the only
  lookup helpers the rest of the codebase is allowed to use.
- Registration order is irrelevant — the map keys on provider id.

The registry also declares the optional **environment-variable map**:

```ts
export const ENV_VAR_BY_PROVIDER: Record<string, string> = {
  mistral: 'MISTRAL_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
};
```

A set variable auto-connects (and activates) that provider at startup
through the exact same path as a manual connect in Settings — see
[§7 Configuration](#7-configuration).

---

## 3. The `ProviderAdapter` contract

`packages/ai-service/src/provider/types.ts`:

```ts
export interface ProviderAdapter {
  readonly metadata: ProviderMetadata;          // { id, name, description, docsUrl? }
  detect(apiKey: string): boolean;              // client key-prefix hint (heuristic only)
  validate(apiKey: string): Promise<{ ok: boolean; error?: string }>;
  discoverModels(apiKey: string): Promise<DiscoveredModel[]>;
  createRuntime(apiKey: string, model?: string): Runtime;
  checkHealth(apiKey: string): Promise<ProviderHealth>;  // { ok, latencyMs, error?, lastChecked }
}
```

Most providers extend **`BaseOpenAICompatible`**
(`packages/ai-service/src/provider/adapters/base.ts`), which implements
`validate`, `discoverModels`, `checkHealth` against an OpenAI-compatible
`GET {baseUrl}/models`, and provides `makeRuntime(...)` returning a
streaming `OpenAICompatibleRuntime` (SSE `chat/completions`). A new
OpenAI-compatible provider is therefore usually just:

```ts
export class MyProviderAdapter extends BaseOpenAICompatible {
  readonly metadata = { id: 'myprovider', name: 'My Provider', description: '…', docsUrl: 'https://…' };
  protected baseUrl = 'https://api.example.com/v1';
  detect(apiKey: string): boolean { return apiKey.startsWith('mp_'); }
  createRuntime(apiKey: string, model?: string): Runtime {
    return this.makeRuntime({ baseUrl: this.baseUrl, apiKey, defaultModel: model || 'current-production-model' });
  }
}
```

Rules for adapter authors:

- **No provider-specific branches anywhere else.** The runtime, store,
  server and UI must never `if (id === 'mistral') …`. Provider
  differences live inside the adapter.
- **`detect()` is a heuristic**, used by `autoConnectProvider` and the
  client-side key-prefix screen. It must never be the only path a
  provider can be connected through (providers without a distinctive
  key prefix, like Mistral and NVIDIA, return `false`).
- **`createRuntime` must always work.** The default model should be a
  current production model; when the provider exposes a `/models` API
  the runtime is driven by user-selected discovered models anyway.

### 3.1 Error states

Validation and health checks classify failures into stable,
user-facing states (`base.ts::classifyError`):

| State | Trigger |
|-------|---------|
| Connected | `GET /models` → 2xx |
| Invalid API key | HTTP 401 |
| Unauthorized | HTTP 403 |
| Rate limited | HTTP 429 |
| Network error | fetch/connection failure (DNS, TLS, refused, timeout) |
| HTTP `<status>` | any other non-2xx |

These labels surface in the onboarding key input and in **AI Settings** —
every OpenAI-compatible provider shares them because they live in the
base class, not in any single adapter.

---

## 4. Authentication & Key Storage

`packages/ai-service/src/provider/credentialStore.ts` persists keys in a
single JSON store (`~/.aura/providers.json`, override with `AURA_HOME`).

- Keys are encrypted at rest with **AES-256-GCM**. The encryption seed
  is `AURA_PROVIDER_SECRET` when set, otherwise a random secret the
  store generates on first use.
- Only a **fingerprint** (`first4…last4` of the key) is ever exposed to
  the UI or API — the raw key never leaves the store once validated.
- API: `storeKey`, `getKey`, `removeKey`, `getFingerprint`, `isConnected`,
  `getAllProviderStores`, `storeModels`, `storeHealth`, `setActive`,
  `getActive`.

The connect flow (`packages/ai-service/src/workspace.ts::connectProvider`)
is generic and identical for every provider:

```
adapter.validate(key)            → reject with classified error if not ok
storeKey(providerId, key)        → encrypted persistence + fingerprint
adapter.discoverModels(key)      → refresh model list (best effort)
adapter.checkHealth(key)         → store { ok, latencyMs, lastChecked }
runtimeManager.switchToProvider  → becomes the active runtime
```

---

## 5. Runtime Integration

`packages/ai-service/src/provider/index.ts` exports `RuntimeManager`, a
singleton owned by the pipeline:

- `runtime` / `hasRuntime` — the active `Runtime` (or null).
- `switchToProvider(id, model?)` — reads the stored key, builds the
  runtime via the adapter and persists the active choice.
- `deactivate()` — turns AI off (no provider until one is connected).
- `byoakStatus()` — connected providers + active id/model for the UI.

`Runtime` (`@aura/runtime` types; implemented by
`OpenAICompatibleRuntime` in `base.ts`) exposes:

- `generate(request)` — non-streaming completion, returns content + usage.
- `stream(request)` — `AsyncIterable<StreamChunk>` over SSE tokens
  (`data:` deltas, usage chunk, `[DONE]`).
- `cancel()` — aborts the in-flight request via `AbortController`.
- `health()` — liveness probe with latency.

All AI features — chat, project intelligence, diagnosis, mission
execution, workflows (`workflow/nodes.ts`) — route their model calls
through the single active runtime, so switching providers switches the
entire platform at once.

---

## 6. Provider Switching

`POST /providers/switch` (`packages/ai-service/src/server.ts`):

```json
{ "providerId": "mistral", "model": "mistral-large-latest" }
```

- Replaces the active runtime with the chosen provider's runtime.
- The new provider must already be connected (have a stored key);
  otherwise the call returns `{ ok: true, error: "No API key configured" }`
  and the hub stays AI-less.
- `{ "providerId": "none" }` deactivates AI entirely.
- The runtime manager restores the previously active provider on startup
  from the store, so the choice survives restarts.

Switching is exercised end-to-end by the verification script
(`scripts/verify-providers.ts`), which connects and switches between
mock OpenAI-compatible endpoints.

---

## 7. Configuration

| Variable | Purpose |
|----------|---------|
| `MISTRAL_API_KEY` | Env-configures Mistral: validates, stores and **activates** it at startup (see §2). |
| `CEREBRAS_API_KEY` | Env-configures Cerebras: validates, stores and **activates** it at startup (see §2). |
| `AURA_HOME` | Override the config home (default `~/.aura`); also where `providers.json` lives. |
| `AURA_PROVIDER_SECRET` | Deterministic AES seed for the provider store (instead of a generated secret). |
| `AI_PORT` | Local service port (default `4319`). |

Env auto-connect runs at `startService` and is deliberately a no-op when
the variable is unset or the provider is already connected. A rejected
key logs a warning and never blocks server startup.

---

## 8. Mistral AI — first-class provider

Mistral is a full peer of Groq and NVIDIA:

- **Adapter** — `packages/ai-service/src/provider/adapters/mistral.ts`,
  extends `BaseOpenAICompatible`, base URL `https://api.mistral.ai/v1`,
  default model `mistral-large-latest`, docs link to
  `https://console.mistral.ai/api-keys`. Mistral keys have no distinctive
  prefix, so `detect()` returns `false` and the user picks Mistral
  explicitly (onboarding card / Settings dialog).
- **Validation** — real `GET /models` call; classified states (401 → Invalid
  API key, 429 → Rate limited, network → Network error, 2xx → Connected).
- **Discovery** — dynamic via the Mistral Models API; the stored model
  list feeds the model dropdown in **AI Settings**.
- **Runtime** — streaming SSE `chat/completions` through the shared
  OpenAI-compatible runtime: generate, stream, cancel, health.
- **Switching** — identical to any provider via `RuntimeManager`.
- **Environment** — `MISTRAL_API_KEY` auto-connects and activates
  Mistral at startup.
- **UI** — featured onboarding card (with *Free Tier / EU-Based* badges)
  alongside Groq and NVIDIA, plus the generic Settings connect dialog,
  status card (provider, model, latency, last validation) and Status Bar.

---

## 9. Cerebras — first-class provider

Cerebras is a full peer of Groq, NVIDIA and Mistral:

- **Adapter** — `packages/ai-service/src/provider/adapters/cerebras.ts`,
  extends `BaseOpenAICompatible`, base URL `https://api.cerebras.ai/v1`,
  default model `llama3.3-70b`, docs link to
  `https://cloud.cerebras.ai/platform/api-keys`. Cerebras keys use the
  `csk_` prefix, so `detect()` returns `true` for `csk_`-prefixed keys and
  auto-detection (server-side `detectProvider` and the client-side
  key-prefix hint) resolves them to Cerebras.
- **Validation** — real `GET /models` call; classified states (401 → Invalid
  API key, 403 → Unauthorized, 429 → Rate limited, network → Network error,
  any non-2xx → HTTP `<status>`, 2xx → Connected).
- **Discovery** — dynamic via the Cerebras Models API (`GET /models`); the
  stored model list feeds the model dropdown in **AI Settings**. No model
  IDs are hardcoded beyond the connect-time default.
- **Runtime** — streaming SSE `chat/completions` through the shared
  OpenAI-compatible runtime: generate, stream, cancel, health.
- **Switching** — identical to any provider via `RuntimeManager`.
- **Environment** — `CEREBRAS_API_KEY` auto-connects and activates
  Cerebras at startup through the same `ENV_VAR_BY_PROVIDER` path as
  `MISTRAL_API_KEY`.
- **UI** — featured onboarding card (with *Ultra Fast / High Throughput*
  badges) alongside Groq, NVIDIA and Mistral, plus the generic Settings
  connect dialog, status card (provider, model, latency, last validation)
  and Status Bar.

---

## 10. Novita AI — first-class provider

Novita is a full peer of Groq, NVIDIA, Mistral and Cerebras:

- **Adapter** — `packages/ai-service/src/provider/adapters/novita.ts`,
  extends `BaseOpenAICompatible`, base URL `https://api.novita.ai/openai/v1`,
  default model `deepseek/deepseek-r1`, docs link to
  `https://novita.ai/docs/api-reference/basic-authentication`. Novita keys
  have no distinctive prefix, so `detect()` returns `false` and the user
  picks Novita explicitly (Settings connect dialog).
- **Validation** — real `GET /models` call through the shared
  `BaseOpenAICompatible` implementation; same classified states as every
  other OpenAI-compatible adapter (§3.1).
- **Discovery** — dynamic via Novita's Models API; the stored model list
  feeds the model dropdown in **AI Settings**.
- **Runtime** — streaming SSE `chat/completions` through the shared
  OpenAI-compatible runtime: generate, stream, cancel, health.
- **Switching** — identical to any provider via `RuntimeManager`.
- **UI** — generic Settings connect dialog, status card, model dropdown
  and Status Bar — no bespoke UI, same as Kimi/OpenRouter/NVIDIA.

## 11. Qwen (Alibaba Cloud Model Studio) — first-class provider

Qwen is a full peer of every provider above:

- **Adapter** — `packages/ai-service/src/provider/adapters/qwen.ts`,
  extends `BaseOpenAICompatible`, base URL
  `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (the
  international/Singapore DashScope endpoint — deliberately not the
  workspace-scoped `{WorkspaceId}.{region}.maas.aliyuncs.com` variant
  Alibaba also documents, which would require collecting a second piece
  of per-user config beyond an API key), default model `qwen-plus` (a
  real model id from Alibaba's own quickstart examples), docs link to
  `https://www.alibabacloud.com/help/en/model-studio/first-api-call-to-qwen`.
  DashScope keys share the generic `sk-` prefix OpenAI's adapter already
  claims, so `detect()` returns `false` — the user picks Qwen explicitly,
  same honest choice as Novita/NVIDIA/OpenRouter/Gemini.
- **Validation** — real `GET /models` call through the shared
  `BaseOpenAICompatible` implementation; same classified states as every
  other OpenAI-compatible adapter (§3.1). Verified live against the real
  endpoint: an unauthenticated request returns 401 (not 404 — the route
  exists) and a fabricated key through the full `/providers/connect` path
  returns `{"ok":false,"error":"Invalid API key (401)"}` from Alibaba's
  actual servers.
- **Discovery** — dynamic via DashScope's OpenAI-compatible Models API;
  the stored model list feeds the model dropdown in **AI Settings**.
- **Runtime** — streaming SSE `chat/completions` through the shared
  OpenAI-compatible runtime: generate, stream, cancel, health.
- **Switching** — identical to any provider via `RuntimeManager`.
- **UI** — generic Settings connect dialog, status card, model dropdown
  and Status Bar; `spark` icon in `AiSettings.tsx::providerIcon()`. No
  bespoke UI or provider-specific branches anywhere in the codebase.

---

## 12. API Surface

`GET /providers` — known providers, connected providers (fingerprint,
models, health), active id/model, pipeline status.

`POST /providers/connect` — `{ providerId, apiKey }` → validate, store,
discover, health, activate.

`POST /providers/disconnect` — `{ providerId }` → remove stored key;
deactivates if it was active.

`POST /providers/switch` — `{ providerId, model? }` → activate provider.

`GET /providers/models` — `{ providerId, apiKey }` → re-discover models.

`GET /models` — models of the active runtime (if any).

---

## 13. UI Surfaces

- **Onboarding** (`apps/desktop/src/onboarding/WorkspaceActivation.tsx`)
  — featured provider cards, live debounced key validation through the
  local service, "Other Providers" accordion.
- **Key prefix hints** (`apps/desktop/src/onboarding/detectProviderId.ts`)
  — client-side heuristic for `gsk_`, `nvapi-`, `csk_`, `sk-ant-`,
  `sk-or-`, `AIza`, `sk-`. Providers without a recognizable prefix
  (Mistral) are selected manually.
- **AI Settings** (`apps/desktop/src/screens/ai/AiSettings.tsx`) —
  connect dialog, per-provider status (key fingerprint, active badge),
  status card (provider, model, latency, last validation, connection
  health), model dropdown, test-connection button.
- **Status Bar** (`apps/desktop/src/shell/StatusBar.tsx`) — active
  provider + model, fed by the status poller (`ops/statusStore.ts`).
