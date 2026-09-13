"""Phase 1.3: provider bridge contract tests.

Covers the 14 required behaviors with deterministic doubles at the
bridge boundary (fake ports, scripted HTTP): resolution, fallback,
missing/unsupported/timeout/cancel classification, secret redaction,
correlation, metadata, renderer isolation, honest degradation, and
agent integration. No real provider calls, no fabricated successes.
"""

import json
import os
import urllib.error

import pytest

from aura.central_agent.intent import ScriptedModelPort
from aura.central_agent.model_routing import (
    FAILURE_CATEGORIES,
    ProviderSpec,
    RoutedModelPort,
    RoutingError,
    classify_failure,
    _StreamStopped,
)
from aura.central_agent.provider_bridge import (
    DEGRADED_CATEGORIES,
    BridgeResult,
    ProviderBridge,
    redact_secrets,
)


def _spec(**kw):
    base = {"id": "p", "base_url": "http://x", "model": "m",
            "api_key_env": "AURA_P13_KEY"}
    base.update(kw)
    return ProviderSpec(**base)


# 1. valid provider/model resolution -----------------------------------

def test_valid_resolution_returns_identity_and_text():
    os.environ["AURA_P13_KEY"] = "k"
    try:
        port = RoutedModelPort([_spec()])

        def fake_post(url, payload, headers, timeout):
            assert payload["model"] == "m"
            return {"choices": [{"message": {"content": '{"a": 1}'}}]}

        port._post = fake_post
        bridge = ProviderBridge(port)
        res = bridge.complete_json("plan", "s", "u", session_id="agt-1",
                                   request_id="req-1")
        assert res.ok and res.data == {"a": 1}
        assert (res.provider, res.model) == ("p", "m")
        assert res.requestId == "req-1" and res.sessionId == "agt-1"
        assert res.latencyMs is not None and res.latencyMs >= 0
        assert res.error_category is None and not res.degraded
    finally:
        del os.environ["AURA_P13_KEY"]


# 2. default provider fallback ------------------------------------------

def test_chain_falls_back_to_next_healthy_provider():
    os.environ["AURA_P13_KEY"] = "k"
    try:
        # max_retries=0: one failure exhausts the spec immediately, so
        # the chain must fail over (default retries would retry "bad"
        # first — verified separately by the retry design).
        port = RoutedModelPort([_spec(id="bad", max_retries=0),
                                _spec(id="good", max_retries=0)])
        calls = []

        def fake_post(url, payload, headers, timeout):
            calls.append(url)
            if len(calls) == 1:
                raise ConnectionRefusedError("down")
            return {"choices": [{"message": {"content": '{"a": 2}'}}]}

        port._post = fake_post
        res = ProviderBridge(port).complete_json("plan", "s", "u")
        assert res.ok and res.provider == "good" and res.data == {"a": 2}
    finally:
        del os.environ["AURA_P13_KEY"]


# 3/4. missing provider / model configuration ----------------------------

def test_missing_provider_configuration_is_honest():
    bridge = ProviderBridge(RoutedModelPort([]))
    res = bridge.complete_json("plan", "s", "u")
    assert not res.ok and res.error_category == "PROVIDER_NOT_CONFIGURED"
    assert res.degraded and res.provider == "unknown"


def test_missing_model_configuration_is_honest():
    os.environ["AURA_P13_KEY"] = "k"
    try:
        port = RoutedModelPort([_spec(model="")])
        res = ProviderBridge(port).complete_json("plan", "s", "u")
        assert not res.ok and res.error_category in (
            "MODEL_NOT_CONFIGURED", "PROVIDER_NOT_CONFIGURED")
        assert res.degraded
    finally:
        del os.environ["AURA_P13_KEY"]


def test_no_port_means_honest_degradation():
    bridge = ProviderBridge(None)
    assert not bridge.available
    res = bridge.complete_stream("answer", "s", "u")
    assert not res.ok
    assert res.error_category == "PROVIDER_NOT_CONFIGURED"
    assert res.degraded


# 5. unsupported provider -------------------------------------------------

def test_retry_before_failover_is_honest():
    """A single failure retries the SAME spec first (capped retries),
    and telemetry attributes the answer to whichever spec answered."""
    os.environ["AURA_P13_KEY"] = "k"
    try:
        port = RoutedModelPort([_spec(id="flaky", max_retries=2)])
        calls = []

        def fake_post(url, payload, headers, timeout):
            calls.append(1)
            if len(calls) == 1:
                raise ConnectionRefusedError("down")
            return {"choices": [{"message": {"content": json.dumps({"a": 3})}}]}

        port._post = fake_post
        res = ProviderBridge(port).complete_json("plan", "s", "u")
        assert res.ok and res.data == {"a": 3}
        assert res.provider == "flaky" and len(calls) == 2
    finally:
        del os.environ["AURA_P13_KEY"]


