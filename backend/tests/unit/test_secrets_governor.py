"""Governor-boundary security: {{secret:X}} resolves ONLY into Fabric args;
every recorded surface (summary, output text, error, timeline) shows the
visible redaction marker — never the value. Mirrors governor.ts contract.
"""
from __future__ import annotations

import asyncio
import json

from aura.workflow.governor import create_governor


class SecretStoreStub:
    """Real resolve/redact semantics without touching disk."""

    def __init__(self, values):
        self._values = values

    def known_values(self):
        return list(self._values.values())

    def resolve(self, text):
        used, missing = [], []
        import re

        def repl(m):
            name = m.group(1)
            if name not in self._values:
                missing.append(name)
                return ""
            used.append(name)
            return self._values[name]

        out = re.sub(r"\{\{\s*secret:([\w.-]+)\s*\}\}", repl, text)
        if missing:
            raise RuntimeError(f"not stored: {', '.join(missing)}")
        return {"text": out, "used": used}

    def redactor(self):
        vals = sorted((v for v in self._values.values() if len(v) >= 4), key=len, reverse=True)

        def scrub(t):
            for v in vals:
                t = t.replace(v, "••••")
            return t
        return scrub


class CaptureFabric:
    def __init__(self):
        self.captured = None

    async def invoke(self, capability_id, input, context):
        self.captured = {"capabilityId": capability_id, "input": json_copy(input)}

        # echo the (resolved) token back through stdout — the leak attempt
        stdout = json.dumps({"token": input.get("token")})
        return {"invocationId": "inv-1", "capabilityId": capability_id,
                "outcome": "succeeded", "detail": "done",
                "output": {"stdout": stdout, "exitCode": 0},
                "verification": {"passed": True, "kind": "exit-code", "detail": "0"},
                "policy": {"decision": "auto-execute", "rule": "risk-default:low",
                           "risk": "low", "reason": "low"},
                "startedAt": "t", "endedAt": "t", "durationMs": 1, "attempts": 1}


def json_copy(x):
    import copy
    return copy.deepcopy(x)


SECRET = "sk-live-999888777666"
NODE = {"id": "n1", "type": "http-request",
        "config": {"url": "https://api.test/{{secret:API_TOKEN}}"}}


def _governor():
    return create_governor(
        fabric=CaptureFabric(),
        secrets=SecretStoreStub({"API_TOKEN": SECRET}),
        workflow_id="wf-1", run_id="wr-1", project_id="p",
        project_path="/p", actor={"kind": "agent", "id": "agent:x"},
    )


def test_secret_resolves_into_args(capfd):
    g = _governor()
    outcome = asyncio.run(g.run(NODE, {"vars": {}}, {"text": ""}, lambda t: t))
    assert outcome["kind"] == "succeeded"


def test_resolved_value_never_reaches_recorded_text():
    g = _governor()

    captured = {}

    class Cap(CaptureFabric):
        async def invoke(self, cap, inp, ctx):
            captured["input"] = inp
            return {"invocationId": "inv-2", "capabilityId": cap,
                    "outcome": "succeeded",
                    "detail": f"called {inp.get('token')}",   # hostile executor leaks it
                    "output": {"stdout": json.dumps({"echoed_url": inp.get("url")})},
                    "verification": {"passed": True, "kind": "http-status",
                                     "detail": "200"},
                    "policy": {"decision": "auto-execute", "rule": "risk-default:low",
                               "risk": "low", "reason": "low"},
                    "startedAt": "t", "endedAt": "t", "durationMs": 1, "attempts": 1}

    g2 = create_governor(fabric=Cap(), secrets=SecretStoreStub({"API_TOKEN": SECRET}),
                         workflow_id="wf", run_id="wr", project_id="p",
                         project_path="/p", actor={"kind": "agent", "id": "a"})
    node = {"id": "n1", "type": "http-request",
            "config": {"url": "https://api.test/{{secret:API_TOKEN}}"}}
    out = asyncio.run(g2.run(node, {"vars": {}}, {"text": ""}, lambda t: t))
    # the VALUE reached the fabric args (that is the one sanctioned place)…
    assert captured["input"]["url"].endswith(SECRET)
    # …but every recorded surface shows only the visible marker:
    assert SECRET not in out["text"] and REDACTION in out["text"]


from aura.secrets import REDACTION


def test_missing_secret_fails_node_not_sends_reference():
    g = create_governor(fabric=CaptureFabric(), secrets=SecretStoreStub({}),
                        workflow_id="w", run_id="r", project_id="p",
                        project_path="/p", actor={"kind": "agent", "id": "a"})
    out = asyncio.run(g.run(NODE, {"vars": {}}, {"text": ""}, lambda t: t))
    assert out["kind"] == "failed" and out["summary"] == "missing secret"
    assert "API_TOKEN" in out["error"]
