# Predictive Engineering Platform

## Purpose and Mission
The Predictive Engineering Platform (PEP) is AURA's **anticipation layer**: it predicts engineering risks *before* they happen. Where the Governance Platform measures the present and the Automation Engine reacts to events, the PEP computes what is *likely to fail next* and what to do about it — files likely to fail, modules likely to become unstable, future technical debt, dependency conflicts, architecture drift, mission failure probability, AI proposal success probability, diagnosis likelihood, and workflow bottlenecks.

The platform is **100% deterministic and 100% real**. There is no ML, no randomness, and no invented metric: every probability is a documented weighted function of real platform signals (git churn, governance reports, the knowledge graph, and mission/diagnosis/automation history). The interface is deliberately **ML-ready** — `PredictiveEvidence` is a plain serializable feature vector and the engines are pure `evidence → report` functions, so a future trained model can consume the same schema without changing any caller.

### Key Responsibilities
- **Risk Engine** — a normalized, explainable risk profile (overall + six dimensions: change volume, architecture stability, technical debt, security posture, coverage gap, historical failures) with per-file and per-module risk and their drivers.
- **Prediction Engine** — nine deterministic predictors producing ranked `Prediction`s (hotspots, regressions, upcoming architecture risks, …) with probability, severity, horizon, confidence, evidence and preventive actions.
- **Confidence Engine** — *how much the deterministic computation is trusted*, as a documented function of signal coverage / positivity / conflict, never a model opinion.
- **Impact Analysis** — blast radius of a file over the knowledge-graph dependency web (direct + transitive dependents, affected layers, risk score).
- **Simulation Engine** — reproducible what-if projections (`modify / add / remove` a target) with a before/after risk level and the affected prediction ids.
- **Integration surface** — consumed by Mission Control (mission-failure + proposal-success), Diagnosis (diagnosis likelihood), the Dashboard (full report) and AI Chat (deterministic explanations).

---

## Modules and Responsibilities

### `packages/predictive/src/types.ts`
The sealed vocabulary — everything the platform reads and writes:
- **Evidence schema** — `PredictiveEvidence` (files with churn/complexity/markers/dependents/diagnosis history; dependency ranges; module aggregates; architecture signals; git; debt; security; docs; health; mission history; diagnosis history with candidates; automation run history; workflow shapes).
- **Prediction kinds** — `file-failure`, `module-instability`, `future-tech-debt`, `dependency-conflict`, `architecture-drift`, `mission-failure`, `proposal-success`, `diagnosis-likelihood`, `workflow-bottleneck`.
- **Prediction/Report shapes** — `Prediction` (id/kind/target/severity/probability/confidence/horizon/drivers/preventiveActions/summary), `RiskProfile`, `PredictionReport` (risk + hotspots + regressions + architectureRisks + preventiveActions + confidence).
- **Impact / Simulation shapes** — `ImpactAnalysis`, `WhatIfSimulation` (`change`, `projection` without vs with the preventive action).
- **Live contexts** — `MissionContext` and `CandidateContext`, the sealed inputs to the per-mission / per-candidate predictors.
- **ML-ready export** — `FeatureMatrix` (one row per file, binary labels) via `extractFeatures`.

### `packages/predictive/src/score.ts`
Pure deterministic math: `clamp01`, `normalize`, `weighted`, `severityOf`, `horizonOf`, `riskLevelOf`, and a stable `sortByScoreDesc` (ties broken by key so output order never depends on iteration).

### `packages/predictive/src/confidence.ts`
`computeConfidence({required, available, positive, negative?, caveats?})` → `{score, coverage, signals, caveats}`. Formula: `0.15 + 0.4·coverage + 0.45·signalScore − 0.08·negative`, clamped to `[0.05, 0.97]` (1.0 is reserved — engineering predictions always carry uncertainty). Missing signals produce an explicit caveat.