def test_port_without_streaming_is_unsupported_not_failed():
    class JsonOnlyPort:
        def complete_json(self, system, user):
            return {"a": 1}

    res = ProviderBridge(JsonOnlyPort()).complete_stream("answer", "s", "u")
    assert not res.ok
    assert res.error_category == "PROVIDER_UNSUPPORTED"
    assert res.degraded


def test_unknown_purpose_rejected():
    bridge = ProviderBridge(ScriptedModelPort([]))
    with pytest.raises(ValueError, match="unsupported bridge purpose"):
        bridge.complete_json("execute", "s", "u")


# 6/7. auth + timeout classification ---------------------------------------

def test_auth_failure_classified():
    os.environ["AURA_P13_KEY"] = "k"
    try:
        port = RoutedModelPort([_spec()])

        def denied(url, payload, headers, timeout):
            raise urllib.error.HTTPError(url, 403, "Forbidden", {}, None)

        port._post = denied
        try:
            port.complete_json("s", "u")
            raised = False
        except RoutingError as exc:
            raised = True
            assert exc.category == "AUTHENTICATION_FAILED"
        assert raised
    finally:
        del os.environ["AURA_P13_KEY"]


def test_timeout_classified():
    assert classify_failure(TimeoutError("timed out")) == "PROVIDER_TIMEOUT"
    assert classify_failure(
        urllib.error.URLError("connection refused")) == "PROVIDER_UNAVAILABLE"
    err = urllib.error.HTTPError("http://x", 429, "slow", {}, None)
    assert classify_failure(err) == "RATE_LIMITED"
    err5 = urllib.error.HTTPError("http://x", 503, "down", {}, None)
    assert classify_failure(err5) == "PROVIDER_UNAVAILABLE"
    assert classify_failure(ValueError("no JSON")) == "INVALID_PROVIDER_RESPONSE"
    assert classify_failure(_StreamStopped()) == "REQUEST_CANCELLED"
    assert classify_failure(RuntimeError("weird")) == "INTERNAL_PROVIDER_ERROR"


# 8. cancellation ------------------------------------------------------------

def test_cancellation_is_cancelled_not_failed():
    seen = []

    class CancellingPort:
        def complete_stream(self, system, user, on_token=None,
                            should_stop=None):
            if callable(on_token):
                on_token("partial ")
            raise _StreamStopped()

    res = ProviderBridge(CancellingPort()).complete_stream(
        "answer", "s", "u", on_token=seen.append)
    assert not res.ok
    assert res.error_category == "REQUEST_CANCELLED"
    assert not res.degraded  # cancelled runs must not fall back silently
    assert seen == ["partial "]  # partial tokens stay visible (honest)


# 9. secret redaction ----------------------------------------------------------

def test_secrets_redacted_everywhere():
    dirty = {
        "apiKey": "sk-live-0123456789abcdef",
        "nested": {"authorization": "Bearer abcdef1234567890",
                   "totalTokens": 42},
        "headers": ["Bearer zyxwvutsrqponmlk"],
        "note": "nothing sensitive here",
    }
    clean = redact_secrets(dirty)
    blob = json.dumps(clean)
    assert "sk-live-0123456789abcdef" not in blob
    assert "abcdef1234567890" not in blob
    assert "zyxwvutsrqponmlk" not in blob
    assert clean["nested"]["totalTokens"] == 42
    assert clean["note"] == "nothing sensitive here"
    assert "[REDACTED]" in blob


def test_routing_errors_carry_no_secrets():
    os.environ["AURA_P13_VERY_SECRET_KEY_9Z"] = "supersecretvalue12345"
    try:
        port = RoutedModelPort([_spec(api_key_env="AURA_P13_VERY_SECRET_KEY_9Z")])

        def boom(url, payload, headers, timeout):
            raise ConnectionRefusedError("down")

        port._post = boom
        try:
            port.complete_json("s", "u")
            raised = None
        except RoutingError as exc:
            raised = exc
        assert raised is not None
        assert "supersecretvalue12345" not in str(raised)
        assert "supersecretvalue12345" not in json.dumps(port.telemetry())
    finally:
        del os.environ["AURA_P13_VERY_SECRET_KEY_9Z"]


# 10/11. correlation + metadata -------------------------------------------------

