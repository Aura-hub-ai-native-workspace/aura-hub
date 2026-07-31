# AURA — Engineering Memory Platform Architecture

> **Implementation Constitution for the Engineering Memory Platform**
> 
> This document describes the architecture of the Engineering Memory Platform that sits above Mission Control, Engineering Diagnosis, Knowledge Fabric, and AI Code Intelligence. Every component described here **exists and runs today** in this codebase. Anything not present in the real source is marked as planned for future implementation.

---

## 1. Vision

The Engineering Memory Platform transforms AURA from an AI that reasons into an AI that gains engineering experience. It provides a persistent, queryable, grounded memory layer that learns from real project history rather than treating every request as a brand new problem.

**Core Principles:**

1. **Grounded in Reality:** Every memory, pattern, and insight must come from real engineering work. No fake memories, no fabricated experience.
2. **Queryable:** Everything must be searchable, filterable, and retrievable through clean APIs.
3. **Persistent:** All engineering knowledge survives restarts and is stored durably.
4. **Integrated:** The platform integrates seamlessly with existing Knowledge Fabric, Mission Control, Diagnosis Engine, and AI Code Intelligence.
5. **Non-Invasive:** Existing systems (Mission Control, Workflow UI, Execution DAG, Timeline UI, Dashboard, Monaco, Workspace) are NOT touched. Only APIs are exposed.
6. **Production Quality:** Built as if AURA will be used for years by professional engineering teams.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    EXISTING SYSTEMS (UNTOUCHED)                   │
├─────────────────────────────────────────────────────────────────┤
│  Mission Control    │  Engineering Diagnosis    │  Knowledge Fabric │
│  Workflow UI        │  AI Code Intelligence     │  Existing Memory  │
│  Execution DAG      │  Monaco Editor            │  Retrieval System │
│  Timeline UI        │  Dashboard                │                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              ENGINEERING MEMORY PLATFORM (NEW LAYER)                │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────────────────┐  │
│  │  PART 1:    │  │  PART 2:    │  │        PART 3:             │  │
│  │ Engineering │  │ Pattern     │  │      Experience            │  │
│  │  Memory     │  │  Engine     │  │       Engine              │  │
│  └─────────────┘  └─────────────┘  └───────────────────────────┘  │
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────────────────┐  │
│  │  PART 4:    │  │  PART 5:    │  │        PART 6:             │  │
│  │ Decision    │  │  Bug        │  │       Mission             │  │
│  │  Memory     │  │  Memory     │  │       Memory              │  │
│  └─────────────┘  └─────────────┘  └───────────────────────────┘  │
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────────────────┐  │
│  │  PART 7:    │  │  PART 8:    │  │        PART 9:             │  │
│  │ Project     │  │ Engineering │  │     Prediction             │  │
│  │  Timeline   │  │  Search     │  │     Foundation             │  │
│  └─────────────┘  └─────────────┘  └───────────────────────────┘  │
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────────────────┐  │
│  │ PART 10:    │  │ PART 11:    │  │        PART 12:             │  │
│  │ Memory      │  │ Engineering │  │      Public APIs           │  │
│  │  Graph      │  │  Insights   │  │                           │  │
│  └─────────────┘  └─────────────┘  └───────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    PERSISTENT STORAGE
                    (~/.aura/engineering-memory/)
```

**Data Flow:**

1. Existing systems (Mission Control, Diagnosis Engine, etc.) continue to operate unchanged
2. Engineering Memory Platform listens for events and records them
3. All memories are stored persistently in `~/.aura/engineering-memory/`
4. Pattern Engine analyzes events for recurring patterns
5. Experience Engine tracks domain-specific experience
6. All data is queryable through Public APIs
7. Future systems can consume these APIs for prediction and intelligence

---

## 3. Package Structure

```
packages/engineering-memory/
├── src/
│   ├── index.ts                    # Main exports
│   ├── types.ts                   # Core type definitions
│   │
│   # PART 1: Engineering Memory
│   ├── memory/
│   │   ├── EngineeringMemory.ts   # Main memory API
│   │   ├── MemoryStore.ts          # Persistent storage
│   │   └── types.ts               # Memory-specific types
│   │
│   # PART 2: Pattern Recognition
│   ├── pattern/
│   │   ├── PatternEngine.ts       # Pattern detection
│   │   ├── PatternStore.ts         # Pattern storage
│   │   └── types.ts               # Pattern types
│   │
│   # PART 3: Experience Engine
│   ├── experience/
│   │   ├── ExperienceEngine.ts    # Experience tracking
│   │   ├── ExperienceStore.ts      # Experience storage
│   │   └── types.ts               # Experience types
│   │
│   # PART 4: Decision Memory
│   ├── decision/
│   │   ├── DecisionMemory.ts      # Decision storage
│   │   └── types.ts               # Decision types
│   │
│   # PART 5: Bug Memory
│   ├── bug/
│   │   ├── BugMemory.ts           # Bug storage
│   │   └── types.ts               # Bug types
│   │
│   # PART 6: Mission Memory
│   ├── mission/
│   │   ├── MissionMemory.ts       # Mission storage
│   │   └── types.ts               # Mission types
│   │
│   # PART 7: Project Timeline
│   ├── timeline/
│   │   ├── ProjectTimeline.ts     # Timeline management
│   │   └── types.ts               # Timeline types
│   │
│   # PART 8: Engineering Search
│   ├── search/
│   │   ├── EngineeringSearch.ts    # Search API
│   │   └── types.ts               # Search types
│   │
│   # PART 9: Prediction Foundation
│   ├── prediction/
│   │   ├── PredictionFoundation.ts # Similarity APIs
│   │   └── types.ts               # Prediction types
│   │
│   # PART 10: Memory Graph
│   ├── graph/
│   │   ├── MemoryGraph.ts         # Graph management
│   │   └── types.ts               # Graph types
│   │
│   # PART 11: Engineering Insights
│   ├── insights/
│   │   ├── EngineeringInsights.ts # Insight generation
│   │   └── types.ts               # Insight types
│   │
│   # PART 12: Public APIs
│   ├── api/
│   │   └── EngineeringMemoryApi.ts # Unified API
│   │
│   # Utilities
│   ├── utils/
│   │   ├── idGenerator.ts         # ID generation
│   │   ├── similarity.ts          # Similarity calculations
│   │   └── validation.ts          # Data validation
│   │
│   └── types.ts                   # Package-level types
│
├── package.json
├── tsconfig.json
└── README.md
```

---

## 4. Data Models

### 4.1 Core Types

**Base Types (`packages/engineering-memory/src/types.ts`):**

```typescript
// Identifiers
type MemoryId = string;
type ProjectId = string;
type MissionId = string;
type DiagnosisId = string;
type PatchId = string;
type DecisionId = string;
type BugId = string;
type SymbolId = string;
type FilePath = string;
type Timestamp = string;

