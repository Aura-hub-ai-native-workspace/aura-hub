"""Smart Context Assembler.

A port of packages/ai-service/src/intelligence/contextAssembler.ts.

Builds the system message from AURA's own facts BEFORE any provider is
called, so swapping the model changes the wording and not the facts.
"""

from __future__ import annotations

from typing import Any

from ..core import js_regex
from ..core.js_string import slice_utf16
from .confidence import evaluate_confidence
from .constants import est_tokens

AUTHORITATIVE_PREAMBLE = "[AURA — Repository Intelligence]\nYou are the voice of AURA, a repository intelligence engine. Every section below was computed by AURA BEFORE you were invoked and is AURA's authoritative understanding of THIS specific repository.\nYour job is to verbalize and reason over AURA's knowledge — not to independently decide what the repository is. Its identity, purpose, architecture, modules, status and relationships are established FACTS supplied by AURA; treat them as ground truth.\nDo not invent a competing description of the project, and do not override AURA's identity with your own inference. Any source excerpts are supporting evidence only and never outrank AURA's structured facts. If the facts below do not cover something, say so plainly rather than guessing."

TYPE_NOUN: dict[str, str] = {
    "operating-system": "operating-system kernel",
    "kernel": "operating-system kernel",
    "compiler": "compiler / language toolchain",
    "database": "database engine",
    "library": "library",
    "cli": "command-line tool",
    "frontend": "frontend application",
    "backend": "backend service",
    "fullstack": "full-stack application",
    "infrastructure": "infrastructure project",
    "ai-framework": "AI / ML framework",
    "mobile": "mobile application",
    "desktop": "desktop application",
    "game": "game",
    "embedded": "embedded firmware project",
    "unknown": "software project",
}

_HAS_SPACE = js_regex.compile(r"\s")
_WHITESPACE = js_regex.compile(r"\s+", "g")


def identity_narrative(identity: dict[str, Any]) -> str:
    style = identity.get("architectureStyle")
    arch = f"{style} " if style and style != "unknown" else ""
    noun = TYPE_NOUN.get(identity["repositoryType"], "software project")
    clauses = [f"{identity['name']} is a {arch}{noun}"]
    primary = identity.get("primaryLanguage")
    if primary and primary != "unknown":
        clauses.append(f"written in {primary}")
    plats = [p for p in identity["platforms"] if p not in ("native", "node")]
    if plats:
        clauses.append(f"targeting {', '.join(plats)}")
    opening = " ".join(clauses)
    if identity.get("buildSystem"):
        opening += f", built with {identity['buildSystem']}"
    opening += "."

    sentences = [opening]
    purpose = identity.get("purpose") or ""
    readme_purpose = (
        _WHITESPACE.sub(" ", purpose).strip()
        if purpose and _HAS_SPACE.search(purpose) and len(purpose) > 20
        else ""
    )
    if readme_purpose and slice_utf16(readme_purpose, 0, 24).lower() not in opening.lower():
        sentences.append(
            readme_purpose if readme_purpose.endswith(".") else f"{readme_purpose}."
        )
    if identity["mainModules"]:
        sentences.append(
            f"Its major subsystems include {', '.join(identity['mainModules'][:6])}."
        )
    if identity["entryPoints"]:
        sentences.append(f"The entry point is {identity['entryPoints'][0]}.")
    if identity["frameworks"]:
        sentences.append(f"It uses {', '.join(identity['frameworks'][:5])}.")
    return " ".join(sentences)


def build_identity_section(identity: dict[str, Any]) -> str:
    facts = [
        f"Type: {identity['repositoryType']}",
        f"Primary Language: {identity['primaryLanguage']}",
        f"Secondary Languages: {', '.join(identity['secondaryLanguages']) or 'none'}",
        f"Architecture: {identity['architectureStyle']}",
        f"Build System: {identity['buildSystem'] if identity.get('buildSystem') else 'unknown'}",
        f"Frameworks: {', '.join(identity['frameworks']) or 'none'}",
        f"Platforms: {', '.join(identity['platforms'])}",
        f"Main Modules: {', '.join(identity['mainModules']) or 'none detected'}",
        f"Entry Points: {', '.join(identity['entryPoints']) or 'none detected'}",
        f"Status: {identity['status']}",
        f"Technology Stack: {', '.join(identity['technologyStack'])}",
    ]
    return ("[Repository Identity]\n" + identity_narrative(identity)
            + "\n\nReference facts (do not copy verbatim — write prose):\n"
            + "\n".join(facts))


