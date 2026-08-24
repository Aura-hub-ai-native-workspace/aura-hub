"""Per-run grants — port of ai-service/fabric/scopes.ts.

Narrowing only: the ceiling is LOCAL_GRANTS and nothing may add to it.
Human-only scopes are absent by design — no flag grants them.
"""

from __future__ import annotations

from typing import Optional

LOCAL_GRANTS = {"read": True, "write": True, "execute": True, "autonomous": False}

FLAG_FOR_SCOPE = {
    "project.read": "read", "aura.read": "read",
    "project.write": "write", "aura.write": "write",
    "process.execute": "execute", "network.outbound": "execute",
}


def grants_for_scopes(scopes):
    out = {"read": False, "write": False, "execute": False, "autonomous": False}
    for scope in scopes:
        flag = FLAG_FOR_SCOPE.get(scope)
        if flag and LOCAL_GRANTS[flag]:
            out[flag] = True
    return out


class RunScopeRegistry:
    def __init__(self) -> None:
        self._by_run: dict[str, set] = {}

    def register(self, run_id: str, scopes: set) -> None:
        self._by_run[run_id] = set(scopes)

    def remove(self, run_id: str) -> None:
        self._by_run.pop(run_id, None)

    def for_run(self, run_id: Optional[str]):
        if run_id is None or run_id not in self._by_run:
            return None
        return grants_for_scopes(self._by_run[run_id])
