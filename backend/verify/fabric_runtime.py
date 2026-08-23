"""Runtime verification of the Capability Fabric over real HTTP.

The differential harness proves the fabric's logic matches the reference.
This proves the *running service* behaves that way: real process, real
HTTP, real files on disk, and a real restart in the middle.

Usage:  uv run python -m verify.fabric_runtime
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

PORT = 4322  # not the shadow default, so a running dev server is untouched
failed = False


def check(name: str, ok: bool, extra: str = "") -> None:
    global failed
    print(f"{'PASS' if ok else 'FAIL'}  {name}{f' — {extra}' if extra else ''}")
    if not ok:
        failed = True


def _wait(port: int, timeout: float = 25.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


class Service:
    """The real backend, started as a real process."""

    def __init__(self, home: Path) -> None:
        self._home = home
        self._proc: subprocess.Popen | None = None

    def __enter__(self) -> httpx.Client:
        env = {**os.environ, "AURA_PY_HOME": str(self._home), "AURA_PY_PORT": str(PORT)}
        self._proc = subprocess.Popen(
            [sys.executable, "-m", "aura_backend"],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        if not _wait(PORT):
            raise SystemExit("the service did not start; cannot claim runtime verification")
        return httpx.Client(base_url=f"http://127.0.0.1:{PORT}", timeout=20)

    def __exit__(self, *_exc) -> None:
        if self._proc is not None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait(timeout=10)
        # The port must be free again for the next start.
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", PORT), timeout=0.3):
                    time.sleep(0.2)
            except OSError:
                return


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="fabric-runtime-") as tmp:
        home = Path(tmp)

        # ── 1. the manifest is served, and nothing claims an executor ──
        with Service(home) as c:
            r = c.get("/fabric/capabilities").json()
            check("1. the whole manifest is served", len(r["capabilities"]) == 33,
                  f"{len(r['capabilities'])} capabilities")
            check("1b. no capability claims an executor it does not have",
                  r["supportedCount"] == 0, f"supportedCount={r['supportedCount']}")
            check("1c. the shipped policy is reported",
                  r["policy"]["byRisk"]["high"] == "require-approval",
                  json.dumps(r["policy"]["byRisk"]))

            # ── 2. a node-backed capability is denied, not silently run ──
            denied = c.post("/fabric/invoke", json={
                "capabilityId": "git.status",
                "context": {"projectId": "p", "actorKind": "agent", "actorId": "t"},
            })
            body = denied.json()
            check("2. a denial is HTTP 200 with a governance outcome",
                  denied.status_code == 200 and body["outcome"] == "denied",
                  f"{denied.status_code} {body['outcome']}")
            check("2b. the denial names why", body["policy"]["rule"] == "no-provider",
                  body["policy"]["rule"])

            # ── 3. a floor holds against a permissive policy over HTTP ──
            c.post("/fabric/policy", json={
                "byRisk": {"low": "auto-execute", "medium": "auto-execute",
                           "high": "auto-execute"},
                "allowAutonomous": True,
            })
            parked = c.post("/fabric/invoke", json={
                "capabilityId": "provider.connect",
                "input": {"providerId": "groq", "apiKey": "sk-live-do-not-log"},
                "context": {"projectId": "p", "actorKind": "human", "actorId": "u",
                            "missionId": "m1", "taskId": "t1"},
            }).json()
            check("3. a floor survives a permissive policy set over HTTP",
                  parked["outcome"] == "awaiting-approval"
                  and parked["policy"]["rule"] == "authorization-floor",
                  f"{parked['outcome']} / {parked['policy']['rule']}")

            # ── 4. the secret never appears anywhere it is served ────────
            approvals = c.get("/fabric/approvals").text
            audit = c.get("/fabric/audit").text
            check("4. the API key is absent from the approvals surface",
                  "sk-live-do-not-log" not in approvals)
            check("4b. the API key is absent from the audit surface",
                  "sk-live-do-not-log" not in audit)
            check("4c. and absent from the file on disk",
                  "sk-live-do-not-log" not in (home / "fabric-audit.jsonl").read_text())
            check("4d. redaction is visible rather than silent",
                  "<redacted>" in approvals, "")

            approval_id = json.loads(approvals)["approvals"][0]["id"]

            # ── 5. decide semantics ────────────────────────────────────
            missing = c.post("/fabric/approvals/apr-nope/decide", json={"granted": True})
            check("5. an unknown approval is 404", missing.status_code == 404,
                  str(missing.status_code))
            first = c.post(f"/fabric/approvals/{approval_id}/decide",
                           json={"granted": True, "decidedBy": "user"})
            check("5b. deciding a pending request succeeds", first.status_code == 200,
                  str(first.status_code))
            second = c.post(f"/fabric/approvals/{approval_id}/decide",
                            json={"granted": True, "decidedBy": "user"})
            check("5c. deciding it again is 409, not a second authorization",
                  second.status_code == 409, str(second.status_code))

            before_audit = len(c.get("/fabric/audit").json()["audit"])

        # ── 6. restart: the trail survives, the spent grant does not ──
        with Service(home) as c:
            after = c.get("/fabric/audit").json()["audit"]
            check("6. the audit trail outlives the process",
                  len(after) >= before_audit, f"{before_audit} -> {len(after)}")
            check("6b. the human decision is in the restored trail",
                  any(r.get("approvalDecision") == "granted" for r in after))
            pending = c.get("/fabric/approvals").json()["approvals"]
            check("6c. a decided request does not come back as pending",
                  pending == [], f"{len(pending)} pending")

            # ── 7. the persisted policy outlives the process too ────────
            policy = c.get("/fabric/capabilities").json()["policy"]
            check("7. the operator's policy was persisted",
                  policy["byRisk"]["high"] == "auto-execute",
                  json.dumps(policy["byRisk"]))
            still_gated = c.post("/fabric/invoke", json={
                "capabilityId": "provider.connect",
                "input": {"providerId": "groq", "apiKey": "k"},
                "context": {"projectId": "p", "actorKind": "human", "actorId": "u"},
            }).json()
            check("7b. and the floor still holds after the restart",
                  still_gated["outcome"] == "awaiting-approval"
                  and still_gated["policy"]["rule"] == "authorization-floor",
                  f"{still_gated['outcome']} / {still_gated['policy']['rule']}")

            # ── 8. an unknown capability is refused by name ─────────────
            unknown = c.post("/fabric/invoke", json={
                "capabilityId": "shell.run_anything",
                "input": {"command": "rm -rf /"},
                "context": {"projectId": "p"},
            }).json()
            check("8. an invented capability is refused",
                  unknown["outcome"] == "failed"
                  and unknown["policy"]["rule"] == "unknown-capability",
                  unknown["policy"]["rule"])
            no_id = c.post("/fabric/invoke", json={"input": {}})
            check("8b. a request with no capabilityId is a 400",
                  no_id.status_code == 400, str(no_id.status_code))

            # ── 9. an unknown policy key cannot become configuration ────
            c.post("/fabric/policy", json={"allowAutonomous": False,
                                           "evilKey": {"agent.delegate": "auto-execute"}})
            reported = c.get("/fabric/capabilities").json()["policy"]
            check("9. an unknown policy key is dropped, not merged",
                  "evilKey" not in reported and reported["allowAutonomous"] is False,
                  json.dumps(list(reported)))

    print("\nRESULT: FAILED" if failed else "\nRESULT: ALL CHECKS PASSED")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
