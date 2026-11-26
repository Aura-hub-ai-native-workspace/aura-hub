#!/usr/bin/env python3
"""orphan-lifecycle-verify — issue #112 acceptance (A1–A5, A8) against the REAL API.

Real API processes, real SIGKILLs, real Docker sandbox containers, a FAKE
`claude` worker (never contacts any service), throwaway homes, private
ports. Everything this script starts runs in its own process group and is
removed in `finally`, including on failure.

    python3 scripts/orphan-lifecycle-verify.py --out DIR [--python PY] [--seed-dir DIR]

A1  crash mid-run, restart: the crashed worker's container is gone BEFORE
    the resumed run's new container appears.
A2  crash with an unsettled STOP on disk: container removed at startup,
    session cancelled, nothing relaunched for 30 s.
A3  repeated crashes (crash, restart, crash during recovery, restart):
    no container of a dead instance survives; dead instances' locks cleaned.
A4  two live instances, different homes: restarting one never touches the
    other's running worker.
A5  two live instances, SAME home: the second one's dispatch (which sweeps)
    and a crash/restart of the second never touch the first one's worker.
A8  Docker unreachable at startup: the API starts and reports the cleanup
    as deferred; the next start with Docker removes the orphan.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TASK = "In calc.py, add a docstring that says SLOWTASK"
FAKE = r"""#!/bin/sh
# FAKE claude for AURA lifecycle tests. Never contacts any service.
case "$1" in --version|-v) echo "2.0.0 (Claude Code) [aura-lifecycle-fake]"; exit 0;; esac
case "$*" in
  *AURA-READY-*) n=$(printf "%s" "$*" | grep -oE "AURA-READY-[A-Z0-9]+" | head -1); mkdir -p work; printf "%s" "$n" > work/aura-ready.txt; echo DONE; exit 0;;
  *SLOWTASK*) sleep 3011 & echo "fake: working slowly"; wait; exit 0;;
  *) echo "fake: done"; exit 0;;