// Categories
type MemoryCategory = 
  | 'mission-created'
  | 'mission-completed'
  | 'mission-failed'
  | 'diagnosis-created'
  | 'diagnosis-completed'
  | 'diagnosis-accepted'
  | 'diagnosis-rejected'
  | 'patch-accepted'
  | 'patch-rejected'
  | 'architecture-decision'
  | 'review-decision'
  | 'knowledge-update'
  | 'documentation-update'
  | 'code-change'
  | 'test-result'
  | 'performance-metric'
  | 'security-finding'
  | 'dependency-update';

// Levels
type ImportanceLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';
type ConfidenceLevel = 'certain' | 'high' | 'medium' | 'low' | 'unknown';
type OutcomeType = 'success' | 'failure' | 'partial' | 'pending' | 'unknown';

// Domains
type EngineeringDomain = 
  | 'authentication'
  | 'authorization'
  | 'backend'
  | 'frontend'
  | 'networking'
  | 'database'
  | 'security'
  | 'performance'
  | 'testing'
  | 'documentation'
  | 'architecture'
  | 'devops'
  | 'build'
  | 'monitoring'
  | 'api-design'
  | 'data-modeling';
```

**Base Memory Record:**

```typescript
interface BaseMemoryRecord {
  id: MemoryId;
  timestamp: Timestamp;
  projectId: ProjectId;
  category: MemoryCategory;
  importance: ImportanceLevel;
  confidence: ConfidenceLevel;
  relatedFiles: FilePath[];
  relatedSymbols: SymbolId[];
  relatedMissionId?: MissionId;
  relatedDiagnosisId?: DiagnosisId;
  tags: string[];
  summary: string;
  detailedRecord: string;
  references: MemoryReference[];
  layer: MemoryLayer;
}

interface MemoryReference {
  type: 'memory' | 'document' | 'issue' | 'commit' | 'pr' | 'url';
  id: string;
  description?: string;
}
```

### 4.2 Engineering Memory (PART 1)

**Memory Record (`packages/engineering-memory/src/memory/types.ts`):**

```typescript
interface EngineeringMemoryRecord extends BaseMemoryRecord {
  metadata: MemoryMetadata;
}

interface MemoryMetadata {
  source: MemorySource;
  version: number;
  contentHash?: string;
  parentId?: MemoryId;
  childIds?: MemoryId[];
  [key: string]: unknown;
}

type MemorySource = 
  | 'mission-control'
  | 'diagnosis-engine'
  | 'ai-code-intelligence'
  | 'knowledge-fabric'
  | 'user'
  | 'system'
  | 'integration';
```

**Storage:**
- Files: `~/.aura/engineering-memory/<projectId>/<memoryId>.json`
- Index: `~/.aura/engineering-memory/<projectId>/index.json`
- Format: JSON with atomic writes

### 4.3 Pattern Engine (PART 2)

**Pattern Record (`packages/engineering-memory/src/pattern/types.ts`):**

```typescript
interface PatternRecord {
  id: PatternId;
  type: PatternType;
  name: string;
  description: string;
  occurrenceCount: number;
  firstSeen: Timestamp;
  lastSeen: Timestamp;
  relatedMemoryIds: MemoryId[];
  severity: ImportanceLevel;
  domain: EngineeringDomain;
  commonFiles: FilePath[];
  commonSymbols: SymbolId[];
  suggestedFix: string;
}

type PatternType = 
  | 'null-pointer-fix'
  | 'architecture-violation'
  | 'dependency-cycle'
  | 'performance-bottleneck'
  | 'security-finding'
  | 'review-comment'
  | 'code-smell'
  | 'test-failure'
  | 'build-error'
  | 'api-change';

