"""Repository Health Engine.

A port of packages/ai-service/src/intelligence/healthEngine.ts.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from ..core import js_regex
from ..core.js_string import slice_utf16
from ..core.json_store import atomic_write_json
from .constants import IGNORE_DIRS
from .identity import _read_dir

_TEST_JS = js_regex.compile(r"\.(test|spec)\.[jt]sx?$")
_TEST_UNDERSCORE = js_regex.compile(r"_test\.(py|go|rs)$")
_TEST_DOT = js_regex.compile(r"\.test\.(py|go|rs)$")


def _round(value: float) -> int:
    """`Math.round` — half rounds toward +Infinity, unlike Python's."""
    import math

    return math.floor(value + 0.5)


def assess_documentation(root: str, modules: list[dict[str, str]]) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []
    missing_docs: list[str] = []
    documented = 0
    total = max(len(modules), 1)

    if not os.path.exists(os.path.join(root, "README.md")):
        issues.append({"severity": "warning", "category": "documentation",
                       "message": "No README.md found"})
    else:
        documented += 1

    has_arch = (os.path.exists(os.path.join(root, "ARCHITECTURE.md"))
                or os.path.exists(os.path.join(root, "docs", "ARCHITECTURE.md")))
    if not has_arch:
        issues.append({"severity": "info", "category": "documentation",
                       "message": "No ARCHITECTURE.md found"})

    for module in modules:
        mod_dir = os.path.join(root, module["path"])
        has_doc = (os.path.exists(os.path.join(mod_dir, "README.md"))
                   or os.path.exists(os.path.join(mod_dir, "DOCS.md"))
                   or os.path.exists(os.path.join(mod_dir, "docs")))
        if has_doc:
            documented += 1
        else:
            missing_docs.append(module["name"])

    score = _round((documented / total) * 100)
    return {"score": min(100, score), "missingDocs": missing_docs, "issues": issues}


def assess_testing(root: str) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []
    test_files = 0
    total_files = 0
    budget = 10000

    def scan(directory: str) -> None:
        nonlocal test_files, total_files, budget
        if budget <= 0:
            return
        try:
            entries = _read_dir(directory)
        except OSError:
            return
        for entry in entries:
            # Post-decrement: the OLD value is tested, as in the reference.
            old = budget
            budget -= 1
            if old <= 0:
                break
            if entry.name.startswith(".") or entry.name in IGNORE_DIRS:
                continue
            full = os.path.join(directory, entry.name)
            if entry.is_dir():
                scan(full)
                continue
            total_files += 1
            if (_TEST_JS.search(entry.name) or _TEST_UNDERSCORE.search(entry.name)
                    or _TEST_DOT.search(entry.name)):
                test_files += 1

    scan(root)

    ratio = test_files / total_files if total_files > 0 else 0
    score = _round(min(100, ratio * 500))

    if test_files == 0:
        issues.append({"severity": "warning", "category": "testing",
                       "message": "No test files found"})
    elif ratio < 0.05:
        issues.append({
            "severity": "info", "category": "testing",
            "message": (f"Low test coverage ratio: {test_files} test files for "
                        f"{total_files} source files"),
        })

    return {"score": score, "testFiles": test_files, "issues": issues}


