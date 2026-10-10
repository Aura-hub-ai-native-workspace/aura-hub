"""Malformed-but-received model output → deterministic intent.

The regression these tests pin is a real production failure. A local
model trapped in a repetition loop emits a truncated JSON object once
generation is bounded:

    "requiredCapabilities": ["workflow.create", "workflow.list",
     "workflow.create", "workflow.list", ...

`json.loads` then raises inside `RoutedModelPort.complete_json`, which
folds it into a `RoutingError`. Before this was wired, that failure was
indistinguishable from a network outage and killed the turn, even
though the provider HAD answered.

So the boundary these tests defend is precise: a response that ARRIVED
and could not be understood may fall back to the deterministic
interpreter; a response that NEVER arrived must stay a hard failure.
Inventing an intent for an outage would be a lie about what the machine
did.
"""

from __future__ import annotations

import json

import pytest

from aura.central_agent.intent import (
    IntentCompilationError,
    IntentCompiler,
)
from aura.central_agent.model_routing import (
    ProviderSpec,
    RoutedModelPort,
    _first_json_object,
)

#: Exactly the shape observed from Ollama when qwen2.5-coder:1.5b loops
#: on the full capability manifest and generation is cut at max_tokens.
#: The live failure was `Expecting ',' delimiter: line 13 column 6`, so
#: the object IS emitted and closed — it is the repeated array that is
#: structurally broken, not a missing brace. Reproduced here verbatim in
#: shape: elements run together with no separating comma.
TRUNCATED_COMPLETION = (
    "```json\n"
    "{\n"
    '  "goal": "inspect backend and frontend",\n'
    '  "entities": [],\n'
    '  "constraints": [],\n'
    '  "requestedOutcome": "a combined summary",\n'
    '  "expectedOutcome": "a combined summary",\n'
    '  "ambiguity": "clear",\n'
    '  "confidence": 1.0,\n'
    '  "urgency": "immediate",\n'
    '  "complexity": "multi-step",\n'
    '  "requiredCapabilities": [\n'
    '    "workflow.create" "workflow.list" "workflow.run"\n'
    '    "workflow.inspect" "workflow.create" "workflow.list"\n'
    "  ]\n"
    "}\n"
    "```"
)

TWO_WORKER_REQUEST = (
    "Use two independent AI workers in parallel on this same project. "
    "Have Claude Code inspect the backend architecture and Kilo Code "
    "inspect the frontend architecture. Neither task should modify files."
)


def _port_returning(content: str) -> RoutedModelPort:
    """A real RoutedModelPort whose HTTP layer yields one Ollama body."""
    spec = ProviderSpec(id="local-ollama",
                        base_url="http://127.0.0.1:11434/v1",
                        model="qwen2.5-coder:1.5b", max_retries=0)
    calls = []

    def fake_post(url, payload, headers, timeout_s):
        calls.append((url, payload))
        return {"choices": [{"message": {"content": content},
                             "finish_reason": "length"}]}

    return RoutedModelPort([spec], post=fake_post), calls


