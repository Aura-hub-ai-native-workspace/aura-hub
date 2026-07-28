# Graph Report - aura-hub  (2026-07-27)

## Corpus Check
- 228 files · ~267,251 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1950 nodes · 4712 edges · 97 communities (87 shown, 10 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 23 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Design System & Core Primitives|Design System & Core Primitives]]
- [[_COMMUNITY_Project Workspace Sections|Project Workspace Sections]]
- [[_COMMUNITY_Conversations & Intent|Conversations & Intent]]
- [[_COMMUNITY_Repository Intelligence Modules|Repository Intelligence Modules]]
- [[_COMMUNITY_Memory Hierarchy|Memory Hierarchy]]
- [[_COMMUNITY_Persistence & Workspace|Persistence & Workspace]]
- [[_COMMUNITY_AI Client & Settings UI|AI Client & Settings UI]]
- [[_COMMUNITY_App Shell & Store|App Shell & Store]]
- [[_COMMUNITY_Workflow Engine|Workflow Engine]]
- [[_COMMUNITY_Workspace Manager & Records|Workspace Manager & Records]]
- [[_COMMUNITY_Home & Projects Screens|Home & Projects Screens]]
- [[_COMMUNITY_Provider Adapters & Runtime|Provider Adapters & Runtime]]
- [[_COMMUNITY_Workflow Editor UI|Workflow Editor UI]]
- [[_COMMUNITY_Intelligence Types|Intelligence Types]]
- [[_COMMUNITY_AI Chat Workspace|AI Chat Workspace]]
- [[_COMMUNITY_FullStack Entities|FullStack Entities]]
- [[_COMMUNITY_Provider Registry|Provider Registry]]
- [[_COMMUNITY_Retrieval Kernel & Budget|Retrieval Kernel & Budget]]
- [[_COMMUNITY_FullStack Engine & Indexer|FullStack Engine & Indexer]]
- [[_COMMUNITY_FullStack Extractors|FullStack Extractors]]
- [[_COMMUNITY_Repository Identity Engine|Repository Identity Engine]]
- [[_COMMUNITY_Coding Engine & Ignore Rules|Coding Engine & Ignore Rules]]
- [[_COMMUNITY_TypeScript Config|TypeScript Config]]
- [[_COMMUNITY_Module Summaries & Glossary|Module Summaries & Glossary]]
- [[_COMMUNITY_Desktop Dependencies|Desktop Dependencies]]
- [[_COMMUNITY_Credential Store & Connect|Credential Store & Connect]]
- [[_COMMUNITY_Retrieval Engine Contracts|Retrieval Engine Contracts]]
- [[_COMMUNITY_Project Profile|Project Profile]]
- [[_COMMUNITY_Gemini Runtime|Gemini Runtime]]
- [[_COMMUNITY_Document Store & Chunks|Document Store & Chunks]]
- [[_COMMUNITY_Context Assembler|Context Assembler]]
- [[_COMMUNITY_Root Workspace Config|Root Workspace Config]]
- [[_COMMUNITY_Coding Indexer & Chunker|Coding Indexer & Chunker]]
- [[_COMMUNITY_Pipeline & Server|Pipeline & Server]]
- [[_COMMUNITY_Project Memory & Graph|Project Memory & Graph]]
- [[_COMMUNITY_Navigation & App Store|Navigation & App Store]]
- [[_COMMUNITY_FullStack Search|FullStack Search]]
- [[_COMMUNITY_anthropic.ts|anthropic.ts]]
- [[_COMMUNITY_PipelineManager|PipelineManager]]
- [[_COMMUNITY_Tauri Config|Tauri Config]]
- [[_COMMUNITY_AURA Hub|AURA Hub]]
- [[_COMMUNITY_ProjectGraphStore|ProjectGraphStore]]
- [[_COMMUNITY_retrievalEngine.ts|retrievalEngine.ts]]
- [[_COMMUNITY_InvertedIndex|InvertedIndex]]
- [[_COMMUNITY_JsonKnowledgeStore|JsonKnowledgeStore]]
- [[_COMMUNITY_runIntelligencePipeline()|runIntelligencePipeline()]]
- [[_COMMUNITY_context.ts|context.ts]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_store.ts|store.ts]]
- [[_COMMUNITY_personality.ts|personality.ts]]
- [[_COMMUNITY_verification.ts|verification.ts]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_index.ts|index.ts]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_indexStore.ts|indexStore.ts]]
- [[_COMMUNITY_validation.ts|validation.ts]]
- [[_COMMUNITY_healthEngine.ts|healthEngine.ts]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_performance.ts|performance.ts]]
- [[_COMMUNITY_config.ts|config.ts]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_detector.ts|detector.ts]]
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_NullEmbeddingProvider|NullEmbeddingProvider]]
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_default.json|default.json]]
- [[_COMMUNITY_RetrievalEngineRegistry|RetrievalEngineRegistry]]
- [[_COMMUNITY_RetrievalKernel|RetrievalKernel]]
- [[_COMMUNITY_lib.rs|lib.rs]]
- [[_COMMUNITY_tailwind.config.ts|tailwind.config.ts]]
- [[_COMMUNITY_AURA_LOGO_SRC|AURA_LOGO_SRC]]
- [[_COMMUNITY_Community 89|Community 89]]
- [[_COMMUNITY_Community 90|Community 90]]
- [[_COMMUNITY_Community 91|Community 91]]
- [[_COMMUNITY_Community 92|Community 92]]
- [[_COMMUNITY_Community 93|Community 93]]
- [[_COMMUNITY_Community 94|Community 94]]
- [[_COMMUNITY_Community 95|Community 95]]
- [[_COMMUNITY_Community 96|Community 96]]
- [[_COMMUNITY_Community 97|Community 97]]
- [[_COMMUNITY_Community 98|Community 98]]
- [[_COMMUNITY_Community 101|Community 101]]