interface PatternDetectionResult {
  pattern: PatternType;
  patternId?: PatternId;
  confidence: number;
  evidence: PatternEvidence[];
  severity: ImportanceLevel;
  files: FilePath[];
  symbols: SymbolId[];
  suggestedFix: string;
  domain: EngineeringDomain;
}
```

**Storage:**
- Files: `~/.aura/engineering-memory/<projectId>/patterns/<patternId>.json`
- Stats: `~/.aura/engineering-memory/<projectId>/patterns/stats.json`

### 4.4 Experience Engine (PART 3)

**Domain Experience Record (`packages/engineering-memory/src/experience/types.ts`):**

```typescript
interface DomainExperienceRecord {
  projectId: ProjectId;
  domain: EngineeringDomain;
  completedMissions: number;
  failedMissions: number;
  successfulDiagnoses: number;
  failedDiagnoses: number;
  totalMissionDurationMinutes: number;
  averageConfidence: number;
  averageReviewScore: number;
  averageRisk: number;
  lastActivity: string;
  relatedMissionIds: MissionId[];
  relatedDiagnosisIds: DiagnosisId[];
  relatedMemoryIds: MemoryId[];
}

interface ProjectExperienceMetrics {
  projectId: ProjectId;
  byDomain: Record<EngineeringDomain, DomainExperienceRecord>;
  overallSuccessRate: number;
  overallFailureRate: number;
  averageConfidence: number;
  averageReviewScore: number;
  averageRisk: number;
  totalMissions: number;
  totalDiagnoses: number;
  totalDurationMinutes: number;
  mostExperiencedDomain: EngineeringDomain;
  leastExperiencedDomain: EngineeringDomain;
}
```

**Storage:**
- Files: `~/.aura/engineering-memory/<projectId>/experience/<domain>.json`

### 4.5 Decision Memory (PART 4)

**Decision Record (`packages/engineering-memory/src/decision/types.ts`):**

```typescript
interface DecisionRecord {
  id: DecisionId;
  projectId: ProjectId;
  timestamp: Timestamp;
  problem: string;
  alternatives: DecisionAlternative[];
  chosenSolution: DecisionAlternative;
  rejectedSolutions: DecisionAlternative[];
  reasoning: string;
  tradeoffs: string[];
  expectedOutcome: string;
  actualOutcome?: string;
  affectedComponents: FilePath[];
  affectedSymbols: SymbolId[];
  relatedMissionId?: MissionId;
  relatedDiagnosisId?: DiagnosisId;
  confidence: ConfidenceLevel;
  importance: ImportanceLevel;
  tags: string[];
  relatedMemoryIds: MemoryId[];
}

interface DecisionAlternative {
  id: string;
  name: string;
  description: string;
  pros: string[];
  cons: string[];
  complexity: 'low' | 'medium' | 'high';
  risk: 'low' | 'medium' | 'high';
}
```

**Storage:**
- Files: `~/.aura/engineering-memory/<projectId>/decisions/<decisionId>.json`

### 4.6 Bug Memory (PART 5)

**Bug Record (`packages/engineering-memory/src/bug/types.ts`):**

```typescript
interface BugRecord {
  id: BugId;
  projectId: ProjectId;
  timestamp: Timestamp;
  bugType: BugType;
  rootCause: string;
  symptoms: string[];
  evidence: string[];
  fixStrategy: string;
  risk: ImportanceLevel;
  files: FilePath[];
  architectureLayer: ArchitectureLayer;
  confidence: ConfidenceLevel;
  relatedMissionId?: MissionId;
  relatedDiagnosisId?: DiagnosisId;
  relatedPatchId?: PatchId;
  tags: string[];
  relatedMemoryIds: MemoryId[];
  isFixed: boolean;
  fixVerification?: string;
}

type BugType = 
  | 'null-pointer'
  | 'type-error'
  | 'logic-error'
  | 'race-condition'
  | 'memory-leak'
  | 'performance'
  | 'security'
  | 'build-error'
  | 'test-failure'
  | 'integration-issue'
  | 'configuration-error'
  | 'api-contract'
  | 'data-corruption'
  | 'unknown';

type ArchitectureLayer = 
  | 'presentation'
  | 'application'
  | 'domain'
  | 'infrastructure'
  | 'database'
  | 'external'
  | 'build'
  | 'test';
```

**Storage:**
- Files: `~/.aura/engineering-memory/<projectId>/bugs/<bugId>.json`

### 4.7 Mission Memory (PART 6)

**Mission Memory Record (`packages/engineering-memory/src/mission/types.ts`):**

```typescript
interface MissionMemoryRecord {
  id: MissionId;
  projectId: ProjectId;
  timestamp: Timestamp;
  intent: string;
  goalGraph: MissionGoalGraph;
  executionHistory: MissionExecutionEvent[];
  approvals: MissionApproval[];
  diffs: MissionDiff[];
  results: MissionResult[];
  durationMinutes: number;
  outcome: OutcomeType;
  failures: MissionFailure[];
  successes: string[];
  confidence: ConfidenceLevel;
  importance: ImportanceLevel;
  tags: string[];
  relatedMemoryIds: MemoryId[];
}

interface MissionGoalGraph {
  goals: MissionGoal[];
  tasks: MissionTask[];
}

interface MissionExecutionEvent {
  timestamp: Timestamp;
  type: 'started' | 'step-proposed' | 'step-accepted' | 'step-rejected' | 
         'step-completed' | 'error' | 'paused' | 'resumed';
  stepId?: string;
  details: string;
}
```

**Storage:**
- Files: `~/.aura/engineering-memory/<projectId>/missions/<missionId>.json`

### 4.8 Project Timeline (PART 7)

**Timeline Event (`packages/engineering-memory/src/timeline/types.ts`):**

```typescript
interface TimelineEvent {
  id: string;
  projectId: ProjectId;
  timestamp: Timestamp;
  type: TimelineEventType;
  entityId: string;
  entityType: 'mission' | 'diagnosis' | 'patch' | 'decision' | 'knowledge' | 'review';
  summary: string;
  details: string;
  relatedFiles: FilePath[];
  relatedSymbols: SymbolId[];
  durationMinutes?: number;
  outcome?: OutcomeType;
}