### `packages/predictive/src/risk.ts`
`computeRiskProfile(evidence)` and `fileRisk(file)`.
- Six dimensions, each pushed with its `EvidencePoint`s: `change-volume` (0.4 fallback when git is unavailable — unknown churn is a mild risk, not zero), `structural` (cycles/layer violations/drift imports/chains), `debt`, `security`, `coverage` (inverse test + doc coverage), `behavioral` (mission/diagnosis/automation failure rates).
- `fileRisk` = weighted churn(0.3) + complexity(0.2) + markers(0.15) + dependents(0.15) + diagnosis count/fired(0.2) + security findings(0.1), with human-readable drivers.
- `topFiles` / `topModules` ranked desc.

### `packages/predictive/src/prediction.ts`
Nine pure predictors, each with its documented formula, explicit drivers, per-kind `required/available/positive` confidence, and preventive actions:
1. `predictFileFailures` — churn × complexity × connectivity; skipped under 0.2 probability.
2. `predictModuleInstability` — worst-file risk(0.6) + module churn(0.25) + module size(0.15).
3. `predictFutureDebt` — markers(0.4) + churn(0.3) + complexity(0.3) on files with debt markers.
4. `predictDependencyConflicts` — vulnerable(0.4) + deprecated(0.2) + loose range(0.25) + manifest changed(0.15).
5. `predictArchitectureDrift` — per-module drift imports + cycle participation, plus a project-level drift prediction.
6. `predictMissionFailure` — history-level rate from mission store; with a live `MissionContext`: historical rate(0.2) + mission risk(0.35) + inverse quality(0.25) + inverse acceptance(0.2).
7. `predictProposalSuccess` — with a live `CandidateContext`: strategy acceptance history(0.4) + candidate confidence(0.4) + limiter(0.2). (No candidate ctx → no prediction.)
8. `predictDiagnosisLikelihood` — churn(0.35) + complexity(0.25) + markers(0.2) + coverage gap(0.2).
9. `predictWorkflowBottlenecks` — per-action failure/retry/latency from automation run history + per-workflow heavy/sequential/depth from workflow shapes.

`predictAll(evidence, missionCtx?, candidateCtx?)` aggregates all nine.

### `packages/predictive/src/impact.ts`
`analyzeImpact(evidence, target)` — BFS over the sealed `dependents` adjacency to find direct + transitive dependents, the distinct layers they touch, and the risk score of the affected surface.

### `packages/predictive/src/simulation.ts`
`simulateChange(evidence, target, change)` — `remove` lowers risk (`−0.5·blast radius`), `add` raises it, `modify` raises it by `0.6·blast radius + 0.4·target risk`; `projection.withoutAction` vs `withPreventive` (modeled as halving exposed risk) and the list of affected prediction ids.

### `packages/predictive/src/index.ts`
The public facade — `PredictiveEngine(evidence)`:
- `report(missionCtx?, candidateCtx?)` → `PredictionReport` (assembles risk, ranks hotspots/regressions/architectureRisks, dedups+sorts preventive actions, aggregates report confidence).
- `missionFailure(ctx)` / `proposalSuccess(ctx)` → single live predictions.
- `impact(target)` / `simulate(target, change)`.
- `features()` → the ML-ready `FeatureMatrix`.
- `extractFeatures(evidence)` — one numeric row per file (`churn/lines/complexity/markers/dependents/diagnosisCount/hasTests/securityFindings`) with the binary label `diagnosisFired > 0`.

### `packages/ai-service/src/predictive/collect.ts`
The **host adapter** — maps real platform state into sealed evidence:
- `scanWorkspace` + `buildModuleGraph` → files, modules, layers (`layerOf`), dependents (`importers`), complexity (`analyzeCodeShape`), markers (regex), test coverage (test-file name matching).
- `getGitChurn` → per-file/per-module change counts (honest `available: false` when not a git repo).
- `getArchitectureHealth` / `getTechnicalDebt` / `getSecurityReport` / `getDocumentationHealth` / `getEngineeringScorecard` → the governance signals.
- `MissionStore` / `DiagnosisStore` (incl. per-candidate confidence/limiter/verdict) / `AutomationStore` run+action states / `WorkflowStore` node shapes → history + workflow signals.
- `missionContextFrom(projectId, missionId)` and `candidateContextFrom(projectId, diagnosisId, candidateId)` — live-context builders for Mission Control and Diagnosis.

