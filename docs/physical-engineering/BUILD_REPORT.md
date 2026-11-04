# AURA HUB — PHYSICAL ENGINEERING FOUNDATION
## Build Report

---

**Branch:** `feature/physical-engineering-foundation`
**Base commit:** `364a6bd` (ci: bound apt and the install step instead of switching mirrors)
**Report generated:** 2026-09-01
**Status:** Foundation complete — all modules implemented, tested, lint-clean

---

## EXECUTIVE SUMMARY

The Physical Engineering Foundation establishes the **basement** of AURA Hub's physical engineering orchestration capability. This phase implements:

- **Engineering domain model** — vocabulary of physical engineering in AURA
- **Engineering Graph** — relationship backbone answering "what depends on what?"
- **Artifact Store** — versioned, integrity-hashed engineering output tracking
- **Tool Registry** — discovery and availability tracking for external engineering tools
- **Capability Contracts** — engineering capability declarations extending the Capability Fabric
- **Event Store** — append-only engineering activity log
- **Change Impact Analysis** — dependency propagation and stale detection
- **Context Extension** — engineering context injection into the ContextAssembler

**Key principle preserved:** AURA is the orchestration layer, not the engineering tool. All tool execution flows through the Capability Fabric with policy, approval, and audit.

---

## REPOSITORY AUDIT

### Architecture inspected

| Component | Location | Status |
|-----------|----------|--------|
| Python backend | `backend/aura/` | ✅ Inspected |
| Capability Fabric | `backend/aura/fabric/` | ✅ Inspected |
| Context Assembly | `backend/aura/central_agent/context.py` | ✅ Inspected |
| Persistence layer | `backend/aura/persistence/` | ✅ Inspected |
| Audit system | `backend/aura/audit/` | ✅ Inspected |
| Approval ledger | `backend/aura/approvals/` | ✅ Inspected |
| Executors | `backend/aura/executors/` | ✅ Inspected |
| Config/paths | `backend/aura/config.py` | ✅ Inspected |
| JSON utilities | `backend/aura/jsonutil.py` | ✅ Inspected |
| Canonicalization | `backend/aura/canonical.py` | ✅ Inspected |
| TypeScript frontend | `apps/desktop/` | ✅ Inspected (not modified) |
| Existing tests | `backend/tests/` | ✅ Inspected |

### Key architectural patterns followed

- JSON persistence via `aura.jsonutil` (`read_json_file`, `write_json_atomic`, `dumps_compact`)
- Path management via `aura.config.aura_path()`
- Context injection via `ContextAssembler` / `ContextBundle` / `ContextItem`
- Event append-only pattern matching `AuditStore`
- Risk classification extending existing Fabric risk model
- ADR-style decision records

---

## ARCHITECTURE IMPLEMENTED

### Files created

```
backend/aura/engineering/
├── __init__.py          # Package exports
├── domain.py            # Domain types, enums, entities, serialization
├── graph.py             # Engineering Graph with JSON persistence
├── artifacts.py         # Artifact Store with versioning & provenance
├── tools.py             # Tool Registry with detection
├── capabilities.py      # Engineering capability contracts
├── events.py            # Append-only engineering event store
├── context.py           # ContextAssembler extension for engineering
└── change_impact.py     # Change impact analysis engine
```

### Documentation

```
docs/physical-engineering/
├── README.md
├── research/RESEARCH_LEDGER.md
├── decisions/
│   ├── ADR-001-orchestration-not-replacement.md
│   ├── ADR-002-engineering-graph-storage.md
│   ├── ADR-003-artifact-provenance.md
│   ├── ADR-004-capability-fabric-remains-single-path.md
│   ├── ADR-005-cadquery-primary-cad.md
│   └── ADR-006-kicad-primary-eda.md
├── architecture/
├── build-log/
├── compatibility/
├── experiments/
├── integrations/
├── risks/
├── schemas/
├── validation/
└── workflows/
```

### Tests

```
backend/tests/unit/test_engineering.py   # 65 tests
```

---

## ENGINEERING GRAPH

**Status:** IMPLEMENTED

- In-memory adjacency list with JSON persistence
- Node types: project, requirement, system, subsystem, component, artifact, constraint, parameter, test, evidence, tool, agent, capability
- Relationship types: derives, contains, modeled_by, derived_from, depends_on, constrained_by, validated_by, produced_by, produces, satisfies, implements, tests
- Forward traversal (dependencies)
- Reverse traversal (dependents)
- Transitive dependency lookup (DFS, max depth 10)
- Change impact detection (reverse traversal with path tracking)
- Provenance queries (produced_by, validates)
- Graph summary with type/relationship counts

**Storage:** JSON file via `aura.jsonutil` (desktop-appropriate, no server dependency)

---

## ARTIFACT SYSTEM

**Status:** IMPLEMENTED

