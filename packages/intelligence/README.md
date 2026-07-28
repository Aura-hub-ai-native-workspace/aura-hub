# @aura/intelligence

The **intelligence foundation** for AURA Hub — a modular, provider-agnostic
pipeline. This package is **architecture only**:

- ❌ no AI SDK
- ❌ no API calls / network
- ❌ no RAG implementation
- ❌ no business logic
- ✅ clean, documented interfaces
- ✅ a runnable, offline placeholder end-to-end
- ✅ a single seam where any real provider plugs in later

## The pipeline

```
User
 ↓  IntelligenceRequest
Intent Classifier      → Intent
 ↓
Prompt Enhancer        → EnhancedPrompt
 ↓
Context Builder        → IntelligenceContext        (retrieval/memory seam)
 ↓
Task Router            → RoutingDecision
 ↓
Specialized Engine     → ProviderRequest            (neutral shape)
 ↓
Provider Adapter       → ProviderResponse           ← THE SEAM (placeholder today)
 ↓
Response Pipeline      → IntelligenceResponse        (middleware chain)
```

The `IntelligenceKernel` orchestrates all stages and records a `PipelineTrace`
for every request.

## Quick start

```ts
import { createIntelligenceKernel, createRequest } from '@aura/intelligence';

const kernel = createIntelligenceKernel();               // all defaults
const res = await kernel.run(createRequest('Summarize the architecture doc'));

res.intent.type;   // 'summarize'
res.engineId;      // 'summarize-engine'
res.providerId;    // 'placeholder'
res.text;          // placeholder output
res.trace.stages;  // per-stage timings
```

Streaming:

```ts
for await (const ev of kernel.stream(createRequest('explain the seam'))) {
  if (ev.type === 'delta') process.stdout.write(ev.text);
  if (ev.type === 'final') console.log(ev.response.usage);
}
```

## Design guarantees

1. **Dependency direction is one-way.** The kernel and every stage depend only
   on **interfaces**. No upper layer imports a concrete provider, engine, or
   classifier. The composition root (`config.ts`) is the only place concrete
   classes are named.
2. **The provider seam is the only backend boundary.** Everything above
   `ProviderAdapter` is provider-agnostic. `ProviderRequest` / `ProviderResponse`
   are neutral shapes. An SDK/HTTP client may live **only** inside an adapter.
3. **Everything is replaceable via config.** Any stage can be swapped without
   touching another.

## Replacing any stage

Every field of `IntelligenceConfig` is optional and defaults to a placeholder:

```ts
createIntelligenceKernel({
  classifier:      myClassifier,      // implements IntentClassifier
  enhancer:        myEnhancer,        // implements PromptEnhancer
  contextBuilder:  myContextBuilder,  // implements ContextBuilder
  router:          myRouter,          // implements TaskRouter
  engines:         [myEngine, ...],   // implement SpecializedEngine
  providers:       [myProvider],      // implement ProviderAdapter
  responsePipeline: myPipeline,       // implements ResponsePipeline
});
```

### Adding a real provider (the whole point)

Implement `ProviderAdapter` and register it. **No layer above changes.**

```ts
import { BaseProviderAdapter, type ProviderRequest, type ProviderResponse } from '@aura/intelligence';

class MyProvider extends BaseProviderAdapter {
  info = { id: 'my-provider', name: 'My Provider', capabilities: ['streaming', 'system-prompt'] };

  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    // 1. translate req.messages → the provider's native request
    // 2. call the provider   ← the ONLY place an SDK/HTTP client belongs
    // 3. translate the native response → ProviderResponse
    return { content, finishReason: 'stop', usage, providerId: this.info.id };
  }

  // optional: async *stream(req) { ... }   ← enables kernel.stream()
}

const kernel = createIntelligenceKernel({
  providers: [new MyProvider()],
  defaultProviderId: 'my-provider',
});
```

The `ProviderRegistry` matches engine-declared **capabilities** to provider
capabilities, so engines request _what they need_ (streaming, tools, vision…),
never _who_ provides it.

### Adding retrieval / memory (no RAG here, just the seam)

The `ContextBuilder` fans out to `ContextProvider`s. A future vector retriever,
project-memory store, or knowledge graph implements one interface:

```ts
const retriever: ContextProvider = {
  id: 'vector-retriever',
  async provide({ request, intent, prompt }) {
    return [/* ContextSource[] — the builder ranks & budgets them */];
  },
};
createIntelligenceKernel({ contextBuilder: new StaticContextBuilder({ providers: [retriever] }) });
```

## Interfaces at a glance

| Stage | Interface | Default (placeholder) |
| --- | --- | --- |
| 1 · Intent | `IntentClassifier` | `KeywordIntentClassifier` |
| 2 · Enhance | `PromptEnhancer` | `TemplatePromptEnhancer` |
| 3 · Context | `ContextBuilder` (+ `ContextProvider`) | `StaticContextBuilder` |
| 4 · Route | `TaskRouter` | `RuleBasedTaskRouter` |
| 5 · Engine | `SpecializedEngine` (+ `EngineRegistry`) | Chat / Code / Summarize / Search |
| 6 · Provider | `ProviderAdapter` (+ `ProviderRegistry`) | `PlaceholderProvider` |
| 7 · Response | `ResponsePipeline` (+ `ResponseMiddleware`) | `DefaultResponsePipeline` |
| — · Telemetry | `Logger`, `TraceRecorder` | `NoopLogger` |

## Demo

`runDemo()` (in `src/demo.ts`) runs several prompts and a streaming example
end-to-end, fully offline — proving the layers above the seam need nothing from
a real backend.

## Status

Foundation complete. When a provider is chosen, implement one `ProviderAdapter`
and register it as default. Nothing else moves.
