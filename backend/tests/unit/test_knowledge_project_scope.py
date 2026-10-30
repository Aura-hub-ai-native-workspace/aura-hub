"""Knowledge is scoped to one project (F-26).

Before, one global index served every project: a document ingested for project
A came back from knowledge.search in an agent run for project B, and the REST
routes had no notion of a project at all. Now:

  * every document carries the project it was ingested for, and a search sees
    only that project's documents (a separate index per project, so not even
    ranking statistics are shared);
  * the project comes from the invocation context (set by whoever invoked the
    capability), or, for REST, from a registered project the caller names;
    a missing project is a refusal, never a global scope;
  * naming a different project in the tool input is refused: there is no
    cross-project authorization mechanism, so none is granted;
  * records written before projects were tracked are "unscoped": kept, counted,
    never returned and never adopted by a project automatically;
  * the enforcement is in the KnowledgeBase API (a required project id), so the
    tool, the REST routes and any other caller apply the same policy.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from aura.knowledge.store import KnowledgeBase


class _Extraction:
    def __init__(self, text):
        from aura.multimodal.ingestor import ExtractionStatus

        self.text = text
        self.mime_type = "text/plain"
        self.metadata = {}
        self.status = ExtractionStatus.OK
        self.note = ""


def _kb(tmp_path):
    return KnowledgeBase(tmp_path / "kb")


def _texts(results):
    return [r.chunk.text for r in results]


# ── the store ──────────────────────────────────────────────────────────────

def test_same_project_results_are_available(tmp_path):
    kb = _kb(tmp_path)
    kb.add_document("/docs/a.txt", _Extraction("quarterly budget forecast for alpha"), project_id="proj-a")
    assert any("budget" in t for t in _texts(kb.search("budget forecast", project_id="proj-a")))


def test_another_projects_documents_are_not_returned(tmp_path):
    kb = _kb(tmp_path)
    kb.add_document("/docs/a.txt", _Extraction("alpha confidential budget forecast"), project_id="proj-a")
    kb.add_document("/docs/b.txt", _Extraction("beta roadmap and hiring plan"), project_id="proj-b")
    assert kb.search("confidential budget", project_id="proj-b") == []
    assert kb.search_with_context("confidential budget", project_id="proj-b") == []
    assert kb.search("hiring plan", project_id="proj-a") == []
    assert kb.search("hiring plan", project_id="proj-b")


def test_a_project_with_no_documents_gets_nothing(tmp_path):
    kb = _kb(tmp_path)
    kb.add_document("/docs/a.txt", _Extraction("alpha budget"), project_id="proj-a")
    assert kb.search("budget", project_id="proj-never-ingested") == []


@pytest.mark.parametrize("bad", [None, "", "   ", 7, ["proj-a"], {"id": "proj-a"}])
def test_a_missing_or_invalid_project_id_is_refused_by_every_operation(tmp_path, bad):
    kb = _kb(tmp_path)
    kb.add_document("/docs/a.txt", _Extraction("alpha budget"), project_id="proj-a")
    with pytest.raises(ValueError, match="project id is required"):
        kb.search("budget", project_id=bad)
    with pytest.raises(ValueError, match="project id is required"):
        kb.search_with_context("budget", project_id=bad)
    with pytest.raises(ValueError, match="project id is required"):
        kb.add_document("/docs/x.txt", _Extraction("x"), project_id=bad)
    with pytest.raises(ValueError, match="project id is required"):
        kb.remove_document("/docs/a.txt", project_id=bad)
    with pytest.raises(ValueError, match="project id is required"):
        kb.documents(project_id=bad)


def test_the_project_id_has_no_default_so_a_global_call_cannot_be_written(tmp_path):
    kb = _kb(tmp_path)
    with pytest.raises(TypeError):
        kb.search("budget")                                   # type: ignore[call-arg]
    with pytest.raises(TypeError):
        kb.add_document("/docs/a.txt", _Extraction("x"))      # type: ignore[call-arg]


def test_the_same_file_in_two_projects_is_two_independent_documents(tmp_path):
    kb = _kb(tmp_path)
    ra = kb.add_document("/shared/notes.txt", _Extraction("alpha version of the notes"), project_id="proj-a")
    rb = kb.add_document("/shared/notes.txt", _Extraction("beta version of the notes"), project_id="proj-b")
    assert ra.doc_id != rb.doc_id
    assert "alpha" in " ".join(_texts(kb.search("notes", project_id="proj-a")))
    assert "beta" in " ".join(_texts(kb.search("notes", project_id="proj-b")))
    assert kb.remove_document("/shared/notes.txt", project_id="proj-a") is True
    assert kb.search("notes", project_id="proj-a") == []
    assert kb.search("notes", project_id="proj-b")                   # the other project's copy is untouched
    assert kb.remove_document("/shared/notes.txt", project_id="proj-a") is False


def test_scores_do_not_depend_on_another_projects_text(tmp_path):
    """A separate index per project: adding documents elsewhere leaves this
    project's ranking scores exactly as they were."""
    kb = _kb(tmp_path)
    kb.add_document("/d/a.txt", _Extraction("invoice approval workflow"), project_id="proj-a")
    before = [r.score for r in kb.search("invoice approval", project_id="proj-a")]
    for i in range(20):
        kb.add_document(f"/d/b{i}.txt", _Extraction("invoice approval invoice approval"), project_id="proj-b")
    after = [r.score for r in kb.search("invoice approval", project_id="proj-a")]
    assert before == after and before


