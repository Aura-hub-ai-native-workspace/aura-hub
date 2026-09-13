"""PyPI — the Python index, read as structured metadata.

PyPI has no search API that is safe to depend on, so this adapter does
the one thing PyPI does well: an exact lookup of a project by name via
the JSON API. That is the right shape for this product anyway — the user
is searching for a tool they already found by name, not browsing.

Trove classifiers make PyPI unusually good at the tool/library question,
and `console_scripts` entry points name the commands a project installs.
As with npm, no install instruction is read: PyPI describes software, it
does not tell AURA how to install it.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime

from ..classify import classify
from ..identity import Provenance, SoftwareRecord, Trust, canonical_id
from .base import ABSENT, SourceResult, fetch_json

PROJECT_URL = "https://pypi.org/pypi/{name}/json"

#: PEP 508 names, conservatively.
_NAME_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$")


def _safe_name(name: str) -> str:
    n = (name or "").strip()
    return n if _NAME_RE.match(n) and len(n) <= 100 else ""


def _entry_point_commands(info: dict) -> list[str]:
    """Console scripts, when the project publishes them.

    PyPI does not expose entry points on the JSON API for every project,
    so absence is not evidence of a library — it just leaves the decision
    to the classifiers, which is what `classify` expects.
    """
    raw = info.get("entry_points")
    if not isinstance(raw, str):
        return []
    out: list[str] = []
    section = False
    for line in raw.splitlines():
        s = line.strip()
        if s.startswith("["):
            section = s.lower().startswith("[console_scripts")
            continue
        if section and "=" in s:
            cmd = s.split("=", 1)[0].strip()
            if _safe_name(cmd):
                out.append(cmd)
    return out[:8]


class PyPISource:
    id = "pypi"

    def search(self, query: str, *, limit: int = 10) -> SourceResult:
        name = _safe_name(query)
        if not name:
            return SourceResult()
        body = fetch_json(PROJECT_URL.format(name=name))
        if body is ABSENT:
            # PyPI answered: there is no such project. A definite negative,
            # not an outage — saying "unreachable" here would blame the
            # network for an honest "not found".
            return SourceResult(detail="PyPI has no project by that name")
        if body is None:
            return SourceResult(unreachable=True,
                                detail="PyPI could not be reached")
        info = body.get("info") if isinstance(body, dict) else None
        if not isinstance(info, dict):
            return SourceResult()

        summary = str(info.get("summary") or "")[:400]
        classifiers = [str(c)[:120] for c in (info.get("classifiers") or [])
                       if isinstance(c, str)][:40]
        keywords_raw = info.get("keywords") or ""
        keywords = ([k.strip() for k in keywords_raw.split(",") if k.strip()][:12]
                    if isinstance(keywords_raw, str) else [])
        execs = _entry_point_commands(info)
        project = str(info.get("name") or name)
        now = datetime.now(UTC).isoformat(timespec="seconds")

        rec = SoftwareRecord(
            canonical_id=canonical_id(project),
            display_name=project,
            summary=summary,
            latest_version=str(info.get("version") or "")[:40],
            homepage=str(info.get("home_page") or info.get("project_url") or "")[:300],
            repository=str((info.get("project_urls") or {}).get("Source") or "")[:300]
            if isinstance(info.get("project_urls"), dict) else "",
            executables=execs,
            kind=classify(name=project, summary=summary, keywords=keywords,
                          classifiers=classifiers, executables=execs),
            provenance=[Provenance(
                source="pypi", trust=Trust.REGISTRY, identifier=project,
                url=f"https://pypi.org/project/{project}/",
                version=str(info.get("version") or "")[:40],
                fetched_at=now,
            )],
        )
        rec.add_alias(project)
        return SourceResult(records=[rec][:limit])
