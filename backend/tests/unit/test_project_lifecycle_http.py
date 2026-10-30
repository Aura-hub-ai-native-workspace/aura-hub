"""From an idea in general chat to a project that remembers it, over HTTP.

General chat (no project) develops an idea; adopting that conversation into
a new project carries what was settled — never the whole transcript, never
anything from another conversation — into the project's Shared Context, and
links the two both ways. Also: the model/local-runtime status endpoint and
the bounded context package the plan builder reads.
"""
from __future__ import annotations

import pytest


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("AURA_SEARCH_ENDPOINT", raising=False)
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    return TestClient(create_app()), tmp_path


IDEA = ("I want to build a habit tracker app that works offline. It must sync when online. "
        "Let's use SQLite. I don't want Electron.")


def chat(client, message, **extra):
    r = client.post("/agent/chat", json={"message": message, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def test_an_idea_conversation_becomes_a_projects_origin(api):
    client, _ = api
    first = chat(client, IDEA)
    assert {"goal", "requirement", "decision", "rejected"} <= {r["kind"] for r in first["result"]["recorded"]}
    assert "create-project" in first["result"]["nextActions"]
    sid = first["sessionId"]
    other = chat(client, "I want to build a recipe app that works offline. Let's use Postgres.")["sessionId"]

    r = client.post("/agent/projects/habit-tracker/adopt", json={"sessionId": sid})
    assert r.status_code == 200, r.text
    assert r.json()["carried"]["decision"] >= 1 and r.json()["carried"]["goal"] == 1

    package = client.get("/agent/context/habit-tracker", params={"q": "which database"}).json()
    assert "habit tracker" in package["text"] and "SQLite" in package["text"] and "Electron" in package["text"]
    assert "Postgres" not in package["text"] and "recipe" not in package["text"]  # the other conversation stayed out

    again = client.post("/agent/projects/habit-tracker/adopt", json={"sessionId": sid})
    assert again.status_code == 200
    assert client.get("/agent/context/habit-tracker").json()["available"] == package["available"]  # idempotent
    # the link is recorded on the conversation too
    assert client.get(f"/agent/sessions/{sid}").json()["adoptedBy"] == "habit-tracker"
    assert client.get(f"/agent/sessions/{other}").json().get("adoptedBy") is None


def test_only_a_chat_can_start_a_project(api):
    client, tmp = api
    work = client.post("/agent/sessions", json={"message": "list my workflows"}).json()["sessionId"]
    r = client.post("/agent/projects/p1/adopt", json={"sessionId": work})
    assert r.status_code == 409
    assert client.post("/agent/projects/p1/adopt", json={"sessionId": "nope"}).status_code == 400
    assert client.post("/agent/projects/p1/adopt", json={"sessionId": "agt-000000000000"}).status_code == 409


def test_a_project_id_cannot_escape_its_scope(api):
    client, _ = api
    sid = chat(client, IDEA)["sessionId"]
    assert client.get("/agent/context/..%2Fetc").status_code in (400, 404)
    assert client.post("/agent/projects/a.b..c/adopt", json={"sessionId": sid}).status_code in (200, 409)
    assert client.post("/agent/projects/.hidden/adopt", json={"sessionId": sid}).status_code == 409


def test_model_status_is_honest_and_never_installs(api, monkeypatch):
    client, _ = api
    import aura.central_agent.model_status as ms

    monkeypatch.setattr(ms, "detect_local_runtime",
                        lambda **_: {"runtime": "ollama", "installed": False, "running": False,
                                     "models": [], "state": "not-installed"})
    body = client.get("/agent/models/status").json()
    assert body["laya"]["configured"] is False and "No reasoning model" in body["laya"]["note"]
    rec = body["recommendation"]
    assert rec["model"] == "qwen3.5:2b" and rec["required"] is False
    assert rec["compatible"] is False and "command" not in rec  # no runtime: no command to run
    assert "Ollama" in rec["problems"][0]


def test_a_chat_keeps_its_answers_and_citations_for_later(api, monkeypatch, tmp_path):
    client, _ = api
    first = chat(client, "What is PEP 8?")
    sid = first["sessionId"]
    session = client.get(f"/agent/sessions/{sid}").json()
    turns = session["chatTurns"]
    assert len(turns) == 1 and turns[0]["question"] == "What is PEP 8?"
    assert turns[0]["research"]["status"] in ("unavailable", "skipped", "ok", "empty")
    chat(client, "And what about PEP 20?", sessionId=sid)
    assert len(client.get(f"/agent/sessions/{sid}").json()["chatTurns"]) == 2
    chats = client.get("/agent/chats").json()["chats"]
    assert chats[0]["sessionId"] == sid and chats[0]["turns"] == 2 and chats[0]["title"] == "What is PEP 8?"
    # project chats are listed under their project, not with general ones
    chat(client, "hello from a project", projectId="proj-x")
    assert all(c["sessionId"] != chats[0]["sessionId"] for c in client.get("/agent/chats?projectId=proj-x").json()["chats"])
    assert [c["title"] for c in client.get("/agent/chats?projectId=proj-x").json()["chats"]] == ["hello from a project"]


def test_general_conversations_do_not_share_notes(api):
    """Another idea explored earlier must not leak into a new conversation, nor
    make an unrelated question look like 'ready to create a project'."""
    client, _ = api
    first = chat(client, IDEA)
    assert "create-project" in first["result"]["nextActions"]
    second = chat(client, "What is PEP 8?")
    assert second["sessionId"] != first["sessionId"]
    assert second["result"]["nextActions"] == []
    ctx = client.get(f"/agent/context/general.{second['sessionId']}", params={"q": "habit tracker SQLite"}).json()
    assert "habit" not in ctx["text"].lower() and "SQLite" not in ctx["text"]
    # the first conversation still has its own notes, and adopting it carries only those
    own = client.get(f"/agent/context/general.{first['sessionId']}", params={"q": "habit tracker SQLite"}).json()
    assert "SQLite" in own["text"]
    r = client.post("/agent/projects/hab/adopt", json={"sessionId": first["sessionId"]})
    assert r.status_code == 200 and r.json()["carried"]["decision"] >= 1
    package = client.get("/agent/context/hab", params={"q": "which database"}).json()
    assert "SQLite" in package["text"] and "PEP" not in package["text"]
