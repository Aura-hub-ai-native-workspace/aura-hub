# TS Backend Production Dependency Audit

**Date:** 2026-08-25 · **Auditor:** AGENT 1 · **Verdict: ZERO FORBIDDEN PRODUCTION TS BACKEND DEPENDENCIES**

## Scope

Searched the entire `migration/python-backend` branch for production references to
legacy TypeScript backend modules. The Python backend (`backend/`) is self-contained.

## Method

1. Searched all Python files for imports of `ai-service`, `tsx`, `ts-node`,
   `start.ts`, `workflow/engine.ts`, `workflow/runner.ts`, `automation/engine.ts`,
   `capability-fabric`, `server.ts`.
2. Verified `backend/pyproject.toml` has no Node/TypeScript dependencies.
3. Confirmed `backend/aura/**` contains only Python + one generated JSON manifest.
4. Verified test harnesses reference TS bundles ONLY under `tests/differential/`
   (oracle/reference, never imported by `aura/` production code).

## Results

| Pattern | Production hits | Oracle/test hits | Status |
|---|---|---|---|
| `ai-service` | 0 | 0 (docs only) | ✅ CLEAR |
| `tsx` / `ts-node` | 0 | 0 | ✅ CLEAR |
| `start.ts` | 0 | 0 | ✅ CLEAR |
| `workflow/engine.ts` | 0 | differential driver (reference) | ✅ ORACLE |
| `workflow/runner.ts` | 0 | 0 | ✅ CLEAR |
| `automation/engine.ts` | 0 | differential driver (reference) | ✅ ORACLE |
| `capability-fabric` (as runtime import) | 0 | esbuild oracle bundles | ✅ ORACLE |
| `server.ts` (as production entry) | 0 | 0 | ✅ CLEAR |

## Conclusion

The Python backend has **zero forbidden production TypeScript backend dependencies**.
All TypeScript references are confined to:
- `tests/differential/` — esbuild-bundled TS oracle for behavioral comparison
- `docs/migration/` — documentation and frozen contracts
- `rebuild-oracle-bundles.mjs` — developer utility to regenerate oracle bundles

The TypeScript packages remain in the repository as historical reference and
differential oracle sources. They are NOT invoked by any production code path.