## God Nodes (most connected - your core abstractions)
1. `cn()` - 73 edges
2. `homePath()` - 41 edges
3. `readJsonFile()` - 41 edges
4. `WorkspaceManager` - 41 edges
5. `Entity` - 40 edges
6. `Icon` - 39 edges
7. `writeJsonFile()` - 38 edges
8. `PipelineManager` - 37 edges
9. `useAppStore` - 32 edges
10. `SourceFile` - 32 edges

## Surprising Connections (you probably didn't know these)
- `AURA Logo` --conceptually_related_to--> `Design Language (AURA Blue, glass, whitespace)`  [INFERRED]
  apps/desktop/src/assets/aura-logo.png → docs/DESIGN.md
- `StatusRow()` --calls--> `cn()`  [EXTRACTED]
  apps/desktop/src/screens/Home.tsx → packages/core/src/utils/cn.ts
- `Toggle()` --calls--> `cn()`  [EXTRACTED]
  apps/desktop/src/screens/ai/AiSettings.tsx → packages/core/src/utils/cn.ts
- `Kv()` --calls--> `cn()`  [EXTRACTED]
  apps/desktop/src/screens/ai/AiWorkspace.tsx → packages/core/src/utils/cn.ts
- `SectionIdentity` --references--> `IconName`  [EXTRACTED]
  apps/desktop/src/shell/sections.ts → packages/ui/src/icons/Icon.tsx

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **AURA Knowledge Layer** — concept_coding_knowledge_engine, concept_fullstack_knowledge_engine, concept_retrieval_memory_foundation [INFERRED 0.75]

## Communities (97 total, 10 thin omitted)

### Community 0 - "Design System & Core Primitives"
Cohesion: 0.04
Nodes (75): AuraLockup(), AuraLogo(), AuraLogoProps, AuraTile(), Badge(), BadgeProps, TONES, ButtonProps (+67 more)

### Community 1 - "Project Workspace Sections"
Cohesion: 0.08
Nodes (41): aiClient, ProjectIntelligence, WorkspaceIntelligence, Card, CardHeader(), EmptyState(), Graph3DNode, GraphCanvas3D() (+33 more)

