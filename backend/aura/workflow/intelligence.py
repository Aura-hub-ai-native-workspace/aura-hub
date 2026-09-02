"""Intelligence node runners — port of nodes.ts generate/intelligence specs.

Model-backed nodes (groq, generate-markdown, generate-code, generate-json)
call the injected model port — the SAME provider seam the central agent's
layer implements (`complete(system, user, *, json_mode)`). A missing port
is an honest failure; a malformed constrained output fails closed. These
nodes are pure compute in the frozen design (nodes.ts classes
'generate'/'intelligence'): they invoke nothing, so no approval gate
applies — identical to the TypeScript oracle.

The keyword intent classifier and template prompt enhancer are faithful
ports of @aura/intelligence's frozen deterministic implementations and ARE
differential-tested against the TypeScript oracle.

Bounds on material size are ADDITIVE Python behavior (no TS counterpart):
material is clipped with a visible marker rather than silently truncated.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable

MAX_MATERIAL_CHARS = 24_000
_TRUNCACTION_MARKER = "…[material truncated]"


def _clip(text: str, n: int) -> str:
    return text[:n]


def _bounded(user: str) -> str:
    if len(user) <= MAX_MATERIAL_CHARS:
        return user
    return user[:MAX_MATERIAL_CHARS] + _TRUNCACTION_MARKER


def _s(v: Any, d: str = "") -> str:
    return v if isinstance(v, str) else d


async def _complete(ctx: dict, system: str, user: str,
                    *, json_mode: bool = False) -> str:
    port = ctx.get("model")
    if port is None:
        raise RuntimeError(
            "this node requires a model runtime, which is not attached to this run.")
    complete = getattr(port, "complete")

    result = complete(system, _bounded(user), json_mode=json_mode)
    if hasattr(result, "__await__"):
        return await result
    return result


def _summary_of(text: str) -> str:
    return _clip(text.replace("\n", " ").strip(), 46)


# ── model-backed generation (TS parity unless noted) ─────────────────────────


async def run_groq(ctx, input, cfg):
    user = "\n\n".join(filter(None, [
        ctx_interpolate(_s(cfg.get("instruction")), ctx, input),
        input.get("text")]))
    if not user.strip():
        raise RuntimeError("nothing to send — connect an upstream node or set an instruction")
    system = _s(cfg.get("system")) or (
        f'You are AURA, the project intelligence for "{ctx.get("projectName")}". '
        "Answer strictly from the provided project material.")
    text = await _complete(ctx, system, user)
    return {"text": text, "summary": _clip(text, 46)}


async def run_generate_markdown(ctx, input, cfg):
    ask = ctx_interpolate(_s(cfg.get("instruction")), ctx, input) \
        or "A clear, well-structured document about the material below."
    system = ('You produce clean Markdown documents (headings, lists, code '
              f'fences). Project: "{ctx.get("projectName")}". '
              "Use ONLY the provided material.")
    text = await _complete(ctx, system, f"{ask}\n\nMaterial:\n{input.get('text', '')}")
    return {"text": text,
            "summary": _clip(re.sub(r"[#*`\n]+", " ", text).strip(), 46)}


async def run_generate_code(ctx, input, cfg):
    lang = _s(cfg.get("language"), "the project language")
    ask = ctx_interpolate(_s(cfg.get("instruction")), ctx, input) \
        or "Generate the most useful code for the material below."
    system = (f"You write production-quality {lang} code. "
              f'Reply with code in fenced blocks plus brief notes. Project: "{ctx.get("projectName")}".')
    text = await _complete(ctx, system, f"{ask}\n\nMaterial:\n{input.get('text', '')}")
    return {"text": text, "summary": _clip(re.sub(r"\s+", " ", text).strip(), 46)}


async def run_generate_json(ctx, input, cfg):
    ask = ctx_interpolate(_s(cfg.get("instruction")), ctx, input) \
        or "Summarize the material below as JSON."
    raw = await _complete(ctx, "You output ONLY valid JSON. No prose, no code fences.",
                          f"{ask}\n\nMaterial:\n{input.get('text', '')}",
                          json_mode=True)
    cleaned = re.sub(r"^```(?:json)?\s*", "", raw.strip(), flags=re.IGNORECASE)
    cleaned = re.sub(r"```\s*$", "", cleaned)
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        # Fail closed with the oracle's own message (nodes.ts generate-json).
        raise RuntimeError("model did not return valid JSON")
    return {"text": json.dumps(data, indent=2), "data": data, "summary": "valid JSON"}


def ctx_interpolate(template: str, ctx: dict, input: dict) -> str:
    from .nodes_core import interpolate

    return interpolate(template or "", ctx, input)


# ── frozen deterministic classifiers (@aura/intelligence ports) ──────────────


class KeywordIntentClassifier:
    """Port of intentClassifier.ts — differential-tested against the oracle."""

    SIGNALS: dict[str, list[str]] = {
        "generate": [r"\b(write|create|generate|draft|build|make)\b"],
        "edit": [r"\b(edit|refactor|rename|change|fix|update|modify)\b"],
        "summarize": [r"\b(summari[sz]e|tl;?dr|shorten|condense)\b"],
        "search": [r"\b(search|find|look up|where is|locate)\b"],
        "transform": [r"\b(translate|convert|reformat|transform)\b"],
        "command": [r"^\s*\/", r"\b(run|open|deploy|start|stop|toggle)\b"],
        "question": [r"\?\s*$",
                     r"^\s*(what|why|how|when|who|which|can|does|is|are)\b"],
        "chat": [r"\b(hi|hello|hey|thanks|thank you)\b"],
        "unknown": [],
    }

    def classify(self, text: str) -> dict:
        t = text.strip()
        scores: dict[str, int] = {}
        for itype, patterns in self.SIGNALS.items():
            score = 0
            for pat in patterns:
                if re.search(pat, t, re.IGNORECASE):
                    score += 1
            if score > 0:
                scores[itype] = score
        if not scores:
            return {"type": "unknown", "confidence": 0.2,
                    "rationale": "no lexical signals matched"}
        ranked = sorted(scores.items(), key=lambda kv: -kv[1])
        top_type, top_score = ranked[0]
        total_hits = sum(v for _, v in ranked)
        return {
            "type": top_type,
            "confidence": min(0.95, 0.45 + (top_score / total_hits) * 0.5),
            "rationale": f'matched {top_score} signal(s) for "{top_type}"',
            "alternatives": [{"type": t2, "confidence": v / total_hits}
                             for t2, v in ranked[1:3]],
        }


class TemplatePromptEnhancer:
    """Port of promptEnhancer.ts."""

    FRAMING: dict[str, list[str]] = {
        "generate": ["Produce a complete, well-structured result.",
                     "Prefer clarity over cleverness."],
        "edit": ["Preserve intent and surrounding style.",
                 "Return only what changed unless asked otherwise."],
        "summarize": ["Capture the essential points faithfully.",
                      "Do not introduce new information."],
        "search": ["Interpret the query as a retrieval request.",
                   "Rank by relevance."],
        "question": ["Answer directly first, then elaborate.",
                     "State uncertainty explicitly."],
        "transform": ["Preserve meaning across the transformation."],
        "command": ["Treat this as an imperative action request."],
        "chat": ["Keep the tone calm, concise and helpful."],
    }

    def enhance(self, text: str, intent: dict) -> dict:
        original = text
        cleaned = re.sub(r"\s+", " ", text).strip()
        directives: dict[str, str] = {}
        if re.search(r"\bin (json|markdown|table|bullet points?)\b", cleaned, re.I):
            directives["format"] = ("json" if re.search(r"json", cleaned, re.I)
                                    else "table" if re.search(r"table", cleaned, re.I)
                                    else "markdown")
        if re.search(r"\b(brief|short|concise)\b", cleaned, re.I):
            directives["length"] = "short"
        if re.search(r"\b(detailed|thorough|in depth)\b", cleaned, re.I):
            directives["length"] = "long"
        hints = self.FRAMING.get(intent.get("type"),
                                 ["Be helpful, precise and calm."])
        return {"original": original, "enhanced": cleaned,
                "systemHints": hints,
                **({"directives": directives} if directives else {})}


async def run_intent_classifier(ctx, input, cfg):
    text = input.get("text") or ""
    intent = KeywordIntentClassifier().classify(text)
    return {"text": text, "data": intent,
            "summary": f'{intent["type"]} ({round(intent["confidence"] * 100)}%)'}


async def run_prompt_enhancer(ctx, input, cfg):
    text = input.get("text") or ""
    classifier = KeywordIntentClassifier()
    intent = classifier.classify(text)
    prompt = TemplatePromptEnhancer().enhance(text, intent)
    return {"text": prompt["enhanced"], "data": prompt,
            "summary": _clip(prompt["enhanced"], 46)}


# ── honest absences (TS parity: these throw in nodes.ts too) ─────────────────


async def run_coding_engine(ctx, input, cfg):
    ke = ctx.get("coding_engine")
    if ke is None:
        raise RuntimeError("no project mounted")
    return await _ke_context_query(ke, ctx, input, cfg, default_q="project overview architecture entry point")


async def run_fullstack_engine(ctx, input, cfg):
    ke = ctx.get("fullstack_engine")
    if ke is None:
        raise RuntimeError("no project mounted")
    q = _s(cfg.get("query")) or input.get("text") or "system architecture services endpoints database"
    search = ke.search({"text": ctx_interpolate(q, ctx, input),
                        "limit": max(1, min(16, int(_n(cfg.get("limit"), 8))))})
    hits = [f'{h["entity"]["kind"]} [{h["entity"]["layer"]}] {h["entity"]["name"]} ({h["entity"]["relPath"]})'
            + (f' — {h["entity"]["summary"]}' if h["entity"].get("summary") else "")
            for h in search.get("hits") or []]
    chains = []
    for p in (search.get("paths") or [])[:6]:
        if len(p.get("entities") or []) < 2:
            continue
        line = p["entities"][0]["name"]
        for i, rel in enumerate(p.get("relations") or []):
            nxt = p["entities"][i + 1]["name"] if i + 1 < len(p["entities"]) else "?"
            line += f' --{rel["kind"]}--> {nxt}'
        chains.append(line)
    parts = ["System entities:\n" + "\n".join(hits) if hits else "No entities matched."]
    if chains:
        parts.append("\nRelationships:\n" + "\n".join(chains))
    text = "\n".join(parts)
    return {"text": text,
            "summary": f'{len(search.get("hits") or [])} entities · {len(chains)} chains'}


async def _ke_context_query(ke, ctx, input, cfg, *, default_q):
    q = _s(cfg.get("query")) or input.get("text") or default_q
    got = ke.getContext({"text": ctx_interpolate(q, ctx, input), "limit": 24},
                        {"limit": max(1, min(12, int(_n(cfg.get("limit"), 6)))),
                         "neighbors": 1, "maxTokens": 3000})
    entries = got.get("entries") or []
    text = "\n\n".join(
        f'----- {e["source"]} -----\n'
        + "\n".join(ch["chunk"]["text"] for ch in e.get("chunks") or [])
        for e in entries)
    return {"text": text or "No matching code found.",
            "files": [e["source"] for e in entries],
            "summary": f'{len(entries)} sources · {got.get("totalTokens", 0)} tok'}


async def run_research_engine(ctx, input, cfg):
    raise RuntimeError("the Research Engine is not implemented yet")


def _n(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


INTELLIGENCE_RUNNERS: dict[str, Callable] = {
    "groq": run_groq,
    "generate-markdown": run_generate_markdown,
    "generate-code": run_generate_code,
    "generate-json": run_generate_json,
    "intent-classifier": run_intent_classifier,
    "prompt-enhancer": run_prompt_enhancer,
    "coding-engine": run_coding_engine,
    "fullstack-engine": run_fullstack_engine,
    "research-engine": run_research_engine,
}
