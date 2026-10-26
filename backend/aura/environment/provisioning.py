"""tool.provision — install an approved dev tool a task needs, and nothing else.

`system.install` stays a human-only floor for every tool. This capability is
the one narrow, deliberate exception, and its safety does not come from a
policy dial: it comes from the checks below, which run in the executor and
cannot be influenced by the caller or by a model.

A tool is provisioned only when ALL of these hold:

1. **Catalogue-only.** The caller names a catalogue node id, validated
   against a strict pattern. The package, installer and arguments come from
   the catalogue entry — never from the caller. The `reason` is recorded and
   never interpreted or executed.
2. **Allowlisted.** The id is on the provisioning allowlist: a short
   built-in default, plus anything the machine's owner adds in
   ``~/.aura/provisioning.json`` (``{"allow": ["pnpm"]}``). A catalogue
   entry is not an authorisation: AI worker CLIs (which need accounts and
   can cost money) and cloud/deploy CLIs are deliberately not on it.
3. **Non-privileged.** The install plan, resolved for THIS machine, needs no
   administrator rights. A root install is refused and the exact verified
   command is handed back for the person to run.
4. **An allowed installer.** Only the installer binaries AURA already
   allowlists (npm, pipx, cargo, gh), argv-only, no shell — the same hardened
   runner `system.install` uses, with its timeout and process-group kill.
5. **Verified.** Success is a fresh probe finding the tool, not an installer
   exit code.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from ..config import aura_home
from .catalog import CatalogEntry, catalog_entry
from .install import INSTALLER_BINARIES, PlanResult, is_plan, plan_install

#: Built-in allowlist: generic, non-privileged toolchain tools only.
DEFAULT_ALLOWLIST = frozenset({"pnpm"})
_NODE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


@dataclass(frozen=True)
class Decision:
    allowed: bool
    #: invalid-id | not-in-catalog | not-allowlisted | no-install-plan |
    #: needs-privilege | installer-not-allowed | ok
    code: str
    reason: str
    command: str | None = None


def operator_allowlist(home: Path | str | None = None) -> frozenset[str]:
    """Tools the machine's owner has additionally approved. Anything in the
    file that is not a plausible catalogue id is ignored."""
    path = Path(home if home is not None else aura_home()) / "provisioning.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return frozenset()
    ids = raw.get("allow") if isinstance(raw, dict) else None
    if not isinstance(ids, list):
        return frozenset()
    return frozenset(i for i in ids if isinstance(i, str) and _NODE_ID.fullmatch(i))


def allowed_ids(home: Path | str | None = None) -> frozenset[str]:
    return DEFAULT_ALLOWLIST | operator_allowlist(home)


def decide(node_id: object, *, allow: frozenset[str] | None = None,
           entry_fn: Callable[[str], CatalogEntry | None] = catalog_entry,
           plan_fn: Callable[[CatalogEntry], PlanResult] = plan_install) -> Decision:
    """May this node be provisioned automatically? Pure; spawns nothing."""
    if not isinstance(node_id, str) or not _NODE_ID.fullmatch(node_id.strip()):
        return Decision(False, "invalid-id", "A catalogue tool id is required (letters, digits, '.', '_', '-').")
    node_id = node_id.strip()
    entry = entry_fn(node_id)
    if entry is None:
        return Decision(False, "not-in-catalog", f"'{node_id}' is not a tool in AURA's catalogue.")
    if node_id not in (allow if allow is not None else allowed_ids()):
        return Decision(False, "not-allowlisted",
                        f"{entry.name} is not on the provisioning allowlist, so AURA will not install it "
                        "on its own. Install it yourself, or ask for it to be allowed.")
    plan = plan_fn(entry)
    if not is_plan(plan):
        return Decision(False, "no-install-plan", f"{entry.name} cannot be installed automatically here: {plan.reason}")
    if plan.privilege != "user":
        return Decision(False, "needs-privilege",
                        f"{entry.name} needs administrator rights to install, so AURA did not run anything. "
                        f"Run this yourself, then continue: {plan.command}", plan.command)
    if plan.bin not in INSTALLER_BINARIES:
        return Decision(False, "installer-not-allowed", f"The installer '{plan.bin}' is not one AURA is allowed to run.")
    return Decision(True, "ok", f"{entry.name} can be installed in user space with {plan.bin}.", plan.command)


def _no(detail: str, output: dict | None = None) -> dict:
    out = {"ok": False, "detail": detail}
    if output:
        out["output"] = output
    return out


async def tool_provision_run(inv: dict) -> dict:
    """Executor for `tool.provision`."""
    from .executor import system_install_executor

    params = (inv.get("input") or inv.get("params")) or {}
    if not isinstance(params, dict):
        return _no("tool.provision input must be an object.")
    node_id = params.get("nodeId")
    decision = decide(node_id)
    if not decision.allowed:
        outcome = "guided" if decision.code == "needs-privilege" else "unavailable"
        return _no(decision.reason, {
            "installOutcome": outcome, "nodeId": str(node_id or ""), "refused": decision.code,
            "requiresUserAction": decision.code in ("needs-privilege", "not-allowlisted"),
            **({"command": decision.command} if decision.command else {})})
    # Only the validated id crosses into the runner; nothing else the caller
    # sent (including `reason`) is passed on.
    clean = {"input": {"nodeId": str(node_id).strip()}, "context": inv.get("context") or {}}
    result = await system_install_executor(clean)
    if isinstance(result.get("output"), dict):
        result["output"]["provisioned"] = True
    return result


async def tool_provision_verify(inv: dict, result: dict) -> dict:
    """Read-back: the tool is really there now, by a fresh probe."""
    from .probe import probe_node

    params = (inv.get("input") or inv.get("params")) or {}
    node_id = str(params.get("nodeId") or "").strip()
    if not result.get("ok") or not _NODE_ID.fullmatch(node_id):
        return {"passed": False, "kind": "read-back",
                "detail": "The tool was not installed, so there is nothing to confirm."}
    probe = probe_node(node_id, refresh=True)
    return ({"passed": True, "kind": "read-back", "detail": "A fresh probe finds the tool on this machine."}
            if probe.present else
            {"passed": False, "kind": "read-back",
             "detail": f"A fresh probe still cannot find the tool. {probe.detail}"})


__all__ = ["DEFAULT_ALLOWLIST", "Decision", "allowed_ids", "decide", "operator_allowlist",
           "tool_provision_run", "tool_provision_verify"]
