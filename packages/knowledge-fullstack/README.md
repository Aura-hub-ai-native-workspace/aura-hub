# @aura/knowledge-fullstack

The **production FullStack Knowledge Engine** — it doesn't index files, it
**understands a software system**. It extracts typed entities across every
layer from real files and links them into a **persistent project graph**,
then answers system-level questions with a structured `ContextPackage`.

- ✅ real recursive analysis (reuses the frozen Coding engine's scanner/reader/ignore)
- ✅ entities: pages · components · layouts · hooks · routes · endpoints · controllers · services · repositories · middleware · auth guards · ORM models · tables · migrations · env vars · dependencies · Dockerfiles · compose services · CI pipelines · build config · architecture modules · docs
- ✅ cross-layer relationships: `calls-endpoint` · `handles` · `uses-service` · `uses-repository` · `maps-to-table` · `foreign-key` · `migrates` · `renders` · `imports` · `uses-hook` · `configures` · `depends-on` · `documents` · `secured-by` · `runs-in`
- ✅ persistent graph (`.aura-fullstack/`, atomic writes), incremental updates + re-linking
- ✅ graph-aware search (where-implemented · callers-of · stores · related-to · dependencies-of)
- ✅ progress + cancellation, large repos
- ❌ no embeddings, no vector search, no Groq, no mock data — and the Coding engine is untouched

## The relationship chain it reconstructs

```
Frontend page → component → API call → endpoint → controller → service
  → repository → ORM model → table → (foreign key) → table
migration → table    auth guard ⇦ endpoint    code → env var / dependency
architecture doc → the code it describes
```

## Usage

```ts
import { FullStackKnowledgeEngine } from '@aura/knowledge-fullstack';

const engine = new FullStackKnowledgeEngine(process.cwd());
await engine.analyze({ onProgress: (p) => console.log(p.phase, p.processed) }); // full
await engine.update();                                                          // incremental + re-link

engine.search({ text: 'Where is authentication implemented?' });
engine.search({ text: 'Which frontend page calls the /api/v1/orders endpoint?' });
engine.search({ text: 'Which database table stores users?' });
engine.search({ text: 'Show everything related to payments' });
engine.search({ text: 'Find every dependency of OrderService' });

const { entities, relations, stats } = engine.graph();
const pkg = engine.toContextPackage(engine.search({ text: '...' })); // → @aura/retrieval ContextPackage
```

## Architecture (reference for the remaining engines)

| Component | Responsibility |
| --- | --- |
| `FullStackIndexer` | scan (reused) → extract per file → **re-link** whole graph; full + incremental |
| `ExtractorRegistry` | runs applicable extractors + cross-cutting env references |
| `FrontendExtractor` | pages, components, layouts, hooks, routes, API usage, assets |
| `BackendExtractor` | endpoints (Express/Nest/FastAPI), controllers, services, repositories, middleware, guards, versioning |
| `DatabaseExtractor` | tables, ORM models, columns, foreign keys, indexes, migrations (SQL/TypeORM/Prisma/Sequelize/Mongoose) |
| `ConfigExtractor` | env vars, dependencies, Dockerfile, Compose, CI/CD, build config |
| `ArchitectureExtractor` | modules/services + responsibilities/boundaries/dependencies from docs |
| `RelationLinker` | pure function: entities → cross-layer relations (re-run every update) |
| `ProjectGraphStore` | persistent graph + adjacency + entity keyword index (reuses the Coding `InvertedIndex`) |
| `FullStackSearch` | intent inference + keyword + graph traversal → `SystemAnswer` |

Entities are the source of truth; relations are recomputed from them on every
run, so the graph is always consistent after an incremental update.

## The vector seam

Entity keyword search reuses the frozen Coding engine's `InvertedIndex`. A
future embedding/vector ranker attaches the same way it will in the Coding
engine — behind the store — without changing extraction, linking, the graph,
or search callers.

## Verification (reproducible, real)

**Real repo (`/home/Groot/aura-hub`)** — full analysis:
```
files analyzed 170   entities 145   relations 416   ~200 ms   heapΔ ~3 MB
by layer  frontend:82 config:49 architecture:10 database:4
by relation  depends-on:191 renders:164 imports:40 uses-hook:17 …
persistence  reload → entities 145 relations 416
```

**Real sample fullstack project (actual Express/NestJS/TypeORM/SQL/Docker/CI files on disk)** — cross-layer:
```
22 files → 41 entities, 44 relations across 6 layers
"Which frontend page calls /api/v1/orders?"  → CheckoutPage --calls-endpoint--> POST /api/v1/orders
"Which database table stores users?"         → users --foreign-key--> orders, users --maps-to-table--> User
"Where is authentication implemented?"       → AuthGuard --configures--> JWT_SECRET, --secured-by--> endpoint
"Find every dependency of OrderService"      → OrderService → OrderRepository → Order → orders → users;
                                                OrderService → PaymentService → PaymentRepository; → typeorm, @nestjs/common
incremental  +1 / ~1 / -1 files → re-linked; deleted entity removed ✅; modified relation added ✅
persistence  reload → search still works ✅
```

The sample project is **real source code on disk** (not injected data): the
engine parses it with the exact logic it applies to any repository.
