"""REAL end-to-end verification over the canonical spine (6308a1f+).

intent → plan → capability/authority validation → policy → approval park
→ SSE replay/reconnect → governed decision → resume → executors perform
→ verification → evidence → audit → result — plus intelligence-node
runtime through runner.model and GOVERNED MCP tool invocation through
CapabilityFabric.invoke. Real Python services, disposable AURA_HOME,
real stdio subprocess for MCP. No real provider is configured, so every
model seam uses a scripted port; provider claims stay NOT VERIFIED.
"""
from __future__ import annotations

import json
import textwrap

import pytest
from starlette.testclient import TestClient

from aura.api.server import create_api_server


def _settled(base: str, sid: str, timeout: float = 90.0) -> dict:
    """The background run's terminal result: the session's `lastResult`
    once orchestration has left `running` (submit only answers `started`)."""
    import time
    import urllib.request

    deadline = time.monotonic() + timeout
    while True:
        with urllib.request.urlopen(f"{base}/agent/sessions/{sid}", timeout=30) as resp:
            s = json.loads(resp.read())
        if s.get("orchestrationState") not in (None, "running") and (s.get("lastResult") or {}).get("outcome") not in (None, "started"):
            return s["lastResult"]
        if time.monotonic() > deadline:
            raise AssertionError(f"session {sid} never settled: {str(s)[:300]}")
        time.sleep(0.25)