type TimelineEventType = 
  | 'mission-created'
  | 'mission-started'
  | 'diagnosis-created'
  | 'diagnosis-completed'
  | 'patch-proposed'
  | 'patch-accepted'
  | 'patch-rejected'
  | 'approval-received'
  | 'execution-started'
  | 'execution-completed'
  | 'knowledge-updated'
  | 'mission-completed'
  | 'review-submitted'
  | 'decision-made';
```

**Storage:**
- Files: `~/.aura/engineering-memory/<projectId>/timeline/<eventId>.json`

### 4.9 Engineering Search (PART 8)

**Search Types (`packages/engineering-memory/src/search/types.ts`):**

```typescript
interface EngineeringSearchQuery {
  query: string;
  projectIds?: ProjectId[];
  categories?: MemoryCategory[];
  domains?: EngineeringDomain[];
  tags?: string[];
  importanceLevels?: ImportanceLevel[];
  confidenceLevels?: ConfidenceLevel[];
  outcomeTypes?: OutcomeType[];
  dateRange?: {
    start?: Timestamp;
    end?: Timestamp;
  };
  limit?: number;
  offset?: number;
  sortBy?: 'timestamp' | 'importance' | 'confidence' | 'relevance';
  sortDirection?: 'asc' | 'desc';
}

interface EngineeringSearchResult {
  memory: BaseMemoryRecord;
  score: number;
  highlights: SearchHighlight[];
}

interface SearchHighlight {
  field: 'summary' | 'detailedRecord' | 'tags';
  text: string;
  positions: [number, number][];
}
```

### 4.10 Prediction Foundation (PART 9)

**Similarity Types (`packages/engineering-memory/src/prediction/types.ts`):**

```typescript
interface SimilarItemsResult<T> {
  items: T[];
  scores: number[];
  queryId: string;
}

interface RiskTrend {
  timestamp: Timestamp;
  domain: EngineeringDomain;
  riskLevel: number;
  riskType: string;
}

interface EngineeringTrend {
  timestamp: Timestamp;
  metric: string;
  value: number;
  domain: EngineeringDomain;
  changeRate: number;
}
```

### 4.11 Memory Graph (PART 10)

**Graph Types (`packages/engineering-memory/src/graph/types.ts`):**

```typescript
interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  projectId: ProjectId;
  updatedAt: Timestamp;
}

interface MemoryGraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

type GraphNodeType = 
  | 'mission'
  | 'diagnosis'
  | 'patch'
  | 'decision'
  | 'knowledge'
  | 'file'
  | 'symbol'
  | 'architecture'
  | 'review'
  | 'documentation';

interface MemoryGraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  weight: number;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
}

type GraphEdgeType = 
  | 'related-to'
  | 'depends-on'
  | 'affects'
  | 'fixes'
  | 'part-of'
  | 'references'
  | 'causes'
  | 'resolves';
```

### 4.12 Engineering Insights (PART 11)

**Insight Types (`packages/engineering-memory/src/insights/types.ts`):**

```typescript
interface EngineeringInsight {
  id: string;
  type: InsightType;
  timestamp: Timestamp;
  title: string;
  description: string;
  domain: EngineeringDomain;
  metric: string;
  value: number;
  previousValue?: number;
  changePercentage?: number;
  severity: ImportanceLevel;
  relatedMemoryIds: MemoryId[];
  relatedPatternIds: PatternId[];
}

type InsightType = 
  | 'bug-density'
  | 'quality-improvement'
  | 'coverage-change'
  | 'architecture-change'
  | 'performance-trend'
  | 'security-trend'
  | 'domain-activity';
```

---

## 5. Memory Graph

The Memory Graph connects all engineering entities into a unified, queryable graph structure.

**Graph Structure:**

```
┌─────────────────────────────────────────────────────────────────┐
│                        MEMORY GRAPH                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐  │
│  │   Mission    │      │  Diagnosis   │      │    Patch     │  │
│  │   Node       │──────│    Node      │──────│    Node      │  │
│  └──────────────┘      └──────────────┘      └──────────────┘  │
│         │                  │                   │              │
│         ▼                  ▼                   ▼              │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐  │
│  │  Decision    │      │     Bug      │      │    File     │  │
│  │   Node       │      │    Node      │      │    Node      │  │
│  └──────────────┘      └──────────────┘      └──────────────┘  │
│         │                  │                   │              │
│         ▼                  ▼                   ▼              │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐  │
│  │  Symbol      │      │  Knowledge   │      │  Timeline    │  │
│  │   Node       │      │    Node      │      │    Node      │  │
│  └──────────────┘      └──────────────┘      └──────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

**Edge Types:**
- `related-to`: General relationship
- `depends-on`: Dependency relationship
- `affects`: Impact relationship
- `fixes`: Bug fix relationship
- `part-of`: Composition relationship
- `references`: Reference relationship
- `causes`: Causality relationship
- `resolves`: Resolution relationship

**Integration with Knowledge Fabric:**
The Memory Graph is designed to be part of the Knowledge Fabric. Nodes reference entities from the Knowledge Fabric's graph, and edges represent engineering-specific relationships.

---

## 6. Pattern Engine

The Pattern Engine detects and manages recurring engineering patterns.

**Detection Pipeline:**

