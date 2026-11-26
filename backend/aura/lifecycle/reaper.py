"""Remove workers left behind by an AURA process that is gone (issue #112).

One rule, used at startup and before every sandboxed dispatch:

* A sandbox **container** is an orphan only if it carries this home's label
  and its owner instance's lock is ``free`` (the owner is dead). A legacy
  container (no instance label) is an orphan only if its owner pid is
  confirmed ``dead``.
* A **host worker** in the registry is an orphan only if its owner
  instance's lock is ``free``; it is terminated only if the process with
  that pid still has the recorded start identity (a reused pid is never
  signalled, its stale entry is dropped).
* Anything else — this instance's own workers, another live instance's
  workers, another home's containers, unreadable labels or entries, a
  lock or process state that cannot be established — is left untouched
  and reported.

Nothing at all is done unless this process's own instance lock is verified.
"""

from __future__ import annotations

import os
import signal
import time
from pathlib import Path
from typing import Any, Callable

from . import registry
from .instance import FREE, HELD, LABEL_HOME, LABEL_INSTANCE, Instance, home_tag, instance_state, instances_dir
from .procident import ALIVE, DEAD, pid_state, pidfd_exited, pidfd_open, pidfd_send_signal, start_identity

#: A lock file younger than this is never cleaned up (see the start-up race note).
LOCK_CLEANUP_MIN_AGE_S = 120.0
LABEL_RUN = "aura.sandbox"
LABEL_OWNER = "aura.sandbox.owner"
NAME_PREFIX = "aura-run-"


def _docker_list() -> list[dict] | None:
    """All AURA sandbox containers, or None when Docker cannot be asked."""
    from ..governance.container import _docker

    fmt = "\t".join(["{{.Names}}", '{{.Label "' + LABEL_INSTANCE + '"}}',
                     '{{.Label "' + LABEL_HOME + '"}}', '{{.Label "' + LABEL_OWNER + '"}}',
                     "{{.State}}"])
    try:
        out = _docker(["ps", "--all", "--filter", f"label={LABEL_RUN}=run", "--format", fmt])
    except Exception:  # noqa: BLE001
        return None
    if getattr(out, "exit_code", 1) != 0:
        return None
    rows = []
    for line in (out.stdout or "").splitlines():
        if not line.strip():
            continue
        name, inst, home, owner, state = (line.split("\t") + [""] * 5)[:5]
        rows.append({"name": name, "instance": inst, "home": home, "owner": owner, "state": state})
    return rows


def _docker_remove(name: str) -> bool:
    from ..governance.container import _docker

    if not name.startswith(NAME_PREFIX):
        return False
    try:
        return getattr(_docker(["rm", "--force", name]), "exit_code", 1) == 0
    except Exception:  # noqa: BLE001
        return False


def _terminate_tree(pid: int, pgid: int | None, expected_identity: str) -> str:
    """Stop a verified orphan worker and its children. Returns what happened.

    Linux (kernel >= 5.3): a pidfd is opened FIRST and the start identity is
    verified AFTER, so the pidfd provably names the verified process; the
    leader is then signalled through it and can never be confused with a
    process that later reuses the pid. The process GROUP is signalled with
    killpg(pgid) only while the pidfd shows the leader alive (the leader
    keeps that number in use). Remaining limitation: the leader can exit
    between that check and killpg; if it was the group's last member, the
    number could in principle be reused in that gap. macOS and Windows have
    no pidfd here and keep a check-then-signal gap (see _terminate_by_pid).
    """
    fd = None
    try:
        fd = pidfd_open(pid)
    except ProcessLookupError:
        return "terminated"  # already gone
    if fd is None:
        return _terminate_by_pid(pid, pgid, expected_identity)
    try:
        if start_identity(pid) != expected_identity or pidfd_exited(fd):
            return "identity-changed"  # the pidfd is not bound to the recorded process
        group = pgid is not None and pgid == pid and _getpgid(pid) == pid
        for sig, wait_s in ((signal.SIGTERM, 3.0), (signal.SIGKILL, 3.0)):
            if pidfd_exited(fd):
                return "terminated"
            try:
                pidfd_send_signal(fd, sig)  # exactly this process
                if group and not pidfd_exited(fd):
                    os.killpg(pid, sig)  # its children; leader alive => pgid in use
            except ProcessLookupError:
                return "terminated"
            except PermissionError:
                return "terminate-not-permitted"
            if pidfd_exited(fd, wait_s):
                return "terminated"
        return "terminated" if pidfd_exited(fd) else "terminate-failed"
    finally:
        os.close(fd)


def _terminate_by_pid(pid: int, pgid: int | None, expected_identity: str) -> str:
    """Fallback without a pidfd (macOS, Windows, old Linux kernels): the identity
    is re-checked immediately before signalling, leaving a small gap in which
    the pid could, in principle, be reused."""
    if start_identity(pid) != expected_identity:
        return "identity-changed"  # re-checked right before signalling
    if os.name == "nt":
        from ..environment.procexec import run_argv

        r = run_argv(["taskkill", "/PID", str(pid), "/T", "/F"], timeout_ms=30_000)
        return "terminated" if r.exit_code == 0 or pid_state(pid) == DEAD else "terminate-failed"
    group = pgid is not None and pgid == pid and _getpgid(pid) == pid
    for sig, wait_s in ((signal.SIGTERM, 3.0), (signal.SIGKILL, 3.0)):
        try:
            os.killpg(pid, sig) if group else os.kill(pid, sig)
        except ProcessLookupError:
            return "terminated"
        except PermissionError:
            return "terminate-not-permitted"
        end = time.monotonic() + wait_s
        while time.monotonic() < end:
            if pid_state(pid) == DEAD:
                return "terminated"
            time.sleep(0.1)
    return "terminated" if pid_state(pid) == DEAD else "terminate-failed"


