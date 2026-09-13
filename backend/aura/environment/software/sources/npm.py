"""npm — the registry, read as structured metadata.

npm is worth having first because it answers the classification question
better than almost any other source: the `bin` field states exactly which
commands a package installs, which is the difference between a tool and a
dependency.

What is read: name, description, keywords, homepage, repository, latest
version, and `bin`. What is never read or used: install instructions,
scripts, README prose, or any field that could become a command. AURA
does not learn how to install from npm; it learns only that the software
exists and what shape it is.
"""

from __future__ import annotations

import re
import urllib.parse
from datetime import UTC, datetime

from ..classify import classify
from ..identity import Provenance, SoftwareRecord, Trust, canonical_id
from .base import SourceResult, fetch_json

SEARCH_URL = "https://registry.npmjs.org/-/v1/search?text={q}&size={n}"
#: The search endpoint omits `bin`, and the full packument lists every
#: version ever published (megabytes). `/latest` is the one manifest that
#: is both small and authoritative about the commands a package installs,
#: so it is fetched for the EXACT name match only — one extra bounded
#: request, never one per result.
MANIFEST_URL = "https://registry.npmjs.org/{name}/latest"

#: npm names are tightly specified; anything else is not a package name
#: and must not be interpolated into a URL.
_NAME_RE = re.compile(r"^(?:@[a-z0-9][\w.-]*/)?[a-z0-9][\w.-]*$", re.I)


def _safe_name(name: str) -> str:
    n = (name or "").strip()
    return n if _NAME_RE.match(n) and len(n) <= 214 else ""


def _bin_names(pkg: dict) -> list[str]:
    """Executables the package declares. Names only, never their paths.

    `bin` is a string or an object; the VALUES are file paths inside the
    package and are deliberately discarded — only the command names are
    kept, as classification evidence and a probe hint.
    """
    raw = pkg.get("bin")
    if isinstance(raw, str):
        base = raw.rsplit("/", 1)[-1].removesuffix(".js")
        return [base] if base else []
    if isinstance(raw, dict):
        return [k for k in raw if isinstance(k, str) and _safe_name(k)][:8]
    return []


class NpmSource:
    id = "npm"

    def _declared_bins(self, name: str) -> list[str]:
        """Commands the package installs, from its latest manifest."""
        manifest = fetch_json(MANIFEST_URL.format(name=urllib.parse.quote(name, safe="@/")))
        if not isinstance(manifest, dict):
            return []
        return _bin_names(manifest)

    def search(self, query: str, *, limit: int = 10) -> SourceResult:
        q = (query or "").strip()
        if not q:
            return SourceResult()
        url = SEARCH_URL.format(q=urllib.parse.quote(q, safe=""),
                                n=max(1, min(limit, 25)))
        body = fetch_json(url)
        if body is None:
            return SourceResult(unreachable=True,
                                detail="the npm registry could not be reached")
        objects = body.get("objects") if isinstance(body, dict) else None
        if not isinstance(objects, list):
            return SourceResult(detail="npm returned no usable results")

        now = datetime.now(UTC).isoformat(timespec="seconds")
        out: list[SoftwareRecord] = []
        for obj in objects[:limit]:
            pkg = (obj or {}).get("package") if isinstance(obj, dict) else None
            if not isinstance(pkg, dict):
                continue
            name = _safe_name(str(pkg.get("name") or ""))
            if not name:
                continue                     # malformed entry, skipped
            summary = str(pkg.get("description") or "")[:400]
            keywords = [str(k)[:40] for k in (pkg.get("keywords") or [])
                        if isinstance(k, str)][:12]
            links = pkg.get("links") if isinstance(pkg.get("links"), dict) else {}
            # Classification hinges on whether this installs a command, so
            # the exact match earns the extra lookup; the rest are judged
            # on the metadata the search already returned.
            execs = _bin_names(pkg)
            if not execs and name.lower() == q.lower():
                execs = self._declared_bins(name)
            rec = SoftwareRecord(
                canonical_id=canonical_id(name),
                display_name=name,
                summary=summary,
                latest_version=str(pkg.get("version") or "")[:40],
                homepage=str((links or {}).get("homepage") or "")[:300],
                repository=str((links or {}).get("repository") or "")[:300],
                executables=execs,
                kind=classify(name=name, summary=summary,
                              keywords=keywords, executables=execs),
                provenance=[Provenance(
                    source="npm", trust=Trust.REGISTRY, identifier=name,
                    url=f"https://www.npmjs.com/package/{name}",
                    version=str(pkg.get("version") or "")[:40],
                    fetched_at=now,
                )],
            )
            rec.add_alias(name)
            out.append(rec)
        return SourceResult(records=out)
