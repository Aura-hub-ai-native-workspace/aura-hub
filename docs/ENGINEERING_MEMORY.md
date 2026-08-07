# Engineering Memory Platform

A persistent subsystem that records the *engineering* history of the workspace — not chat. Every record derives from a real engineering event observed through public engine APIs or explicit user actions. There is no synthetic memory: a memory exists only because something actually happened.

- **Source of truth** — persisted in `localStorage` under `aura.ops.memory`, cap 4000 records.
- **Deduplicated** — each real event maps to one stable `dedupe` key, so polls and re-ingestion can never double-record (across restarts too).
- **Queryable** — Timeline, History, Search, Filters, Importance, Related Memories, and a force-layout Memory Graph.

## Memory model

A `MemoryItem` has:

| Field        | Meaning |
|--------------|---------|
| `id`         | Stable `memo-<n>` id (monotonic counter) |
| `projectId`  | Owning project, if the event is project-scoped |
| `at`         | ISO timestamp of the event |
| `category`   | `architecture \| code \| mission \| diagnosis \| documentation \| review \| decision \| learning` |
| `importance` | `critical \| high \| medium \| low` |
| `title`      | Short human-readable subject |
| `summary`    | One-sentence description |
| `reason`     | *Why* it matters — always recorded with the event |
| `user`       | `human \| ai \| system` |
| `source`     | `editor \| ai-action \| mission \| diagnosis \| conversation \| memory-item \| provider \| system` |
| `files`      | File paths involved |
| `symbols`    | Symbols involved |
| `layer`      | App layer, e.g. `engine \| service \| desktop` |
| `dependencies` | Related files referenced by the event |
| `missionId` / `diagnosisId` | Cross-references into Mission Control / Diagnostics |
| `refs`       | Related memory ids (scored at record time) |
| `embedding`  | `number[] \| null` — reserved for future semantic search |
| `dedupe`     | Stable key for the underlying real event |

### Importance rules (`importanceOf`)

Deterministic, not random:

- `review`, `decision` → **high**
- `mission` with failed execution → **critical**
- `diagnosis` accepted/rejected, AI code change → **high**
- `documentation` → **medium**
- `learning` → **medium**
- everything else → **low**

## Real event sources

All capture paths call public client APIs — no private engine internals are reached.

| Source | Real event | Capture mechanism |
|--------|-----------|-------------------|
| Editor | File saved (dirty → clean transition) with line diff counts | `useEditorStore.subscribe(reconcileEditor)`, hour-deduped per file |
| AI Action | Proposal accepted / declined | `recordAiActionMemory` called from `AIActionDialog` accept / close handlers |
| Diagnosis | Fix accepted / rejected | `recordDiagnosisMemory` called from `useDiagnosis` after successful `accept` / `reject` |
| Missions | Mission summaries + execution timeline entries (`task-accepted`, `task-completed`, `task-failed`, `review-passed`, …) | `missionClient.dashboard()` + `missionClient.list()` via 30s `reconcileAll()` |
| Diagnoses | Backend diagnosis records incl. decision state | `diagnosisClient.list()` via `reconcileAll()` |
| Conversations | Project conversations (`title`, `messageCount`, `preview`) | `aiClient.listConversations()` via `reconcileAll()` |
| Providers | Provider switch (active model diff) | `aiClient.getProviders()` via `reconcileAll()`, baseline compare |
| Backend memory | Memory items (`code`, `decision`, `correction`, `learning`, `accepted`, `rejected`, …) | `aiClient.listMemory()` via `reconcileAll()` |

### Dedupe keys

- Editor save: `editor:<projectId>:<path>:<utcHour>`
- AI action: `ai-action:<projectId>:<file>:<accepted|declined>:<eventTime>`
- Diagnosis: `diagnosis:<id>:<accepted|rejected>`
- Mission summary: `mission:<id>:<createdAt>`
- Mission timeline entry: `mission:<id>:<taskId>:<type>`
- Backend memory item: `memory:<id>`
- Conversation: `conversation:<id>:<updatedAt>`
- Provider switch: `provider:<projectId>:<model>:<time>`

## Capture pipeline

```
real event ─► explicit hook (recordAiActionMemory / recordDiagnosisMemory)
           ─► 30s reconcileAll()  ─► record() ─► importanceOf()
           ─► useEditorStore.subscribe(reconcileEditor)
                                    │
                                    ▼
                          dedupe check (stable key)
                                    │
                                    ▼
                         MemoryStore (Zustand, persisted)
                                    │
                     localStorage 'aura.ops.memory' (cap 4000)
```

`startMemoryRecorder()` (mounted once in `App`) subscribes the editor and kicks off the reconcile loop; it returns a stop function for teardown.

## Queries

- **Search** — token substring match over title, summary, reason, files, symbols, layer, dependencies.
- **Filters** — categories, importances, project, free-text query; live counts shown ("N shown of M").
- **Related memories** (`relatedMemories`) — scoring: shared `missionId`/`diagnosisId` (+4 each), shared file (+2), shared symbol (+2), shared layer (+1), shared dependency (+1). Top 8 by score.
- **Memory graph** (`layoutMemoryGraph`) — deterministic 90-iteration force layout (ring init, repulsion + spring + center pull, clamped 0.06–0.94), capped at 60 nodes; edges from shared mission/diagnosis/file/symbol/layer.

## UI

- **Timeline** — day-grouped view (`Today` label), `Show more` cap of 200 entries.
- **History** — virtualized flat list (item height 44).
- **Graph** — SVG, category-colored nodes, click-to-select, `<title>` tooltips, `var(--…)` CSS tokens.
- **Detail** — summary/reason, quick-open Mission & Diagnosis, clickable file chips that open the editor, symbols, layer/deps, user/source/project meta, Related Memories.
- **Integration** — dockable as the `engineering-memory` panel (added to `PanelKind`), dashboard card in `EngineeringOverview`, palette command `Open Engineering Memory`.

## Future work

- Populate `embedding` via the provider chain and enable semantic (vector) search.
- Cross-link memory into the Knowledge Fabric (already reading `listMemory`; a write-back path is possible).
- Export / import memories for portability.
