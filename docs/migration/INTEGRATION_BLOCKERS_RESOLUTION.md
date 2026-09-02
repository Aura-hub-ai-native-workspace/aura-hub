# Integration Blockers — Resolution Record

Branch `migration/python-backend`. Evidence-backed blockers from Agent 3's
runtime verification; each resolved at the canonical boundary.

## B1 — Automation run response shape
`POST /automation/rules/{id}/run` now mirrors the frozen contract
(`engine.ts runRuleNow`): the **flat persisted run dict** on success;
`{error: "conditions not met", run: null}` only when trigger/conditions
genuinely refuse; 404 `{error}` for an unknown rule. The route calls the
canonical `AutomationEngine.run_rule_now` (conditions evaluated, actions
EXECUTED through WorkflowRunner) and returns `store.get_run(...)` so the
response IS the persisted record. Engine semantics untouched. Root causes
fixed: response-shape mismatch AND an action-handler registered under a
non-canonical key (`workflow-run` → TS vocabulary `run-workflow`).

## B2 — Central Agent capability vocabulary
Generation updated to canonical IDs — no aliases, no client mapping:
- `fs.write_file` → **filesystem.write** (intent.py heuristic + planner task).
- `workflow.list` / `workflow.create`: these were REAL lineage capabilities
  (fabric/executors.py @ b4b42a8) missing from this branch's executor set.
  Restored as canonical aura-internal capabilities (low risk, permissions [],
  read-back verify on create) over the ONE WorkflowStore, registered through
  ONE authoritative function (`register_canonical_internal_capabilities`).
- The frozen `manifest.json` is NOT hand-edited — the freshness gate against
  the TS bundle stays green; descriptors register at wiring time.
- Unknown capabilities still fail closed (unchanged).

## B3 — Projects / Missions classification
- `/projects` (GET list+current, POST add, POST open, GET profile):
  **A. REQUIRED migrated contract** — exposed thin over the existing
  canonical `ProjectRegistry` (persisted projects.json, one store; the same
  registry now also backs the project.* Fabric executors). Historical TS
  shapes matched ({projects,current} / record / {project,profile,status}).
- `/missions/*`, `/projects/{pid}/missions*`, mission annotation:
  **C. Explicitly unsupported** — no canonical Python mission engine exists.
  Frozen honest 501 `{error}` naming the dependency. Nothing fabricated.

## Also fixed during verification
- `CapabilityView` now exposes descriptor-contract defaults (description,
  risk, irreversible, …) and attribute views for input FIELDS — the agent
  layer's discovery reads them as objects.
- Ad-hoc engine facade narrowed to READ-ONLY routes (git-status): the frozen
  export-file binding sources content from upstream node input, which a
  synthesized single-node graph cannot supply honestly; write effects use
  the direct governed invoke_fabric (identical policy/approval/audit).