def assess_dependencies(root: str) -> dict[str, Any]:
    score = 80
    has_lockfile = any(os.path.exists(os.path.join(root, f)) for f in (
        "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "go.sum"))
    if has_lockfile:
        score += 10
    if os.path.exists(os.path.join(root, "Dockerfile")):
        score += 5
    has_ci = (os.path.exists(os.path.join(root, ".github", "workflows"))
              or os.path.exists(os.path.join(root, ".gitlab-ci.yml"))
              or os.path.exists(os.path.join(root, ".circleci")))
    if has_ci:
        score += 5
    if os.path.exists(os.path.join(root, ".env.example")):
        score += 2
    if (os.path.exists(os.path.join(root, ".snyk"))
            or os.path.exists(os.path.join(root, "dependabot.yml"))):
        score += 3
    return {"score": min(100, score), "issues": []}


def assess_architecture(
    root: str, identity: dict[str, Any] | None, modules: list[dict[str, str]]
) -> dict[str, Any]:
    score = 60
    has_arch_docs = (os.path.exists(os.path.join(root, "ARCHITECTURE.md"))
                     or os.path.exists(os.path.join(root, "docs", "ARCHITECTURE.md"))
                     or os.path.exists(os.path.join(root, "DESIGN.md")))
    if has_arch_docs:
        score += 15
    if 2 <= len(modules) <= 15:
        score += 10
    if identity and identity.get("entryPoints"):
        score += 5
    if identity and identity.get("repositoryType") != "unknown":
        score += 10
    return {"score": min(100, score), "issues": []}


def find_orphan_modules(root: str, modules: list[dict[str, str]]) -> list[str]:
    """Modules whose name appears nowhere else under `src/`.

    The reference's inner walk uses `return` where `continue` was meant:

        if (e.isDirectory()) { checkImports(full); return; }

    so once it descends into the first subdirectory it never looks at the
    remaining siblings. Reproduced, because it changes which modules are
    called orphans.
    """
    orphans: list[str] = []

    for module in modules:
        referenced = False
        scan_budget = 1000

        def check_imports(directory: str, module=module) -> None:
            nonlocal referenced, scan_budget
            if referenced or scan_budget <= 0:
                return
            try:
                entries = _read_dir(directory)
            except OSError:
                return
            for entry in entries:
                # `referenced || scanBudget-- <= 0` short-circuits, so the
                # budget is NOT spent once a reference has been found.
                if referenced:
                    break
                old = scan_budget
                scan_budget -= 1
                if old <= 0:
                    break
                if entry.name.startswith(".") or entry.name in IGNORE_DIRS:
                    continue
                full = os.path.join(directory, entry.name)
                if entry.is_dir():
                    check_imports(full)
                    return
                if entry.name == module["name"]:
                    continue
                try:
                    with open(full, "rb") as handle:
                        content = handle.read().decode("utf-8", errors="replace")
                except OSError:
                    continue
                if module["name"] in slice_utf16(content, 0, 5000):
                    referenced = True

        src_dir = os.path.join(root, "src")
        if os.path.exists(src_dir):
            check_imports(src_dir)

        if not referenced and module["path"] != "src":
            orphans.append(module["name"])

    return orphans


def generate_repository_health(
    home: Path, project_id: str, root: str, now: str,
    identity: dict[str, Any] | None, summary: dict[str, Any] | None,
) -> dict[str, Any]:
    modules = [{"name": m["name"], "path": m["path"]}
               for m in ((summary or {}).get("modules") or [])]
    all_issues: list[dict[str, Any]] = []

    doc = assess_documentation(root, modules)
    test = assess_testing(root)
    dep = assess_dependencies(root)
    arch = assess_architecture(root, identity, modules)

    all_issues.extend(doc["issues"])
    all_issues.extend(test["issues"])
    all_issues.extend(dep["issues"])
    all_issues.extend(arch["issues"])

    orphans = find_orphan_modules(root, modules)
    if orphans:
        all_issues.append({
            "severity": "info", "category": "architecture",
            "message": f"Potentially orphaned modules: {', '.join(orphans)}",
        })

    score = {
        "overall": _round((doc["score"] + test["score"] + dep["score"] + arch["score"]) / 4),
        "documentation": doc["score"],
        "architecture": arch["score"],
        "testing": test["score"],
        "dependencies": dep["score"],
        "maintainability": _round(
            (arch["score"] + dep["score"] + (100 - len(orphans) * 5)) / 3
        ),
    }

    health = {
        "score": score,
        "issues": all_issues,
        "metrics": {
            "totalFiles": (summary or {}).get("totalFiles", 0) if summary else 0,
            "documentedModules": len(modules) - len(doc["missingDocs"]),
            "totalModules": len(modules),
            "testFiles": test["testFiles"],
            "deadCodeEstimate": 0,
            "orphanModules": len(orphans),
            "missingDocs": doc["missingDocs"],
            "unreferencedApis": [],
        },
        "generatedAt": now,
    }
    atomic_write_json(home / "health" / f"{project_id}.json", health)
    return health