### `packages/ai-service/src/predictive/index.ts`
`buildPredictiveEngine({projectId, projectPath, days?, runNpmAudit?})` → collected evidence → ready `PredictiveEngine`.

---

## Integration Points

| Consumer | Surface | What it gets |
| --- | --- | --- |
| **Mission Control** | `GET /predictive/mission/:id`, `POST /predictive/simulate` | mission failure probability + drivers/preventive actions; what-if projections |
| **Diagnosis** | `GET /predictive/report`, `GET /predictive/candidate/:diagId/:candId` | diagnosis-likelihood predictions per file; proposal success probability for a candidate |
| **Dashboard** | `GET /predictive/report` | risk profile, hotspots, regressions, architecture risks, preventive actions, feature matrix |
| **AI Chat** | `POST /predictive/explain` | deterministic, human-readable explanation of the report (or a single prediction) |

The host (`WorkspaceManager`) exposes the shared `missions`/`diagnoses` stores; the collector instantiates its own read-only instances of the mission/diagnosis/automation/workflow stores (same files under `~/.aura`), so no domain code is modified.

---

## HTTP Surface (`packages/ai-service/src/server.ts`, `/predictive`)

| Route | Method | Purpose |
| --- | --- | --- |
| `/predictive/report?projectId=` | GET | Full `PredictionReport` (risk + all predictions + hotspots/regressions/architecture risks + actions). |
| `/predictive/mission/:id?projectId=` | GET | Mission-failure `Prediction` for a live mission. |
| `/predictive/candidate/:diagId/:candId?projectId=` | GET | Proposal-success `Prediction` for a diagnosis candidate. |
| `/predictive/impact/:target?projectId=` | GET | `ImpactAnalysis` blast radius for a file. |
| `/predictive/simulate` | POST | `{projectId, target, change}` → `WhatIfSimulation`. |
| `/predictive/explain` | POST | `{projectId, predictionId?}` → deterministic explain text (for AI Chat). |

---

## Design Constraints
- **Deterministic or nothing**: the same `PredictiveEvidence` always produces the same report. No randomness, no timestamps inside the pipeline (timestamps enter only as evidence), stable tie-breaking in every sort.
- **Real signals only**: every number maps to a real platform source; when a source is unavailable (e.g. no git repo) the platform says so — churn-based signals fall back to an explicit 0.4 risk with a caveat, and confidence drops.
- **ML-ready by schema, not by model**: `PredictiveEvidence`/`FeatureMatrix` are sealed, serializable feature vectors. A future model replaces the deterministic scoring functions behind the same inputs/outputs — callers do not change.
- **Host owns evidence**: `packages/predictive` only computes; `packages/ai-service` collects. No domain record is mutated and no frozen module is touched.
- **Confidence is honesty, not a number**: 1.0 is unreachable; caveats are surfaced to the UI/AI chat whenever signals are missing or conflict.
- **Explainable**: every prediction carries its drivers (`label=value=source=weight`), preventive actions, and a one-line summary — so the AI Chat can answer "why?".

---

## Verification
`node scripts/run-ts.mjs scripts/verify-predictive.ts` (from `E:\aura-hub`) runs the full pipeline against the real workspace and asserts the sealed contract: real serializable evidence, deterministic reports, all nine prediction kinds, ranked hotspots/regressions/architecture risks, deduped actions, live mission-failure + proposal-success predictors, reproducible impact/simulation, the ML-ready feature matrix, and deterministic explain text. Result on the current workspace: **41 passed, 0 failed** (git unavailable → honest fallback path exercised). All packages and `scripts` typecheck clean (`tsc -p <tsconfig> --noEmit` EXIT 0).