esac
"""


class Fail(Exception):
    pass


class Harness:
    def __init__(self, out: Path, python: str, seed_dir: Path | None):
        self.out, self.python, self.seed = out, python, seed_dir
        self.token = secrets.token_hex(24)
        self.bin = out / "bin"
        self.bin.mkdir(parents=True)
        (self.bin / "claude").write_text(FAKE)
        (self.bin / "claude").chmod(0o755)
        self.procs: list[subprocess.Popen] = []
        self.log = open(out / "verify.log", "a", encoding="utf-8")

    def say(self, msg: str) -> None:
        line = f"{time.strftime('%H:%M:%S')} {msg}"
        print(line, flush=True)
        self.log.write(line + "\n")
        self.log.flush()

    # ── homes, APIs ──────────────────────────────────────────────────────────
    def home(self, name: str) -> Path:
        root = self.out / name
        (root / "home").mkdir(parents=True)
        proj = root / "proj"
        proj.mkdir()
        (proj / "calc.py").write_text("def add(a, b):\n    return a + b\n")
        env = {**os.environ, "GIT_AUTHOR_DATE": "2026-11-26T00:00:00Z", "GIT_COMMITTER_DATE": "2026-11-26T00:00:00Z"}
        for c in (["git", "init", "-q"], ["git", "-c", "user.email=t@example.invalid", "-c", "user.name=t",
                                          "commit", "-q", "--allow-empty", "-m", "x"]):
            subprocess.run(c, cwd=proj, check=True, env=env, capture_output=True)
        if self.seed and (self.seed / "manicode").is_dir():
            shutil.copytree(self.seed / "manicode", root / "home" / ".config" / "manicode")
        return root

    def start(self, root: Path, port: int, tag: str, docker_host: str | None = None) -> subprocess.Popen:
        env = {"PATH": f"{self.bin}:/usr/bin:/bin", "HOME": str(root / "home"),
               "AURA_HOME": str(root / "home" / ".aura"), "AURA_INSTANCE_TOKEN": self.token,
               "LANG": "C.UTF-8"}
        if docker_host:
            env["DOCKER_HOST"] = docker_host
        logf = open(root / f"api-{tag}.log", "ab")
        p = subprocess.Popen([self.python, "scripts/serve_central_agent_api.py", str(port)], cwd=REPO, env=env,
                             stdin=subprocess.DEVNULL, stdout=logf, stderr=subprocess.STDOUT, start_new_session=True)
        logf.close()
        self.procs.append(p)
        end = time.monotonic() + 90
        while time.monotonic() < end:
            if p.poll() is not None:
                raise Fail(f"API {tag} exited early ({p.returncode}); see api-{tag}.log")
            try:
                self.http(port, "/health", timeout=2)
                return p
            except Exception:  # noqa: BLE001
                time.sleep(0.2)
        raise Fail(f"API {tag} not healthy in 90 s")

    def crash(self, p: subprocess.Popen) -> None:
        os.kill(p.pid, signal.SIGKILL)  # the API process only, as a crash would
        p.wait(15)

    def http(self, port: int, path: str, body: dict | None = None, timeout: float = 60) -> dict:
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}",
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"x-aura-instance-token": self.token, "content-type": "application/json"},
                                     method="GET" if body is None else "POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)

    def connect_and_submit(self, port: int, root: Path) -> str:
        if not self.http(port, "/workers/connect", {"id": "claude-code"}, timeout=120).get("connected"):
            raise Fail("fake worker did not connect")
        return self.http(port, "/agent/sessions", {"message": TASK, "projectPath": str(root / "proj")})["sessionId"]

    def session(self, port: int, sid: str) -> dict:
        d = self.http(port, f"/agent/sessions/{sid}")
        return {"state": d.get("orchestrationState"), "outcome": (d.get("lastResult") or {}).get("outcome")}

    # ── containers ───────────────────────────────────────────────────────────
    def containers(self) -> list[dict]:
        fmt = '{{.Names}}\t{{.Label "aura.sandbox.instance"}}\t{{.Label "aura.sandbox.owner"}}\t{{.State}}'
        out = subprocess.run(["docker", "ps", "-a", "--filter", "label=aura.sandbox=run", "--format", fmt],
                             capture_output=True, text=True, timeout=30).stdout
        rows = []
        for line in out.splitlines():
            n, i, o, s = (line.split("\t") + ["", "", ""])[:4]
            rows.append({"name": n, "instance": i, "owner": o, "state": s})
        return rows

    def owned_by_pid(self, pid: int) -> list[dict]:
        return [c for c in self.containers() if c["owner"] == str(pid)]

    def wait_for(self, pred, timeout: float, what: str):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            v = pred()
            if v:
                return v
            time.sleep(0.1)
        raise Fail(f"timed out after {timeout:.0f} s waiting for {what}")

    def cleanup(self) -> dict:
        for p in self.procs:
            if p.poll() is None:
                try:
                    os.killpg(p.pid, signal.SIGTERM)
                except OSError:
                    pass
        time.sleep(2)
        for p in self.procs:
            if p.poll() is None:
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except OSError:
                    pass
                p.wait(10)
        mine = {str(p.pid) for p in self.procs}
        for c in self.containers():
            if c["owner"] in mine:
                subprocess.run(["docker", "rm", "-f", c["name"]], capture_output=True, timeout=60)
        left = [c for c in self.containers() if c["owner"] in mine]
        return {"apisAlive": [p.pid for p in self.procs if p.poll() is None], "containersLeft": left}


def a1(h: Harness) -> dict:
    root = h.home("a1")
    api1 = h.start(root, 4441, "1")
    sid = h.connect_and_submit(4441, root)
    old = h.wait_for(lambda: h.owned_by_pid(api1.pid), 90, "the first worker container")[0]["name"]
    h.crash(api1)
    api2 = h.start(root, 4441, "2")
    t0 = time.monotonic()
    old_gone = new_seen = None
    while time.monotonic() - t0 < 90 and new_seen is None:
        rows = h.containers()
        if old_gone is None and not any(c["name"] == old for c in rows):
            old_gone = time.monotonic() - t0
        if any(c["owner"] == str(api2.pid) for c in rows):
            new_seen = time.monotonic() - t0
        time.sleep(0.1)
    state = h.session(4441, sid)
    h.http(4441, f"/agent/sessions/{sid}/cancel", {"reason": "a1 done"})
    ok = old_gone is not None and new_seen is not None and old_gone <= new_seen and state["state"] == "running"
    return {"pass": ok, "oldContainerGoneAfterS": old_gone, "newContainerSeenAfterS": new_seen, "sessionWhileResumed": state}


def a2(h: Harness) -> dict:
    root = h.home("a2")
    api1 = h.start(root, 4442, "1")
    sid = h.connect_and_submit(4442, root)
    old = h.wait_for(lambda: h.owned_by_pid(api1.pid), 90, "the worker container")[0]["name"]
    h.crash(api1)
    f = root / "home" / ".aura" / "agent" / "sessions" / f"{sid}.json"
    d = json.loads(f.read_text())
    d["cancellation"] = {"sessionId": sid, "cancelled": True, "accepted": True, "reason": "user stop",
                         "requestedBy": "user", "requestedAt": "2026-11-26T00:00:00Z", "settled": False}
    f.write_text(json.dumps(d))
    api2 = h.start(root, 4442, "2")
    gone = h.wait_for(lambda: not any(c["name"] == old for c in h.containers()), 30, "the orphan to be removed")
    time.sleep(30)
    relaunched = h.owned_by_pid(api2.pid)
    state = h.session(4442, sid)
    ok = bool(gone) and not relaunched and state["state"] == "cancelled" and state["outcome"] == "cancelled"
    return {"pass": ok, "orphanRemoved": bool(gone), "relaunchedContainers": relaunched, "session": state}


def a3(h: Harness) -> dict:
    root = h.home("a3")
    api1 = h.start(root, 4443, "1")
    sid = h.connect_and_submit(4443, root)
    h.wait_for(lambda: h.owned_by_pid(api1.pid), 90, "worker under api1")
    h.crash(api1)
    api2 = h.start(root, 4443, "2")
    h.wait_for(lambda: h.owned_by_pid(api2.pid), 90, "resumed worker under api2")
    h.crash(api2)  # crash during recovery
    api3 = h.start(root, 4443, "3")
    h.wait_for(lambda: h.owned_by_pid(api3.pid), 90, "resumed worker under api3")
    dead = [c for c in h.containers() if c["owner"] in (str(api1.pid), str(api2.pid))]
    h.http(4443, f"/agent/sessions/{sid}/cancel", {"reason": "a3 done"})
    time.sleep(3)
    left = h.owned_by_pid(api3.pid)
    locks = sorted(p.stem for p in (root / "home" / ".aura" / "run" / "instances").glob("*.lock"))
    ok = not dead and not left and len(locks) == 1
    return {"pass": ok, "deadInstanceContainersWhenApi3Dispatched": dead, "leftAfterStop": left,
            "instanceLockFiles": len(locks)}


def a4(h: Harness) -> dict:
    ra, rb = h.home("a4-a"), h.home("a4-b")
    apia = h.start(ra, 4444, "a")
    apib = h.start(rb, 4445, "b")
    sida = h.connect_and_submit(4444, ra)
    sidb = h.connect_and_submit(4445, rb)
    h.wait_for(lambda: h.owned_by_pid(apia.pid), 90, "worker A")
    b_ctr = h.wait_for(lambda: h.owned_by_pid(apib.pid), 90, "worker B")[0]["name"]
    h.crash(apia)
    apia2 = h.start(ra, 4444, "a2")
    h.wait_for(lambda: h.owned_by_pid(apia2.pid), 90, "A's resumed worker")
    time.sleep(5)
    b_alive = any(c["name"] == b_ctr and c["state"] == "running" for c in h.containers())
    b_state = h.session(4445, sidb)
    for port, sid in ((4444, sida), (4445, sidb)):
        h.http(port, f"/agent/sessions/{sid}/cancel", {"reason": "a4 done"})
    return {"pass": b_alive and b_state["state"] == "running", "otherHomeWorkerStillRunning": b_alive,
            "otherHomeSession": b_state}


def a5(h: Harness) -> dict:
    root = h.home("a5")
    x = h.start(root, 4446, "x")
    sidx = h.connect_and_submit(4446, root)
    x_ctr = h.wait_for(lambda: h.owned_by_pid(x.pid), 90, "worker X")[0]["name"]
    y = h.start(root, 4447, "y")  # second live instance, same home: startup reaping runs here
    sidy = h.http(4447, "/agent/sessions", {"message": TASK, "projectPath": str(root / "proj")})["sessionId"]
    h.wait_for(lambda: h.owned_by_pid(y.pid), 90, "worker Y (its dispatch runs the executor sweep)")
    x_after_y = any(c["name"] == x_ctr and c["state"] == "running" for c in h.containers())
    h.crash(y)
    y2 = h.start(root, 4447, "y2")  # restart of the other instance reaps Y's orphan, never X's worker
    time.sleep(8)
    x_after_restart = any(c["name"] == x_ctr and c["state"] == "running" for c in h.containers())
    y_orphans = h.owned_by_pid(y.pid)
    h.http(4446, f"/agent/sessions/{sidx}/cancel", {"reason": "a5 done"})
    try:
        h.http(4447, f"/agent/sessions/{sidy}/cancel", {"reason": "a5 done"})
    except Exception:  # noqa: BLE001
        pass
    _ = y2
    ok = x_after_y and x_after_restart and not y_orphans
    return {"pass": ok, "xWorkerSurvivedYDispatch": x_after_y, "xWorkerSurvivedYRestart": x_after_restart,
            "yOrphansLeft": y_orphans}


def a8(h: Harness) -> dict:
    root = h.home("a8")
    api1 = h.start(root, 4448, "1")
    sid = h.connect_and_submit(4448, root)
    old = h.wait_for(lambda: h.owned_by_pid(api1.pid), 90, "worker")[0]["name"]
    h.crash(api1)
    # Edit the session so nothing is resumed (a stopped run), isolating startup cleanup.
    f = root / "home" / ".aura" / "agent" / "sessions" / f"{sid}.json"
    d = json.loads(f.read_text())
    d["cancellation"] = {"sessionId": sid, "cancelled": True, "accepted": True, "requestedBy": "user",
                         "requestedAt": "2026-11-26T00:00:00Z", "settled": False}
    f.write_text(json.dumps(d))
    api2 = h.start(root, 4448, "2", docker_host="unix:///nonexistent/aura-no-docker.sock")
    time.sleep(3)
    still_there = any(c["name"] == old for c in h.containers())
    log2 = (root / "api-2.log").read_text(errors="replace")
    deferred_reported = "deferred" in log2
    h.crash(api2)
    h.start(root, 4448, "3")
    gone = h.wait_for(lambda: not any(c["name"] == old for c in h.containers()), 30, "orphan removed with Docker back")
    ok = still_there and deferred_reported and bool(gone)
    return {"pass": ok, "startedWithoutDocker": True, "orphanKeptWhileDockerUnreachable": still_there,
            "deferralReported": deferred_reported, "removedWhenDockerBack": bool(gone)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--seed-dir", default=None, help="optional pre-downloaded freebuff runtime (manicode/)")
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True)
    results: dict = {"startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                     "commit": subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"],
                                              capture_output=True, text=True).stdout.strip(),
                     "dirty": bool(subprocess.run(["git", "-C", str(REPO), "status", "--porcelain"],
                                                  capture_output=True, text=True).stdout.strip())}
    tests = {"A1": a1, "A2": a2, "A3": a3, "A4": a4, "A5": a5, "A8": a8}
    wanted = [t for t in a.only.split(",") if t] or list(tests)
    for name in wanted:
        h = Harness(out / name, a.python, Path(a.seed_dir) if a.seed_dir else None)
        h.say(f"== {name}")
        try:
            r = tests[name](h)
        except Fail as exc:
            r = {"pass": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001
            r = {"pass": False, "error": f"{type(exc).__name__}: {exc}"}
        finally:
            r_cleanup = h.cleanup()
        r["cleanup"] = r_cleanup
        if r_cleanup["apisAlive"] or r_cleanup["containersLeft"]:
            r["pass"] = False
            r["cleanupIncomplete"] = True
        results[name] = r
        h.say(f"{name}: {'PASS' if r['pass'] else 'FAIL'} {json.dumps({k: v for k, v in r.items() if k != 'cleanup'})}")
    results["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    (out / "results.json").write_text(json.dumps(results, indent=1))
    failed = [k for k in wanted if not results[k]["pass"]]
    print(f"RESULT: {len(wanted) - len(failed)}/{len(wanted)} passed" + (f"; failed: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