```
Input (Code/File/Memory)
    │
    ▼
┌─────────────────────┐
│  Rule-Based Matching │  ← Default rules for known patterns
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│  Text-Based Detection │  ← Keyword matching for pattern types
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│  Context Analysis    │  ← Analyze related files/symbols
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│  Pattern Recording    │  ← Store in PatternStore
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│  Pattern Clustering   │  ← Group similar detections
└─────────────────────┘
    │
    ▼
Pattern Records & Statistics
```

**Default Pattern Rules:**
- Null pointer fixes
- Architecture violations
- Dependency cycles
- Performance bottlenecks
- Security findings
- Review comments
- Code smells
- Test failures
- Build errors
- API changes

**Clustering Algorithm:**
- Jaccard similarity for text matching
- File/symbol overlap analysis
- Severity and domain weighting
- Configurable similarity thresholds

---

## 7. Experience Engine

The Experience Engine tracks engineering experience by domain.

**Experience Tracking:**

```
┌─────────────────────────────────────────────────────────────────┐
│                   EXPERIENCE TRACKING                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Mission Completion:                                                │
│    ├── Completed: +1 to domain, update confidence/review/risk     │
│    └── Failed: +1 to domain, update confidence/risk               │
│                                                                     │
│  Diagnosis Outcome:                                                │
│    ├── Success: +1 to domain, update confidence                   │
│    └── Failure: +1 to domain, update confidence                   │
│                                                                     │
│  Review Scoring:                                                   │
│    └── Score: update average review score for domain              │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

**Experience Metrics:**
- Completed missions count
- Failed missions count
- Success rate (completed / total)
- Failure rate (failed / total)
- Average confidence
- Average review score
- Average risk
- Total duration
- Last activity timestamp

**Domain-Specific Tracking:**
Each domain (authentication, backend, frontend, etc.) has its own experience record, allowing for domain-specific insights and comparisons.

---

## 8. Public APIs

The Engineering Memory Platform exposes clean, modular APIs for consumption by other AURA subsystems.

### 8.1 Main API (`EngineeringMemoryApi`)

**Memory APIs:**
```typescript
// Create memories
createMemory(record: {...}): EngineeringMemoryRecord
queryMemories(query: {...}): EngineeringMemoryRecord[]
getMemoriesByMission(missionId: MissionId): EngineeringMemoryRecord[]
getMemoriesByDiagnosis(diagnosisId: DiagnosisId): EngineeringMemoryRecord[]
```

**Pattern APIs:**
```typescript
detectPatternsInCode(projectId, filePath, content, language): PatternDetectionResult[]
detectPatternsFromMemory(...): PatternDetectionResult[]
getPatternRecords(projectId: ProjectId): PatternRecord[]
getPatternStats(projectId: ProjectId): ProjectPatternStatistics
```

**Experience APIs:**
```typescript
getDomainExperience(projectId, domain): DomainExperienceRecord
getProjectExperience(projectId): Record<EngineeringDomain, DomainExperienceRecord>
getOverallExperience(): OverallExperienceMetrics
```

**Decision APIs:**
```typescript
createDecision(record: {...}): DecisionRecord
searchDecisions(projectId, problem, limit): DecisionRecord[]
getDecisionsByMission(projectId, missionId): DecisionRecord[]
```

**Bug APIs:**
```typescript
createBug(record: {...}): BugRecord
searchBugs(projectId, rootCause, limit): BugRecord[]
findSimilarBugs(projectId, bugId, limit): { bug: BugRecord; score: number }[]
```

**Mission APIs:**
```typescript
createMissionMemory(record: {...}): MissionMemoryRecord
searchMissions(projectId, intent, limit): MissionMemoryRecord[]
findSimilarMissions(projectId, missionId, limit): { mission: MissionMemoryRecord; score: number }[]
```

**Timeline APIs:**
```typescript
getTimeline(projectId: ProjectId): TimelineEvent[]
getTimelineEventsByType(projectId, type): TimelineEvent[]
getTimelineSummary(projectId: ProjectId): TimelineSummary
```

**Search APIs:**
```typescript
searchEngineeringMemory(query: EngineeringSearchQuery): EngineeringSearchResult[]
showAuthenticationDecisions(options): DecisionRecord[]
findArchitectureViolations(options): EngineeringMemoryRecord[]
showSimilarBugs(projectId, bugId, limit): BugRecord[]
findPerformanceOptimizations(options): EngineeringMemoryRecord[]
showRejectedPatches(options): EngineeringMemoryRecord[]
```

**Prediction APIs:**
```typescript
findSimilarBugsApi(projectId, bugId, limit): SimilarItemsResult
findSimilarMissionsApi(projectId, missionId, limit): SimilarItemsResult
findSimilarDecisionsApi(projectId, decisionId, limit): SimilarItemsResult
findSimilarFilesApi(projectId, filePath, limit): SimilarItemsResult<FilePath>
```

**Graph APIs:**
```typescript
getMemoryGraph(projectId: ProjectId): MemoryGraph
getGraphNode(nodeId: string): MemoryGraphNode
getGraphNeighbors(nodeId: string): { node: MemoryGraphNode; edge: MemoryGraphEdge }[]
```

**Insights APIs:**
```typescript
generateInsights(projectId: ProjectId): EngineeringInsight[]
getTopInsights(projectId, limit): EngineeringInsight[]
getInsightsByType(projectId, type): EngineeringInsight[]
```

### 8.2 API Design Principles

1. **Read-Only for Existing Systems:** All APIs that interact with existing systems (Mission Control, Diagnosis, etc.) are read-only. They query data but never mutate it.

2. **Write-Only for Memory:** APIs that create memories, patterns, decisions, etc. only write to the Engineering Memory Platform's own storage.

3. **Modular:** Each API is independent and can be used without requiring other APIs.

4. **Type-Safe:** All APIs use TypeScript types for compile-time safety.

5. **Error-Resilient:** APIs handle errors gracefully and return meaningful error information.

---

## 9. Integration Points

### 9.1 Integration with Mission Control

The Engineering Memory Platform integrates with Mission Control through event listeners:

```typescript
// In Mission Control, when a mission is created:
engineeringMemoryApi.createMemory({
  projectId: mission.projectId,
  category: 'mission-created',
  summary: `Mission created: ${mission.intent}`,
  detailedRecord: JSON.stringify(mission),
  relatedMissionId: mission.id,
  tags: ['mission', 'created'],
  importance: 'medium',
  confidence: 'high',
});

