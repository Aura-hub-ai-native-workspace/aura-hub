# Python backend — target architecture

**Status:** ACTIVE · Governs all phases after P1. The layout below is binding for
where code lives; deviations require editing this file in the same commit.

## 1. Top level

```
backend/                     ← the canonical Python backend (new)
    pyproject.toml           project + pinned dev tooling
    aura/                    importable package ("aura" = AURA Hub backend)
        __init__.py
        contracts/           Pydantic models GENERATED-FAITHFUL to docs/migration/schemas
        canonical.py         fingerprintInvocation, graphHash, ICU-root comparator
        config.py            AURA_HOME resolution, settings
        errors.py            error taxonomy mapping to {error} wire bodies
        jsonutil.py         Node-compatible JSON (compact/pretty) read/write
        policy/              P2: stricter ladder, floors, sanitize, evaluation
        approvals/           P2: pending-only store, single-use spend, fingerprints
        audit/               P2: append-only JSONL store, caps, trim
        exec/                P2/P5: settle() port, allow-lists, TIMEOUT=124
        persistence/         P3: ~/.aura readers/writers per frozen format
        fabric/              P4: registry, resolve, invoke pipeline, verification
        workspace/           P5: projects, cwd resolution, environment probes
        workflow/            P6: engine, nodes, versions, dryrun, runs
        automation/          P7: rules, triggers, scheduler, stores
        agent/               P8: bounds, loop, trace, resume
        providers/           P9: adapters, credential envelope (AES-GCM interop)
        context/             P9: context fabric facade
        api/                 P10: route table mirroring server.ts seg-routing, SSE
    tests/
        unit/                pure-Python tests
        vectors/             frozen-vector assertions (V1..V4, G1)
        differential/        TS-vs-Python harness (node subprocess on real bundles)
        golden/              schema+round-trip harness over docs/migration/golden
docs/migration/              constitution + status (existing)
```

Rules:
1. **One authority per concern** — mirrors the TS tree's own rule. No second policy
   engine, no parallel audit writer, no side channel around `fabric.invoke`.
2. Layering arrows point inward only: `api → {workflow,automation,…} → fabric →
   policy/approvals/audit/persistence`. Nothing under `fabric/` imports anything
   from `api/`, `workflow/`, or `automation/`.
3. `contracts/` may be imported by everyone; it imports only stdlib+pydantic.
4. The TS tree remains the reference; Python never wraps/spawns TS to *serve*
   requests (forbidden by mission §35). The ONLY sanctioned TS coexistence is the
   diagnosis sidecar (D1) behind its frozen SSE contract and the differential
   test harness.

## 2. Technology selection (rationale per mission §4)

| Concern | Choice | WHY | Security | Compatibility | Migration impact |
| --- | --- | --- | --- | --- | --- |
| HTTP/SSE | **Starlette** (+uvicorn) at P10 | route-table parity with hand-rolled seg-router is trivial; StreamingResponse gives exact SSE framing incl. `[DONE]` control | no magic auth layers to fight; gates are explicit middleware we write | wire format fully controlled | replaces node:http idiom-for-idiom |
| Models | **Pydantic v2** (`extra="allow"`) | models validate against frozen schemas; extras preserved (no silent field drops) | validation at boundaries mirrors TS ad-hoc checks | alias generator for camelCase | generated-faithful from schemas |
| Schema tests | **jsonschema** | Draft2020-12 validator already proven on goldens | — | identical validator used since P0 | zero |
| Async | **asyncio** | direct mapping of AbortSignal→task cancellation; subprocess support | cancellation semantics testable | matches settle() port | core runtime |
| Process | `asyncio.create_subprocess_exec` behind one `settle()` | preserve exit/signal/124 semantics exactly | allow-lists enforced in OUR layer | byte-parity with TS behavior | critical-path port |
| Crypto | **cryptography** AESGCM | only way to read existing providers.json | GCM tag/IV semantics preserved | cross-runtime decrypt required | P9 |
| Cron | **croniter** (validated vs hand parser goldens) | TS parser is hand-rolled; croniter must pass golden schedule cases before use | no eval of user input beyond parsing | schedule-state compat | P7 |
| Git/filesystem | subprocess `git` CLI (NOT GitPython) | output-parsing parity beats library convenience | same allow-list story as today | identical stdout contracts | trivial |
| Tests | pytest (+pytest-asyncio) | industry standard; installed 9.1.1 | — | runs everywhere | harness lives in backend/tests |

Nothing else. No ORM, no Celery, no Redis, no OpenAI SDK (providers stay raw httpx
calls at P9). Dependencies beyond these require an architecture-doc edit first.

## 3. Canonicalization design (the P1 keystone)

Node's default `Array.prototype.sort((a,b)=>a.localeCompare(b))` is ICU root
collation: primary = base letters (case/accent-folded), secondary = accents,
tertiary = case with **lowercase before uppercase**, then punctuation/variable
weighting. Python `sorted()` is code-point order and disagrees on mixed case
(`'B' < 'a'`). Therefore:

- `aura.canonical.icu_root_key(s)` builds a multi-level sort key:
  L1 casefolded + accent-stripped (NFD, combining marks removed),
  L2 the stripped marks,
  L3 per-char (case_class, ord) with lower=0/upper=1.
- Comparator correctness is asserted against frozen V4 plus a seeded randomized
  differential battery executed against the REAL TypeScript implementations
  (esbuild-bundled `capability-fabric/src/fabric.ts` and
  `ai-service/src/workflow/versions.ts`) via node subprocess — see
  differential-testing.md.
- Known limitation, documented not hidden: exotic scripts fall outside the
  Latin/ASCII domain this key covers. The differential harness generates
  identifier-domain keys (what capability inputs actually carry); any future
  fingerprinted input domain expansion MUST extend the key + rerun vectors.

Serialization parity (`jsonutil.py`): compact separators `(,)`/`(:)` with
`ensure_ascii=False` for digests; pretty `indent=2` + trailing-newline-absent for
stores; JSONL = compact + `\n`.

## 4. Cutover shape (preview of P10–P13)

Strangler proxy owns :4319 during transition with a per-route map (default TS);
flips happen per-route under full `.mjs` regression. State owners (live runs,
approval parking) flip atomically in quiesced windows. Diagnosis routes proxy to
the TS sidecar permanently. Final removal follows Definition of Done.

## 5. Status tracking

`python-migration-status.md` is the machine-readable ledger (one row per
subsystem × phase gate). It is updated in the same commit as the code that
changes state.
