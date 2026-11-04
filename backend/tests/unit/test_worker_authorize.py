"""The owner's Allow click records one worker in worker-policy.json and nothing else."""
from __future__ import annotations

import json

import pytest

pytestmark = pytest.mark.real_billing_policy
from starlette.testclient import TestClient

from aura.api.server import create_app
from aura.workers.billing import authorize, decide


def test_authorize_allows_exactly_that_worker(tmp_path):
    assert not decide("opencode", tmp_path).allowed
    d = authorize("opencode", tmp_path)
    assert d.allowed and d.billing == "owner-authorized"
    assert not decide("claude-code", tmp_path).allowed


def test_other_policy_keys_survive_and_ids_are_not_duplicated(tmp_path):
    (tmp_path / "worker-policy.json").write_text(json.dumps({"verifiedFree": ["kilo-code"], "timeoutMs": 90000, "authorized": ["opencode"]}))
    authorize("opencode", tmp_path)
    authorize("claude-code", tmp_path)
    raw = json.loads((tmp_path / "worker-policy.json").read_text())
    assert raw["verifiedFree"] == ["kilo-code"] and raw["timeoutMs"] == 90000
    assert raw["authorized"] == ["claude-code", "opencode"]


def test_an_unknown_worker_cannot_be_authorized(tmp_path):
    with pytest.raises(ValueError):
        authorize("rm -rf", tmp_path)
    assert not (tmp_path / "worker-policy.json").exists()


def test_the_route_authorizes_and_rejects_unknown_ids(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    c = TestClient(create_app())
    ok = c.post("/workers/authorize", json={"id": "opencode"})
    assert ok.status_code == 200 and ok.json()["authorized"] is True
    assert c.post("/workers/authorize", json={"id": "nope"}).status_code == 400
    assert decide("opencode", tmp_path).allowed and not decide("codex-cli", tmp_path).allowed
