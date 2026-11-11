"""Repository-Aware Intent Classifier.

A port of packages/ai-service/src/intelligence/repositoryIntent.ts.

Classifies a query into one of 17 repository-specific intents, each
mapping to a different retrieval strategy.

Every pattern goes through `core.js_regex`, because several of them
depend on JavaScript's ASCII-only `\\b` — `/\\b参数|接口|方法签名\\b/` cannot
match in JavaScript at all, since CJK characters are not word characters
there. Compiled with Python's Unicode `\\b` it would match, and the
classifier would pick a different intent for the same question.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..core import js_regex


@dataclass(frozen=True)
class IntentSignal:
    patterns: tuple[str, ...]
    negative_patterns: tuple[str, ...] = ()
    boost_patterns: tuple[str, ...] = ()


# Declaration order is load-bearing: `scores` is a JavaScript `Map`, and
# a tie is broken by which intent was inserted first.
INTENT_SIGNALS: dict[str, IntentSignal] = {
    "project_overview": IntentSignal((
        r"\b(what is (this|the) (project|repo|repository|codebase))\b",
        r"\b(tell me about (this|the) (project|repo|repository))\b",
        r"\b(project (overview|summary|description))\b",
        r"\b(how is (this|the) (project|repo) (structured|organized))\b",
        r"\b(what does (this|the) (project|repo) do)\b",
        r"\b(what (is|are) the (purpose|goal|aim) of)\b",
        r"\b(give me an overview)\b",
        r"\b(high[- ]level (overview|summary|description))\b",
    )),
    "architecture": IntentSignal((
        r"\b(architecture|architectural)\b",
        r"\b(system (design|structure|layout))\b",
        r"\b(how is (this|the) (system|codebase|project) (structured|designed|organized|built))\b",
        r"\b(overall (design|structure|architecture))\b",
        r"\b(module (structure|layout|organization))\b",
        r"\b(component (diagram|structure|hierarchy))\b",
        r"\b(data flow|control flow)\b",
        r"\b(deployment (architecture|diagram|structure))\b",
    )),
    "module_explanation": IntentSignal((
        r"\b(explain|describe|tell me about)\b.*\b(module|package|library|component|service|engine|subsystem|layer)\b",
        r"\b(module|package|library|component|service|engine|subsystem|layer)\b.*\b(explain|describe|overview|purpose)\b",
        r"\b(how does|what does)\b.*\b(module|package|library|component|service|engine|subsystem)\b",
        r"\b(scheduler|filesystem|memory manager|driver|networking|process|thread)\b",
        r"\b(kernel|mm|fs|net|ipc|boot|arch|drivers)\b",
        r"\b(VFS|IRQ|ISR|syscall|interrupt)\b",
    )),
    "function_explanation": IntentSignal(
        (
            r"\b(explain|describe|what does)\b.*\b(function|method|class|struct|interface|type|trait)\b",
            r"\b(function|method|class|struct|interface|type|trait)\b.*\b(explain|describe|purpose|do)\b",
            r"\b(how does .+ (work|operate|behave))\b",
            r"\b(what does .+ do)\b",
        ),
        negative_patterns=(r"\b(module|package|service|engine|subsystem)\b",),
    ),
    "bug_fix": IntentSignal((
        r"\b(bug|error|issue|problem|crash|failure|broken)\b",
        r"\b(fix|repair|resolve|debug|troubleshoot)\b",
        r"\b(not (working|functioning|compiling|building|running))\b",
        r"\b(fails?|failed|failing|throws?|throwing)\b",
        r"\b(stack trace|backtrace|core dump)\b",
    )),
    "debugging": IntentSignal(
        (
            r"\b(debug|debugging|diagnose|investigate)\b",
            r"\b(why (is|does|did|has|are|were))\b",
            r"\b(how to (debug|trace|profile|monitor))\b",
            r"\b(log|logging|logger|trace|tracing)\b",
            r"\b(breakpoint|watchpoint|step through)\b",
        ),
        negative_patterns=(r"\b(explain|describe|what is)\b.*\b(module|service)\b",),
    ),
    "refactoring": IntentSignal((
        r"\b(refactor|restructure|reorganize|cleanup|clean up)\b",
        r"\b(improve|improvement|optimize|simplify|modernize)\b",
        r"\b(technical debt|code smell|duplication)\b",
        r"\b(extract|move|rename|split|merge)\b.*\b(function|method|class|module)\b",
    )),
    "code_search": IntentSignal((
        r"\b(search|find|look up|locate|where)\b.*\b(code|function|class|variable|file|implementation)\b",
        r"\b(where is|where are)\b.*\b(implemented|defined|declared|used|called)\b",
        r"\b(all .*(functions|methods|classes|types|interfaces|variables|constants))\b",
        r"\b(grep|rg|find)\b.*\b(for|in)\b",
    )),
    "api_reference": IntentSignal((
        r"\b(API|endpoint|route|REST|GraphQL|gRPC)\b",
        r"\b(request|response|payload|schema|specification)\b",
        # In JavaScript `\b` is ASCII-only, so this alternation can only
        # ever match through its middle branch. Preserved verbatim.
        r"\b参数|接口|方法签名\b",
        r"\b(arguments?|parameters?|inputs?|outputs?)\b.*\b(of|for|to)\b",
        r"\b(document(ed)?|documenting)\b.*\b(API|endpoint|method|function)\b",
    )),
    "dependency": IntentSignal((
        r"\b(dependenc|dependenc(y|ies)|package|library|import|require)\b",
        r"\b(third[- ]party|external|vendor)\b",
        r"\b(npm|pip|cargo|go mod|maven|gradle|pub)\b",
        r"\b(version|upgrade|update|downgrade)\b.*\b(package|dependency|library)\b",
    )),
    "build_system": IntentSignal((
        r"\b(build|compile|transpile|bundle|package|deploy)\b.*\b(system|process|pipeline|command|script)\b",
        r"\b(Makefile|Cargo|CMake|Gradle|Maven|Vite|Webpack|Rollup)\b",
        r"\b(how to (build|compile|run|deploy|start|test))\b",
        r"\b(CI\/CD|pipeline|workflow|action)\b",
        r"\b(Docker|container|image)\b.*\b(build|create|run)\b",
    )),
    "documentation": IntentSignal((
        r"\b(documentation|docs|README|CONTRIBUTING|CHANGELOG|LICENSE)\b",
        r"\b(document|documenting|documented)\b",
        r"\b(where is the|find the|missing)\b.*\b(docs?|documentation)\b",
        r"\b(readme|architect(ure|ural))\b.*\b(doc|document|file)\b",
    )),
    "design": IntentSignal((
        r"\b(design|pattern|convention|standard|style)\b",
        r"\b(how should|how to|best practice|approach)\b",
        r"\b(architecture decision|ADR|RFC|proposal)\b",
        r"\b(interface design|API design|data model)\b",
    )),
    "security": IntentSignal((
        r"\b(security|vulnerability|CVE|exploit|attack|injection)\b",
        r"\b(authentication|authorization|auth|permission|access control)\b",
        r"\b(encrypt|decrypt|hash|token|JWT|session|cookie)\b",
        r"\b(XSS|CSRF|SQL injection|SSRF|RCE)\b",
        r"\b(secrets?|credential|password|API key)\b",
    )),
    "performance": IntentSignal((
        r"\b(performance|slow|fast|speed|latency|throughput)\b",
        r"\b(bottleneck|optimization|optimize|profil|benchmark)\b",
        r"\b(memory (usage|leak|consumption)|CPU|cache|O\(n\))\b",
        r"\b(algorithm|complexity|time|space)\b.*\b(complexity|efficient|optimal)\b",
    )),
    "testing": IntentSignal((
        r"\b(test|testing|tests|unit test|integration test|e2e)\b",
        r"\b(mock|stub|fixture|assert|expect|should)\b",
        r"\b(Jest|Mocha|Vitest|Cypress|Playwright|pytest|JUnit|cargo test)\b",
        r"\b(coverage|test case|test suite|test plan)\b",
    )),
    "unknown": IntentSignal(()),
}

# The three signal classes carry different case sensitivity in the
# reference: every pattern is `/i` except two in `module_explanation`
# and one in `code_search`, which are case-SENSITIVE on purpose so that
# `\b(VFS|IRQ|ISR|syscall|interrupt)\b` does not fire on prose.
_CASE_SENSITIVE = {
    r"\b(kernel|mm|fs|net|ipc|boot|arch|drivers)\b",
    r"\b(VFS|IRQ|ISR|syscall|interrupt)\b",
    r"\b(grep|rg|find)\b.*\b(for|in)\b",
    r"\b参数|接口|方法签名\b",
    r"\b(arguments?|parameters?|inputs?|outputs?)\b.*\b(of|for|to)\b",
}


def _compiled(pattern: str):
    return js_regex.compile(pattern, "" if pattern in _CASE_SENSITIVE else "i")


_COMPILED: dict[str, dict[str, tuple[Any, ...]]] = {
    name: {
        "patterns": tuple(_compiled(p) for p in signal.patterns),
        "negative": tuple(_compiled(p) for p in signal.negative_patterns),
        "boost": tuple(_compiled(p) for p in signal.boost_patterns),
    }
    for name, signal in INTENT_SIGNALS.items()
}


@dataclass
class RetrievalStrategy:
    sources: list[str]
    token_budget: int
    include_source: bool
    include_graph: bool
    include_memory: bool

    def to_json(self) -> dict[str, Any]:
        return {
            "sources": list(self.sources), "tokenBudget": self.token_budget,
            "includeSource": self.include_source, "includeGraph": self.include_graph,
            "includeMemory": self.include_memory,
        }


RETRIEVAL_STRATEGIES: dict[str, RetrievalStrategy] = {
    "project_overview": RetrievalStrategy(
        ["identity", "readme", "architecture_docs", "module_summaries", "graph_overview"],
        3000, False, True, True),
    "architecture": RetrievalStrategy(
        ["architecture_docs", "graph_full", "module_summaries", "identity",
         "important_files"], 4000, False, True, True),
    "module_explanation": RetrievalStrategy(
        ["target_module", "module_summaries", "graph_relationships", "related_modules"],
        4000, True, True, True),
    "function_explanation": RetrievalStrategy(
        ["target_function", "file_context", "graph_relationships", "module_context"],
        3500, True, True, False),
    "bug_fix": RetrievalStrategy(
        ["target_code", "dependencies", "related_functions", "error_history"],
        4000, True, True, True),
    "debugging": RetrievalStrategy(
        ["target_code", "graph_relationships", "module_context", "error_history"],
        4000, True, True, True),
    "refactoring": RetrievalStrategy(
        ["target_code", "graph_relationships", "module_summaries", "design_docs"],
        4000, True, True, True),
    "code_search": RetrievalStrategy(["coding_engine", "graph_search"], 3000, True, False, False),
    "api_reference": RetrievalStrategy(
        ["api_docs", "endpoint_entities", "module_summaries", "target_code"],
        3500, True, True, False),
    "dependency": RetrievalStrategy(
        ["dependency_graph", "manifest_files", "config_files"], 2500, False, True, False),
    "build_system": RetrievalStrategy(
        ["build_files", "ci_files", "config_files", "documentation"], 2500, True, False, False),
    "documentation": RetrievalStrategy(
        ["documentation_files", "readme", "architecture_docs", "design_docs"],
        3000, False, False, False),
    "design": RetrievalStrategy(
        ["architecture_docs", "design_docs", "graph_full", "module_summaries"],
        3500, False, True, True),
    "security": RetrievalStrategy(
        ["target_code", "auth_modules", "dependency_graph", "config_files"],
        3500, True, True, True),
    "performance": RetrievalStrategy(
        ["target_code", "graph_relationships", "module_summaries"], 3500, True, True, True),
    "testing": RetrievalStrategy(
        ["test_files", "target_code", "module_summaries"], 3500, True, False, False),
    "unknown": RetrievalStrategy(
        ["coding_engine", "fullstack_engine", "memory"], 3000, True, True, True),
}

_PASCAL = js_regex.compile(r"\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b", "g")
_CAMEL = js_regex.compile(r"\b[a-z]+(?:[A-Z][a-z]+)+\b", "g")
_FILES = js_regex.compile(r"[\w/.-]+\.[a-z]{1,4}\b", "g")
_QUOTED = js_regex.compile(r"\"([^\"]+)\"|'([^']+)'", "g")


def extract_entities(text: str) -> list[str]:
    entities: list[str] = []
    entities.extend(m.group(0) for m in _PASCAL.finditer(text))
    camel = [m.group(0) for m in _CAMEL.finditer(text)]
    entities.extend(list(dict.fromkeys(camel))[:5])
    entities.extend(m.group(0) for m in _FILES.finditer(text))
    # `String.prototype.slice(1, -1)` on the whole match strips exactly
    # one quote from each end, whichever kind matched.
    entities.extend(m.group(0)[1:-1] for m in _QUOTED.finditer(text))
    return list(dict.fromkeys(entities))[:10]


@dataclass
class RepositoryIntent:
    type: str
    confidence: float
    entities: list[str] = field(default_factory=list)
    retrieval_strategy: RetrievalStrategy | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "confidence": self.confidence,
            "entities": list(self.entities),
            "retrievalStrategy": (
                self.retrieval_strategy.to_json() if self.retrieval_strategy else None
            ),
        }


def classify_repository_intent(text: str) -> RepositoryIntent:
    scores: dict[str, float] = {}

    for name, compiled in _COMPILED.items():
        score = 0.0
        for pattern in compiled["patterns"]:
            if pattern.search(text):
                score += 1
        for pattern in compiled["boost"]:
            if pattern.search(text):
                score += 0.5
        for pattern in compiled["negative"]:
            if pattern.search(text):
                score -= 0.5
        if score > 0:
            scores[name] = score

    intent_type = "unknown"
    confidence = 0.2

    if scores:
        # `Array.prototype.sort` is stable, so equal scores keep the
        # insertion order — which is INTENT_SIGNALS' declaration order.
        ranked = sorted(scores.items(), key=lambda kv: -kv[1])
        top_type, top_score = ranked[0]
        total_hits = sum(v for _, v in ranked)
        intent_type = top_type
        confidence = min(0.95, 0.45 + (top_score / total_hits) * 0.5)

    strategy = RETRIEVAL_STRATEGIES[intent_type]
    return RepositoryIntent(
        type=intent_type,
        confidence=confidence,
        entities=extract_entities(text),
        # `{ ...strategy }` is a shallow copy; the arrays are shared in
        # the reference too, and nothing mutates them.
        retrieval_strategy=RetrievalStrategy(
            sources=strategy.sources, token_budget=strategy.token_budget,
            include_source=strategy.include_source, include_graph=strategy.include_graph,
            include_memory=strategy.include_memory,
        ),
    )