class TestMalformedOutputFallsBack:
    def test_truncated_json_object_is_really_unparseable(self):
        """Guard the premise: the loop output must fail with the SAME
        error the live run produced. If a future model stops looping this
        test would otherwise pass for the wrong reason."""
        match = _first_json_object(TRUNCATED_COMPLETION)
        assert match is not None, "an object was emitted and closed"
        with pytest.raises(json.JSONDecodeError) as err:
            json.loads(match)
        assert "Expecting ',' delimiter" in str(err.value)

    def test_permissive_compiler_returns_valid_intent(self):
        port, _ = _port_returning(TRUNCATED_COMPLETION)
        compiler = IntentCompiler(mode="model", model_port=port,
                                  allow_heuristic_fallback=True)
        intent = compiler.compile(TWO_WORKER_REQUEST, "CONTEXT")

        # A real, normalized AgentIntent — validated by construction.
        assert intent.goal
        assert intent.expectedOutcome
        assert isinstance(intent.requiredCapabilities, list)

    def test_original_parse_failure_stays_observable(self, caplog):
        port, _ = _port_returning(TRUNCATED_COMPLETION)
        compiler = IntentCompiler(mode="model", model_port=port,
                                  allow_heuristic_fallback=True)
        with caplog.at_level("WARNING"):
            compiler.compile(TWO_WORKER_REQUEST, "CONTEXT")

        warnings = [r.getMessage() for r in caplog.records
                    if r.levelname == "WARNING"]
        assert any("unusable output" in m for m in warnings), warnings
        assert any("model routing failed" in m for m in warnings), (
            "the provider's own failure text must survive into the log")

    def test_fallback_sends_no_second_provider_call(self):
        """One received answer, one decision — no retry storm, no
        fabricated second completion."""
        port, calls = _port_returning(TRUNCATED_COMPLETION)
        compiler = IntentCompiler(mode="model", model_port=port,
                                  allow_heuristic_fallback=True)
        compiler.compile(TWO_WORKER_REQUEST, "CONTEXT")
        assert len(calls) == 1

    def test_no_worker_execution_is_invented(self):
        """Compilation describes intent. It must never assert that any
        worker ran, produced output, or was verified.

        Asserted on the DUMPED KEYS, not on prose: the deterministic
        fallback legitimately writes words like "verified" into its
        expectedOutcome, and prose is not a claim of execution.
        `ContractModel` allows extra fields, so a key scan is the only
        honest check that no execution result rode along.
        """
        port, _ = _port_returning(TRUNCATED_COMPLETION)
        compiler = IntentCompiler(mode="model", model_port=port,
                                  allow_heuristic_fallback=True)
        intent = compiler.compile(TWO_WORKER_REQUEST, "CONTEXT")
        dumped = set(intent.model_dump())

        for claim in ("performed", "verified", "evidence", "invocationId",
                      "auditRef", "runId", "verification", "outputs",
                      "workerResults", "status", "outcome"):
            assert claim not in dumped, (
                f"intent compilation invented execution claim {claim!r}")

        # It DID delegate-intent, which is a request, not a result.
        assert intent.requiredCapabilities, "intent should still say what is wanted"


class TestStrictCompilerStillFailsClosed:
    def test_strict_compiler_raises_on_malformed_json(self):
        port, _ = _port_returning(TRUNCATED_COMPLETION)
        compiler = IntentCompiler(mode="model", model_port=port,
                                  allow_heuristic_fallback=False)
        with pytest.raises(IntentCompilationError) as err:
            compiler.compile(TWO_WORKER_REQUEST, "CONTEXT")
        assert "model routing failed" in str(err.value)


class TestUnrelatedFailuresNeverFallBack:
    """No answer arrived → stay loud. These must NOT be softened."""

    @pytest.mark.parametrize("category", [
        "PROVIDER_TIMEOUT",
        "PROVIDER_UNAVAILABLE",
        "AUTHENTICATION_FAILED",
        "RATE_LIMITED",
        "REQUEST_CANCELLED",
        "PROVIDER_NOT_CONFIGURED",
        "MODEL_NOT_CONFIGURED",
        "INTERNAL_PROVIDER_ERROR",
    ])
    def test_non_response_categories_are_hard_failures(self, category):
        from aura.central_agent.model_routing import RoutingError

        def boom(*_a, **_k):
            raise RoutingError("provider is unreachable", category)

        spec = ProviderSpec(id="local-ollama",
                            base_url="http://127.0.0.1:11434/v1",
                            model="qwen2.5-coder:1.5b", max_retries=0)
        port = RoutedModelPort([spec], post=boom)
        compiler = IntentCompiler(mode="model", model_port=port,
                                  allow_heuristic_fallback=True)
        with pytest.raises(IntentCompilationError) as err:
            compiler.compile(TWO_WORKER_REQUEST, "CONTEXT")
        assert "model routing failed" in str(err.value)

    def test_unconfigured_provider_still_fails_closed(self):
        """No port at all is a construction error, not a soft one — the
        guard must not be reachable by turning on the fallback."""
        with pytest.raises(ValueError):
            IntentCompiler(mode="model", model_port=None,
                           allow_heuristic_fallback=True)