def test_scope_survives_a_restart(tmp_path):
    kb = _kb(tmp_path)
    kb.add_document("/d/a.txt", _Extraction("alpha budget"), project_id="proj-a")
    again = KnowledgeBase(tmp_path / "kb")
    assert again.search("budget", project_id="proj-a")
    assert again.search("budget", project_id="proj-b") == []
    assert again.documents(project_id="proj-a")[0]["projectId"] == "proj-a"


# ── records written before projects were tracked ───────────────────────────

def _write_legacy_store(tmp_path, project_value="ABSENT"):
    """An index.json and chunk file in the old format (no projectId)."""
    store = tmp_path / "kb"
    (store / "chunks").mkdir(parents=True)
    record = {"docId": "legacydoc0000001", "path": "/old/secret.txt", "mimeType": "text/plain",
              "chunkCount": 1, "charCount": 30, "addedAt": 1.0, "metadata": {},
              "extractionStatus": "ok", "extractionNote": ""}
    if project_value != "ABSENT":
        record["projectId"] = project_value
    (store / "index.json").write_text(json.dumps([record]))
    chunk = {"id": "legacydoc0000001:0", "docId": "legacydoc0000001", "text": "legacy password hunter2 text",
             "startChar": 0, "endChar": 28, "index": 0}
    (store / "chunks" / "legacydoc0000001.jsonl").write_text(json.dumps(chunk) + "\n")
    return store


@pytest.mark.parametrize("value", ["ABSENT", None, "", 123, ["proj-a"], {"x": 1}])
def test_old_or_damaged_records_never_become_visible_to_a_project(tmp_path, value):
    store = _write_legacy_store(tmp_path, value)
    kb = KnowledgeBase(store)
    assert kb.snapshot()["documents"] == 1                   # kept, not deleted
    assert kb.unscoped_count() == 1
    for pid in ("proj-a", "proj-b", "legacy", ""):
        if pid:
            assert kb.search("hunter2 password", project_id=pid) == []
            assert kb.search_with_context("hunter2 password", project_id=pid) == []
            assert kb.documents(project_id=pid) == []


def test_unscoped_records_are_not_adopted_and_survive_a_save(tmp_path):
    store = _write_legacy_store(tmp_path)
    kb = KnowledgeBase(store)
    kb.add_document("/new/a.txt", _Extraction("fresh alpha text"), project_id="proj-a")   # triggers a save
    again = KnowledgeBase(store)
    assert again.unscoped_count() == 1
    assert again.search("hunter2", project_id="proj-a") == []