// When a mission is completed:
engineeringMemoryApi.createMemory({
  projectId: mission.projectId,
  category: 'mission-completed',
  summary: `Mission completed: ${mission.intent}`,
  detailedRecord: `Outcome: ${mission.outcome}`,
  relatedMissionId: mission.id,
  tags: ['mission', 'completed', mission.outcome],
  importance: mission.outcome === 'failure' ? 'high' : 'medium',
  confidence: 'high',
});

// Also update experience:
experienceEngine.recordMissionCompletion(
  mission.projectId,
  domain, // Determined from mission
  mission.id,
  mission.durationMinutes,
  mission.confidence,
  mission.reviewScore,
  mission.risk
);

// And record timeline event:
projectTimeline.recordMissionCompleted(
  mission.projectId,
  mission.id,
  mission.outcome,
  mission.durationMinutes
);
```

### 9.2 Integration with Diagnosis Engine

```typescript
// When a diagnosis is created:
engineeringMemoryApi.createMemory({
  projectId: diagnosis.projectId,
  category: diagnosis.decision.status === 'accepted' ? 'diagnosis-accepted' : 
            diagnosis.decision.status === 'rejected' ? 'diagnosis-rejected' : 'diagnosis-created',
  summary: `Diagnosis: ${diagnosis.classification.category} in ${diagnosis.filePath}`,
  detailedRecord: JSON.stringify(diagnosis),
  relatedDiagnosisId: diagnosis.id,
  relatedFiles: [diagnosis.filePath],
  tags: ['diagnosis', diagnosis.classification.category],
  importance: 'medium',
  confidence: diagnosis.confidence.overall,
});

// Update experience:
experienceEngine.recordDiagnosisSuccess(
  diagnosis.projectId,
  domain, // Determined from diagnosis
  diagnosis.id,
  diagnosis.confidence.overall
);

// Detect patterns:
const patterns = patternEngine.detectFromDiagnosis(
  diagnosis.projectId,
  diagnosis.id,
  diagnosis.classification.category,
  diagnosis.filePath,
  diagnosis.signals.evidence
);

// Record patterns:
patternEngine.recordDetections(diagnosis.projectId, patterns);

// Record timeline:
projectTimeline.recordDiagnosisCompleted(
  diagnosis.projectId,
  diagnosis.id,
  diagnosis.classification.category,
  diagnosis.decision.status
);
```

### 9.3 Integration with Knowledge Fabric

The Memory Graph is designed to integrate with the Knowledge Fabric:

```typescript
// When Knowledge Fabric updates:
engineeringMemoryApi.createMemory({
  projectId: projectId,
  category: 'knowledge-update',
  summary: `Knowledge updated: ${updateType}`,
  detailedRecord: description,
  relatedFiles: files,
  relatedSymbols: symbols,
  tags: ['knowledge', updateType],
  importance: 'low',
  confidence: 'high',
});

// Also update memory graph:
const knowledgeNode = memoryGraph.addKnowledgeNode(
  knowledgeId,
  projectId,
  label,
  { updateType, description }
);

