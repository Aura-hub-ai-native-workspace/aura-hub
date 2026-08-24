# Differential testing — TypeScript vs Python

**Principle (mission §24):** same input into both backends, outputs compared;
any unexplained semantic divergence is a migration blocker. Where
nondeterminism exists, defined invariants are compared instead of raw output.

## Harness design (Phase 1)

```
seeded case generator (random.Random(141101), deterministic)
        │
        ├─► Python:  aura.canonical.fingerprint_invocation / graph_hash
        │
        └─► node ──► esbuild-bundled REAL TS sources
                     packages/capability-fabric/src/fabric.ts
                     packages/ai-service/src/workflow/versions.ts
        │
        ▼
per-case digest equality asserted (exact string)
```

Key properties:

1. **The oracle is the genuine implementation**, not a transcription. The
   pytest session fixture builds reference bundles with the repo's own esbuild
   (`node_modules/.bin/esbuild`, same alias pattern as
   `scripts/build-service-bundle.mjs`) into `/tmp/opencode/tsref/`. The driver
   (`backend/tests/differential/ts_driver.mjs`) imports those bundles.
2. **No silent skips**: missing esbuild/sources SKIPs loudly with a reason;
   a divergence FAILS with the first offending case printed.
3. **Deterministic**: identical seed → identical case set on every machine.
4. **Case domains** mirror what AURA actually fingerprints today: camelCase /
   mixed-case identifier keys, nested objects with random insertion order
   (proving nested order stays significant — V3 semantics), absent vs null vs
   present context fields (`?? null` semantics), edge-id/x/y noise for graph
   hashing (proving exclusions).
5. **Volume**: 200 fingerprint cases + 120 graph cases per run.

## Results ledger

| Date | Commit | Functions | Cases | Result |
| --- | --- | --- | --- | --- |
| 2026-08-24 | phase 1 | fingerprintInvocation, hashGraph | 320 | **0 divergences** (after punctuation-bucket fix below) |
| 2026-08-24 | phase 2 | sanitizePolicy + evaluatePolicy (full evaluation objects incl. reasons) | 250 | **0 divergences** on first full run |

## Collation findings recorded by the harness (2026-08-24)

The randomized battery exposed a real ICU-root property the static vectors did
not cover: **punctuation/symbols carry LOWER primary weight than digits and
letters** (`_-,;:!?.'"()[]{}@*/\&#%`^+<=>|~$` < `0-9` < `a-z` case-merged). The
first Python key formulation used code points and diverged on 78/120 graph
cases (e.g. `Node1` vs `node_2`). Fix: probe-derived primary buckets in
`aura.canonical.icu_root_key` (`_PUNCT_BUCKET` table). This is exactly the
class of bug the harness exists to catch before it reaches approval-binding.

## Extension protocol

Every future subsystem port (policy decisions, envelope computation,
dry-run reports, schedule generation, agent bounds/tool resolution) adds:
a case generator over its real input domain, a bundled-TS oracle built from
its true source file, and a results row here. A subsystem is not "migrated"
until its differential battery is green AND the existing `.mjs` suites stay
green against the live product.
