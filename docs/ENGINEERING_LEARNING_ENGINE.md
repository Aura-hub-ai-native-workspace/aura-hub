# Engineering Learning Engine

A deterministic analytics layer that sits on top of Engineering Memory (see `docs/ENGINEERING_MEMORY.md`) and turns raw event records into engineering knowledge: patterns, risk predictions, insights, trends and an engineering health score.

It is **rule-based intelligence** — statistics, trend detection and graph-derived signals over real memory records. No machine learning, no fabricated numbers, no placeholder predictions. The API is deliberately shaped so a future ML model can replace `analyzeMemories` behind the same types.

## Architecture

```
Engineering Memory (persisted localStorage 'aura.ops.memory')
        │
        ▼
  ops/learningEngine.ts          ← the Learning Engine (pure, deterministic)
  analyzeMemories(memories)
        │
        ├──► patterns            repeated bugs · hot/unstable/reliable modules
        │                        AI acceptance · architecture hotspots ·
        │                        mission bottlenecks · workflow habits
        ├──► insights            headline statistics behind the patterns
        ├──► predictions         break risk · refactor · debt growth ·
        │                        architecture risk · dependency churn ·
        │                        regressions (confidence + mitigations)
        ├──► trends              14-day time series + direction deltas
        └──► health              Project / Architecture / Knowledge /
                                 Mission / Memory / Learning-confidence
        │
        ▼
  Consumers:
    ops/EngineeringLearning.tsx  ← "Engineering Learning" panel (screen + panel)
    EngineeringOverview          ← dashboard card (health + top signals)
    useConversations.send        ← AI Chat answers learning questions locally
```

## Data flow

1. **Capture** — `ops/memoryRecorder.ts` records real engineering events into the memory store (editor saves, AI accept/reject, diagnosis decisions, missions, conversations, provider switches, backend memory items). Every record carries a stable `dedupe` key.
2. **Analyze** — `useLearningEngine(projectId?)` recomputes `analyzeMemories` over the scoped memory list via `useMemo`. The engine never polls; it derives from whatever memory already exists.
3. **Consume** — the panel, dashboard card and AI chat all read the same `EngineAnalysis` object, so every surface agrees.

## Pattern discovery

All patterns require a minimum sample count (`MIN_SAMPLES = 2`) — a single event never becomes a "pattern".

| Pattern | Derived from |
|---------|--------------|
| `repeated-bug` | diagnosis events grouped per file (title: "`file` has failed diagnosis N times") |
| `hot-module` | editor-save (`source='editor'`) events grouped per file |
| `unstable-module` | per-file `(diagnoses + declined AI) / total touches` ratio, descending |
| `reliable-module` | files with ≥3 edits and zero diagnoses / zero declined proposals |
| `ai-rejection` | per-file AI acceptance rate `< 40%` (accepted vs declined `ai-action` memories) |
| `architecture-hotspot` | per-layer count of `critical`/`high` importance + diagnosis events |
| `mission-bottleneck` | missions with failed executions / failed tasks (via `missionId`) |
| `workflow-habit` | hour-of-day histogram + bursts (≥3 events in one `project:hour`) |

## Prediction engine

Each prediction carries `target`, `risk`, `confidence`, an evidence-based `detail`, and concrete `actions`. Confidence is a bounded function of evidence strength and recency — never a guess.

| Prediction | Evidence rules |
|------------|----------------|
| `file-break` | files with ≥1 diagnosis; recent diagnoses and rejections raise the score |
| `refactor` | ≥3 edits combined with diagnoses or declined AI proposals |
| `debt-growth` | per-file edit rate rising between the first and second half of the 14-day window |
| `architecture-risk` | layers where ≥50% of events are critical/high importance |
| `dependency-churn` | files with heavy recent touches (repeated nearby edits) |
| `regression` | a diagnosis following an accepted AI change on the same file within 7 days |

## Trend detection

Daily buckets over the last 14 days produce six trend series: activity, diagnosis rate, AI acceptance, mission failures, knowledge growth and code changes. A `delta` compares the average of the second half against the first; direction is `up`/`down`/`flat` beyond a ±10% threshold, with tone based on whether movement is good or bad for that metric.

## Health score

Six components, each 0–100, weighted into an overall score:

| Component | Weight | Basis |
|-----------|--------|-------|
| Project | 25% | diagnosis ratio + critical-event penalty |
| Architecture | 20% | critical/high share among architecture/layer records |
| Knowledge | 15% | knowledge items + freshness |
| Mission | 20% | completed ÷ (completed + failed) missions |
| Memory | 10% | record freshness + coverage − cap pressure |
| Learning confidence | 10% | record count + freshness (grows with data) |

When fewer than 5 records exist the score is marked **insufficient** and the UI shows a "collecting" state — the engine refuses to fake confidence.

## AI chat integration

`useConversations.send` first calls `answerLearningQuestion(text, projectId, scopeLabel)`. When the question matches a learning intent (most-bugs, stability, learned patterns, decisions, health, risk/predictions, trends), the answer is generated **deterministically from real memory** and delivered locally (no backend stream), persisted to the conversation with `meta.learning = true`. Everything else falls through to the normal grounded AI pipeline. Because `answerLearningQuestion` reads `useMemoryStore` directly, it works even when the backend is offline.

## Future ML integration

The engine is intentionally separable. To replace rule-based analysis with a model:

1. Keep the `EngineAnalysis`, `LearningPattern`, `LearningPrediction`, `LearningTrend`, `EngineeringHealth` types unchanged.
2. Swap the body of `analyzeMemories` for an ML inference call (optionally feeding the persisted memory list, which already includes a reserved `embedding: number[] | null` field per record).
3. Consumers (`EngineeringLearning.tsx`, dashboard, chat) require no changes — they only see the stable types.

## Files

- `apps/desktop/src/ops/learningEngine.ts` — engine core: patterns, predictions, insights, trends, health, React hook, chat answering
- `apps/desktop/src/ops/EngineeringLearning.tsx` — panel UI (Patterns / Predictions / Trends / Health tabs, SVG trend charts, health ring)
- `apps/desktop/src/ops/panels/EngineeringLearningPanel.tsx` — workspace-panel wrapper
- `apps/desktop/src/ops/EngineeringOverview.tsx` — dashboard learning card
- `apps/desktop/src/ai/useConversations.ts` — local deterministic learning answers in chat
- `apps/desktop/src/ops/layoutStore.ts`, `ops/panels.tsx`, `shell/useCommands.ts` — panel + palette registration