// Connect to related entities:
for (const symbol of symbols) {
  const symbolNode = memoryGraph.addSymbolNode(symbol, projectId, symbol);
  memoryGraph.addRelatedEdge(knowledgeNode.id, symbolNode.id);
}
```

---

## 10. Storage Architecture

### 10.1 Directory Structure

```
~/.aura/
├── engineering-memory/          # Engineering Memory Platform root
│   ├── <projectId1>/           # Per-project storage
│   │   ├── <memoryId>.json     # Individual memory records
│   │   ├── index.json          # Memory index for fast queries
│   │   ├── patterns/           # Pattern records
│   │   │   ├── <patternId>.json
│   │   │   └── stats.json
│   │   ├── experience/         # Experience records
│   │   │   └── <domain>.json
│   │   ├── decisions/          # Decision records
│   │   │   └── <decisionId>.json
│   │   ├── bugs/               # Bug records
│   │   │   └── <bugId>.json
│   │   ├── missions/           # Mission memory records
│   │   │   └── <missionId>.json
│   │   └── timeline/           # Timeline events
│   │       └── <eventId>.json
│   └── <projectId2>/           # Another project
│       └── ...
└── ...
```

### 10.2 File Formats

All files are JSON with the following structure:

**Memory Record:**
```json
{
  "id": "mem_abc123",
  "projectId": "proj_123",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "category": "mission-created",
  "importance": "medium",
  "confidence": "high",
  "relatedFiles": ["src/index.ts"],
  "relatedSymbols": ["main", "App"],
  "relatedMissionId": "mission_123",
  "tags": ["mission", "created"],
  "summary": "Mission created: Add authentication",
  "detailedRecord": "Full mission details...",
  "references": [],
  "metadata": {
    "source": "mission-control",
    "version": 1
  }
}
```

**Pattern Record:**
```json
{
  "id": "pat_abc123",
  "type": "null-pointer-fix",
  "name": "Null pointer fix in backend",
  "description": "Detected null pointer pattern in backend domain",
  "occurrenceCount": 5,
  "firstSeen": "2024-01-01T12:00:00.000Z",
  "lastSeen": "2024-01-15T12:00:00.000Z",
  "severity": "high",
  "domain": "backend",
  "relatedMemoryIds": ["mem_1", "mem_2"],
  "commonFiles": ["src/utils.ts"],
  "commonSymbols": ["getUser"],
  "suggestedFix": "Add null check before accessing property"
}
```

### 10.3 Atomic Writes

All writes use atomic file operations:
1. Write to temporary file (`<file>.tmp`)
2. Rename temporary file to final file
3. This ensures no partial writes if the process crashes

---

## 11. Event System

The Engineering Memory Platform uses an event-driven architecture for real-time updates.

**Event Types:**

```typescript
// Memory Events
interface MemoryEvent {
  type: 'created' | 'updated' | 'deleted' | 'linked' | 'unlinked';
  memoryId: MemoryId;
  projectId: ProjectId;
  timestamp: string;
  data?: Record<string, unknown>;
}

// Pattern Events
interface PatternEngineEvent {
  type: 'pattern-detected' | 'pattern-clustered' | 'pattern-updated' | 'pattern-removed';
  projectId: ProjectId;
  timestamp: string;
  data: PatternDetectionResult | PatternCluster | PatternRecord;
}

// Experience Events
interface ExperienceEngineEvent {
  type: 'experience-updated' | 'milestone-reached' | 'domain-mastered';
  projectId: ProjectId;
  domain: EngineeringDomain;
  timestamp: string;
  data: DomainExperienceRecord | { milestone: string; value: number };
}
```

**Event Listeners:**

```typescript
// Add a global memory event listener
engineeringMemory.onGlobalEvent((event: MemoryEvent) => {
  console.log('Memory event:', event.type, event.memoryId);
});

// Add a project-specific listener
engineeringMemory.onProjectEvent('proj_123', (event: MemoryEvent) => {
  console.log('Project memory event:', event);
});

// Add a pattern engine listener
patternEngine.on((event: PatternEngineEvent) => {
  console.log('Pattern event:', event.type);
});

// Add an experience engine listener
experienceEngine.on((event: ExperienceEngineEvent) => {
  console.log('Experience event:', event.type);
});
```

---

## 12. Similarity and Matching

The platform uses deterministic similarity calculations combined with AI reasoning.

**Similarity Algorithms:**

1. **Jaccard Similarity:** For set-based comparison
   ```typescript
   function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
     const intersection = [...a].filter(x => b.has(x)).length;
     const union = a.size + b.size - intersection;
     return intersection / union;
   }
   ```

2. **Cosine Similarity:** For vector-based comparison
   ```typescript
   function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
     let dotProduct = 0, aMagnitude = 0, bMagnitude = 0;
     for (const [key, aVal] of a) {
       const bVal = b.get(key) || 0;
       dotProduct += aVal * bVal;
       aMagnitude += aVal * aVal;
       bMagnitude += bVal * bVal;
     }
     return dotProduct / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude));
   }
   ```

3. **Weighted Similarity:** For multi-factor comparison
   ```typescript
   function weightedSimilarity(
     factors: { text?: number; tags?: number; category?: number; importance?: number; recency?: number },
     a: any,
     b: any
   ): number {
     // Combine multiple similarity factors with weights
   }
   ```

**Tokenization:**
```typescript
function tokenize(text: string): Set<string> {
  const stopWords = new Set(['the', 'a', 'is', 'are', ...]);
  return new Set(
    text.toLowerCase().match(/[a-z0-9]+/g)?.filter(w => w.length > 2 && !stopWords.has(w)) ?? []
  );
}
```

---

## 13. Validation

All data is validated before storage using a comprehensive validation system.

**Validation Functions:**

```typescript
// Type guards
isValidMemoryCategory(value: string): value is MemoryCategory
isValidImportanceLevel(value: string): value is ImportanceLevel
isValidConfidenceLevel(value: string): value is ConfidenceLevel
isValidEngineeringDomain(value: string): value is EngineeringDomain

// Complex validation
validateStringLength(value, fieldName, minLength, maxLength): string | null
validateNonEmptyArray(value, fieldName, minLength): string | null
isValidTimestamp(value: string): boolean

// Validation collector
class ValidationCollector {
  private errors: ValidationError[] = [];
  add(field: string, message: string, value: unknown): void
  addIf(field: string, message: string, value: unknown, condition: boolean): void
  isValid(): boolean
  getResult(): ValidationResult
  throwIfInvalid(context: string): void
}
```

---

## 14. ID Generation

Unique IDs are generated for all entities using a consistent pattern:

```typescript
function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  const seq = (++counter).toString(36);
  return `${prefix}_${timestamp}_${random}_${seq}`;
}

