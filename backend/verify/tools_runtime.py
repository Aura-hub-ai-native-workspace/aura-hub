"""Runtime verification of the tool lifecycle over real HTTP.

Walks the lifecycle the brief names — DISCOVER, DETECT, then the INSTALL
gate — against a real running service on a real machine, and checks that
the security boundary holds at the transport edge.

INSTALL is exercised up to the point of refusal only. Actually installing
software on the developer's machine is not something a verification script
gets to do uninvited, so the checks here prove that an install is refused,
gated or handed over — never that one was performed.

Usage:  uv run python -m verify.tools_runtime
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

PORT = 4324
failed = False


def check(name: str, ok: bool, extra: str = "") -> None:
    global failed
    print(f"{'PASS' if ok else 'FAIL'}  {name}{f' — {extra}' if extra else ''}")
    if not ok:
        failed = True


def _wait(port: int, timeout: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="tools-runtime-") as tmp:
        env = {**os.environ, "AURA_PY_HOME": tmp, "AURA_PY_PORT": str(PORT)}
        proc = subprocess.Popen(
            [sys.executable, "-m", "aura_backend"],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        try:
            if not _wait(PORT):
                raise SystemExit("the service did not start")
            c = httpx.Client(base_url=f"http://127.0.0.1:{PORT}", timeout=120)

            # ── DISCOVER ────────────────────────────────────────────────
            catalog = c.get("/environment/catalog").json()["catalog"]
            check("1. the catalogue is served", len(catalog) == 105, f"{len(catalog)} entries")
            check("1b. entries carry what routing needs",
                  all({"id", "name", "capabilities", "transport"} <= set(e) for e in catalog))

            # ── DETECT ──────────────────────────────────────────────────
            scan = c.post("/environment/scan", json={"refresh": True}).json()
            check("2. a real scan finds real tools", scan["found"] > 0,
                  f"{scan['found']} of {len(scan['results'])} present")
            git = scan["results"].get("git", {})
            check("2b. and reports a genuine version",
                  git.get("present") is True and git.get("version", "")[0:1].isdigit(),
                  f"git {git.get('version')}")
            check("2c. an absent tool is reported absent, never faked",
                  all(not (r["present"] is False and r.get("version"))
                      for r in scan["results"].values()),
                  "no absent node claims a version")
            check("2d. the scan feeds the capability projection",
                  "source-control" in scan["providedCapabilities"])

            # ── the boundary: a probe is a NAME, never a command ────────
            for hostile in ("git; rm -rf /", "../../bin/sh", "/bin/sh"):
                probed = c.post("/environment/probe", json={"id": hostile}).json()
                check(f"3. a hostile node id runs nothing: {hostile!r}",
                      probed["result"]["present"] is False
                      and probed["result"]["detail"] == "That node is not in the catalog.")
            bad = c.post("/environment/probe", json={})
            check("3b. probing with no id is a 400", bad.status_code == 400, str(bad.status_code))

            # ── routing now works, because the scan populated it ────────
            caps = c.get("/fabric/capabilities").json()
            check("4. the scan made node-backed capabilities routable",
                  "source-control" in caps["providedNodeCapabilities"])
            status = c.post("/fabric/invoke", json={
                "capabilityId": "git.status",
                "context": {"projectId": "p", "actorKind": "agent", "actorId": "t"},
            }).json()
            # No project registry yet (Phase 3), so this reaches the
            # executor and fails there — but it is no longer DENIED for
            # want of a provider, which is what routing was blocking on.
            check("4b. git.status now routes instead of being denied",
                  status["policy"]["rule"] != "no-provider",
                  f"{status['outcome']} / {status['policy']['rule']}")

            # ── a targeted scan must not erase everything else ──────────
            before = set(c.get("/fabric/capabilities").json()["providedNodeCapabilities"])
            c.post("/environment/scan", json={"ids": ["git"], "refresh": True})
            after = set(c.get("/fabric/capabilities").json()["providedNodeCapabilities"])
            check("5. a targeted scan merges rather than erasing the rest",
                  after == before, f"{len(before)} -> {len(after)} capabilities")

            # ── INSTALL: refused, gated or handed over. Never performed. ─
            unknown = c.post("/fabric/invoke", json={
                "capabilityId": "system.install",
                "input": {"nodeId": "definitely-not-a-node"},
                "approvedCapabilities": ["system.install"],
                "context": {"projectId": "p", "actorKind": "human", "actorId": "u"},
            }).json()
            check("6. installing an uncatalogued node is refused",
                  unknown["outcome"] == "failed" and "catalogue" in unknown["detail"],
                  unknown["detail"][:70])

            gated = c.post("/fabric/invoke", json={
                "capabilityId": "system.install",
                "input": {"nodeId": "pnpm"},
                "context": {"projectId": "p", "actorKind": "human", "actorId": "u"},
            }).json()
            check("6b. an install with no grant is gated by the system floor",
                  gated["outcome"] == "awaiting-approval"
                  and gated["policy"]["rule"] == "system-floor"
                  and gated["attempts"] == 0,
                  f"{gated['outcome']} / {gated['policy']['rule']}")

            root_tier = next(
                (e for e in catalog
                 if e.get("install", {}).get("privilege") == "root"), None
            )
            if root_tier:
                guided = c.post("/fabric/invoke", json={
                    "capabilityId": "system.install",
                    "input": {"nodeId": root_tier["id"]},
                    "approvedCapabilities": ["system.install"],
                    "context": {"projectId": "p", "actorKind": "human", "actorId": "u"},
                }).json()
                out = guided.get("output") or {}
                check("6c. a root-tier install runs nothing and hands over a command",
                      out.get("installOutcome") == "guided"
                      and out.get("requiresUserAction") is True
                      and bool(out.get("command")),
                      f"{out.get('installOutcome')}: {str(out.get('command'))[:50]}")
                # Verification is SKIPPED, not failed: the Fabric only runs
                # a check when the executor reported success, and a guided
                # handoff reports `ok: false` because nothing ran. So the
                # honest assertions are that it did not pass, and that the
                # outcome is not `succeeded`. (The reference behaves the
                # same way — its executor's `guided` verify branch is
                # unreachable for exactly this reason.)
                check("6d. a guided install never reads as verified or succeeded",
                      guided["verification"]["passed"] is not True
                      and guided["outcome"] != "succeeded",
                      f"outcome={guided['outcome']} passed={guided['verification']['passed']}")

            # ── the audit records the tool work ─────────────────────────
            audit = c.get("/fabric/audit").json()["audit"]
            check("7. every governed call reached the trail", len(audit) >= 4, f"{len(audit)}")
            check("7b. a gated install is recorded with no execution",
                  any(r["capabilityId"] == "system.install"
                      and r["outcome"] == "awaiting-approval"
                      and not r.get("executedNodeId")
                      for r in audit))
            check("7c. no probe command leaked into the trail",
                  not any("rm -rf" in json.dumps(r) for r in audit))
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)

    print("\nRESULT: FAILED" if failed else "\nRESULT: ALL CHECKS PASSED")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
