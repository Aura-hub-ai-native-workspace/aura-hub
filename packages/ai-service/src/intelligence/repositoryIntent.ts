/**
 * Repository-Aware Intent Classifier
 * ==================================================================
 * Classifies user queries into 17 repository-specific intent types.
 * Each intent maps to a different retrieval strategy.
 *
 * This replaces the generic KeywordIntentClassifier when the
 * Repository Intelligence Engine is active.
 */

import type { RepositoryIntent, RepositoryIntentType, RetrievalStrategy } from './types';

/* ── Intent signal patterns ──────────────────────────────────────── */

interface IntentSignal {
  patterns: RegExp[];
  negativePatterns?: RegExp[];
  boostPatterns?: RegExp[];
}

const INTENT_SIGNALS: Record<RepositoryIntentType, IntentSignal> = {
  project_overview: {
    patterns: [
      /\b(what is (this|the) (project|repo|repository|codebase))\b/i,
      /\b(tell me about (this|the) (project|repo|repository))\b/i,
      /\b(project (overview|summary|description))\b/i,
      /\b(how is (this|the) (project|repo) (structured|organized))\b/i,
      /\b(what does (this|the) (project|repo) do)\b/i,
      /\b(what (is|are) the (purpose|goal|aim) of)\b/i,
      /\b(give me an overview)\b/i,
      /\b(high[- ]level (overview|summary|description))\b/i,
    ],
  },
  architecture: {
    patterns: [
      /\b(architecture|architectural)\b/i,
      /\b(system (design|structure|layout))\b/i,
      /\b(how is (this|the) (system|codebase|project) (structured|designed|organized|built))\b/i,
      /\b(overall (design|structure|architecture))\b/i,
      /\b(module (structure|layout|organization))\b/i,
      /\b(component (diagram|structure|hierarchy))\b/i,
      /\b(data flow|control flow)\b/i,
      /\b(deployment (architecture|diagram|structure))\b/i,
    ],
  },
  module_explanation: {
    patterns: [
      /\b(explain|describe|tell me about)\b.*\b(module|package|library|component|service|engine|subsystem|layer)\b/i,
      /\b(module|package|library|component|service|engine|subsystem|layer)\b.*\b(explain|describe|overview|purpose)\b/i,
      /\b(how does|what does)\b.*\b(module|package|library|component|service|engine|subsystem)\b/i,
      /\b(scheduler|filesystem|memory manager|driver|networking|process|thread)\b/i,
      /\b(kernel|mm|fs|net|ipc|boot|arch|drivers)\b/,
      /\b(VFS|IRQ|ISR|syscall|interrupt)\b/,
    ],
  },
  function_explanation: {
    patterns: [
      /\b(explain|describe|what does)\b.*\b(function|method|class|struct|interface|type|trait)\b/i,
      /\b(function|method|class|struct|interface|type|trait)\b.*\b(explain|describe|purpose|do)\b/i,
      /\b(how does .+ (work|operate|behave))\b/i,
      /\b(what does .+ do)\b/i,
    ],
    negativePatterns: [/\b(module|package|service|engine|subsystem)\b/i],
  },
  bug_fix: {
    patterns: [
      /\b(bug|error|issue|problem|crash|failure|broken)\b/i,
      /\b(fix|repair|resolve|debug|troubleshoot)\b/i,
      /\b(not (working|functioning|compiling|building|running))\b/i,
      /\b(fails?|failed|failing|throws?|throwing)\b/i,
      /\b(stack trace|backtrace|core dump)\b/i,
    ],
  },
  debugging: {
    patterns: [
      /\b(debug|debugging|diagnose|investigate)\b/i,
      /\b(why (is|does|did|has|are|were))\b/i,
      /\b(how to (debug|trace|profile|monitor))\b/i,
      /\b(log|logging|logger|trace|tracing)\b/i,
      /\b(breakpoint|watchpoint|step through)\b/i,
    ],
    negativePatterns: [/\b(explain|describe|what is)\b.*\b(module|service)\b/i],
  },
  refactoring: {
    patterns: [
      /\b(refactor|restructure|reorganize|cleanup|clean up)\b/i,
      /\b(improve|improvement|optimize|simplify|modernize)\b/i,
      /\b(technical debt|code smell|duplication)\b/i,
      /\b(extract|move|rename|split|merge)\b.*\b(function|method|class|module)\b/i,
    ],
  },
  code_search: {
    patterns: [
      /\b(search|find|look up|locate|where)\b.*\b(code|function|class|variable|file|implementation)\b/i,
      /\b(where is|where are)\b.*\b(implemented|defined|declared|used|called)\b/i,
      /\b(all .*(functions|methods|classes|types|interfaces|variables|constants))\b/i,
      /\b(grep|rg|find)\b.*\b(for|in)\b/,
    ],
  },
  api_reference: {
    patterns: [
      /\b(API|endpoint|route|REST|GraphQL|gRPC)\b/i,
      /\b(request|response|payload|schema|specification)\b/i,
      /\b参数|接口|方法签名\b/,
      /\b(arguments?|parameters?|inputs?|outputs?)\b.*\b(of|for|to)\b/,
      /\b(document(ed)?|documenting)\b.*\b(API|endpoint|method|function)\b/i,
    ],
  },
  dependency: {
    patterns: [
      /\b(dependenc|dependenc(y|ies)|package|library|import|require)\b/i,
      /\b(third[- ]party|external|vendor)\b/i,
      /\b(npm|pip|cargo|go mod|maven|gradle|pub)\b/i,
      /\b(version|upgrade|update|downgrade)\b.*\b(package|dependency|library)\b/i,
    ],
  },
  build_system: {
    patterns: [
      /\b(build|compile|transpile|bundle|package|deploy)\b.*\b(system|process|pipeline|command|script)\b/i,
      /\b(Makefile|Cargo|CMake|Gradle|Maven|Vite|Webpack|Rollup)\b/i,
      /\b(how to (build|compile|run|deploy|start|test))\b/i,
      /\b(CI\/CD|pipeline|workflow|action)\b/i,
      /\b(Docker|container|image)\b.*\b(build|create|run)\b/i,
    ],
  },
  documentation: {
    patterns: [
      /\b(documentation|docs|README|CONTRIBUTING|CHANGELOG|LICENSE)\b/i,
      /\b(document|documenting|documented)\b/i,
      /\b(where is the|find the|missing)\b.*\b(docs?|documentation)\b/i,
      /\b(readme|architect(ure|ural))\b.*\b(doc|document|file)\b/i,
    ],
  },
  design: {
    patterns: [
      /\b(design|pattern|convention|standard|style)\b/i,
      /\b(how should|how to|best practice|approach)\b/i,
      /\b(architecture decision|ADR|RFC|proposal)\b/i,
      /\b(interface design|API design|data model)\b/i,
    ],
  },
  security: {
    patterns: [
      /\b(security|vulnerability|CVE|exploit|attack|injection)\b/i,
      /\b(authentication|authorization|auth|permission|access control)\b/i,
      /\b(encrypt|decrypt|hash|token|JWT|session|cookie)\b/i,
      /\b(XSS|CSRF|SQL injection|SSRF|RCE)\b/i,
      /\b(secrets?|credential|password|API key)\b/i,
    ],
  },
  performance: {
    patterns: [
      /\b(performance|slow|fast|speed|latency|throughput)\b/i,
      /\b(bottleneck|optimization|optimize|profil|benchmark)\b/i,
      /\b(memory (usage|leak|consumption)|CPU|cache|O\(n\))\b/i,
      /\b(algorithm|complexity|time|space)\b.*\b(complexity|efficient|optimal)\b/i,
    ],
  },
  testing: {
    patterns: [
      /\b(test|testing|tests|unit test|integration test|e2e)\b/i,
      /\b(mock|stub|fixture|assert|expect|should)\b/i,
      /\b(Jest|Mocha|Vitest|Cypress|Playwright|pytest|JUnit|cargo test)\b/i,
      /\b(coverage|test case|test suite|test plan)\b/i,
    ],
  },
  unknown: {
    patterns: [],
  },
};