### Community 2 - "Conversations & Intent"
Cohesion: 0.05
Nodes (36): IntentClassifier, KeywordIntentClassifier, PromptEnhancer, TemplatePromptEnhancer, emptyStatus(), normalize(), PipelineManager, createRequest() (+28 more)

### Community 3 - "Repository Intelligence Modules"
Cohesion: 0.08
Nodes (53): FileContent, fileExists(), getDirectoryTree(), getFileInfo(), getProjectInfo(), listFiles(), ProjectInfo, readFile() (+45 more)

### Community 4 - "Memory Hierarchy"
Cohesion: 0.10
Nodes (24): MemoryHierarchy, MemoryLayers, RecallHit, clockOf(), InMemoryKnowledgeMemory, InMemoryPersistentMemory, InMemoryProjectMemory, InMemorySessionMemory (+16 more)

### Community 5 - "Persistence & Workspace"
Cohesion: 0.11
Nodes (29): buildCrossRepoGraph(), CROSS_REPO_FILE, CrossRepoEdge, CrossRepoGraph, detectLanguageClusters(), detectMonorepoCluster(), detectSharedCode(), findPath() (+21 more)

### Community 6 - "AI Client & Settings UI"
Cohesion: 0.06
Nodes (51): ArchitectureLayer, Conversation, ConvMessage, ENV, FieldSpec, FolderNode, GraphEntity, GraphRelation (+43 more)

### Community 7 - "App Shell & Store"
Cohesion: 0.12
Nodes (15): CommandPalette(), CommandPaletteProps, SECTION_ICON, SECTION_ORDER, DialogProps, SIZES, boot, breathe (+7 more)

### Community 8 - "Workflow Engine"
Cohesion: 0.11
Nodes (14): Delivery, RunOptions, RunResult, runWorkflow(), NODE_SPECS, NodeResult, NodeSpec, RunCtx (+6 more)

### Community 9 - "Workspace Manager & Records"
Cohesion: 0.09
Nodes (10): Conversation, MemoryItem, MemoryKind, IndexStatus, Mount, ProjectProfile, ProjectRecord, OpenResult (+2 more)

### Community 10 - "Home & Projects Screens"
Cohesion: 0.13
Nodes (26): ProviderStatus, AiWorkspace(), IconButton, PanelSection(), PropertyRow(), Tooltip(), useWorkspace, useHotkey() (+18 more)

### Community 11 - "Provider Adapters & Runtime"
Cohesion: 0.12
Nodes (10): BaseOpenAICompatible, GroqAdapter, KimiAdapter, MistralAdapter, NvidiaAdapter, OpenAIAdapter, OpenRouterAdapter, adapters (+2 more)

### Community 12 - "Workflow Editor UI"
Cohesion: 0.24
Nodes (12): isCacheStale(), runIntelligencePipeline(), buildModuleDescription(), extractCapabilities(), extractFileDescription(), FileSummary, generateRepositorySummary(), loadRepositorySummary() (+4 more)

### Community 13 - "Intelligence Types"
Cohesion: 0.11
Nodes (30): AgentContext, ConfidenceSource, AssembledContext, ContextAssemblerInput, detectDocKind(), INTENT_DOC_PRIORITIES, prioritizeDocuments(), IntelligenceEngineResult (+22 more)

### Community 14 - "AI Chat Workspace"
Cohesion: 0.09
Nodes (18): ConversationSummary, InspectResult, StreamDone, StreamError, AiMarkdown(), inline(), errorTitle(), Kv() (+10 more)

### Community 15 - "FullStack Entities"
Cohesion: 0.05
Nodes (49): ArchitectureExtractor, isMarkdown(), BackendExtractor, isBackendCandidate(), referencedClasses(), versionOf(), ConfigExtractor, DatabaseExtractor (+41 more)

