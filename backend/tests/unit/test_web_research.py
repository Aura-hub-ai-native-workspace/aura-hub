"""web.research — the capability, its consent gate, and the plan it builds.

Three claims are load-bearing here, and each is pinned:

  1. OFF really means off. A plan that reaches the executor without the
     consent flag is refused, and a model cannot supply the flag itself —
     the planner overwrites whatever the proposal carried with the
     person's actual choice.
  2. No provider is baked in. With no gateway configured the capability
     refuses and says how to fix it; it never reaches somewhere on its
     own and it never invents results.
  3. With consent and a gateway, the evidence comes back bounded, fenced
     and attributed, because that is what the answer synthesizer and the
     inter-task handoff are built to treat as data.

Nothing here touches the network: the fetch seam is injected.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from aura.executors.web_research import (
    CONSENT_KEY,
    MAX_RESULTS_CAP,
    html_to_text,
    load_web_config,
    parse_results,
    web_research_run,
    web_research_verify,
)

SEARCH_PAYLOAD = json.dumps({"results": [
    {"title": "Blackwell", "url": "https://example.com/blackwell",
     "content": "Shipping notes."},
    {"title": "MI300X", "url": "https://example.org/mi300",
     "content": "Bandwidth figures."},
]})
PAGE = ("<html><head><style>b{}</style></head><body>"
        "<script>steal()</script><h1>Blackwell</h1><p>Real page text.</p>"
        "</body></html>")


def _inv(**inp):
    return {"input": inp, "context": {"timeoutMs": 5_000}}


def _fake_fetch(url, timeout_ms, accept="*/*"):
    if "example.com/blackwell" in url or "example.org" in url:
        return 200, PAGE
    return 200, SEARCH_PAYLOAD


@pytest.fixture()
def gateway(tmp_path, monkeypatch):
    """An isolated AURA home with a search gateway pointed at."""
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    monkeypatch.delenv("AURA_SEARCH_ENDPOINT", raising=False)
    (tmp_path / "web.json").write_text(json.dumps({
        "searchEndpoint": "https://search.internal/s",
        "fetchPages": 2,
    }), encoding="utf-8")
    return tmp_path


# ── the consent gate ────────────────────────────────────────────────────────


class TestConsentGate:
    """OFF means off, at the last possible moment."""

    @pytest.mark.parametrize("value", [
        None, False, "true", "yes", 1, 0, [], {}, "on",
    ])
    async def test_anything_but_literal_true_is_refused(self, gateway, value):
        inv = _inv(query="latest ai gpu releases")
        if value is not None:
            inv["input"][CONSENT_KEY] = value
        result = await web_research_run(inv, fetch_fn=_fake_fetch)
        assert result["ok"] is False
        assert "not enabled" in result["detail"]

    async def test_a_refusal_never_reaches_the_gateway(self, gateway):
        """The gate is checked BEFORE the endpoint is even read."""
        calls: list[str] = []

        def spy(url, timeout_ms, accept="*/*"):
            calls.append(url)
            return 200, SEARCH_PAYLOAD

        result = await web_research_run(_inv(query="secret question"), fetch_fn=spy)
        assert result["ok"] is False
        assert calls == [], "nothing may be fetched without consent"

    async def test_consent_still_needs_a_query(self, gateway):
        result = await web_research_run(_inv(query="   ", webResearch=True),
                                       fetch_fn=_fake_fetch)
        assert result["ok"] is False
        assert "query is required" in result["detail"]

    async def test_consent_alone_does_not_invent_a_gateway(self, tmp_path,
                                                            monkeypatch):
        """No configured gateway is an honest refusal, not a default engine."""
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        monkeypatch.delenv("AURA_SEARCH_ENDPOINT", raising=False)
        result = await web_research_run(_inv(query="anything", webResearch=True),
                                       fetch_fn=_fake_fetch)
        assert result["ok"] is False
        assert "no web research gateway" in result["detail"].lower()
        assert "web.json" in result["detail"]


# ── no hardcoded provider ───────────────────────────────────────────────────


class TestNoHardcodedProvider:
    async def test_a_metadata_endpoint_is_refused(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        monkeypatch.delenv("AURA_SEARCH_ENDPOINT", raising=False)
        (tmp_path / "web.json").write_text(json.dumps({
            "searchEndpoint": "http://169.254.169.254/latest/meta-data"}),
            encoding="utf-8")
        result = await web_research_run(_inv(query="x", webResearch=True),
                                       fetch_fn=_fake_fetch)
        assert result["ok"] is False

    async def test_a_non_http_endpoint_is_refused(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        monkeypatch.delenv("AURA_SEARCH_ENDPOINT", raising=False)
        (tmp_path / "web.json").write_text(json.dumps({
            "searchEndpoint": "file:///etc/passwd"}), encoding="utf-8")
        result = await web_research_run(_inv(query="x", webResearch=True),
                                       fetch_fn=_fake_fetch)
        assert result["ok"] is False

    def test_the_environment_can_point_at_a_different_gateway(self, tmp_path,
                                                              monkeypatch):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        monkeypatch.setenv("AURA_SEARCH_ENDPOINT", "http://127.0.0.1:8888/s")
        assert load_web_config()["searchEndpoint"] == "http://127.0.0.1:8888/s"

    def test_unreadable_config_is_simply_not_configured(self, tmp_path,
                                                       monkeypatch):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        monkeypatch.delenv("AURA_SEARCH_ENDPOINT", raising=False)
        (tmp_path / "web.json").write_text("{not json", encoding="utf-8")
        assert load_web_config() == {}


# ── the evidence it returns ─────────────────────────────────────────────────


class TestResults:
    async def test_results_come_back_bounded_and_attributed(self, gateway):
        result = await web_research_run(
            _inv(query="latest ai gpu releases", webResearch=True),
            fetch_fn=_fake_fetch)
        assert result["ok"] is True
        out = result["output"]
        assert out["count"] == 2
        assert all({"title", "url", "snippet"} <= set(r) for r in out["results"])
        # Fenced as data, which is what the synthesizer and the handoff
        # envelope both require before they will read it.
        assert '[source=https://example.com/blackwell' in out["stdout"]
        assert out["stdout"].count("[/source]") == 2

    async def test_page_scripts_never_reach_the_context(self, gateway):
        result = await web_research_run(
            _inv(query="x", webResearch=True), fetch_fn=_fake_fetch)
        stdout = result["output"]["stdout"]
        assert "steal()" not in stdout
        assert "Real page text." in stdout

    async def test_the_result_count_is_capped(self, gateway):
        result = await web_research_run(
            _inv(query="x", webResearch=True, max_results=9_999),
            fetch_fn=_fake_fetch)
        assert result["output"]["count"] <= MAX_RESULTS_CAP

    async def test_an_empty_result_set_is_an_answer_not_a_failure(self, gateway):
        def empty(url, timeout_ms, accept="*/*"):
            return 200, json.dumps({"results": []})
        result = await web_research_run(_inv(query="x", webResearch=True),
                                       fetch_fn=empty)
        assert result["ok"] is True
        assert result["output"]["count"] == 0
        verified = await web_research_verify({}, result)
        assert verified["passed"] is True

    async def test_a_gateway_error_is_reported_not_hidden(self, gateway):
        def broken(url, timeout_ms, accept="*/*"):
            raise TimeoutError
        result = await web_research_run(_inv(query="x", webResearch=True),
                                       fetch_fn=broken)
        assert result["ok"] is False
        assert await web_research_verify({}, result) == {
            "passed": False, "kind": "audit-only",
            "detail": result["detail"]}

    def test_an_unrecognised_gateway_shape_yields_nothing(self):
        assert parse_results("<html>not json</html>") == []
        assert parse_results(json.dumps({"unexpected": True})) == []
        assert parse_results(json.dumps({"results": "not a list"})) == []

    def test_metadata_urls_in_gateway_results_are_dropped(self):
        rows = parse_results(json.dumps({"results": [
            {"title": "creds", "url": "http://169.254.169.254/latest",
             "content": "x"}]}))
        assert rows == []

    def test_html_extraction_is_bounded(self):
        assert len(html_to_text("<p>" + "a" * 10_000 + "</p>", 100)) <= 115


# ── the capability is registered ────────────────────────────────────────────


class TestRegistration:
    def test_the_descriptor_is_in_the_fabric(self):
        import aura.fabric as fab
        from aura.executors import register_canonical_internal_capabilities

        register_canonical_internal_capabilities(None)
        cap = fab._BY_ID["web.research"]
        assert cap["surface"] == "aura-internal"
        assert "network.outbound" in cap["permissions"]
        assert {f["name"] for f in cap["input"]} >= {"query", CONSENT_KEY}

    def test_the_executor_is_registered(self):
        from aura.executors import all_executors

        assert "web.research" in {e.capabilityId for e in all_executors()}

    def test_no_duplicate_internal_ids(self):
        from aura.executors import CANONICAL_INTERNAL_CAPABILITIES

        ids = [c["id"] for c in CANONICAL_INTERNAL_CAPABILITIES]
        assert len(ids) == len(set(ids))


# ── the planner gates it ────────────────────────────────────────────────────


class TestPlannerGating:
    NOW = "2026-01-01T00:00:00Z"

    def _delegate(self, **extra):
        from aura.contracts import AgentIntent

        return AgentIntent(
            goal="add retry to the client", expectedOutcome="done",
            requiredCapabilities=["agent.delegate"],
            delegateTask="add retry to the client", **extra)

    def test_off_leaves_the_plan_exactly_as_it_was(self):
        from aura.central_agent.planner import TaskPlanner

        plan = TaskPlanner().plan(self._delegate(), "agt-1", self.NOW)
        assert [t.capabilityId for t in plan.tasks] == ["agent.delegate"]
        assert plan.tasks[0].inputFrom == "literal"

    def test_on_puts_a_governed_search_in_front_of_the_work(self):
        from aura.central_agent.planner import TaskPlanner

        plan = TaskPlanner().plan(self._delegate(webResearch=True),
                                  "agt-1", self.NOW)
        assert [t.capabilityId for t in plan.tasks] == ["web.research",
                                                       "agent.delegate"]
        research, worker = plan.tasks
        assert research.input[CONSENT_KEY] is True
        # The worker consumes VERIFIED research through the one sanctioned
        # handoff, and gains no network access of its own.
        assert worker.inputFrom == "upstream-output"
        assert worker.dependsOn == ["research"]
        assert CONSENT_KEY not in worker.input
        assert "network" not in worker.input

    def test_a_model_cannot_grant_itself_consent(self):
        """A proposal claiming webResearch:true is overwritten with the choice.

        The planner is built the way the service builds it — over the real
        manifest — because that is the only wiring in which a model can
        reach this capability at all. Proving the re-stamp here is proving
        it on the path that actually exists.
        """
        from aura.central_agent.planner import TaskPlanner
        from aura.fabric.manifest import all_capabilities

        known = {c.id for c in all_capabilities()}
        assert "web.research" in known, (
            "web.research must be visible to the planner, or the model "
            "cannot reach it and this test proves nothing")

        from aura.central_agent.planner import PlanningError

        planner = TaskPlanner(known_capabilities=lambda: known)
        proposal = {
            "tasks": [{
                "id": "t1", "description": "look it up",
                "capabilityId": "web.research",
                "input": {"query": "anything", CONSENT_KEY: True},
            }],
        }
        # The proposal asks for research AND writes webResearch:true into its
        # own input. Both are ignored: the plan is refused outright rather
        # than built with a neutralised flag, so the request produces one
        # honest error instead of a dispatched task that fails at the
        # executor and leaves a "tried and refused" audit record behind.
        with pytest.raises(PlanningError) as exc:
            planner.plan_from_model(self._delegate(), "agt-1", self.NOW,
                                    proposal)
        assert "research is off" in str(exc.value)

        on = planner.plan_from_model(self._delegate(webResearch=True),
                                     "agt-1", self.NOW, proposal)
        assert on.tasks[0].input[CONSENT_KEY] is True

    def test_consent_is_written_in_both_directions(self):
        from aura.central_agent.planner import apply_web_research_preference
        from aura.contracts import AgentIntent

        smuggled = AgentIntent(goal="x", expectedOutcome="y",
                               webResearch=True)
        stamped = apply_web_research_preference(smuggled, False, "research x")
        assert stamped.webResearch is False

    def test_only_a_real_question_is_promoted_out_of_small_talk(self):
        from aura.central_agent.planner import apply_web_research_preference
        from aura.contracts import AgentIntent

        def chat(text):
            return apply_web_research_preference(
                AgentIntent(goal=text, expectedOutcome="y", conversational=True),
                True, text)

        asked = chat("What are the latest AI GPU releases?")
        assert asked.conversational is False
        assert asked.requiredCapabilities == ["web.research"]

        greeting = chat("hi")
        assert greeting.conversational is True

    def test_a_question_about_your_own_files_researches_too_when_asked(self):
        """File in context + web research in the SAME plan.

        The local document and the open web are two halves of one answer,
        so with the toggle on both capabilities belong to the same mission.
        Without it, the toggle would silently do nothing for exactly the
        question people most want it for.
        """
        from aura.central_agent.planner import TaskPlanner
        from aura.contracts import AgentIntent

        def plan_for(web: bool):
            intent = AgentIntent(
                goal="compare this specification with current practice",
                expectedOutcome="y", surface="knowledge",
                requiredCapabilities=["knowledge.search"], webResearch=web)
            return TaskPlanner().plan(intent, "agt-1", self.NOW)

        off = [t.capabilityId for t in plan_for(False).tasks]
        on = [t.capabilityId for t in plan_for(True).tasks]
        assert off == ["knowledge.search"]
        assert on == ["web.research", "knowledge.search"]

        # The local read keeps its own input: the handoff resolver only
        # attaches evidence to a string `task` field, so rewiring a query
        # would have made it refuse rather than silently mangle the query.
        knowledge_task = plan_for(True).tasks[1]
        assert knowledge_task.inputFrom == "literal"
        assert "query" in knowledge_task.input

    def test_model_listed_capabilities_do_not_include_system_tools(self):
        from aura.central_agent.planner import apply_web_research_preference
        from aura.contracts import AgentIntent
        model_intent = AgentIntent(
            goal="How does it compare with AMD MI300X?",
            expectedOutcome="comparison",
            requiredCapabilities=["workflow.create", "system.install",
                                  "knowledge.search"],
            webResearch=True,
        )
        stamped = apply_web_research_preference(
            model_intent, True, "How does it compare with AMD MI300X?")
        assert stamped.webResearch is True
        assert stamped.requiredCapabilities == ["web.research", "knowledge.search"]

    def test_a_model_naming_the_capability_does_not_unlock_it(self):
        """The leak this test exists for: naming is not permission.

        `apply_web_research_preference` only stamps the flag. It does not
        stop a model from putting "web.research" straight into
        requiredCapabilities. If the planner trusts that naming, a model
        reaches the open web for a person who left the toggle off — with
        no error anywhere, because every individual step looked correct.

        So the check belongs at the point where a capability becomes a
        task, and this test asserts it there, on a planner wired over the
        real manifest.
        """
        from aura.central_agent.planner import PlanningError, TaskPlanner
        from aura.contracts import AgentIntent
        from aura.fabric.manifest import all_capabilities

        known = {c.id for c in all_capabilities()}
        assert "web.research" in known
        planner = TaskPlanner(known_capabilities=lambda: known)

        hostile = AgentIntent(
            goal="What are the latest AI GPU releases?",
            expectedOutcome="A grounded answer.", surface="web-research",
            requiredCapabilities=["web.research"],
            webResearch=False)

        with pytest.raises(PlanningError) as exc:
            planner.plan(hostile, "agt-1", self.NOW)
        # The message must name the actual cause, or the person goes
        # looking for a missing capability instead of an off toggle.
        assert "research is off" in str(exc.value)

        # With the person's choice ON, the identical hostile intent works.
        hostile.webResearch = True
        plan = planner.plan(hostile, "agt-1", self.NOW)
        assert [t.capabilityId for t in plan.tasks] == ["web.research"]

    def test_a_model_proposed_plan_cannot_smuggle_research_in(self):
        """The second door: the model's own DAG, not just the dispatch.

        A model can propose task structure directly, bypassing the
        deterministic dispatch entirely. If only `plan()` is gated, that
        route is a way around the toggle — and a subtler one, because the
        proposed task looks like any other.
        """
        from aura.central_agent.planner import PlanningError, TaskPlanner
        from aura.contracts import AgentIntent
        from aura.fabric.manifest import all_capabilities

        known = {c.id for c in all_capabilities()}
        planner = TaskPlanner(known_capabilities=lambda: known)
        intent = AgentIntent(
            goal="What are the latest AI GPU releases?",
            expectedOutcome="A grounded answer.", surface="web-research",
            requiredCapabilities=["web.research"], webResearch=False)

        smuggle = {"tasks": [{"id": "r1", "capabilityId": "web.research",
                              "description": "look it up"}],
                   "acceptance": [{"kind": "audit-only",
                                   "description": "cited",
                                   "tasks": ["r1"]}]}
        with pytest.raises(PlanningError) as exc:
            planner.plan_from_model(intent, "agt-1", self.NOW, smuggle)
        assert "research is off" in str(exc.value)

        # And the honest consent still lets the same proposal through.
        intent.webResearch = True
        plan = planner.plan_from_model(intent, "agt-1", self.NOW, smuggle)
        assert [t.capabilityId for t in plan.tasks] == ["web.research"]

    def test_consent_off_keeps_the_other_capabilities_in_the_plan(self):
        """Turning research off removes research, not the whole plan."""
        from aura.central_agent.planner import TaskPlanner
        from aura.contracts import AgentIntent
        from aura.fabric.manifest import all_capabilities

        known = {c.id for c in all_capabilities()}
        planner = TaskPlanner(known_capabilities=lambda: known)
        intent = AgentIntent(
            goal="compare this specification with current practice",
            expectedOutcome="A grounded answer.", surface="knowledge",
            requiredCapabilities=["knowledge.search", "web.research"],
            webResearch=False)
        plan = planner.plan(intent, "agt-1", self.NOW)
        assert [t.capabilityId for t in plan.tasks] == ["knowledge.search"]

    def test_the_research_template_carries_consent(self):
        from aura.central_agent.planner import plan_web_research
        from aura.contracts import AgentIntent

        plan = plan_web_research(
            AgentIntent(goal="latest ai gpu", expectedOutcome="y"),
            "agt-1", self.NOW)
        assert len(plan.tasks) == 1
        task = plan.tasks[0]
        assert task.capabilityId == "web.research"
        assert task.input[CONSENT_KEY] is True
        assert task.verification.kind == "audit-only"


# ── the executor is what the pipeline calls ─────────────────────────────────


def test_the_registered_executor_is_the_gated_one():
    """The adapter wiring must not bypass the gate the module enforces."""
    from aura.executors import EXECUTOR_TABLE, ExecutorAdapter

    adapter = ExecutorAdapter("web.research", EXECUTOR_TABLE["web.research"])
    result = asyncio.run(adapter.run(_inv(query="x")),
                         )
    assert result["ok"] is False
    assert "not enabled" in result["detail"]


# ── through the real governed pipeline ──────────────────────────────────────


def _fabric_cfg(tmp_path, monkeypatch, executors=None):
    """The production fabric: policy, approval ledger, audit store."""
    from aura.approvals import ApprovalLedger
    from aura.audit import AuditStore
    from aura.executors import (
        all_executors,
        register_canonical_internal_capabilities,
    )
    from aura.fabric import CapabilityFabric, FabricConfig, FabricHost

    class _H(FabricHost):
        def permissions_for(self, _cap, _ctx):
            return {"read": True, "write": True, "execute": True,
                    "autonomous": True, "network": True}

        def node_available(self, _cap):
            return None

        async def request_approval(self, _req, _ctx):
            return False

    audit = AuditStore(tmp_path / "audit.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)
    fabric = CapabilityFabric(_H())
    fabric.attach_audit_store(audit.load, audit.append)
    fabric.attach_approval_store(lambda: [], lambda x: None)
    fabric._ledger = ledger
    exec_map = executors if executors is not None else {
        e.capabilityId: e for e in all_executors(tmp_path)}
    for cap_id, exe in exec_map.items():
        try:
            fabric.register(exe)
        except Exception:
            fabric.executors[cap_id] = exe
    register_canonical_internal_capabilities(fabric)
    return FabricConfig(fabric=fabric, policy_config={},
                        permissions={"read": True, "write": True},
                        executors=exec_map, audit_store=audit, ledger=ledger)


class TestGovernedPipeline:
    """The capability, invoked the way the agent actually invokes it."""

    def test_consent_off_is_refused_and_still_audited(self, gateway, tmp_path,
                                                      monkeypatch):
        from aura.audit import AuditStore
        from aura.fabric import invoke_fabric

        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        cfg = _fabric_cfg(tmp_path, monkeypatch)
        r = invoke_fabric("web.research", {"query": "anything"}, {}, cfg)
        assert r["outcome"] != "succeeded"
        # Refused or not, the attempt is on the record — silence is not an
        # acceptable answer to "did AURA go out to the web?".
        records = AuditStore(tmp_path / "audit.jsonl").load()
        assert any(x["capabilityId"] == "web.research" for x in records)

    def test_consent_on_runs_through_policy_and_lands_in_the_audit_trail(
            self, gateway, tmp_path, monkeypatch):
        from aura.audit import AuditStore
        from aura.executors import ExecutorAdapter, web_research_run
        from aura.fabric import invoke_fabric

        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        # Swap in the executor with its network seam pinned, so the test
        # exercises the pipeline rather than the socket.
        cfg = _fabric_cfg(tmp_path, monkeypatch, executors={
            "web.research": ExecutorAdapter("web.research", {
                "run": lambda inv: web_research_run(inv, fetch_fn=_fake_fetch),
                "verify": web_research_verify,
            }),
        })
        r = invoke_fabric(
            "web.research",
            {"query": "latest ai gpu releases", CONSENT_KEY: True},
            {}, cfg)
        assert r["outcome"] == "succeeded"
        assert r["policy"]["decision"] == "auto-execute"

        records = AuditStore(tmp_path / "audit.jsonl").load()
        entry = next(x for x in records if x["capabilityId"] == "web.research")
        assert entry["verified"] is True
        # The consent that authorised it is legible in the audit trail.
        assert CONSENT_KEY in (entry.get("inputSummary") or "")

    def test_results_reach_shared_context_as_attributed_data(
            self, gateway, tmp_path, monkeypatch):
        """Fetched evidence must arrive downstream as DATA, attributed.

        This is the handoff the planner wires for delegated work, so it is
        the seam where "results return to AURA's mission context" actually
        happens. A raw page body is never concatenated into a task; it is
        fenced and credited to its source.
        """
        from aura.central_agent.handoff import (
            UpstreamEvidence,
            build_envelope,
            resolve_task_input,
        )
        from aura.executors import ExecutorAdapter, web_research_run

        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        adapter = ExecutorAdapter("web.research", {
            "run": lambda inv: web_research_run(inv, fetch_fn=_fake_fetch),
            "verify": web_research_verify,
        })
        result = asyncio.run(adapter.run(
            _inv(query="latest ai gpu releases", webResearch=True)))
        stdout = result["output"]["stdout"]

        envelope = build_envelope([UpstreamEvidence(
            task_id="research", agent="aura", stdout=stdout,
            invocation_ids=["inv-1"])])
        resolved = resolve_task_input(
            {"task": "Compare this spec against current practice."},
            envelope["text"])

        downstream = resolved["task"]
        assert "Compare this spec against current practice." in downstream
        assert "https://example.com/blackwell" in downstream
        assert "steal()" not in downstream, "page script text must not survive"
        assert envelope["consumed_ids"] == ["inv-1"]


class TestOffUserFacingRefusal:
    """OFF must produce a clean refusal, never an internal validation error.

    When Web Research is off and the one configured capability for this
    request is web.research, plan() raises the consent PlanningError.
    That already-clean message must reach the user — the fallback model
    plan proposal must NOT run, or its (malformed) validation error would
    be the user-facing text ("model plan rejected: task t1 declares
    inputFrom 'upstream-output'…").
    """

    def test_off_returns_clean_refusal_no_internal_text(self, tmp_path):
        import json
        from aura.central_agent import AgentSessionStore, CentralAgent
        from aura.central_agent.intent import IntentCompiler, ScriptedModelPort
        from aura.fabric import FabricConfig

        malformed_plan = {"tasks": [
            {"id": "t1", "capabilityId": "web.research",
             "inputFrom": "upstream-output"}]}
        intent_requiring_web = {
            "goal": "Search the web for OpenAI and tell me what it is",
            "expectedOutcome": "A grounded answer.",
            "surface": "web-research",
            "requiredCapabilities": ["web.research"],
            "ambiguity": "clear", "confidence": 0.9,
            "complexity": "single", "conversational": False,
            "needsClarification": False, "clarificationQuestion": None,
        }
        port = ScriptedModelPort([
            ("INTENT GOAL:", malformed_plan),      # plan-proposal call
            ("Search the web", intent_requiring_web),  # intent call
        ])
        calls = {"complete_json": 0}
        orig_json = port.complete_json

        def spy_json(system, user):
            calls["complete_json"] += 1
            return orig_json(system, user)

        port.complete_json = spy_json  # type: ignore[assignment]
        cfg = FabricConfig(fabric=None, audit_store=None, ledger=None,
                           permissions={}, executors={}, secrets=None)
        intents = IntentCompiler(mode="model", model_port=port,
                                 allow_heuristic_fallback=True)
        agent = CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(tmp_path),
                             intent_compiler=intents)

        result = agent.submit(
            "Search the web for OpenAI and tell me what it is",
            web_research=False)

        # 1. OFF refusal reached the user, in natural language.
        assert "web research is off" in result.summary.lower()
        # 2. No internal validator message leaked.
        assert "inputFrom" not in result.summary
        assert "model plan rejected" not in result.summary
        assert "upstream-output" not in result.summary
        # 3. No web.research execution: the request never produced a plan,
        #    so no gateway call and no fabric invocation could occur.
        assert result.outcome != "completed"
        # 4. The model was asked to produce an intent once; it was NOT
        #    asked to propose a plan (bounded before touching the model
        #    planner with web.research=off).
        assert calls["complete_json"] == 1
