"""What an in-flight run is allowed to ask for.

A port of packages/ai-service/src/fabric/scopes.ts.

The Fabric asks its host one question before policy runs: *what may this
actor do?* This module holds the per-run answer. It is a **narrowing**
mechanism and only a narrowing mechanism:

  * It can take capability away from a run. It can never add any — the
    ceiling is `LOCAL_GRANTS`, and a scope not in the ceiling is not
    grantable here.
  * It decides nothing about risk, approval or floors. A narrowed grant
    produces a `permission-denied` from the EXISTING policy engine; no
    new decision path is introduced.
  * It is keyed by run id, registered when a run starts and removed when
    it ends, so a grant cannot outlive the run that earned it.
"""

from __future__ import annotations

from ..policy.types import Grants, PermissionScope

# The ceiling. AURA is a single-user desktop app and the service already
# runs with the user's own privileges, so read, write and execute are
# genuinely available. `autonomous` stays false because the policy engine
# decides what runs unattended and must not be pre-empted here.
LOCAL_GRANTS = Grants(read=True, write=True, execute=True, autonomous=False)

# Nothing is granted at all. What an unregistered run gets.
NO_GRANTS = Grants(read=False, write=False, execute=False, autonomous=False)

# Which coarse flag each scope needs. Mirrors `grants_for()` in the policy
# engine — the mapping is stated there and read here rather than being
# invented, so the two cannot drift into disagreeing about what "write"
# means.
#
# ACCOUNT_AUTHORIZE, RESOURCE_DESTROY and SYSTEM_MODIFY are absent on
# purpose: no flag grants them, at any level, and the human-only floors in
# the policy engine are what satisfy them.
_FLAG_FOR_SCOPE: dict[PermissionScope, str] = {
    PermissionScope.PROJECT_READ: "read",
    PermissionScope.AURA_READ: "read",
    PermissionScope.PROJECT_WRITE: "write",
    PermissionScope.AURA_WRITE: "write",
    PermissionScope.PROCESS_EXECUTE: "execute",
    PermissionScope.NETWORK_OUTBOUND: "execute",
}


def grants_for_scopes(scopes: list[PermissionScope]) -> Grants:
    """Narrow the ceiling to exactly the flags a set of scopes needs."""
    flags = {"read": False, "write": False, "execute": False, "autonomous": False}
    for scope in scopes:
        flag = _FLAG_FOR_SCOPE.get(scope)
        if flag is None:
            continue
        # AND with the ceiling, so this can only ever subtract.
        if getattr(LOCAL_GRANTS, flag):
            flags[flag] = True
    return Grants(**flags)


class RunScopeRegistry:
    """Live per-run grants.

    In memory only. A scope that survived a restart would be a standing
    permission for a run that is no longer executing, which is precisely
    the mistake the Fabric already refuses to make with unspent approvals.
    """

    def __init__(self) -> None:
        self._by_run: dict[str, Grants] = {}

    def register(self, run_id: str, scopes: list[PermissionScope]) -> Grants:
        grants = grants_for_scopes(scopes)
        self._by_run[run_id] = grants
        return grants

    def release(self, run_id: str) -> None:
        self._by_run.pop(run_id, None)

    def for_run(self, run_id: str | None) -> Grants | None:
        """Grants for an invocation.

        A call carrying a run id with no registration is **not** given the
        ceiling. An unregistered run is one nobody computed an envelope
        for, and the safe reading of "I do not know what this is allowed
        to do" is "nothing", not "everything".
        """
        if not run_id:
            return None
        return self._by_run.get(run_id, NO_GRANTS)

    def active(self) -> int:
        return len(self._by_run)