- 16 artifact types: cad-model, schematic, pcb, firmware, bom, gerber, drill, simulation-result, test-report, documentation, configuration, measurement, evidence, step, stl, dxf
- SHA-256 content hashing for integrity
- Semver versioning with parent chain
- Full provenance chain: agent, capability, tool, invocation ID, audit ID, policy decision, approval status, input artifacts, parameters, constraints, validation result
- Status tracking: unverified, verified, failed, pending, stale
- Dependency and dependent lookups
- Version history traversal
- Integrity verification

---

## PROVENANCE

**Status:** IMPLEMENTED

Every artifact tracks:
- WHO produced it (agent)
- WHAT capability was invoked
- WHAT tool was used
- WHAT invocation ID links to the Fabric
- WHAT audit ID links to the AuditStore
- WHAT policy decision was made
- WAS human approval required/granted
- WHAT input artifacts were dependencies
- WHAT parameters and constraints were active
- WHAT validation occurred
- WHEN it happened

---

## CAPABILITY FABRIC

**Status:** EXTENDED (declarative contracts, no live executors)

### Engineering capabilities declared

| Domain | Capabilities | Risk Range |
|--------|-------------|------------|
| Mechanical (CAD) | cad.create_part, cad.modify_parameter, cad.export_step, cad.export_stl | LOW–MEDIUM |
| Electronics (EDA) | electronics.create_schematic, electronics.create_pcb, electronics.run_drc, electronics.run_erc, electronics.generate_bom, electronics.export_gerber | LOW–HIGH |
| Firmware/Device | device.detect, device.build, device.flash, device.monitor | LOW–CRITICAL_PHYSICAL |
| Simulation | simulation.run_spice, simulation.inspect_result | LOW |

All capabilities have input/output schemas, risk classification, and approval requirements. All are marked `status: "proposed"` — no live executors exist yet.

---

## TOOL REGISTRY

**Status:** IMPLEMENTED

### Registered tools

| Tool | Domain | Capabilities | Headless | Cross-Platform |
|------|--------|-------------|----------|----------------|
| CadQuery | Mechanical | cad.create_part, cad.modify_parameter, cad.export_step, cad.export_stl | ✅ | ✅ |
| FreeCAD | Mechanical | cad.export_step, cad.export_stl, cad.interactive | ✅ | ✅ |
| OpenSCAD | Mechanical | cad.export_stl | ✅ | ✅ |
| KiCad | Electronics | electronics.export_gerber, electronics.export_drill, electronics.generate_bom, electronics.run_drc, electronics.run_erc | ✅ | ✅ |
| KiCad IPC API | Electronics | electronics.create_schematic, electronics.create_pcb, electronics.run_drc | ❌ | ✅ |
| ngspice | Simulation | simulation.run_spice | ✅ | ✅ |
| PlatformIO | Firmware | device.create_project, device.build, device.flash, device.monitor | ✅ | ✅ |
| esptool.py | Firmware | device.flash, device.erase | ✅ | ✅ |

Detection is lazy — tools are probed via subprocess on demand, not at startup. Detection results are persisted. The platform runs even when no tools are installed.

---

## ENGINEERING CONTEXT

**Status:** IMPLEMENTED

- `make_engineering_context_provider()` returns a function compatible with the ContextAssembler pattern
- Injects: graph summary, artifact overview, stale artifact alerts, tool availability, capability summary, recent events
- `extend_context_assembler()` convenience function for wiring into existing assembler instances

---

## EVENT MODEL

**Status:** IMPLEMENTED

20 event types covering the full engineering lifecycle:
- Project: project.created
- Requirements: requirement.created
- Components: component.created
- Artifacts: artifact.created, artifact.updated, artifact.verified, artifact.failed, artifact.stale
- Capabilities: capability.requested, capability.approved, capability.denied, capability.executed
- Tools: tool.detected, tool.unavailable
- Simulation: simulation.started, simulation.completed
- Validation: validation.started, validation.completed
- Dependencies: dependency.changed, change-impact.detected

Persistence: JSONL (one event per line), append-only, capped at 10,000 events.

---

## CHANGE IMPACT

**Status:** IMPLEMENTED

- `analyze_change_impact(graph, node_id, ...)` — finds all affected nodes via reverse traversal
- `propagate_change(graph, node_id, ...)` — analyze + mark stale + record events
- Suggested actions by node type and relationship
- Suggested revalidation order (artifacts first, then tests, then other nodes)
- Structured `ImpactReport` with serialization
- Integration with ArtifactStore for automatic stale marking
- Integration with EventStore for impact analysis recording

---

## SECURITY

**Status:** Documented (ADR-004, risk classification in capabilities)

### Risk classification implemented

| Risk Level | Examples | Approval Required |
|-----------|----------|------------------|
| LOW | inspect artifact, export visualization, run static validation, run DRC | No |
| MEDIUM | create CAD model, modify parameter, generate PCB | Yes |
| HIGH | manufacturing export (Gerber), destructive modification | Yes |
| CRITICAL_PHYSICAL | flash physical device, reset device, actuate hardware | Yes (always) |

