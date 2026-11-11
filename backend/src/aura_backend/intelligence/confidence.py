"""Confidence System.

A port of packages/ai-service/src/intelligence/confidence.ts.

Distinguishes documented facts from inferred information and uncertain
claims, so the model never presents a guess as established.
"""

from __future__ import annotations

from typing import Any

from ..core import js_regex
from ..core.js_string import slice_utf16

_FILE_REF = js_regex.compile(r"[\w/.-]+\.[a-z]{1,4}")


def evaluate_confidence(claim: str, source: dict[str, Any]) -> dict[str, Any]:
    claim_lower = claim.lower()
    identity = source.get("identity")
    summary = source.get("summary")

    if identity:
        if (identity["name"].lower() in claim_lower
                or identity["repositoryType"] in claim_lower):
            return {
                "level": "documented",
                "evidence": (f"Project identity states this is a "
                             f"{identity['repositoryType']} project"),
                "source": "identity",
            }
        purpose = identity.get("purpose")
        if purpose and slice_utf16(purpose.lower(), 0, 30) in claim_lower:
            return {"level": "documented",
                    "evidence": "Purpose is stated in project identity",
                    "source": "identity"}

    if summary:
        for module in summary["modules"]:
            if module["name"].lower() in claim_lower:
                return {
                    "level": "documented",
                    "evidence": (f'Module "{module["name"]}" is documented in '
                                 "repository summary"),
                    "source": "summary",
                }

    match = _FILE_REF.search(claim)
    if match:
        file_path = match.group(0)
        if any(file_path in d for d in source.get("documentation", [])):
            return {"level": "documented",
                    "evidence": f"Referenced file {file_path} is in documentation",
                    "source": "documentation"}

    for entity in source.get("graphEntities", []):
        if entity.lower() in claim_lower:
            return {
                "level": "inferred",
                "evidence": (f'Entity "{entity}" found in code graph but not '
                             "explicitly documented"),
                "source": "graph",
            }

    # `evidence` only — `source` is absent, and `JSON.stringify` drops it.
    return {"level": "uncertain",
            "evidence": "No direct evidence found in repository knowledge"}