def build_summary_section(summary: dict[str, Any]) -> str:
    lines = [f"# {summary['projectName']} — Module Overview"]
    if summary.get("purpose"):
        lines.append(f"Purpose: {summary['purpose']}")
    lines.append(f"Total Files: {summary['totalFiles']}")
    lines.append("")
    for module in summary["modules"][:10]:
        lines.append(f"## {module['name']}")
        lines.append(module["description"])
        if module["capabilities"]:
            lines.append(f"Key: {', '.join(module['capabilities'][:6])}")
        if module["childModules"]:
            lines.append(f"Submodules: {', '.join(module['childModules'])}")
        lines.append("")
    return "[Module Summaries]\n" + "\n".join(lines)


def build_profile_section(profile: dict[str, Any]) -> str:
    lines = [
        "[Repository Profile]",
        f"Architecture Style: {profile['architectureStyle']}",
        (f"Design Patterns: {', '.join(profile['designPatterns'])}"
         if profile["designPatterns"] else ""),
        (f"Naming Conventions: {', '.join(profile['namingConventions'])}"
         if profile["namingConventions"] else ""),
        (f"Module Structure: {', '.join(profile['moduleStructure'])}"
         if profile["moduleStructure"] else ""),
        ("Key Decisions:\n" + "\n".join(f"- {d}" for d in profile["keyDecisions"])
         if profile["keyDecisions"] else ""),
    ]
    return "\n".join(line for line in lines if line)


def build_glossary_hint(glossary: dict[str, Any] | None) -> str:
    if not glossary:
        return ""
    terms = list(glossary["entries"])[:15]
    if not terms:
        return ""
    return f"[Project Terms] Use these project-specific terms: {', '.join(terms)}"


def build_grounding_rules() -> str:
    return "[Answering Rules]\nAnswer as AURA, from the authoritative facts above. Treat the Repository Identity, Architecture, Modules, Status, Relationships and Memory as established truth — never contradict or re-derive them.\nUse source excerpts only for specifics (names, signatures, exact behavior); they support the facts above but do not redefine the project.\nIf a detail is not present in AURA's facts, state that plainly instead of inventing it.\n\n[Response Style]\nReply as a knowledgeable senior engineer writing for another engineer: a complete, fluent, well-structured answer in natural prose. Begin with a direct one- or two-sentence summary that answers the question, then explain — what the project is, what it does, how it is built and organized — drawing naturally on the identity, purpose, architecture, modules and platform.\nWrite in full sentences and connected paragraphs. Where it genuinely aids clarity, use light markdown: a short lead paragraph followed by a few bullet points for the major modules or key facts. Aim for a thorough, confident, readable explanation — several sentences at minimum, not one line.\nCRITICAL: never answer with terse fragments, comma-separated keywords, or the bracketed \"[Field: value]\" notation used above. That notation is AURA's internal data format, NOT your output format — translate it into prose. For example, do not write \"aura-kernel a kernel C, /main, x86\"; instead write \"aura-kernel is a small operating-system kernel written in C. It targets x86_64 and boots from ...\"."


def build_module_detail(module: dict[str, Any]) -> str:
    lines = [
        f"Module: {module['name']}",
        f"Path: {module['path']}",
        f"Language: {module['primaryLanguage']}",
        f"Files: {module['fileCount']}",
        f"Description: {module['description']}",
        (f"Key Components: {', '.join(module['capabilities'])}"
         if module["capabilities"] else ""),
        (f"Submodules: {', '.join(module['childModules'])}"
         if module["childModules"] else ""),
    ]
    return "\n".join(line for line in lines if line)


def _project_overview(inp: dict[str, Any]) -> list[str]:
    parts = []
    if inp["identity"]:
        parts.append(build_identity_section(inp["identity"]))
    if inp["summary"]:
        parts.append(build_summary_section(inp["summary"]))
    if inp["profile"]:
        parts.append(build_profile_section(inp["profile"]))
    if inp["graphContext"]:
        parts.append(f"[Architecture Graph]\n{inp['graphContext']}")
    if inp["memoryContext"]:
        parts.append(inp["memoryContext"])
    return parts


def _architecture(inp: dict[str, Any]) -> list[str]:
    parts = []
    if inp["identity"]:
        parts.append(build_identity_section(inp["identity"]))
    if inp["profile"]:
        parts.append(build_profile_section(inp["profile"]))
    if inp["graphContext"]:
        parts.append(f"[Architecture Graph]\n{inp['graphContext']}")
    if inp["summary"]:
        parts.append(build_summary_section(inp["summary"]))
    if inp["memoryContext"]:
        parts.append(inp["memoryContext"])
    return parts


