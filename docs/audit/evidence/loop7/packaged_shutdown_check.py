"""Packaged check of POST /shutdown against the bundled backend (loop 7).

Starts the backend from the extracted AppImage with a random instance token, then proves:
  - requests without / with a wrong token, or without the x-aura-shutdown header, are refused
    and leave the backend running;
  - the authorized request is accepted (200), a repeat during shutdown is idempotent (200),
    and the process exits cleanly within a bounded time;
  - the token never appears in this record or in the backend's logs.
Usage: python3 -I packaged_shutdown_check.py <extracted-resources-dir>
"""
import json
import pathlib
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

RES = pathlib.Path(sys.argv[1])
PY = RES / "python/runtime/bin/python3"
ENTRY = RES / "python/scripts/serve_central_agent_api.py"
BACKEND = RES / "python/backend"
PORT = 43792
TOKEN = secrets.token_urlsafe(24)
HOME = pathlib.Path("/tmp/aura-shutdown-check-loop7")
if HOME.exists():
    shutil.rmtree(HOME)
HOME.mkdir(parents=True)
LOG = HOME / "backend.log"

env = {"PATH": "/usr/bin:/bin", "PYTHONPATH": str(BACKEND), "PYTHONDONTWRITEBYTECODE": "1",
       "PYTHONUNBUFFERED": "1", "AURA_HOME": str(HOME), "AURA_INSTANCE_TOKEN": TOKEN}
started = time.time()
proc = subprocess.Popen([str(PY), str(ENTRY), str(PORT)], cwd=str(HOME), env=env,
                        stdin=subprocess.DEVNULL, stdout=LOG.open("w"), stderr=subprocess.STDOUT)


def req(method, path, token=None, extra=None, timeout=10, shutdown=True):
    headers = {}
    if shutdown:
        headers["x-aura-shutdown"] = "1"
    if token is not None:
        headers["x-aura-instance-token"] = token
    if extra:
        headers.update(extra)
    r = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=b"" if method == "POST" else None,
                               method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            body = resp.read()[:200].decode("utf-8", "replace")
            return resp.status, body
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:200].decode("utf-8", "replace")


for _ in range(120):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2)
        break
    except Exception:
        time.sleep(0.25)
else:
    print("backend never became healthy"); sys.exit(2)

lines = [f"packaged check of POST /shutdown (artifact sha256 {sys.argv[2] if len(sys.argv) > 2 else 'n/a'}), {time.strftime('%Y-%m-%dT%H:%M:%S%z')}",
         f"interpreter: {subprocess.run([str(PY), '-V'], capture_output=True, text=True).stdout.strip()} (bundled), backend: bundled, token: random per run, never printed"]

status, _ = req("POST", "/shutdown", shutdown=False)                    # no headers at all
lines.append(f"{'no headers at all':32} {status}")
status, _ = req("POST", "/shutdown")                                   # shutdown header, no token
lines.append(f"{'header only (no token)':32} {status}")
status, _ = req("POST", "/shutdown", token="wrong-token-value")
lines.append(f"{'wrong token + header':32} {status}")
status, _ = req("POST", "/shutdown", token=TOKEN, shutdown=False)
lines.append(f"{'token, no shutdown header':32} {status}")
alive = proc.poll() is None
lines.append(f"{'still running after refusals':32} {'yes' if alive else 'no (' + str(proc.returncode) + ')'}")

t0 = time.time()
status, body = req("POST", "/shutdown", token=TOKEN)
lines.append(f"{'authorized':32} {status} {body[:80]}")
status2, body2 = req("POST", "/shutdown", token=TOKEN, timeout=5)
lines.append(f"{'repeat request while stopping':32} {status2} {body2[:80]}")
try:
    rc = proc.wait(timeout=15)
except subprocess.TimeoutExpired:
    proc.kill()
    lines.append("exited after: >15 s (FORCED KILL)"); rc = "killed"
else:
    lines.append(f"exited after: {int((time.time() - t0) * 1000)} ms")
lines.append(f"exit status:                   {rc}")

time.sleep(0.5)
try:
    urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2)
    lines.append("port free:                     no")
except Exception:
    lines.append("port free:                     yes")

log_text = LOG.read_text(errors="replace") if LOG.exists() else ""
lines.append(f"token present in this record or the backend logs: "
             f"{sum(l.count(TOKEN) for l in lines) + log_text.count(TOKEN)}")

out = pathlib.Path(__file__).with_name("packaged-shutdown-check.txt")
out.write_text("\n".join(lines) + "\n")
print("\n".join(lines))