### Key security properties

- Capability Fabric remains the ONLY governed execution path
- No engineering agent can execute tools directly
- All tool execution goes through: Agent → Capability → Policy → Approval → Executor → Tool → Verification → Artifact → Audit
- Physical actions (device.flash, device.reset) are always CRITICAL_PHYSICAL

---

## RESEARCH FINDINGS

### CAD Integration

- **CadQuery** (primary): Python parametric CAD, OpenCascade-backed, headless-capable, STEP/STL export. Well-suited for agent-driven programmatic CAD.
- **FreeCAD** (secondary): Full parametric CAD with Python scripting, FreeCADCmd for headless. Good for interactive operations and visualization.
- **OpenSCAD**: CSG-only, no STEP support, limited for complex engineering.
- **Onshape**: Cloud-only, REST API, commercial license. Not suitable for desktop-first architecture.

### EDA Integration

- **KiCad** (primary): Open-source, kicad-cli for headless DRC/ERC/Gerber/BOM export. KiCad 9+ has Protobuf IPC API for interactive automation.
- Altium/Cadence: Commercial, limited automation APIs for open integration.

### Embedded Systems

- **PlatformIO**: Cross-platform build system, CLI automation, ESP-IDF integration.
- **ESP-IDF**: Official Espressif SDK, CMake-based builds.
- Device flashing is CRITICAL_PHYSICAL — always requires human approval.

### Simulation

- **ngspice**: Open-source SPICE simulator, CLI-capable, well-established.
- FEA/CFD tools (CalculiX, Elmer) exist but are complex to integrate.

---

## TEST RESULTS

```
65 passed in 0.40s
```

### Test coverage by module

| Module | Tests | Status |
|--------|-------|--------|
| Domain types | 6 | ✅ All pass |
| Domain serialization | 3 | ✅ All pass |
| Engineering Graph | 14 | ✅ All pass |
| Artifact Store | 14 | ✅ All pass |
| Tool Registry | 9 | ✅ All pass |
| Capability Contracts | 7 | ✅ All pass |
| Event Store | 7 | ✅ All pass |
| Change Impact | 5 | ✅ All pass |
| Integration | 1 | ✅ All pass |

### Existing tests

```
402 passed, 1 skipped (excluding 3 pre-existing failures)
```

Pre-existing failures (NOT introduced by this branch):
- `test_manifest_snapshot_matches_typescript` — manifest drift between TS and Python
- `test_full_report_parity` — missing TS reference files
- `test_agent_loop_parity` — missing TS reference files

---

## FAILURES

None introduced by this branch.

---

## PRE-EXISTING ISSUES

1. **Manifest drift** (`test_manifest_freshness.py`) — `manifest.json` has drifted from TypeScript `CAPABILITY_MANIFEST`. Not related to engineering foundation.
2. **Differential test infrastructure** — TS reference files (`/tmp/opencode/tsref/`) missing in test environment. Not related to engineering foundation.

---

## KNOWN LIMITATIONS

1. **No live CAD executor** — Capability contracts are declared but no CadQuery executor is wired
2. **No live EDA executor** — KiCad capabilities are declared but no executor exists
3. **No live simulation executor** — ngspice capabilities declared but not connected
4. **No live device executor** — PlatformIO capabilities declared but not connected
5. **Graph is in-memory** — Desktop-appropriate for projects with hundreds of nodes; not suitable for millions
6. **No 3D visualization** — Three.js integration deferred to Phase 3
7. **No cross-project graph** — Each project has its own graph instance
8. **No real tool detection** — Detection runs subprocess commands; actual tools not installed in test env

---

## DEPENDENCIES INTRODUCED

None. The engineering foundation uses only:
- Python standard library (hashlib, uuid, json, enum, dataclasses, subprocess, pathlib, collections, datetime)
- Existing AURA modules (config, jsonutil, central_agent.context)

No new pip packages. No new system dependencies.

---

## NEXT PHASE

### Recommended Phase 1 (next development sprint)

1. **CadQuery executor** — Wire a real CadQuery executor into the Capability Fabric
2. **CadQuery tool detection** — Verify CadQuery installation
3. **Simple CAD workflow** — Agent generates a parametric part via CadQuery, creates artifact, records provenance
4. **Engineering context in prompts** — Wire `extend_context_assembler` into the Central Agent's prompt assembly
5. **Engineering workspace UI prep** — Define React component extension points for engineering tree, artifact panel

### Recommended Phase 2

1. **KiCad executor** — Wire KiCad CLI for DRC, ERC, Gerber export
2. **STEP file generation** — CadQuery → STEP → artifact tracking
3. **Engineering graph visualization** — Render dependency graph in the UI
4. **Change impact UI** — Show affected items when artifacts change

### Long-term

1. FreeCAD integration for interactive visualization
2. PlatformIO/ESP-IDF for firmware orchestration
3. ngspice for circuit simulation
4. Manufacturing output pipeline
5. Full engineering workspace UI