def test_correlation_and_metadata_flow():
    port = ScriptedModelPort([("needle", "word one two")])
    got = []
    res = ProviderBridge(port).complete_stream(
        "answer", "s", "say needle here", on_token=got.append,
        session_id="agt-9", request_id="req-9")
    assert res.ok and res.text == "word one two"
    assert got and "".join(got) == "word one two"
    assert res.sessionId == "agt-9" and res.requestId == "req-9"
    assert res.purpose == "answer"


# 12. renderer isolation (static: no key material may exist client-side) -------

def test_no_renderer_credential_exposure():
    """No key-shaped VALUES may exist client-side. Prefix literals used
    for provider detection (e.g. onboarding/detectProviderId.ts matching
    `sk-ant-` as a pattern) are legitimate and must not trip this."""
    import pathlib
    import re

    root = pathlib.Path(__file__).resolve().parents[3]
    value_re = re.compile(
        r"sk-(?:ant|live)-[A-Za-z0-9\-_]{10,}|"
        r"Bearer\s+eyJ[A-Za-z0-9\-_]+|"
        r"apiKey\s*[:=]\s*['\"][^'\"]{8,}")
    offenders = []
    for path in (root / "apps" / "desktop" / "src").rglob("*.ts*"):
        if ".test." in path.name:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if value_re.search(text):
            offenders.append(path.name)
    assert offenders == [], offenders


# 13/14. honest degradation + agent integration ----------------------------------

def test_agent_falls_back_honestly_without_provider(tmp_path):
    from aura.central_agent import AgentSessionStore, CentralAgent
    from aura.central_agent.intent import IntentCompiler
    from aura.fabric import FabricConfig

    cfg = FabricConfig(fabric=None, audit_store=None, ledger=None,
                       permissions={}, executors={}, secrets=None)
    agent = CentralAgent(
        fabric_cfg=cfg, session_store=AgentSessionStore(tmp_path),
        intent_compiler=IntentCompiler(mode="heuristic"))
    res = agent.submit("Explain this project briefly")
    assert res.outcome == "needs-clarification"
    assert "no-model" in (res.failureReason or "") or res.summary


def test_agent_answer_carries_model_identity_in_evidence(tmp_path):
    from aura.central_agent import AgentSessionStore, CentralAgent
    from aura.central_agent.execution import ExecutionOutcome
    from aura.central_agent.intent import IntentCompiler
    from aura.contracts import TaskOutcome, TaskPlan
    from aura.fabric import FabricConfig

    port = ScriptedModelPort([("anything", "Summary text here.")])
    cfg = FabricConfig(fabric=None, audit_store=None, ledger=None,
                       permissions={}, executors={}, secrets=None)
    agent = CentralAgent(
        fabric_cfg=cfg, session_store=AgentSessionStore(tmp_path),
        intent_compiler=IntentCompiler(
            mode="model", model_port=port, allow_heuristic_fallback=True))
    session = agent.sessions.create("proj-1")
    agent.sessions.append_message(session, "user", "Summarize anything.")
    agent.sessions.save(session)
    plan = TaskPlan.model_validate({
        "planId": "pln-1", "sessionId": session.sessionId,
        "intent": {"goal": "g", "expectedOutcome": "e"},
        "tasks": [{"id": "t1", "description": "d",
                   "capabilityId": "agent.delegate",
                   "verification": {"kind": "audit-only"}}],
        "createdAt": "2026-01-01T00:00:00Z"})
    row = TaskOutcome.model_validate({
        "taskId": "t1", "state": "done", "performed": True, "verified": True})
    outcome = ExecutionOutcome(
        outcomes=[row],
        verified_outputs={"t1": {"node_id": "n", "agent": "a",
                                 "stdout": "out", "scope_paths": []}})
    result = agent._synthesize(session, plan, outcome)
    assert result.outcome == "completed"
    assert "Summary text here." in result.summary
    # Scripted ports carry no telemetry: identity stays honestly unknown
    # in events, and evidence carries no fabricated model name.
    assert result.evidence is not None
    assert result.evidence.modelProvider is None
    assert result.evidence.modelName is None


def test_failure_categories_closed_set():
    assert FAILURE_CATEGORIES >= {
        "PROVIDER_NOT_CONFIGURED", "MODEL_NOT_CONFIGURED",
        "PROVIDER_UNSUPPORTED", "AUTHENTICATION_FAILED", "RATE_LIMITED",
        "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE",
        "INVALID_PROVIDER_RESPONSE", "REQUEST_CANCELLED",
        "INTERNAL_PROVIDER_ERROR",
    }
