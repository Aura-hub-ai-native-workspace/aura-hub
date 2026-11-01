"""With no text model, a coding agent writes chat answers: read-only, in an empty folder, never for plans."""
import os
from types import SimpleNamespace

import aura.fabric as fabric
from aura.central_agent.agent_text import ANSWER_RULES, AgentTextPort
from aura.central_agent.service import CentralAgent


def _service(candidates):
    svc = CentralAgent.__new__(CentralAgent)
    svc.fabric_cfg = SimpleNamespace()
    svc._agent_candidates = lambda: (candidates, [])
    return svc


def test_the_port_asks_for_an_answer_without_changes_and_streams_it_whole():
    seen = {}
    port = AgentTextPort(lambda prompt, stop: seen.setdefault("prompt", prompt) and "the answer", "opencode", "OpenCode")
    tokens = []
    assert port.complete_stream("SYSTEM", "USER", on_token=tokens.append) == "the answer"
    assert tokens == ["the answer"]
    assert "SYSTEM" in seen["prompt"] and "USER" in seen["prompt"] and ANSWER_RULES in seen["prompt"]
    assert port.complete_json("s", "u") is None            # an agent never compiles intents or plans
    assert port.providers[0].id == "opencode"


def test_small_talk_and_a_missing_agent_get_no_port():
    svc = _service([{"id": "opencode", "name": "OpenCode"}])
    assert svc._agent_text_port("hello", "agt-aaaaaa") is None
    assert _service([])._agent_text_port("What is the capital of France and its population?", "agt-aaaaaa") is None


def test_opencode_is_preferred_and_the_call_is_read_only_in_an_empty_folder(monkeypatch):
    calls = {}

    def fake_invoke(capability, payload, context, cfg):
        calls.update(capability=capability, payload=payload, context=context, existed=os.listdir(context["cwd"]))
        calls["folder"] = context["cwd"]
        return {"outcome": "succeeded", "output": {"stdout": "## Answer\nParis.\n\n✗ Glob \"*\" failed\nError: noise"}}

    monkeypatch.setattr(fabric, "invoke_fabric", fake_invoke)
    svc = _service([{"id": "kilo-code", "name": "Kilo Code"}, {"id": "opencode", "name": "OpenCode"}])
    port = svc._agent_text_port("What is the capital of France and its population?", "agt-aaaaaa")
    assert port.providers[0].id == "opencode"
    assert port.complete_stream("sys", "usr") == "## Answer\nParis."
    assert calls["capability"] == "agent.delegate" and calls["payload"]["role"] == "research"
    assert calls["context"]["nodeId"] == "opencode"
    assert calls["existed"] == []                          # an empty folder: there is no project to change
    assert not os.path.exists(calls["folder"])             # and it is removed afterwards


def test_a_failed_agent_run_gives_no_answer(monkeypatch):
    monkeypatch.setattr(fabric, "invoke_fabric", lambda *a, **k: {"outcome": "failed", "output": {"stdout": "x"}})
    assert _service([])._agent_answer("opencode", "q", None) is None

    def boom(*a, **k):
        raise RuntimeError("no worker")

    monkeypatch.setattr(fabric, "invoke_fabric", boom)
    assert _service([])._agent_answer("opencode", "q", None) is None


def test_the_answer_is_attributed_to_the_agent_that_wrote_it():
    from aura.central_agent.provider_bridge import ProviderBridge

    port = AgentTextPort(lambda prompt, stop: "an answer", "opencode", "OpenCode")
    result = ProviderBridge(port).complete_stream("answer", "s", "u")
    assert result.ok and result.provider == "opencode" and "OpenCode" in result.model


def test_the_answer_call_is_flagged_as_reasoning_so_opencode_uses_its_plan_agent(monkeypatch):
    calls = {}
    monkeypatch.setattr(fabric, "invoke_fabric",
                        lambda cap, payload, ctx, cfg: calls.update(payload=payload) or {"outcome": "succeeded", "output": {"stdout": "ok"}})
    svc = _service([{"id": "opencode", "name": "OpenCode"}])
    svc._agent_text_port("What is the capital of France and its population?", "agt-aaaaaa").complete_stream("s", "u")
    assert calls["payload"]["reasoner"] is True