def _getpgid(pid: int) -> int | None:
    try:
        return os.getpgid(pid)
    except OSError:
        return None


def reap_orphans(home: str | Path, me: Instance | None, *, containers: bool = True,
                 workers: bool = True,
                 docker_list: Callable[[], list[dict] | None] = _docker_list,
                 docker_remove: Callable[[str], bool] = _docker_remove,
                 terminate: Callable[[int, int | None, str], str] = _terminate_tree) -> dict[str, Any]:
    """Reap orphans of dead instances. Returns a report; never raises."""
    report: dict[str, Any] = {"removedContainers": [], "keptContainers": [],
                              "terminatedWorkers": [], "keptWorkers": [],
                              "droppedEntries": [], "deferred": [], "cleanedInstances": []}
    if me is None or not me.verified:
        report["skipped"] = "this process's instance lock is not held and verified; nothing was touched"
        return report
    my_tag = home_tag(home)
    states: dict[str, str] = {}

    def owner_state(iid: str) -> str:
        if iid not in states:
            states[iid] = instance_state(home, iid)
        return states[iid]

    rows: list[dict] | None = None
    if containers:
        rows = docker_list()
        if rows is None:
            report["deferred"].append("containers: Docker could not be queried; cleanup deferred")
        else:
            for row in rows:
                name = row.get("name", "")
                keep = None
                if not name.startswith(NAME_PREFIX):
                    keep = "not an AURA run container"
                elif row.get("instance"):
                    if row["instance"] == me.id:
                        keep = "owned by this instance"
                    elif row.get("home") != my_tag:
                        keep = "belongs to another AURA home"
                    else:
                        st = owner_state(row["instance"])
                        if st != FREE:
                            keep = ("owner instance is alive" if st == HELD
                                    else f"owner instance state is {st}; ownership cannot be established")
                else:
                    owner = row.get("owner", "")
                    pid = int(owner) if owner.isdigit() else None
                    if pid == os.getpid():
                        keep = "legacy container owned by this process"
                    elif pid is None:
                        keep = "legacy container without a readable owner"
                    else:
                        ps = pid_state(pid)
                        if ps != DEAD:
                            keep = ("legacy owner pid is alive (possibly reused)" if ps == ALIVE
                                    else "legacy owner pid state unknown")
                if keep:
                    report["keptContainers"].append({"name": name, "reason": keep})
                elif docker_remove(name):
                    report["removedContainers"].append(name)
                else:
                    report["keptContainers"].append({"name": name, "reason": "removal failed"})

    if workers:
        for rec in registry.entries(home):
            eid = rec.get("id")
            if rec.get("_unreadable"):
                report["keptWorkers"].append({"entry": eid, "reason": "unreadable registry entry"})
                continue
            iid, pid, ident = rec.get("instance", ""), rec.get("pid"), rec.get("startIdentity")
            if iid == me.id:
                continue  # this instance's own live worker
            st = owner_state(iid)
            if st != FREE:
                report["keptWorkers"].append({"entry": eid, "pid": pid, "reason": (
                    "owner instance is alive" if st == HELD
                    else f"owner instance state is {st}; ownership cannot be established")})
                continue
            ps = pid_state(pid)
            if ps == DEAD:
                registry.unregister(home, eid)
                report["droppedEntries"].append({"entry": eid, "pid": pid, "reason": "process already gone"})
                continue
            if ps != ALIVE or not ident:
                report["keptWorkers"].append({"entry": eid, "pid": pid,
                                              "reason": "process state or identity unknown"})
                continue
            now_ident = start_identity(pid)
            if now_ident is None:
                report["keptWorkers"].append({"entry": eid, "pid": pid, "reason": "identity cannot be read"})
                continue
            if now_ident != ident:
                registry.unregister(home, eid)
                report["droppedEntries"].append({"entry": eid, "pid": pid,
                                                 "reason": "pid now belongs to a different process; not signalled"})
                continue
            outcome = terminate(pid, rec.get("pgid"), ident)
            if outcome in ("terminated", "identity-changed"):
                registry.unregister(home, eid)
                (report["terminatedWorkers"] if outcome == "terminated"
                 else report["droppedEntries"]).append({"entry": eid, "pid": pid, "outcome": outcome})
            else:
                report["keptWorkers"].append({"entry": eid, "pid": pid, "reason": outcome})

    # Lock files of dead instances that no longer own anything are removed —
    # only when both containers and workers were examined and Docker answered,
    # so a lock is never forgotten while something might still refer to it.
    d = instances_dir(home)
    if containers and workers and rows is not None and d.is_dir():
        removed = set(report["removedContainers"])
        still_owned = {r.get("instance") for r in registry.entries(home)}
        still_owned |= {r.get("instance") for r in rows if r.get("name") not in removed}
        for lock in d.glob("*.lock"):
            iid = lock.stem
            if iid == me.id or iid in still_owned or owner_state(iid) != FREE:
                continue
            # A starting instance creates its lock file and locks it a moment
            # later; in that gap the file probes "free". Never delete a young
            # lock file, and re-probe right before deleting (not the cached
            # state), so a live instance's lock is never removed.
            try:
                age = time.time() - lock.stat().st_mtime
            except OSError:
                continue
            if age < LOCK_CLEANUP_MIN_AGE_S or instance_state(home, iid) != FREE:
                continue
            for f in (lock, d / f"{iid}.json"):
                try:
                    f.unlink()
                except OSError:
                    pass
            report["cleanedInstances"].append(iid)
    return report