### Community 16 - "Provider Registry"
Cohesion: 0.07
Nodes (22): AiSettings, ConnectedProvider, HealthResult, ProviderInfo, AiSettings(), DialogState, EMPTY_DIALOG, providerIcon() (+14 more)

### Community 17 - "Retrieval Kernel & Budget"
Cohesion: 0.19
Nodes (13): BudgetAllocator, CompressionPolicyId, Compressor, COMPRESSORS, EngineAllotment, getCompressor(), NoopCompressor, PlaceholderSummarizeCompressor (+5 more)

### Community 19 - "FullStack Extractors"
Cohesion: 0.20
Nodes (10): 1. Philosophy → structure, 2. Monorepo & dependency direction, 3. State architecture, 4. The extension points (where intelligence plugs in), 5. Theming, 6. Motion, 7. Native runtime (Tauri v2), 8. Conventions (+2 more)

### Community 20 - "Repository Identity Engine"
Cohesion: 0.11
Nodes (30): CANDIDATE_EXTS, collectSignals(), computeFingerprint(), detectArchitectureStyle(), detectBuildSystem(), detectEntryPoints(), detectModules(), detectPlatforms() (+22 more)

### Community 21 - "Coding Engine & Ignore Rules"
Cohesion: 0.23
Nodes (3): FILE(), keywords(), ProjectMemory

### Community 22 - "TypeScript Config"
Cohesion: 0.07
Nodes (28): compilerOptions, allowImportingTsExtensions, baseUrl, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, jsx, lib (+20 more)

### Community 23 - "Module Summaries & Glossary"
Cohesion: 0.20
Nodes (10): Adding a real provider (the whole point), Adding retrieval / memory (no RAG here, just the seam), @aura/intelligence, Demo, Design guarantees, Interfaces at a glance, Quick start, Replacing any stage (+2 more)

### Community 24 - "Desktop Dependencies"
Cohesion: 0.08
Nodes (25): dependencies, @aura/core, @aura/ui, framer-motion, react, react-dom, description, devDependencies (+17 more)

### Community 25 - "Credential Store & Connect"
Cohesion: 0.14
Nodes (24): DEFAULT_STORE, deriveKey(), getActive(), getAllProviderStores(), getConnectedIds(), getFingerprint(), getHealth(), getKey() (+16 more)

### Community 26 - "Retrieval Engine Contracts"
Cohesion: 0.20
Nodes (14): EngineBudgetConfig, CHAT_DEFAULT_CONFIG, ChatRetrievalEngine, CODING_DEFAULT_CONFIG, CodingRetrievalEngine, FULLSTACK_DEFAULT_CONFIG, FullStackRetrievalEngine, RESEARCH_DEFAULT_CONFIG (+6 more)

### Community 27 - "Project Profile"
Cohesion: 0.16
Nodes (22): buildProfile(), classify(), DB_DEPS, deriveBuildSystem(), deriveCodingStyle(), deriveEntryPoints(), deriveImportantFiles(), derivePurpose() (+14 more)

### Community 28 - "Gemini Runtime"
Cohesion: 0.15
Nodes (11): ANTHROPIC_MODELS, AnthropicRuntime, GenerateRequest, GenerateResponse, HealthStatus, HealthStatusType, ModelInfo, RuntimeConfig (+3 more)

### Community 29 - "Document Store & Chunks"
Cohesion: 0.15
Nodes (7): ChunkProvider, NaiveChunkOptions, NaiveChunkProvider, DocumentStore, InMemoryDocumentStore, Chunk, RetrievalDocument

### Community 30 - "Context Assembler"
Cohesion: 0.18
Nodes (23): evaluateConfidence(), assembleApiReference(), assembleArchitecture(), assembleBugFix(), assembleCodeSearch(), assembleContext(), assembleFunctionExplanation(), assembleGeneric() (+15 more)

### Community 31 - "Root Workspace Config"
Cohesion: 0.08
Nodes (25): allowScripts, esbuild@0.21.5, dependencies, 3d-force-graph, three, description, devDependencies, rimraf (+17 more)

