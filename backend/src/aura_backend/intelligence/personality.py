"""Repository Personality.

A port of packages/ai-service/src/intelligence/personality.ts.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from ..core.json_store import atomic_write_json
from .constants import IGNORE_DIRS
from .identity import _ext_of, _read_dir

FORMAL = ("shall", "therefore", "consequently", "furthermore", "moreover")
CASUAL = ("hey", "guys", "cool", "awesome", "check out")
TECHNICAL = ("implementation", "architecture", "abstraction", "interface", "protocol")
ACADEMIC = ("hypothesis", "methodology", "analysis", "conclusion", "abstract")

CONCISE = ("brief", "quick", "short", "summary")
DETAILED = ("comprehensive", "detailed", "in-depth", "thorough")
TUTORIAL = ("step", "tutorial", "guide", "how to", "getting started")
REFERENCE = ("api", "reference", "documentation", "specification")

CODE_EXTS = (".ts", ".js", ".py")


def read_text_file(path: str) -> str | None:
    try:
        with open(path, "rb") as handle:
            return handle.read().decode("utf-8", errors="replace")
    except OSError:
        return None


def detect_communication_style(root: str) -> str:
    content = (read_text_file(os.path.join(root, "README.md"))
               or read_text_file(os.path.join(root, "readme.md")) or "")
    lower = content.lower()

    formal = sum(1 for i in FORMAL if i in lower)
    casual = sum(1 for i in CASUAL if i in lower)
    technical = sum(1 for i in TECHNICAL if i in lower)
    academic = sum(1 for i in ACADEMIC if i in lower)
    top = max(formal, casual, technical, academic)

    if top == 0:
        return "mixed"
    if formal == top:
        return "formal"
    if casual == top:
        return "casual"
    if technical == top:
        return "technical"
    return "academic"


def detect_code_style(root: str) -> str:
    minimal = verbose = functional = oo = 0

    def scan_file(path: str) -> None:
        nonlocal minimal, verbose, functional, oo
        content = read_text_file(path)
        if content is None:
            return
        if "=>" in content and "class " not in content:
            functional += 1
        if ".map(" in content and ".filter(" in content:
            functional += 1
        if "class " in content and "extends" in content:
            oo += 1
        if "interface " in content and "implements" in content:
            oo += 1
        lines = len(content.split("\n"))
        comments = len([line for line in content.split("\n")
                        if line.strip().startswith("//")])
        if lines < 50 and comments < 5:
            minimal += 1
        if lines > 100 and comments > 10:
            verbose += 1

    def scan_dir(directory: str, depth: int = 0) -> None:
        if depth > 3:
            return
        try:
            entries = _read_dir(directory)
        except OSError:
            return
        for entry in entries:
            if entry.name.startswith(".") or entry.name in IGNORE_DIRS:
                continue
            full = os.path.join(directory, entry.name)
            if entry.is_dir():
                scan_dir(full, depth + 1)
            elif _ext_of(entry.name) in CODE_EXTS:
                scan_file(full)

    scan_dir(root)

    top = max(minimal, verbose, functional, oo)
    if top == 0:
        return "mixed"
    if functional == top:
        return "functional"
    if oo == top:
        return "object-oriented"
    if minimal == top:
        return "minimal"
    return "verbose"


def detect_documentation_tone(root: str) -> str:
    docs_dir = os.path.join(root, "docs")
    doc_content = ""

    if os.path.exists(docs_dir):
        try:
            files = [e.name for e in _read_dir(docs_dir) if e.name.endswith(".md")]
            for name in files[:5]:
                doc_content += read_text_file(os.path.join(docs_dir, name)) or ""
        except OSError:
            pass

    if not doc_content:
        return "mixed"

    lower = doc_content.lower()
    concise = sum(1 for i in CONCISE if i in lower)
    detailed = sum(1 for i in DETAILED if i in lower)
    tutorial = sum(1 for i in TUTORIAL if i in lower)
    reference = sum(1 for i in REFERENCE if i in lower)
    top = max(concise, detailed, tutorial, reference)

    if top == 0:
        return "mixed"
    if concise == top:
        return "concise"
    if detailed == top:
        return "detailed"
    if tutorial == top:
        return "tutorial"
    return "reference"


def detect_technical_level(
    glossary: dict[str, Any] | None, _identity: dict[str, Any] | None
) -> str:
    if not glossary:
        return "intermediate"
    entries = glossary["entries"]
    term_count = len(entries)
    advanced = len([e for e in entries.values()
                    if "advanced" in e["definition"].lower()
                    or "complex" in e["definition"].lower()])

    if term_count > 50 and advanced > 10:
        return "expert"
    if term_count > 20 and advanced > 5:
        return "advanced"
    if term_count < 10:
        return "beginner"
    return "intermediate"


def detect_response_patterns(
    root: str, _identity: dict[str, Any] | None
) -> dict[str, Any]:
    use_examples = os.path.exists(os.path.join(root, "examples"))
    include_references = False

    docs_dir = os.path.join(root, "docs")
    if os.path.exists(docs_dir):
        try:
            names = [e.name for e in _read_dir(docs_dir)]
            if any("reference" in n or "api" in n for n in names):
                include_references = True
        except OSError:
            pass

    content = (read_text_file(os.path.join(root, "README.md"))
               or read_text_file(os.path.join(root, "readme.md")) or "")
    readme_lines = len(content.split("\n"))

    if readme_lines < 30:
        verbosity = "minimal"
    elif readme_lines > 100:
        verbosity = "detailed"
    else:
        verbosity = "moderate"

    return {"verbosity": verbosity, "useExamples": use_examples,
            "includeReferences": include_references}


def detect_personality(
    home: Path, project_id: str, root: str, now: str,
    identity: dict[str, Any] | None, _profile: dict[str, Any] | None,
    glossary: dict[str, Any] | None,
) -> dict[str, Any]:
    personality = {
        "projectId": project_id,
        "communicationStyle": detect_communication_style(root),
        "codeStyle": detect_code_style(root),
        "documentationTone": detect_documentation_tone(root),
        "technicalLevel": detect_technical_level(glossary, identity),
        "responsePatterns": detect_response_patterns(root, identity),
        "generatedAt": now,
    }
    atomic_write_json(home / "personality" / f"{project_id}.json", personality)
    return personality