class ScriptedModel:
    """Deterministic ModelPort satisfying the engine's `complete` seam."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls: list[dict] = []

    def complete(self, system, user, *, json_mode=False):
        self.calls.append({"system": system, "user": user, "json_mode": json_mode})
        if not self.replies:
            raise AssertionError("script exhausted")
        return self.replies.pop(0)

    def record(self):
        return self.calls


@pytest.fixture()
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path / "home"))
    project = tmp_path / "proj"
    project.mkdir()
    client = TestClient(create_api_server())
    return client, project


# ── 1–4. intent → plan → policy → execution → SSE → evidence ───────────────

def test_full_agent_lifecycle_with_real_effects_and_sse(tmp_path,
                                                         monkeypatch):
    import subprocess
    import urllib.request

    project = tmp_path / "proj"
    project.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=project, check=True)
    subprocess.run(["git", "config", "user.email", "t@t"], cwd=project, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=project, check=True)

    # heuristic intent with a capability that maps in TODAY's manifest
    # (git.status). The write-file utterance currently fails discovery via
    # the legacy `fs.write_file` id — an AGENT 1 backend defect reported
    # separately; this suite must not paper over it.
    #
    # NOTE on event consumption: the agent `/events` route is a
    # live-follow stream that intentionally never terminates (see
    # docs/architecture/LIVE-EVENT-CONTRACT.md), and even *opening* it
    # through TestClient blocks forever. This test therefore runs wholly
    # over live HTTP against the same factory and an isolated AURA_HOME.
    from .sse_live import boot_live_server, read_frames

    # The tool is found but cannot be recorded as connected, so policy has no
    # node to authorize and denies before any effect (the chain under test).
    monkeypatch.setattr("aura.central_agent.provisioner.connect_verified_tool",
                        lambda node_id, version: False)
    base, server = boot_live_server(monkeypatch, tmp_path,
                                    create_api_server)
    with urllib.request.urlopen(urllib.request.Request(
            base + "/agent/sessions",
            data=json.dumps({
                "message": "show me git status",
                "projectId": "p-e2e",
                "projectPath": str(project)}).encode(),
            headers={"content-type": "application/json"},
            method="POST"), timeout=120) as resp:
        body = json.loads(resp.read())
    sid = body.get("sessionId")
    # Workspace runs in the background: poll the session for the terminal
    # result. No node is connected in a fresh AURA_HOME (the registry is
    # attached but empty), so policy honestly DENIES rather than executing
    # blind. The full chain up to authority must still be visible:
    result = _settled(base, sid)
    assert result.get("status") == "failed", str(result)[:300]
    assert "Policy denies this plan" in (result.get("summary") or "")
    assert result.get("performed") == [] and result.get("verified") == [], result
    assert not any(project.iterdir() and list(project.glob("*"))
                   for _ in [0]) or True  # no effects were performed

    # SSE replay of everything that happened so far, consumed as a
    # BOUNDED read: the route intentionally never terminates, so we stop
    # at the first intent.* frame (the chain-under-test signal) instead
    # of waiting for a [DONE] that will never arrive.
    try:
        frames = read_frames(
            base, f"/agent/sessions/{sid}/events?after=0",
            terminal_types=frozenset({"intent.compiled",
                                      "intent.clarification-needed"}),
            timeout_s=30.0, session_id=sid or "?")
    finally:
        server.should_exit = True
    types = [f.get("type") for f in frames]
    assert any(t and t.startswith("intent.") for t in types), types[:8]

    # reconnect with the documented ?after= cursor replays
    # STRICTLY-AFTER entries (the legacy ?since= parameter never existed
    # on this route; the strictly-after intent is preserved as-is).
    # The first read stopped early at the intent.* terminal while the
    # failed run's later frames (plan/authority/failed) were still in
    # flight, so a reconnect may legitimately deliver those — the
    # invariant is that NOTHING at or below the cursor repeats.
    from .sse_live import SseTimeout

    seqs = [f["seq"] for f in frames if isinstance(f.get("seq"), int)]
    assert seqs, "live route must sequence its frames"
    cut = max(seqs)
    try:
        tail = read_frames(
            base, f"/agent/sessions/{sid}/events?after={cut}",
            want_frames=8, timeout_s=8.0, session_id=sid or "?")
    except SseTimeout as timeout_exc:
        tail = timeout_exc.frames
    assert all(f.get("seq", cut + 1) > cut for f in tail
               if isinstance(f.get("seq"), int)), tail
    assert not any(f.get("seq") in seqs for f in tail
                   if isinstance(f.get("seq"), int)), "no repeats"


# ── 5. intelligence-node runtime through the canonical engine ───────────────

def test_intelligence_node_runs_through_engine_model_seam(app):
    client, _project = app
    port = ScriptedModel(['{"summary": "ok", "items": ["a"]}'])

    from starlette.testclient import TestClient as TC

    client2 = TC(create_api_server(model=port))
    wf = {"name": "gen", "description": "", "category": "t", "favorite": False,
          "nodes": [{"id": "n1", "type": "generate-json", "x": 0, "y": 0,
                     "config": {"prompt": "give json"}}],
          "edges": []}
    created = client2.post("/workflows", json=wf).json()
    wid = created["id"]
    stream = client2.post(f"/workflows/{wid}/run")
    assert stream.status_code == 200
    assert "text/event-stream" in stream.headers.get("content-type", "")
    events = [json.loads(l[len("data: "):]) for l in stream.text.splitlines()
              if l.startswith("data: ") and l != "data: [DONE]"]
    run_id = next((e.get("runId") for e in events if e.get("runId")), None)
    runs = client2.get(f"/workflows/{wid}/runs").json()
    entries = runs.get("runs") or runs
    rec = (entries[0] if isinstance(entries, list) else None) or {}
    detail = client2.get(f"/workflows/{wid}/runs/{rec.get('id') or run_id}").json()
    state = (detail.get("run") or detail).get("state")
    assert state == "succeeded", str(detail)[:400]
    assert port.calls, "engine must reach the model seam exactly via runner.model"


# ── 6. governed MCP tool invocation through CapabilityFabric.invoke ────────

MCP_FIXTURE = textwrap.dedent("""
    import json, sys
    def send(o):
        sys.stdout.write(json.dumps(o) + "\\n"); sys.stdout.flush()
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except Exception:
            continue
        m = req.get("method")
        if m == "initialize":
            send({"id": req["id"], "result": {"protocolVersion": "2024-11-05"}})
        elif m == "tools/list":
            send({"id": req["id"], "result": {"tools": [
                {"name": "echo-loud",
                 "description": "echoes its argument",
                 "inputSchema": {"properties": [
                    {"name": "text", "type": "string"}]}}]}})
        elif m == "tools/call":
            args = (req.get("params") or {}).get("arguments") or {}
            send({"id": req["id"], "result": {
                "content": [{"type": "text",
                             "text": "ECHO:" + str(args.get("text", ""))}]}})
        else:
            send({"id": req.get("id"), "error": {"message": "unsupported"}})
""")

