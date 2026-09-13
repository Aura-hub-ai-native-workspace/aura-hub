"""The contract every software source honours.

Deliberately narrow. A source answers "what do you know about this
name" and returns records; it cannot install, execute, or confer trust.
That narrowness is what lets a new registry be added later without
touching the resolver or widening the security surface.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Protocol

from ..identity import SoftwareRecord

#: Every outbound call is bounded. A registry that hangs must not hang
#: the user's search.
HTTP_TIMEOUT_S = 6.0
#: Hard ceiling on a response body. Registries are chatty; we read
#: metadata, not tarballs.
MAX_BYTES = 512_000
USER_AGENT = "AURA-Hub/0.1 (+software-discovery)"


@dataclass
class SourceResult:
    records: list[SoftwareRecord] = field(default_factory=list)
    #: True when the source could not be reached — distinct from "no
    #: results", so the UI can say "offline" rather than "not found".
    unreachable: bool = False
    detail: str = ""


class SoftwareSource(Protocol):
    """A place AURA can learn about software."""

    id: str

    def search(self, query: str, *, limit: int = 10) -> SourceResult: ...


class _Absent:
    """The source answered, and the answer was "no such thing".

    Distinct from None on purpose. A 404 is a definitive negative from a
    reachable service; a transport failure is no answer at all. Collapsing
    them would make the UI tell a user their tool "could not be reached"
    when the registry cheerfully replied that it does not exist — or,
    worse, report a network outage as proof of absence.
    """

    __slots__ = ()

    def __bool__(self) -> bool:
        return False


ABSENT = _Absent()


def fetch_json(url: str, *, timeout: float = HTTP_TIMEOUT_S):
    """GET one JSON document, bounded in time and size.

    Returns the decoded body, ABSENT when the service answered 404, or
    None on any failure — unreachable host, non-JSON, oversized body. A
    source that cannot answer says so; it never raises into the user's
    search, and it never retries in a loop.
    """
    if not url.startswith("https://"):
        return None                      # plaintext transport is not a source
    req = urllib.request.Request(url, headers={
        "accept": "application/json",
        "user-agent": USER_AGENT,
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                return None
            raw = resp.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as err:
        return ABSENT if err.code == 404 else None
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None
    if len(raw) > MAX_BYTES:
        return None
    try:
        return json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError:
        return None