def test_ingesting_the_old_file_again_inside_a_project_scopes_the_new_copy_only(tmp_path):
    store = _write_legacy_store(tmp_path)
    kb = KnowledgeBase(store)
    kb.add_document("/old/secret.txt", _Extraction("rewritten secret content"), project_id="proj-a")
    assert kb.search("rewritten", project_id="proj-a")
    assert kb.search("hunter2", project_id="proj-a") == []   # the legacy text stays unreachable
    assert kb.unscoped_count() == 1


def test_the_snapshot_reports_counts_and_no_document_list(tmp_path):
    kb = _kb(tmp_path)
    kb.add_document("/d/a.txt", _Extraction("alpha"), project_id="proj-a")
    snap = kb.snapshot()
    assert snap["documents"] == 1 and snap["unscopedDocuments"] == 0
    assert "docs" not in snap


# ── the tools ──────────────────────────────────────────────────────────────

@pytest.fixture()
def tools(tmp_path):
    from aura.executors import multimodal_executors

    kb = _kb(tmp_path)
    by_id = {e.capabilityId: e for e in multimodal_executors(kb, tmp_path / "artifacts")}
    return kb, by_id, tmp_path


def _inv(cwd, project_id="ABSENT", **inp):
    ctx = {"cwd": str(cwd), "actor": {"kind": "agent", "id": "central-agent"}}
    if project_id != "ABSENT":
        ctx["projectId"] = project_id
    return {"id": "inv-1", "input": inp, "context": ctx}


def _run(exe, inv):
    return asyncio.run(exe.run(inv))


def _project_file(tmp_path, name, text):
    path = tmp_path / name
    path.write_text(text)
    return name


def test_the_tool_ingests_and_finds_within_its_own_project(tools):
    kb, by_id, tmp = tools
    name = _project_file(tmp, "plan.txt", "ZEBRAPLAN rollout schedule SECRETVALUE9921")
    ingest = _run(by_id["document.ingest"], _inv(tmp, "proj-a", path=name))
    assert ingest["ok"] is True, ingest
    assert kb.documents(project_id="proj-a")
    found = _run(by_id["knowledge.search"], _inv(tmp, "proj-a", query="ZEBRAPLAN rollout"))
    assert found["ok"] is True and "SECRETVALUE9921" in json.dumps(found)


def test_the_tool_in_another_project_cannot_read_it(tools):
    kb, by_id, tmp = tools
    name = _project_file(tmp, "plan.txt", "ZEBRAPLAN rollout schedule SECRETVALUE9921")
    assert _run(by_id["document.ingest"], _inv(tmp, "proj-a", path=name))["ok"] is True
    mine = _run(by_id["knowledge.search"], _inv(tmp, "proj-a", query="ZEBRAPLAN rollout"))
    assert "SECRETVALUE9921" in json.dumps(mine)            # the document really is there
    other = _run(by_id["knowledge.search"], _inv(tmp, "proj-b", query="ZEBRAPLAN rollout"))
    assert "SECRETVALUE9921" not in json.dumps(other)


@pytest.mark.parametrize("project_id", ["ABSENT", None, "", "   ", 7])
def test_a_missing_project_identity_fails_closed_for_search_and_ingest(tools, project_id):
    kb, by_id, tmp = tools
    name = _project_file(tmp, "plan.txt", "ZEBRAPLAN rollout schedule SECRETVALUE9921")
    kb.add_document(str(tmp / "plan.txt"), _Extraction("ZEBRAPLAN rollout schedule SECRETVALUE9921"), project_id="proj-a")
    search = _run(by_id["knowledge.search"], _inv(tmp, project_id, query="ZEBRAPLAN"))
    assert search["ok"] is False and "project" in search["detail"].lower()
    assert "SECRETVALUE9921" not in json.dumps(search)
    ingest = _run(by_id["document.ingest"], _inv(tmp, project_id, path=name))
    assert ingest["ok"] is False and "project" in ingest["detail"].lower()
    assert len(kb.documents(project_id="proj-a")) == 1        # nothing was added