### Community 32 - "Coding Indexer & Chunker"
Cohesion: 0.14
Nodes (6): CodingKnowledgeEngine, IgnoreRules, CodingIndexer, IndexDelta, IndexOptions, IndexStats

### Community 33 - "Pipeline & Server"
Cohesion: 0.07
Nodes (32): ActiveProvider, isProviderConnected(), ProviderAdapterFactory, ProviderInfo, removeCredential(), setupProviders(), storeCredential(), buildKnowledgeGraph() (+24 more)

### Community 34 - "Project Memory & Graph"
Cohesion: 0.20
Nodes (5): ConversationSummary, ConvMessage, FILE(), genId(), ProjectConversations

### Community 35 - "Navigation & App Store"
Cohesion: 0.13
Nodes (15): NAV_ITEMS, NAV_TITLES, NavItem, PROJECT_TABS, ProjectTabDef, ActivityEntry, KnowledgeUpdate, ModelStatus (+7 more)

### Community 36 - "FullStack Search"
Cohesion: 0.20
Nodes (10): Architecture, @aura/retrieval, Integration, Interfaces (each explains its responsibility), Memory hierarchy, Quick start, Replacing anything, The four engines (+2 more)

### Community 37 - "anthropic.ts"
Cohesion: 0.11
Nodes (14): AnthropicAdapter, GeminiAdapter, ConnectedProvider, getCredential(), getFingerprint(), registerProvider(), registerAdapter(), ActiveRuntime (+6 more)

### Community 38 - "PipelineManager"
Cohesion: 0.31
Nodes (10): assessArchitecture(), assessDependencies(), assessDocumentation(), assessTesting(), findOrphanModules(), generateRepositoryHealth(), HEALTH_FILE(), loadRepositoryHealth() (+2 more)

### Community 39 - "Tauri Config"
Cohesion: 0.10
Nodes (19): app, security, windows, script, wait, build, beforeBuildCommand, beforeDevCommand (+11 more)

### Community 40 - "AURA Hub"
Cohesion: 0.33
Nodes (6): AI Operating Environment, Fixed Frame / Interchangeable Surfaces, Intelligence Pipeline, Inward-only Dependency Direction, Provider Seam (provider-agnostic), AURA Hub Architecture

### Community 42 - "retrievalEngine.ts"
Cohesion: 0.22
Nodes (8): IndexCandidate, IndexProvider, InMemoryIndexProvider, tokenize(), KeywordRetrievalProvider, RetrievalProvider, RetrievalQuery, SearchResult

### Community 43 - "InvertedIndex"
Cohesion: 0.12
Nodes (12): CodingSearch, MODE_EXPANSIONS, FileKind, LanguageId, FileRecord, KnowledgeStore, editDistance(), ExpansionKind (+4 more)

### Community 44 - "JsonKnowledgeStore"
Cohesion: 0.18
Nodes (3): CodeChunk, CodeDocument, JsonKnowledgeStore

### Community 46 - "context.ts"
Cohesion: 0.17
Nodes (15): ContextBuilder, CodingEngineOptions, KIND_CATEGORY, CodingContext, CodingContextEntry, ContextChunkRef, ContextOptions, IgnoreConfig (+7 more)

### Community 47 - "package.json"
Cohesion: 0.12
Nodes (16): dependencies, @aura/core, clsx, tailwind-merge, description, exports, main, name (+8 more)

### Community 48 - "package.json"
Cohesion: 0.12
Nodes (15): dependencies, @aura/intelligence, @aura/knowledge-coding, @aura/knowledge-fullstack, @aura/runtime, description, exports, main (+7 more)

### Community 50 - "store.ts"
Cohesion: 0.29
Nodes (8): dir(), fileOf(), now(), sanitize(), WorkflowStore, genId(), Workflow, WorkflowSummary