/* ── Retrieval strategies per intent ─────────────────────────────── */

const RETRIEVAL_STRATEGIES: Record<RepositoryIntentType, RetrievalStrategy> = {
  project_overview: {
    sources: ['identity', 'readme', 'architecture_docs', 'module_summaries', 'graph_overview'],
    tokenBudget: 3000,
    includeSource: false,
    includeGraph: true,
    includeMemory: true,
  },
  architecture: {
    sources: ['architecture_docs', 'graph_full', 'module_summaries', 'identity', 'important_files'],
    tokenBudget: 4000,
    includeSource: false,
    includeGraph: true,
    includeMemory: true,
  },
  module_explanation: {
    sources: ['target_module', 'module_summaries', 'graph_relationships', 'related_modules'],
    tokenBudget: 4000,
    includeSource: true,
    includeGraph: true,
    includeMemory: true,
  },
  function_explanation: {
    sources: ['target_function', 'file_context', 'graph_relationships', 'module_context'],
    tokenBudget: 3500,
    includeSource: true,
    includeGraph: true,
    includeMemory: false,
  },
  bug_fix: {
    sources: ['target_code', 'dependencies', 'related_functions', 'error_history'],
    tokenBudget: 4000,
    includeSource: true,
    includeGraph: true,
    includeMemory: true,
  },
  debugging: {
    sources: ['target_code', 'graph_relationships', 'module_context', 'error_history'],
    tokenBudget: 4000,
    includeSource: true,
    includeGraph: true,
    includeMemory: true,
  },
  refactoring: {
    sources: ['target_code', 'graph_relationships', 'module_summaries', 'design_docs'],
    tokenBudget: 4000,
    includeSource: true,
    includeGraph: true,
    includeMemory: true,
  },
  code_search: {
    sources: ['coding_engine', 'graph_search'],
    tokenBudget: 3000,
    includeSource: true,
    includeGraph: false,
    includeMemory: false,
  },
  api_reference: {
    sources: ['api_docs', 'endpoint_entities', 'module_summaries', 'target_code'],
    tokenBudget: 3500,
    includeSource: true,
    includeGraph: true,
    includeMemory: false,
  },
  dependency: {
    sources: ['dependency_graph', 'manifest_files', 'config_files'],
    tokenBudget: 2500,
    includeSource: false,
    includeGraph: true,
    includeMemory: false,
  },
  build_system: {
    sources: ['build_files', 'ci_files', 'config_files', 'documentation'],
    tokenBudget: 2500,
    includeSource: true,
    includeGraph: false,
    includeMemory: false,
  },
  documentation: {
    sources: ['documentation_files', 'readme', 'architecture_docs', 'design_docs'],
    tokenBudget: 3000,
    includeSource: false,
    includeGraph: false,
    includeMemory: false,
  },
  design: {
    sources: ['architecture_docs', 'design_docs', 'graph_full', 'module_summaries'],
    tokenBudget: 3500,
    includeSource: false,
    includeGraph: true,
    includeMemory: true,
  },
  security: {
    sources: ['target_code', 'auth_modules', 'dependency_graph', 'config_files'],
    tokenBudget: 3500,
    includeSource: true,
    includeGraph: true,
    includeMemory: true,
  },
  performance: {
    sources: ['target_code', 'graph_relationships', 'module_summaries'],
    tokenBudget: 3500,
    includeSource: true,
    includeGraph: true,
    includeMemory: true,
  },
  testing: {
    sources: ['test_files', 'target_code', 'module_summaries'],
    tokenBudget: 3500,
    includeSource: true,
    includeGraph: false,
    includeMemory: false,
  },
  unknown: {
    sources: ['coding_engine', 'fullstack_engine', 'memory'],
    tokenBudget: 3000,
    includeSource: true,
    includeGraph: true,
    includeMemory: true,
  },
};

