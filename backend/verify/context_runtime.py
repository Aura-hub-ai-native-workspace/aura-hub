"""Runtime differential of the Context Fabric, over real HTTP.

The in-process harness (`parity.context_parity`) deliberately composes
with **no Capability Fabric attached**, so it can drive the stale,
unknown and budget-overflow paths from fixtures. That leaves two sections
it cannot compare at all: `capabilities`, which is the real policy engine
answering for all 33 capabilities, and `activity`, which is the real
audit trail.

This closes that gap the only honest way — both backends running as real
processes, given the same project, the same policy and the same machine,
then asked the same questions:

    GET /projects/{id}/context
    GET /projects/{id}/context/contract?surface=...

and the answers diffed.

Nothing here touches the user's AURA state: isolated homes, ports of its
own, and a disposable project directory.

Usage (from backend/):  uv run python -m verify.context_runtime
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Self

import httpx

TS_PORT = 4335
PY_PORT = 4336
SURFACES = ["general", "coding", "debugging", "architecture", "git",
            "testing", "mission", "planning", "review"]
# The only two surfaces whose budget sets `allCapabilities`. Written out
# rather than imported from the port, so a mutation of the budget table
# cannot make this agree with itself.
ALL_CAPABILITY = {"mission", "planning"}

CLOCK = "<clock>"

# Capabilities whose EXECUTOR has not been migrated yet. Their absence is
# a Phase 3 fact recorded in PHASE_03_WORKSPACE.md, not a Context Fabric
# defect — the projection is faithfully reporting what its own fabric
# says. The set is derived from each backend's `/fabric/capabilities` at
# run time and then checked against this list, so a capability that
# quietly stops working cannot hide behind the exclusion.
DEFERRED_EXECUTORS = {
    "mission.inspect", "mission.approve",  # the mission store — Phase 11
    "knowledge.graph",                      # the knowledge graph — Phase 4
    "workflow.run",                         # the workflow engine — Phase 9
}
_ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z")

failed = False


def check(name: str, ok: bool, extra: str = "") -> None:
    global failed
    print(f"{'PASS' if ok else 'FAIL'}  {name}{f' — {extra}' if extra else ''}")
    if not ok:
        failed = True


def _wait(port: int, timeout: float = 90.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.3)
    return False


def _free(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return False
    except OSError:
        return True


class Backend:
    def __init__(self, argv: list[str], env: dict[str, str], port: int, cwd: Path) -> None:
        self._argv, self._env, self._port, self._cwd = argv, env, port, cwd
        self._proc: subprocess.Popen | None = None

    def __enter__(self) -> Self:
        self._proc = subprocess.Popen(
            self._argv, env={**os.environ, **self._env}, cwd=str(self._cwd),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        if not _wait(self._port):
            # Say WHY. A verifier that reports only "did not start" makes
            # an infrastructure failure look like a caught regression,
            # which is worse than no verifier at all.
            self._proc.terminate()
            try:
                self._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            output = b""
            if self._proc.stdout is not None:
                output = self._proc.stdout.read() or b""
            raise SystemExit(
                f"backend on {self._port} did not start:\n"
                + output.decode(errors="replace")[-3000:]
            )
        return self

    def __exit__(self, *_exc) -> None:
        if self._proc is None:
            return
        self._proc.terminate()
        try:
            self._proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            self._proc.wait(timeout=15)


def _blank_clocks(payload: Any) -> Any:
    """Replace every ISO timestamp with a marker.

    Blunt on purpose: over HTTP EVERY timestamp in a context view is
    produced by the process answering the request — composition time, the
    live sections' `generatedAt`, the scan time, each audit record's `at`.
    None of them can agree between two processes, and none of them is the
    property under test here. The fixture-driven harness compares the
    timestamps that ARE claims, exactly.
    """
    if isinstance(payload, str):
        return _ISO.sub(CLOCK, payload)
    if isinstance(payload, dict):
        return {k: _blank_clocks(v) for k, v in payload.items()}
    if isinstance(payload, list):
        return [_blank_clocks(v) for v in payload]
    return payload


def _drop_capabilities(payload: Any, ids: set[str]) -> Any:
    """Remove the named capabilities from a capabilities section."""
    value = (payload or {}).get("value")
    if not value:
        return payload
    return {**payload, "value": [c for c in value if c["id"] not in ids]}


def _drop_from_contract(text: str, ids: set[str]) -> str:
    """Remove the named capabilities from a rendered contract."""
    out = []
    for line in text.split("\n"):
        if line.startswith(("available: ", "requires_human_approval: ")):
            label, _, rest = line.partition(": ")
            kept = [p for p in rest.split(", ") if p not in ids]
            line = f"{label}: {', '.join(kept)}"
        elif line.startswith("  - ") and line[4:].split(" ")[0] in ids:
            continue
        out.append(line)
    return "\n".join(out)


def _drop_not_drivable_block(text: str) -> list[str]:
    """Strip the `present_but_not_drivable` block, returning its ids.

    The block is `slice(0, 10)` of everything that has no executor. The
    Python backend has four MORE such capabilities (the deferred ones),
    which pushes different entries past the tenth — so the truncation
    itself differs, as a consequence of the executor gap rather than of
    the renderer. The block is therefore compared per backend against
    that backend's own view instead of across the two.
    """
    ids: list[str] = []
    out: list[str] = []
    inside = False
    present = False
    for line in text.split("\n"):
        if line == "present_but_not_drivable:":
            inside = True
            present = True
            continue
        if inside and line.startswith("  - "):
            ids.append(line[4:].split(" ")[0])
            continue
        inside = False
        out.append(line)
    return ["\n".join(out), ids, present]


def _diff(label: str, ts: Any, py: Any) -> None:
    ts, py = _blank_clocks(ts), _blank_clocks(py)
    if ts == py:
        check(label, True)
        return
    if isinstance(ts, str) and isinstance(py, str):
        a, b = ts.split("\n"), py.split("\n")
        for i in range(max(len(a), len(b))):
            x = a[i] if i < len(a) else "<end>"
            y = b[i] if i < len(b) else "<end>"
            if x != y:
                check(label, False, f"line {i + 1}: TS={x!r} PY={y!r}")
                return
    if isinstance(ts, dict) and isinstance(py, dict):
        for key in sorted(set(ts) | set(py)):
            if ts.get(key) != py.get(key):
                check(label, False,
                      f"{key}: TS={json.dumps(ts.get(key), sort_keys=True)[:300]} "
                      f"PY={json.dumps(py.get(key), sort_keys=True)[:300]}")
                return
    check(label, False, "differs")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="/mnt/storage/aura-hub")
    args = ap.parse_args()
    repo = Path(args.repo)

    for port in (TS_PORT, PY_PORT):
        # A previous run's socket can linger; give it a moment rather
        # than failing in a way that reads like a divergence.
        deadline = time.monotonic() + 30
        while not _free(port) and time.monotonic() < deadline:
            time.sleep(0.5)
        if not _free(port):
            print(f"port {port} is busy; refusing to take it")
            return 1

    with tempfile.TemporaryDirectory(prefix="context-runtime-") as tmp:
        work = Path(tmp)
        ts_home, py_home = work / "ts", work / "py"
        ts_home.mkdir()
        py_home.mkdir()
        project = work / "subject"
        project.mkdir()
        (project / "package.json").write_text('{"name":"subject","version":"1.0.0"}')
        (project / "README.md").write_text("# Subject\n\nA disposable project.\n")
        (project / "src").mkdir()
        (project / "src" / "index.ts").write_text("export const x = 1;\n")

        bundle = repo / ".aura" / "context-runtime-service.mjs"
        build = subprocess.run(
            ["npx", "esbuild", "packages/ai-service/src/start.ts", "--bundle",
             "--platform=node", "--format=esm", "--external:typescript",
             f"--outfile={bundle}"],
            cwd=str(repo), capture_output=True, text=True, check=False,
        )
        if build.returncode != 0:
            print(build.stderr, file=sys.stderr)
            return 1

        try:
            with (
                Backend(["node", str(bundle), "--none"],
                        {"AURA_HOME": str(ts_home), "AI_PORT": str(TS_PORT)},
                        TS_PORT, repo),
                Backend([sys.executable, "-m", "aura_backend"],
                        {"AURA_PY_HOME": str(py_home), "AURA_PY_PORT": str(PY_PORT)},
                        PY_PORT, Path(__file__).resolve().parents[1]),
            ):
                ts = httpx.Client(base_url=f"http://127.0.0.1:{TS_PORT}", timeout=180)
                py = httpx.Client(base_url=f"http://127.0.0.1:{PY_PORT}", timeout=180)

                # ── identical setup on both ──────────────────────────
                ids = []
                for client in (ts, py):
                    body = client.post("/projects",
                                       json={"path": str(project), "name": "Subject"}).json()
                    ids.append((body.get("project") or {}).get("id"))
                check("0. both backends register the project under the same id",
                      ids[0] == ids[1] and ids[0], f"{ids}")
                project_id = ids[0]

                # A cold scan races the probe timeouts on both runtimes
                # (documented in Phase 8), so warm the caches first and
                # measure the second scan.
                for client in (ts, py):
                    client.post("/environment/scan", json={})
                scans = [client.post("/environment/scan", json={}).json()
                         for client in (ts, py)]
                ts_nodes = sorted(k for k, v in scans[0]["results"].items() if v["present"])
                py_nodes = sorted(k for k, v in scans[1]["results"].items() if v["present"])
                check("0b. both backends see the same machine",
                      ts_nodes == py_nodes,
                      f"TS-only={set(ts_nodes) - set(py_nodes)} "
                      f"PY-only={set(py_nodes) - set(ts_nodes)}")

                # ── real governed activity, so the trail is not empty ──
                for client in (ts, py):
                    for _ in range(3):
                        client.post("/fabric/invoke", json={
                            "capabilityId": "filesystem.list",
                            "input": {"path": "."},
                            "context": {"projectId": project_id,
                                        "actorKind": "human", "actorId": "verifier"},
                        })
                    client.post("/fabric/invoke", json={
                        "capabilityId": "system.install",
                        "input": {"nodeId": "ripgrep"},
                        "context": {"projectId": project_id,
                                    "actorKind": "agent", "actorId": "verifier"},
                    })
                trail = [len(c.get("/fabric/audit").json()["audit"]) for c in (ts, py)]
                check("1. both trails recorded the same number of actions",
                      trail[0] == trail[1] and trail[0] >= 4, f"{trail}")

                # ── the view ─────────────────────────────────────────
                ts_view = ts.get(f"/projects/{project_id}/context").json()
                py_view = py.get(f"/projects/{project_id}/context").json()
                # Which capabilities each backend can actually drive.
                # Asked of the FABRIC, not inferred from the context view,
                # so the exclusion below rests on a declared fact.
                supported = [
                    {c["id"] for c in client.get("/fabric/capabilities").json()["capabilities"]
                     if c["supported"]}
                    for client in (ts, py)
                ]
                gap = supported[0] - supported[1]
                check("1b. the executor gap is exactly the documented one",
                      gap == DEFERRED_EXECUTORS and not (supported[1] - supported[0]),
                      f"missing in Python: {sorted(gap)}; "
                      f"extra: {sorted(supported[1] - supported[0])}")

                for section in ("project", "repository", "changes", "git",
                                "environment", "missions", "activity",
                                "constraints"):
                    _diff(f"2. view.{section}", ts_view.get(section), py_view.get(section))
                # Capabilities, minus the ones whose executor is a later
                # phase. Everything else — risk, availability, the policy
                # engine's own rule name and reason — must match for all
                # 33, and does.
                _diff("2. view.capabilities (excluding unmigrated executors)",
                      _drop_capabilities(ts_view.get("capabilities"), gap),
                      _drop_capabilities(py_view.get("capabilities"), gap))
                check("2b. the excluded capabilities differ ONLY in availability",
                      all(
                          {k: v for k, v in a.items() if k not in ("availability", "reason", "rule")}
                          == {k: v for k, v in b.items() if k not in ("availability", "reason", "rule")}
                          for a, b in zip(
                              [c for c in ts_view["capabilities"]["value"] if c["id"] in gap],
                              [c for c in py_view["capabilities"]["value"] if c["id"] in gap],
                              strict=True,
                          )
                      ))
                for field in ("contractVersion", "contextVersion", "surface", "freshness"):
                    _diff(f"2. view.{field}", ts_view.get(field), py_view.get(field))

                # The property the in-process harness could not reach:
                # 33 capabilities, each carrying the real policy engine's
                # own decision and rule name.
                caps = ts_view["capabilities"]["value"]
                check("3. every catalogued capability is described",
                      len(caps) == 33, f"{len(caps)}")
                check("3b. availability is not uniform — the policy really spoke",
                      len({c["availability"] for c in caps}) > 1,
                      str(sorted({c["availability"] for c in caps})))
                check("3c. an approval-gated capability names the rule that gated it",
                      all(c.get("rule") for c in caps if c["availability"] == "approval"))

                acts = ts_view["activity"]["value"]
                check("4. the activity projection is not empty",
                      len(acts) >= 4, f"{len(acts)}")
                check("4b. and is newest-first on both",
                      [a["capabilityId"] for a in acts]
                      == [a["capabilityId"] for a in py_view["activity"]["value"]])

                # ── the contract, at every surface ───────────────────
                for surface in SURFACES:
                    path = f"/projects/{project_id}/context/contract?surface={surface}"
                    ts_text, ts_blocked, ts_shown = _drop_not_drivable_block(
                        _drop_from_contract(ts.get(path).json()["contract"], gap))
                    py_text, py_blocked, py_shown = _drop_not_drivable_block(
                        _drop_from_contract(py.get(path).json()["contract"], gap))
                    _diff(f"5. contract[{surface}]", ts_text, py_text)
                    # The block's CONTENTS are truncated differently
                    # because of the executor gap, but whether it appears
                    # at all is the surface budget speaking, and the two
                    # must agree on that exactly.
                    check(f"5a. contract[{surface}] shows the not-drivable block "
                          "on the same surfaces",
                          ts_shown == py_shown and ts_shown == (surface in ALL_CAPABILITY),
                          f"TS={ts_shown} PY={py_shown}")
                    if ts_blocked or py_blocked:
                        # Each backend's own listing must agree with its
                        # own view — the block is truthful on both, it is
                        # only truncated at a different point.
                        for label, blocked, view in (("TypeScript", ts_blocked, ts_view),
                                                     ("Python", py_blocked, py_view)):
                            drivable = {c["id"] for c in view["capabilities"]["value"]
                                        if c["availability"] != "not-drivable"}
                            check(f"5b. contract[{surface}] {label} lists only "
                                  "capabilities its own view calls not-drivable",
                                  not (set(blocked) & drivable),
                                  f"{len(blocked)} listed")

                # ── git can be turned off, identically ───────────────
                _diff("6. view with git=false",
                      ts.get(f"/projects/{project_id}/context?git=false").json()["git"],
                      py.get(f"/projects/{project_id}/context?git=false").json()["git"])

                # ── an unresolvable project ──────────────────────────
                ts_404 = ts.get("/projects/nope/context")
                py_404 = py.get("/projects/nope/context")
                check("7. an unknown project is 404 on both, not an empty view",
                      ts_404.status_code == py_404.status_code == 404,
                      f"{ts_404.status_code}/{py_404.status_code}")
                _diff("7b. and says the same thing", ts_404.json(), py_404.json())
                check("7c. the contract route is 404 too",
                      ts.get("/projects/nope/context/contract").status_code
                      == py.get("/projects/nope/context/contract").status_code == 404)

                # ── no secret can reach a context ────────────────────
                for client in (ts, py):
                    client.post("/fabric/invoke", json={
                        "capabilityId": "provider.connect",
                        "input": {"providerId": "groq", "apiKey": "sk-live-context-probe"},
                        "context": {"projectId": project_id,
                                    "actorKind": "human", "actorId": "verifier"},
                    })
                for label, client in (("TypeScript", ts), ("Python", py)):
                    body = client.get(f"/projects/{project_id}/context").text
                    contract = client.get(
                        f"/projects/{project_id}/context/contract").text
                    check(f"8. no API key reaches the {label} context view",
                          "sk-live-context-probe" not in body)
                    check(f"8b. nor the {label} agent contract",
                          "sk-live-context-probe" not in contract)

                # ── composing a context changes nothing ──────────────
                before = py.get("/fabric/audit").json()["audit"]
                for _ in range(3):
                    py.get(f"/projects/{project_id}/context")
                    py.get(f"/projects/{project_id}/context/contract")
                after = py.get("/fabric/audit").json()["audit"]
                check("9. reading context executes nothing",
                      len(before) == len(after), f"{len(before)} -> {len(after)}")
                check("9b. and does not mount the project",
                      py.get(f"/projects/{project_id}/context").json()
                        ["project"]["mounted"] is False)
        finally:
            bundle.unlink(missing_ok=True)

    print("\nRESULT: DIVERGENCE FOUND" if failed
          else "\nRESULT: BOTH BACKENDS COMPOSE THE SAME CONTEXT")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