def test_naming_another_project_in_the_input_is_refused(tools):
    kb, by_id, tmp = tools
    kb.add_document("/d/b.txt", _Extraction("BETAROADMAP content BETAVALUE5512"), project_id="proj-b")
    asked = _run(by_id["knowledge.search"], _inv(tmp, "proj-a", query="BETAROADMAP", projectId="proj-b"))
    assert asked["ok"] is False and "own project" in asked["detail"]
    assert "BETAVALUE5512" not in json.dumps(asked)
    name = _project_file(tmp, "n.txt", "note text")
    refused = _run(by_id["document.ingest"], _inv(tmp, "proj-a", path=name, projectId="proj-b"))
    assert refused["ok"] is False
    assert kb.documents(project_id="proj-b")[0]["path"].endswith("b.txt") and len(kb.documents(project_id="proj-b")) == 1


def test_naming_the_invocations_own_project_in_the_input_is_accepted(tools):
    kb, by_id, tmp = tools
    kb.add_document("/d/a.txt", _Extraction("ALPHATEXT roadmap ALPHAVALUE3380"), project_id="proj-a")
    ok = _run(by_id["knowledge.search"], _inv(tmp, "proj-a", query="ALPHATEXT", projectId="proj-a"))
    assert ok["ok"] is True and "ALPHAVALUE3380" in json.dumps(ok)


def test_the_tool_never_returns_old_unscoped_records(tools):
    kb, by_id, tmp = tools
    holder = tmp / "legacy-holder"
    holder.mkdir()
    legacy_kb = KnowledgeBase(_write_legacy_store(holder))
    from aura.executors import multimodal_executors

    exe = {e.capabilityId: e for e in multimodal_executors(legacy_kb, tmp / "art")}["knowledge.search"]
    result = _run(exe, _inv(tmp, "proj-a", query="legacy password"))
    assert "hunter2" not in json.dumps(result)


def test_the_real_fabric_applies_the_same_rule(tmp_path, monkeypatch):
    from aura.audit import AuditStore
    from aura.fabric import CapabilityFabric, FabricConfig, FabricHost, builtin_executors, invoke_fabric

    class Host(FabricHost):
        def permissions_for(self, _cap, _ctx):
            return {"read": True, "write": True, "execute": True, "autonomous": True, "network": True}

        def node_available(self, _cap):
            return True

    home = tmp_path / "home"
    monkeypatch.setenv("AURA_HOME", str(home))
    audit = AuditStore(home / "audit" / "trail.jsonl")
    fab = CapabilityFabric(Host())
    fab.attach_audit_store(audit.load, audit.append)
    execs = builtin_executors(home)
    for e in execs.values():
        try:
            fab.register(e)
        except Exception:
            pass
    cfg = FabricConfig(fabric=fab, policy_config={}, permissions={"read": True, "write": True},
                       executors=execs, audit_store=audit)
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "plan.txt").write_text("ZEBRAPLAN rollout schedule SECRETVALUE9921")

    def call(cap, project_id, **inp):
        ctx = {"cwd": str(proj), "actor": {"kind": "agent", "id": "central-agent"}}
        if project_id is not None:
            ctx["projectId"] = project_id
        return invoke_fabric(cap, inp, ctx, cfg)

    assert call("document.ingest", "proj-a", path="plan.txt")["outcome"] in ("succeeded", "unverified")
    assert "SECRETVALUE9921" in json.dumps(call("knowledge.search", "proj-a", query="ZEBRAPLAN"))
    assert "SECRETVALUE9921" not in json.dumps(call("knowledge.search", "proj-b", query="ZEBRAPLAN"))
    refused = call("knowledge.search", None, query="ZEBRAPLAN")
    assert refused["outcome"] != "succeeded" and "SECRETVALUE9921" not in json.dumps(refused)


# ── REST ───────────────────────────────────────────────────────────────────

@pytest.fixture()
def api(tmp_path, monkeypatch):
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("AURA_HOME", str(home))
    client = TestClient(create_app())
    ids = {}
    for name in ("alpha", "beta"):
        folder = tmp_path / name
        folder.mkdir()
        resp = client.post("/projects", json={"path": str(folder), "name": name})
        assert resp.status_code == 200, resp.text
        ids[name] = resp.json().get("id") or resp.json()["project"]["id"]
    return client, ids


def _upload(client, project_id, name, text):
    data = {"projectId": project_id} if project_id is not None else {}
    return client.post("/documents/ingest", files={"file": (name, text.encode(), "text/plain")}, data=data)


