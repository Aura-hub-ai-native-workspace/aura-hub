# Engineering Twin

A live digital twin of every repository — deterministic, derived from existing platform data, with no duplicate storage and no fake data.

## Overview

The Engineering Twin is a continuously updated engineering model that maintains eight state modules and answers eight fundamental questions about every file, module, mission, diagnosis, memory, and automation in the repository.

## Eight State Modules

| Module | Data Source | What It Tracks |
|--------|------------|----------------|
| **Repository State** | `ProjectProfile`, `IndexStatus` | File count, languages, frameworks, dependencies, index phase |
| **Architecture State** | `ArchitectureLayer[]`, `ProjectIntelligence.architecture` | Module hierarchy, entry points, API surface, layer definitions |
| **Dependency State** | `ProjectProfile.dependencies` | Runtime/dev dependencies with versions, framework detection |
| **Mission State** | `missionClient.list(projectId)` | Active missions, mission history, execution status, task runs |
| **Diagnosis State** | `diagnosisClient.list(projectId)` | Pending/accepted/rejected diagnoses, bug categories, decisions |
| **Memory State** | `useWorkspace.memory` | User/AI-authored memory items, decisions, bug records |
| **Learning State** | Memory items with `kind: 'learning'` | Corrections, knowledge updates, pattern detections |
| **Automation State** | `workflowClient.list()`, workflow templates | Saved workflows, automation rules, scheduled tasks |

## Eight Questions the Twin Answers

1. **What changed?** — Change intelligence log: file-level create/modify/delete/rename with timestamps, line counts, and change patterns
2. **Why did it change?** — Mission context: the mission objective, classification, and intent that drove the change
3. **Who changed it?** — Git blame data embedded in diagnosis signals and mission signals
4. **What depends on it?** — Knowledge graph edges: which entities reference or depend on the changed file/symbol
5. **What broke after it?** — Diagnosis records: bugs detected after the change, with failure signals and root causes
6. **What missions affect it?** — Mission records linked by file path or symbol reference
7. **What memories reference it?** — Memory items with `relatedFiles` or `relatedSymbols` matching the entity
8. **What automations are attached?** — Workflows and automation rules that target the file/module

## Nine Visualization Modules

### 1. Twin Overview
Summary dashboard showing verification score, validation score, entity counts, dependency counts, change velocity, and hotspot count — all derived from real indexed data.

### 2. Repository Timeline
File-level change history from the change intelligence log. Shows change velocity, hotspot files, and detected change patterns (frequently_changed, change_burst).

### 3. Architecture Timeline
Architecture layer evolution — module hierarchy, entry points, and layer definitions derived from graphify graph.json or the FullStack knowledge graph.

### 4. Dependency Timeline
Runtime and dev dependencies with versions, grouped by kind. Derived from the project profile.

### 5. Risk Map
Risk scoring per file based on change frequency (hotspot score) and complexity. Files with high change frequency and high impact are flagged as hotspots.

### 6. Heat Map
Change frequency visualization across the repository. Each cell represents a file with color intensity proportional to total lines changed.

### 7. Change Replay
Mission execution history replayed chronologically. Shows mission status (completed, failed, reviewing, in-flight) and category.

### 8. Relationship Explorer
Cross-cutting relationships between entities from the knowledge graph. Shows entity kind, layer, file path, and connection density.

### 9. Twin Diff
Comparison of twin states across versions. Shows verification/validation scores, active hotspots, and AI recommendations.

## Integration Points

### AI Chat
AI Chat uses the Twin before answering. When a user asks about the repository, the AI first consults the Twin's state modules to ground its response in real data.

### Mission Control
Mission Control plans using the Twin. When creating a new mission, the planner consults the Twin's Repository State, Architecture State, and Dependency State to understand the current project context.

### Diagnosis
Diagnosis simulates against the Twin. When running a diagnosis, the engine consults the Twin's Mission State and Memory State to understand the change context and prior decisions.

### Learning
Learning learns from the Twin. When a mission completes or a diagnosis is accepted, the Learning module updates the Twin's Memory State and Learning State with the outcome.

## Data Flow

```
┌─────────────────────────────────────────────────────┐
│                  Engineering Twin                    │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │ Repository│  │Architecture│  │  Dependency      │ │
│  │ State     │  │ State     │  │  State           │ │
│  └─────┬────┘  └─────┬─────┘  └────────┬─────────┘ │
│        │              │                  │           │
│  ┌─────▼──────────────▼──────────────────▼─────────┐ │
│  │            Twin Data Layer                      │ │
│  │  (derived from existing platform APIs)          │ │
│  └─────┬──────────────┬──────────────────┬────────┘ │
│        │              │                  │           │
│  ┌─────▼────┐  ┌─────▼─────┐  ┌────────▼────────┐ │
│  │ Mission  │  │Diagnosis  │  │ Memory/Learning │ │
│  │ State    │  │ State     │  │ State           │ │
│  └──────────┘  └───────────┘  └─────────────────┘ │
│                                                     │
│  ┌────────────────────────────────────────────────┐ │
│  │ Automation State                              │ │
│  │ (workflows, templates, scheduled tasks)       │ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Determinism Guarantee

The Engineering Twin is fully deterministic:
- Every data point is derived from existing platform APIs
- No duplicate storage — the Twin reads from the same stores as everything else
- No fake data — empty states are shown when data is unavailable
- All calculations are pure functions of the input data

## Adding a New Twin Module

1. Add the state module data fetch to `EngineeringTwin.tsx`
2. Add the visualization module to the `twinModules` array
3. Update the `NavKey` type in `packages/core/src/types.ts`
4. Add the nav item to `NAV_ITEMS` in `packages/core/src/navigation.ts`
5. Add the nav title to `NAV_TITLES` in `packages/core/src/navigation.ts`
6. Add the section identity to `sections.ts`
7. Register the screen in `ScreenRouter.tsx`
