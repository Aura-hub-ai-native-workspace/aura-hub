"""Repository Verification Report.

A port of packages/ai-service/src/intelligence/verification.ts.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from ..core.json_store import atomic_write_json
from .constants import IGNORE_DIRS
from .health_engine import _round
from .identity import _read_dir


def verify_identity(identity: dict[str, Any] | None, _root: str) -> dict[str, Any]:
    findings: list[str] = []
    score = 0

    if not identity:
        findings.append("No project identity generated")
        return {"name": "Identity", "score": 0, "status": "fail", "findings": findings}

    if identity.get("name"):
        score += 20
        findings.append(f"Name: {identity['name']}")
    if identity.get("purpose"):
        score += 20
        findings.append("Purpose documented")
    if identity.get("primaryLanguage") != "unknown":
        score += 20
        findings.append(f"Primary language: {identity.get('primaryLanguage')}")
    if identity.get("repositoryType") != "unknown":
        score += 20
        findings.append(f"Type: {identity.get('repositoryType')}")
    if identity.get("architectureStyle") != "unknown":
        score += 20
        findings.append(f"Architecture: {identity.get('architectureStyle')}")

    status = "pass" if score >= 80 else "warn" if score >= 60 else "fail"
    return {"name": "Identity", "score": score, "status": status, "findings": findings}


def verify_documentation(root: str, summary: dict[str, Any] | None) -> dict[str, Any]:
    findings: list[str] = []
    score = 0

    if (os.path.exists(os.path.join(root, "README.md"))
            or os.path.exists(os.path.join(root, "readme.md"))):
        score += 30
        findings.append("README.md exists")
    else:
        findings.append("No README.md found")

    if os.path.exists(os.path.join(root, "docs")):
        score += 20
        findings.append("docs/ directory exists")

    if summary:
        modules = summary.get("modules") or []
        documented = [m for m in modules
                      if m.get("description") and len(m["description"]) > 10]
        coverage = len(documented) / len(modules) if modules else 0
        score += _round(coverage * 50)
        findings.append(f"{len(documented)}/{len(modules)} modules documented")

    status = "pass" if score >= 70 else "warn" if score >= 40 else "fail"
    return {"name": "Documentation", "score": score, "status": status,
            "findings": findings}


def count_source_modules(root: str) -> int:
    count = 0
    src_dir = os.path.join(root, "src")
    if os.path.exists(src_dir):
        try:
            for entry in _read_dir(src_dir):
                if (entry.is_dir() and entry.name not in IGNORE_DIRS
                        and not entry.name.startswith(".")):
                    count += 1
        except OSError:
            pass
    return count or 1  # At least 1 for root


def verify_module_coverage(root: str, summary: dict[str, Any] | None) -> dict[str, Any]:
    findings: list[str] = []
    actual = count_source_modules(root)
    documented = len((summary or {}).get("modules") or []) if summary else 0

    if actual == 0:
        findings.append("No source modules found")
        return {"name": "Module Coverage", "score": 100, "status": "pass",
                "findings": findings}

    score = min(100, _round((documented / actual) * 100))
    findings.append(f"{documented}/{actual} modules indexed")
    status = "pass" if score >= 80 else "warn" if score >= 50 else "fail"
    return {"name": "Module Coverage", "score": score, "status": status,
            "findings": findings}


def verify_health(health: dict[str, Any] | None) -> dict[str, Any]:
    findings: list[str] = []

    if not health:
        findings.append("No health report generated")
        return {"name": "Health", "score": 0, "status": "fail", "findings": findings}

    score_block = health["score"]
    score = _round((score_block["documentation"] + score_block["testing"]
                    + score_block["maintainability"]) / 3)

    findings.append(f"Documentation: {score_block['documentation']}/100")
    findings.append(f"Testing: {score_block['testing']}/100")
    findings.append(f"Maintainability: {score_block['maintainability']}/100")
    if health.get("issues"):
        findings.append(f"{len(health['issues'])} issues detected")

    status = "pass" if score >= 70 else "warn" if score >= 50 else "fail"
    return {"name": "Health", "score": score, "status": status, "findings": findings}


def verify_architecture(
    profile: dict[str, Any] | None, identity: dict[str, Any] | None
) -> dict[str, Any]:
    findings: list[str] = []
    score = 0

    if profile:
        score += 30
        findings.append(f"Architecture style: {profile['architectureStyle']}")
        if profile.get("designPatterns"):
            score += 20
            findings.append(f"{len(profile['designPatterns'])} design patterns detected")
        if profile.get("namingConventions"):
            score += 20
            findings.append(
                f"{len(profile['namingConventions'])} naming conventions identified"
            )
        if profile.get("keyDecisions"):
            score += 30
            findings.append(f"{len(profile['keyDecisions'])} key decisions documented")

    if identity:
        findings.append(f"Identity architecture: {identity['architectureStyle']}")

    status = "pass" if score >= 60 else "warn" if score >= 30 else "fail"
    return {"name": "Architecture", "score": score, "status": status,
            "findings": findings}


def verify_glossary(glossary: dict[str, Any] | None, _root: str) -> dict[str, Any]:
    findings: list[str] = []

    if not glossary:
        findings.append("No glossary generated")
        return {"name": "Glossary", "score": 0, "status": "fail", "findings": findings}

    terms = list(glossary["entries"])
    score = min(100, len(terms) * 2)
    findings.append(f"{len(terms)} terms documented")

    if any("component" in t.lower() for t in terms):
        score += 10
        findings.append("Component terminology documented")
    if any("api" in t.lower() for t in terms):
        score += 10
        findings.append("API terminology documented")

    status = "pass" if score >= 60 else "warn" if score >= 30 else "fail"
    return {"name": "Glossary", "score": score, "status": status, "findings": findings}


def generate_summary(score: int, sections: list[dict[str, Any]]) -> str:
    failing = [s for s in sections if s["status"] == "fail"]
    warnings = [s for s in sections if s["status"] == "warn"]

    if score >= 90:
        return "Excellent! Repository intelligence is comprehensive and accurate."
    if score >= 70:
        return f"Good. Score {score}/100. {len(warnings)} warnings to address."
    if score >= 50:
        return f"Fair. Score {score}/100. {len(failing)} sections need attention."
    return f"Needs work. Score {score}/100. Run intelligence pipeline to improve coverage."


def generate_verification_report(
    home: Path, project_id: str, root: str, now: str,
    identity: dict[str, Any] | None, summary: dict[str, Any] | None,
    health: dict[str, Any] | None, profile: dict[str, Any] | None,
    glossary: dict[str, Any] | None,
) -> dict[str, Any]:
    sections: list[dict[str, Any]] = []
    recommendations: list[str] = []

    sections.append(verify_identity(identity, root))
    if sections[-1]["status"] == "fail":
        recommendations.append("Regenerate project identity with `generateIdentity()`")

    sections.append(verify_documentation(root, summary))
    if sections[-1]["score"] < 70:
        recommendations.append("Add README files to undocumented modules")

    sections.append(verify_module_coverage(root, summary))
    if sections[-1]["score"] < 80:
        recommendations.append("Run module summarizer to document all modules")

    sections.append(verify_health(health))
    if sections[-1]["status"] == "warn":
        recommendations.append("Address health issues identified in the report")

    sections.append(verify_architecture(profile, identity))

    sections.append(verify_glossary(glossary, root))
    if sections[-1]["score"] < 60:
        recommendations.append("Build project glossary to document terminology")

    overall = _round(sum(s["score"] for s in sections) / len(sections))

    report = {
        "projectId": project_id,
        "generatedAt": now,
        "overallScore": overall,
        "sections": sections,
        "recommendations": recommendations,
        "summary": generate_summary(overall, sections),
    }
    atomic_write_json(
        home / "reports" / f"{project_id}-verification.json", report
    )
    return report