### Community 51 - "personality.ts"
Cohesion: 0.26
Nodes (13): CodeStyle, CommunicationStyle, detectCodeStyle(), detectCommunicationStyle(), detectDocumentationTone(), detectPersonality(), detectResponsePatterns(), detectTechnicalLevel() (+5 more)

### Community 52 - "verification.ts"
Cohesion: 0.16
Nodes (13): buildLayerStack(), CONTAINER, Edge, extractArchitectureLayers(), GraphJson, GraphLink, GraphNode, itemsFor() (+5 more)

### Community 53 - "package.json"
Cohesion: 0.14
Nodes (13): dependencies, @aura/knowledge-coding, @aura/retrieval, description, exports, main, name, private (+5 more)

### Community 54 - "index.ts"
Cohesion: 0.23
Nodes (11): sha1(), chunkDocument(), ChunkOptions, extractSymbols(), ALLOWED_DOTFILES, DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_EXTS, looksBinary() (+3 more)

### Community 55 - "package.json"
Cohesion: 0.15
Nodes (12): dependencies, zustand, description, exports, main, name, peerDependencies, react (+4 more)

### Community 56 - "package.json"
Cohesion: 0.15
Nodes (12): dependencies, @aura/retrieval, description, exports, main, name, private, scripts (+4 more)

### Community 57 - "indexStore.ts"
Cohesion: 0.20
Nodes (10): buildDocument(), CODE_LANGS, CONFIG_LANGS, detectKind(), detectLanguage(), DOC_LANGS, EXT_LANG, isIndexableLanguage() (+2 more)

### Community 58 - "validation.ts"
Cohesion: 0.32
Nodes (6): detectByKeyPrefix(), DetectionStrategy, detectProvider(), KEY_PREFIX_RULES, listProviders(), getAllAdapters()

### Community 59 - "healthEngine.ts"
Cohesion: 0.11
Nodes (27): buildGlossary(), extractModuleNames(), GLOSSARY_FILE(), guessDefinition(), loadGlossary(), analyzeDependencies(), buildRepositoryProfile(), detectArchitectureStyle() (+19 more)

### Community 60 - "package.json"
Cohesion: 0.18
Nodes (10): description, exports, main, name, private, scripts, typecheck, type (+2 more)

### Community 61 - "performance.ts"
Cohesion: 0.28
Nodes (12): countSourceModules(), generateSummary(), generateVerificationReport(), loadVerificationReport(), REPORT_FILE(), VerificationSection, verifyArchitecture(), verifyDocumentation() (+4 more)

### Community 62 - "config.ts"
Cohesion: 0.40
Nodes (8): HeuristicRankingProvider, RankingProvider, WEIGHTS, createDefaultMemory(), createRetrievalKernel(), resolveRetrievalConfig(), runDemo(), seedDocs()

### Community 63 - "package.json"
Cohesion: 0.18
Nodes (10): description, exports, main, name, private, scripts, typecheck, type (+2 more)

### Community 64 - "package.json"
Cohesion: 0.18
Nodes (10): description, exports, main, name, private, scripts, typecheck, type (+2 more)

### Community 65 - "compilerOptions"
Cohesion: 0.18
Nodes (10): compilerOptions, composite, declaration, emitDeclarationOnly, noEmit, outDir, rootDir, extends (+2 more)

### Community 66 - "compilerOptions"
Cohesion: 0.20
Nodes (9): compilerOptions, composite, declaration, emitDeclarationOnly, noEmit, outDir, rootDir, extends (+1 more)

### Community 68 - "compilerOptions"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, noEmit, tsBuildInfoFile, types, extends, include, references

### Community 69 - "detector.ts"
Cohesion: 0.22
Nodes (6): AURA Hub — Design Language, Components, Motion vocabulary, Principles, Tokens (semantic), Type

### Community 71 - "compilerOptions"
Cohesion: 0.25
Nodes (7): compilerOptions, lib, noEmit, rootDir, types, extends, include

### Community 72 - "NullEmbeddingProvider"
Cohesion: 0.39
Nodes (3): EmbeddingProvider, NullEmbeddingProvider, Embedding

