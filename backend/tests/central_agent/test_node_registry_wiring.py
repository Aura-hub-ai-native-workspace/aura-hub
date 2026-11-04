"""P0-3: the policy host and the connect route must share one node registry.

Before the fix, each ConnectedNodeStore cached connected-nodes.json at
construction. A node connected through the environment connect route was
written to disk, but the policy host (a different instance) kept its stale
list, so git.status was denied with "Nothing connected can perform git
status yet" until the process restarted.

No node is fabricated here: the git node is connected through the real
POST /environment/connect route, which probes the installed git binary.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import threading
import time

import pytest


@pytest.fixture()
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("AURA_HOME", str(h))
    return h


def test_two_store_instances_see_each_others_writes(home):
    from aura.persistence.nodes import ConnectedNodeStore

    policy_host_store = ConnectedNodeStore()      # built at server start
    connect_route_store = ConnectedNodeStore()    # built per request
    connect_route_store.register("git", "Git", ["source-control"])
    assert [n["id"] for n in policy_host_store.list_nodes()] == ["git"]


def test_a_stale_instance_does_not_clobber_a_newer_registration(home):
    from aura.persistence.nodes import ConnectedNodeStore

    a = ConnectedNodeStore()
    b = ConnectedNodeStore()
    a.register("alpha", "Alpha", ["x"])
    b.register("beta", "Beta", ["y"])
    ids = sorted(n["id"] for n in ConnectedNodeStore().list_nodes())
    assert ids == ["alpha", "beta"]


def test_concurrent_registrations_through_two_instances_are_all_kept(home):
    from aura.persistence.nodes import ConnectedNodeStore

    stores = [ConnectedNodeStore(), ConnectedNodeStore()]
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def writer(idx: int) -> None:
        barrier.wait()
        try:
            for i in range(50):
                stores[idx].register(f"n-{idx}-{i}", "N", ["cap"])
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=writer, args=(i,)) for i in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert len(ConnectedNodeStore().list_nodes()) == 100


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_authorized_git_status_executes_through_the_connected_git_node(home, tmp_path):
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    proj = tmp_path / "proj"
    proj.mkdir()
    for cmd in (["git", "init", "-q"], ["git", "config", "user.email", "t@t"],
                ["git", "config", "user.name", "t"]):
        subprocess.run(cmd, cwd=proj, check=True)
    (proj / "a.txt").write_text("x")
    subprocess.run(["git", "add", "."], cwd=proj, check=True)
    subprocess.run(["git", "commit", "-qm", "init"], cwd=proj, check=True)

    client = TestClient(create_app())

    # 1. Connect git the way a person does: the real probe of the binary.
    connected = client.post("/environment/connect", json={"id": "git"})
    assert connected.status_code == 200, connected.text
    assert connected.json()["connected"] is True, connected.json()

    # 2. The same server, without a restart, now authorizes git.status.
    body = client.post("/agent/sessions", json={
        "message": "show me git status", "projectId": "p-git",
        "projectPath": str(proj)}).json()
    assert body["result"]["status"] == "started", body["result"]
    sid = body["sessionId"]

    deadline = time.monotonic() + 90
    while True:
        s = client.get(f"/agent/sessions/{sid}").json()
        if s.get("orchestrationState") not in (None, "running") and (s.get("lastResult") or {}).get("outcome") not in (None, "started"):
            break
        assert time.monotonic() < deadline, f"never settled: {str(s)[:300]}"
        time.sleep(0.25)

    # 3. Terminal, real, and evidenced: the git call ran and was verified.
    res = s["lastResult"]
    assert res["outcome"] == "completed", json.dumps(res)[:500]
    assert "Policy denies" not in (res.get("summary") or "")
    assert res["performed"] == ["t1"], res
    assert res["verified"] == ["t1"], res
    assert res["evidence"] is not None, "a completed run must carry evidence"
    assert s["state"] == "completed"


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_a_tool_the_task_needs_is_verified_connected_and_authorized_without_a_manual_step(home, tmp_path):
    """No person connects anything. The plan declares git.status needs the
    local git program; the coordinator probes it (a real probe), records the
    confirmed tool as connected, and the policy host then authorizes it."""
    from starlette.testclient import TestClient

    from aura.api.server import create_app
    from aura.persistence.nodes import ConnectedNodeStore

    proj = tmp_path / "proj"
    proj.mkdir()
    for cmd in (["git", "init", "-q"], ["git", "config", "user.email", "t@t"],
                ["git", "config", "user.name", "t"]):
        subprocess.run(cmd, cwd=proj, check=True)
    (proj / "a.txt").write_text("x")
    subprocess.run(["git", "add", "."], cwd=proj, check=True)
    subprocess.run(["git", "commit", "-qm", "init"], cwd=proj, check=True)

    assert ConnectedNodeStore().get("git") is None, "fresh home starts with no nodes"
    client = TestClient(create_app())
    body = client.post("/agent/sessions", json={
        "message": "show me git status", "projectId": "p-auto",
        "projectPath": str(proj)}).json()
    deadline = time.monotonic() + 90
    while True:
        s = client.get(f"/agent/sessions/{body['sessionId']}").json()
        if s.get("orchestrationState") not in (None, "running") and \
                (s.get("lastResult") or {}).get("outcome") not in (None, "started"):
            break
        assert time.monotonic() < deadline, f"never settled: {str(s)[:300]}"
        time.sleep(0.25)

    assert s["lastResult"]["outcome"] == "completed", json.dumps(s["lastResult"])[:500]
    assert s["lastResult"]["performed"] == ["t1"]
    recorded = ConnectedNodeStore().get("git")
    assert recorded is not None and recorded["capabilities"] == ["source-control"]
    assert recorded["version"], "the record carries the version a probe confirmed"


def test_connect_verified_tool_refuses_workers_and_unknown_tools(home):
    from aura.central_agent.provisioner import connect_verified_tool
    from aura.persistence.nodes import ConnectedNodeStore

    assert connect_verified_tool("no-such-tool-zzz", "1.0") is False
    assert connect_verified_tool("claude-code", "2.1") is False, "AI workers need their handshake"
    assert ConnectedNodeStore().list_nodes() == []