// Example IDs:
// mem_abc123_def456_7 (memory)
// pat_abc123_def456_8 (pattern)
// dec_abc123_def456_9 (decision)
// bug_abc123_def456_a (bug)
// tl_abc123_def456_b (timeline)
// node_abc123_def456_c (graph node)
// edge_abc123_def456_d (graph edge)
```

---

## 15. Extension Points

The Engineering Memory Platform is designed for extensibility:

### 15.1 Adding New Memory Categories

1. Add the category to `MemoryCategory` type in `types.ts`
2. Add creation method to `EngineeringMemory` class
3. Add any category-specific validation

### 15.2 Adding New Pattern Types

1. Add the pattern type to `PatternType` type in `pattern/types.ts`
2. Add a pattern matching rule to `DEFAULT_PATTERN_RULES` in `PatternEngine.ts`
3. Add any pattern-specific detection logic

### 15.3 Adding New Engineering Domains

1. Add the domain to `EngineeringDomain` type in `types.ts`
2. Add experience tracking to `ExperienceEngine`
3. Add domain-specific insights to `EngineeringInsights`

### 15.4 Adding New Graph Node Types

1. Add the node type to `GraphNodeType` type in `graph/types.ts`
2. Add a node creation method to `MemoryGraphBuilder`
3. Add any type-specific edge connections

### 15.5 Adding New Insight Types

1. Add the insight type to `InsightType` type in `insights/types.ts`
2. Add insight generation method to `EngineeringInsights`
3. Add any type-specific insight logic

---

## 16. Quality Bar

The Engineering Memory Platform adheres to the following quality standards:

1. **No Fake Memories:** Every memory must come from real engineering work. No fabricated or simulated data.

2. **No Placeholders:** All implementations are complete and functional. No stub methods or TODO placeholders.

3. **Type Safety:** All code is TypeScript with strict type checking. No `any` types unless absolutely necessary.

4. **Error Handling:** All operations handle errors gracefully with meaningful error messages.

5. **Atomic Operations:** All writes are atomic to prevent data corruption.

6. **Indexed Queries:** All data is indexed for fast retrieval. No linear scans for common queries.

7. **Memory Efficient:** Data structures are designed to minimize memory usage while maintaining performance.

8. **Thread Safe:** All operations are designed to be thread-safe for concurrent access.

9. **Testable:** All modules are designed with testability in mind, with clear separation of concerns.

10. **Documented:** All public APIs are documented with TypeScript types and JSDoc comments.

---

## 17. Future Work

The following are planned for future implementation:

1. **Real-Time Notifications:** WebSocket or SSE support for real-time memory updates
2. **Advanced Prediction:** Machine learning models for prediction (when real data is available)
3. **Cross-Project Analysis:** Insights that span multiple projects
4. **Team Collaboration:** Shared memory across team members
5. **Version Control Integration:** Integration with git for change tracking
6. **CI/CD Integration:** Integration with CI/CD pipelines for automated memory capture
7. **Performance Optimization:** Optimizations for large-scale projects
8. **Advanced Search:** Vector embeddings for semantic search (when real data justifies it)

---

## 18. Migration Guide

### 18.1 For Existing AURA Users

The Engineering Memory Platform is designed to be non-disruptive:

1. **No Changes Required:** Existing functionality continues to work unchanged
2. **Opt-In Memory:** Memory recording is opt-in and can be disabled
3. **Backward Compatible:** All existing data formats are supported
4. **Gradual Adoption:** Features can be adopted incrementally

### 18.2 For Developers

To integrate with the Engineering Memory Platform:

1. **Import the API:**
   ```typescript
   import { engineeringMemoryApi } from '@aura/engineering-memory';
   ```

2. **Use the APIs:**
   ```typescript
   // Create a memory
   const memory = engineeringMemoryApi.createMemory({
     projectId: 'my-project',
     category: 'mission-created',
     summary: 'New mission created',
     detailedRecord: 'Full details...',
     // ...
   });

   // Query memories
   const memories = engineeringMemoryApi.queryMemories({
     projectIds: ['my-project'],
     categories: ['mission-created'],
     limit: 10,
   });
   ```

3. **Add Event Listeners:**
   ```typescript
   // Listen for memory events
   engineeringMemoryApi.onGlobalEvent((event) => {
     console.log('Memory event:', event);
   });
   ```

---

## 19. Glossary

| Term | Definition |
|------|------------|
| Engineering Memory | Persistent storage of engineering events and knowledge |
| Pattern Engine | Detects and manages recurring engineering patterns |
| Experience Engine | Tracks engineering experience by domain |
| Decision Memory | Stores engineering decisions for future reference |
| Bug Memory | Stores bug diagnoses and outcomes |
| Mission Memory | Stores mission records and outcomes |
| Project Timeline | Chronological record of engineering events |
| Engineering Search | Semantic search across all engineering memories |
| Prediction Foundation | Infrastructure for future prediction capabilities |
| Memory Graph | Graph connecting all engineering entities |
| Engineering Insights | Automatically generated insights from historical data |
| Knowledge Fabric | Existing AURA system for codebase knowledge |
| Mission Control | Existing AURA system for mission planning and execution |
| Diagnosis Engine | Existing AURA system for bug diagnosis |
| AI Code Intelligence | Existing AURA system for code intelligence |

---

## 20. References

- [Engineering Intelligence Platform Architecture](../ENGINEERING_INTELLIGENCE_PLATFORM.md)
- [AURA Main Architecture](../../ARCHITECTURE.md)
- [Knowledge Fabric Implementation](../../packages/knowledge-fullstack/)
- [Retrieval System Implementation](../../packages/retrieval/)

---

*This document is the implementation constitution for the Engineering Memory Platform. All implementations must conform to the architecture described herein.*