### Community 73 - "compilerOptions"
Cohesion: 0.25
Nodes (7): compilerOptions, lib, noEmit, rootDir, types, extends, include

### Community 74 - "compilerOptions"
Cohesion: 0.29
Nodes (6): compilerOptions, lib, noEmit, types, extends, include

### Community 75 - "compilerOptions"
Cohesion: 0.29
Nodes (6): compilerOptions, lib, noEmit, types, extends, include

### Community 76 - "compilerOptions"
Cohesion: 0.29
Nodes (6): compilerOptions, lib, noEmit, types, extends, include

### Community 77 - "compilerOptions"
Cohesion: 0.29
Nodes (6): compilerOptions, lib, noEmit, types, extends, include

### Community 78 - "default.json"
Cohesion: 0.33
Nodes (5): description, identifier, permissions, $schema, windows

### Community 79 - "RetrievalEngineRegistry"
Cohesion: 0.13
Nodes (15): AssembleInput, ContextAssembler, DefaultAssemblerOptions, DefaultContextAssembler, normalize(), GlobalBudget, RetrievalEngine, RetrievalEngineRegistry (+7 more)

### Community 90 - "Community 90"
Cohesion: 0.25
Nodes (8): AURA Logo, Design Language (AURA Blue, glass, whitespace), Desktop entry (index.html), AURA Design Language, AURA Hub, Monorepo layout, Quick start, What's inside

### Community 91 - "Community 91"
Cohesion: 0.33
Nodes (4): Coding Knowledge Engine, Five-Layer Memory Hierarchy, FullStack Knowledge Engine, Retrieval & Memory Foundation

### Community 92 - "Community 92"
Cohesion: 0.09
Nodes (19): DB_DEPS, DIR_WEIGHT, FRAMEWORK_DEPS, IGNORE_DIRS, LANG_BY_EXT, detectChanges(), FileIndexState, hasChanges() (+11 more)

### Community 93 - "Community 93"
Cohesion: 0.33
Nodes (6): Architecture (reference for the remaining engines), @aura/knowledge-fullstack, The relationship chain it reconstructs, The vector seam, Usage, Verification (reproducible, real)

### Community 94 - "Community 94"
Cohesion: 0.40
Nodes (5): @aura/knowledge-coding, Pipeline (each component is standalone & replaceable), The vector-index seam, Usage, Verification (reproducible, real files)

### Community 97 - "Community 97"
Cohesion: 0.33
Nodes (3): ArchitectureDiagram3D(), DEFAULT_LAYERS, LayerDef

### Community 98 - "Community 98"
Cohesion: 0.32
Nodes (7): abortError(), Accum, throwIfAborted(), ScanResult, WorkspaceScanner, FileError, ScanEntry

### Community 101 - "Community 101"
Cohesion: 0.25
Nodes (4): COLORS, ProjectRegistry, REGISTRY(), slug()

## Knowledge Gaps
- **454 isolated node(s):** `name`, `version`, `private`, `type`, `description` (+449 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `runStream()` connect `AI Chat Workspace` to `store.ts`?**
  _High betweenness centrality (0.158) - this node is a cross-community bridge._
- **Why does `byKind()` connect `Project Workspace Sections` to `FullStack Entities`?**
  _High betweenness centrality (0.122) - this node is a cross-community bridge._
- **Why does `FullStackKnowledgeEngine` connect `FullStack Entities` to `Coding Indexer & Chunker`, `Pipeline & Server`, `Intelligence Types`, `Workspace Manager & Records`?**
  _High betweenness centrality (0.117) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _455 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Design System & Core Primitives` be split into smaller, more focused modules?**
  _Cohesion score 0.042777155655095184 - nodes in this community are weakly interconnected._
- **Should `Project Workspace Sections` be split into smaller, more focused modules?**
  _Cohesion score 0.08360360360360361 - nodes in this community are weakly interconnected._
- **Should `Conversations & Intent` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._