def test_rest_requires_a_project_on_all_three_routes(api):
    client, ids = api
    assert _upload(client, None, "a.txt", "ZEBRAPLAN text").status_code == 400
    assert client.get("/knowledge/search", params={"q": "ZEBRAPLAN"}).status_code == 400
    assert client.get("/documents/list").status_code == 400
    for route, params in (("/knowledge/search", {"q": "x", "projectId": " "}), ("/documents/list", {"projectId": ""})):
        assert client.get(route, params=params).status_code == 400


def test_rest_refuses_an_unregistered_project(api):
    client, _ = api
    assert _upload(client, "proj-nonexistent", "a.txt", "ZEBRAPLAN text").status_code == 404
    assert client.get("/knowledge/search", params={"q": "ZEBRAPLAN", "projectId": "proj-nonexistent"}).status_code == 404
    assert client.get("/documents/list", params={"projectId": "proj-nonexistent"}).status_code == 404


def test_rest_scopes_ingest_search_and_listing_to_the_named_project(api):
    client, ids = api
    assert _upload(client, ids["alpha"], "plan.txt", "ZEBRAPLAN rollout schedule").status_code == 200
    mine = client.get("/knowledge/search", params={"q": "ZEBRAPLAN rollout", "projectId": ids["alpha"]}).json()
    assert mine["results"] and "ZEBRAPLAN" in json.dumps(mine)
    theirs = client.get("/knowledge/search", params={"q": "ZEBRAPLAN rollout", "projectId": ids["beta"]}).json()
    assert theirs["results"] == []
    assert len(client.get("/documents/list", params={"projectId": ids["alpha"]}).json()["documents"]) == 1
    assert client.get("/documents/list", params={"projectId": ids["beta"]}).json()["documents"] == []


def test_the_same_upload_name_in_two_projects_stays_separate(api):
    client, ids = api
    assert _upload(client, ids["alpha"], "notes.txt", "ALPHANOTE content").status_code == 200
    assert _upload(client, ids["beta"], "notes.txt", "BETANOTE content").status_code == 200
    a = json.dumps(client.get("/knowledge/search", params={"q": "content", "projectId": ids["alpha"]}).json())
    b = json.dumps(client.get("/knowledge/search", params={"q": "content", "projectId": ids["beta"]}).json())
    assert "ALPHANOTE" in a and "BETANOTE" not in a
    assert "BETANOTE" in b and "ALPHANOTE" not in b


def test_the_tool_and_the_rest_route_give_the_same_answer_for_the_same_project(api, tmp_path):
    """UI and tool invocation apply one policy: same project, same sources;
    another project, nothing. The tool is called through the real /fabric/invoke."""
    client, ids = api
    assert _upload(client, ids["alpha"], "plan.txt", "ZEBRAPLAN rollout schedule SECRETVALUE9921").status_code == 200
    for name in ("alpha", "beta"):
        tool = client.post("/fabric/invoke", json={
            "capabilityId": "knowledge.search", "input": {"query": "ZEBRAPLAN rollout"},
            "context": {"cwd": str(tmp_path), "projectId": ids[name],
                        "actor": {"kind": "agent", "id": "central-agent"}}}).json()
        rest = client.get("/knowledge/search", params={"q": "ZEBRAPLAN rollout", "projectId": ids[name]}).json()
        assert ("SECRETVALUE9921" in json.dumps(tool)) == bool(rest["results"]) == (name == "alpha"), (name, tool, rest)


def test_the_tool_route_without_a_project_is_refused(api, tmp_path):
    client, ids = api
    assert _upload(client, ids["alpha"], "plan.txt", "ZEBRAPLAN rollout schedule SECRETVALUE9921").status_code == 200
    tool = client.post("/fabric/invoke", json={
        "capabilityId": "knowledge.search", "input": {"query": "ZEBRAPLAN rollout"},
        "context": {"cwd": str(tmp_path), "actor": {"kind": "agent", "id": "central-agent"}}}).json()
    assert tool["outcome"] != "succeeded" and "SECRETVALUE9921" not in json.dumps(tool)