def _module_explanation(inp: dict[str, Any]) -> list[str]:
    parts = []
    entities = inp["intent"].entities
    target = entities[0].lower() if entities else None
    if inp["summary"] and target:
        module = next(
            (m for m in inp["summary"]["modules"] if target in m["name"].lower()), None
        )
        if module:
            parts.append(f"[Target Module]\n{build_module_detail(module)}")
    if inp["graphContext"]:
        parts.append(f"[Module Relationships]\n{inp['graphContext']}")
    if inp["codingContext"]:
        parts.append(inp["codingContext"])
    if inp["memoryContext"]:
        parts.append(inp["memoryContext"])
    return parts


def _function_explanation(inp: dict[str, Any]) -> list[str]:
    parts = []
    if inp["codingContext"]:
        parts.append(inp["codingContext"])
    if inp["graphContext"]:
        parts.append(f"[Code Relationships]\n{inp['graphContext']}")
    return parts


def _bug_fix(inp: dict[str, Any]) -> list[str]:
    parts = []
    if inp["codingContext"]:
        parts.append(inp["codingContext"])
    if inp["graphContext"]:
        parts.append(f"[Dependencies & Relationships]\n{inp['graphContext']}")
    if inp["memoryContext"]:
        parts.append(inp["memoryContext"])
    return parts


def _code_search(inp: dict[str, Any]) -> list[str]:
    return [inp["codingContext"]] if inp["codingContext"] else []


def _api_reference(inp: dict[str, Any]) -> list[str]:
    parts = []
    if inp["codingContext"]:
        parts.append(inp["codingContext"])
    if inp["graphContext"]:
        parts.append(f"[API Relationships]\n{inp['graphContext']}")
    if inp["summary"]:
        parts.append(build_summary_section(inp["summary"]))
    return parts


def _testing(inp: dict[str, Any]) -> list[str]:
    parts = []
    if inp["codingContext"]:
        parts.append(inp["codingContext"])
    if inp["summary"]:
        parts.append(build_summary_section(inp["summary"]))
    return parts


def _generic(inp: dict[str, Any]) -> list[str]:
    parts = []
    if inp["identity"]:
        parts.append(build_identity_section(inp["identity"]))
    if inp["codingContext"]:
        parts.append(inp["codingContext"])
    if inp["graphContext"]:
        parts.append(f"[Architecture]\n{inp['graphContext']}")
    if inp["memoryContext"]:
        parts.append(inp["memoryContext"])
    return parts


_BY_INTENT = {
    "project_overview": _project_overview,
    "architecture": _architecture,
    "module_explanation": _module_explanation,
    "function_explanation": _function_explanation,
    "bug_fix": _bug_fix,
    "debugging": _bug_fix,
    "code_search": _code_search,
    "api_reference": _api_reference,
    "testing": _testing,
}


def assemble_context(inp: dict[str, Any]) -> dict[str, Any]:
    intent = inp["intent"]
    confidence_marks: list[dict[str, Any]] = []

    wrapped = dict(inp)
    wrapped["codingContext"] = (
        "[Supporting Source Excerpts — evidence only, subordinate to AURA's facts "
        f"above]\n{inp['codingContext']}" if inp["codingContext"] else ""
    )
    wrapped["memoryContext"] = (
        f"[Repository Memory]\n{inp['memoryContext']}" if inp["memoryContext"] else ""
    )

    facts = _BY_INTENT.get(intent.type, _generic)(wrapped)
    has_content = any(bool(f) for f in facts)

    parts: list[str] = []
    if has_content:
        parts.append(AUTHORITATIVE_PREAMBLE)
    parts.extend(facts)

    glossary_hint = build_glossary_hint(inp["glossary"])
    if glossary_hint:
        parts.append(glossary_hint)

    if has_content:
        parts.append(build_grounding_rules())

    for source in inp["retrievedFiles"]:
        confidence_marks.append(evaluate_confidence(source, {
            "identity": inp["identity"], "summary": inp["summary"],
            "documentation": inp["retrievedFiles"], "graphEntities": [],
        }))

    if inp["retrievedFiles"]:
        parts.append("[Retrieved Files]\n"
                     + "\n".join(f"- {f}" for f in inp["retrievedFiles"]))

    system_messages: list[dict[str, str]] = []
    full_context = "\n\n".join(p for p in parts if p)
    if full_context:
        system_messages.append({"role": "system", "content": full_context})

    return {
        "systemMessages": system_messages,
        "totalTokens": est_tokens(full_context),
        "confidenceMarks": confidence_marks,
        "retrievedSources": inp["retrievedFiles"],
    }