/* ── Entity extraction ───────────────────────────────────────────── */

function extractEntities(text: string): string[] {
  const entities: string[] = [];
  // PascalCase identifiers (classes, components)
  const pascal = text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g);
  if (pascal) entities.push(...pascal);
  // CamelCase identifiers (functions, variables)
  const camel = text.match(/\b[a-z]+(?:[A-Z][a-z]+)+\b/g);
  if (camel) entities.push(...[...new Set(camel)].slice(0, 5));
  // File paths
  const files = text.match(/[\w/.-]+\.[a-z]{1,4}\b/g);
  if (files) entities.push(...files);
  // Quoted strings
  const quoted = text.match(/"([^"]+)"|'([^']+)'/g);
  if (quoted) entities.push(...quoted.map(q => q.slice(1, -1)));
  return [...new Set(entities)].slice(0, 10);
}

/* ── Classifier ──────────────────────────────────────────────────── */

export function classifyRepositoryIntent(text: string): RepositoryIntent {
  const scores = new Map<RepositoryIntentType, number>();

  for (const [type, signal] of Object.entries(INTENT_SIGNALS) as [RepositoryIntentType, IntentSignal][]) {
    let score = 0;
    for (const p of signal.patterns) if (p.test(text)) score += 1;
    if (signal.boostPatterns) for (const p of signal.boostPatterns) if (p.test(text)) score += 0.5;
    if (signal.negativePatterns) for (const p of signal.negativePatterns) if (p.test(text)) score -= 0.5;
    if (score > 0) scores.set(type, score);
  }

  let intentType: RepositoryIntentType = 'unknown';
  let confidence = 0.2;

  if (scores.size > 0) {
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const [topType, topScore] = ranked[0];
    const totalHits = ranked.reduce((s, [, v]) => s + v, 0);
    intentType = topType;
    confidence = Math.min(0.95, 0.45 + (topScore / totalHits) * 0.5);
  }

  const entities = extractEntities(text);
  const strategy = { ...RETRIEVAL_STRATEGIES[intentType] };

  return {
    type: intentType,
    confidence,
    entities,
    retrievalStrategy: strategy,
  };
}
