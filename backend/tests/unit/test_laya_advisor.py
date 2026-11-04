"""The Laya advisor: protocol, advisory-only answers, and silent failure."""
from __future__ import annotations

import sys
import textwrap

import pytest

from aura.central_agent.laya_advisor import LayaAdvisor

STUB_OK = textwrap.dedent("""
    import json, sys
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        req = json.loads(line)
        kind = "frontend" if "page" in req["state"]["body"] else "backend"
        print(json.dumps({"id": req["id"], "result": {"answers": {"decision": {
            "type": "choice", "choice": kind, "probabilities": {kind: 0.9, "other": 0.1}}}}}), flush=True)
""")
STUB_NOT_READY = 'import json\nprint(json.dumps({"ready": False, "error": "no model"}), flush=True)\n'


def _advisor(tmp_path, body: str) -> LayaAdvisor:
    script = tmp_path / "stub.py"
    script.write_text(body, encoding="utf-8")
    adv = LayaAdvisor(python=sys.executable, script=script, reply_timeout_s=10, ready_timeout_s=20)
    adv.warm()
    return adv


def _wait_ready(adv: LayaAdvisor) -> None:
    import time
    deadline = time.time() + 20
    while adv.state == "loading" and time.time() < deadline:
        time.sleep(0.05)


def test_advice_is_returned_once_the_worker_is_ready(tmp_path):
    adv = _advisor(tmp_path, STUB_OK)
    _wait_ready(adv)
    assert adv.state == "ready"
    got = adv.ask_choice("Build the landing page with the hero section", "Which kind?", {"frontend": "ui", "backend": "server"})
    assert got == ("frontend", 0.9)
    assert adv.ask_choice("Write the database migration", "Which kind?", {"frontend": "ui", "backend": "server"})[0] == "backend"
    adv._stop()


def test_nothing_is_said_until_the_model_is_ready(tmp_path):
    adv = LayaAdvisor(python=sys.executable, script=tmp_path / "missing.py")
    assert adv.ask_choice("anything", "Which?", {"a": "x"}) is None  # cold: starts loading, says nothing yet
    assert adv.state in ("loading", "failed", "disabled")


def test_a_worker_that_cannot_load_turns_the_advisor_off(tmp_path):
    adv = _advisor(tmp_path, STUB_NOT_READY)
    _wait_ready(adv)
    assert adv.state == "failed"
    assert adv.ask_choice("build a page", "Which?", {"a": "x"}) is None


def test_a_missing_interpreter_disables_without_raising(tmp_path):
    adv = LayaAdvisor(python=str(tmp_path / "no-such-python"), script=tmp_path / "x.py")
    adv.warm()
    _wait_ready(adv)
    assert adv.state == "disabled"
    assert adv.ask_choice("build a page", "Which?", {"a": "x"}) is None


STUB_WORKER = textwrap.dedent("""
    import json, sys
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        req = json.loads(line)
        choice = "kilo-code"
        print(json.dumps({"id": req["id"], "result": {"answers": {"worker": {
            "type": "choice", "choice": choice, "probabilities": {choice: 0.8, "opencode": 0.2}}}}}), flush=True)
""")
CANDIDATES = [{"id": "opencode", "name": "OpenCode"}, {"id": "kilo-code", "name": "Kilo Code"}]


def test_laya_chooses_an_allowed_worker(tmp_path):
    adv = _advisor(tmp_path, STUB_WORKER)
    _wait_ready(adv)
    assert adv.choose_worker("Build the page", CANDIDATES) == {"worker": "kilo-code", "probability": 0.8}
    adv._stop()


def test_laya_cannot_pick_a_worker_that_is_not_allowed(tmp_path):
    adv = _advisor(tmp_path, STUB_WORKER)
    _wait_ready(adv)
    assert adv.choose_worker("Build the page", [{"id": "opencode", "name": "OpenCode"}]) is None
    adv._stop()


def test_select_workers_uses_laya_pick_and_states_its_confidence():
    from aura.central_agent import plan_handoff as ph

    handoff = {"tasks": [{"id": "t1", "title": "Build the page", "description": "front end", "worker": None,
                          "targetFile": None, "files": []}]}
    out = ph.select_workers(handoff, CANDIDATES, [], chooser=lambda brief, c: {"worker": "kilo-code", "probability": 0.8})
    assert out["handoff"]["tasks"][0]["worker"] == "kilo-code"
    assert out["selections"][0]["reason"].startswith("Laya chose Kilo Code (80% sure)")


def test_an_unsure_laya_pick_is_still_the_choice_and_says_so():
    from aura.central_agent import plan_handoff as ph

    handoff = {"tasks": [{"id": "t1", "title": "Build the page", "description": "front end", "worker": None,
                          "targetFile": None, "files": []}]}
    out = ph.select_workers(handoff, CANDIDATES, [], chooser=lambda brief, c: {"worker": "opencode", "probability": 0.6})
    assert out["handoff"]["tasks"][0]["worker"] == "opencode"
    assert "60% sure" in out["selections"][0]["reason"]


def test_a_pick_outside_the_allowed_agents_stops_the_plan():
    from aura.central_agent import plan_handoff as ph

    handoff = {"tasks": [{"id": "t1", "title": "Build the page", "description": "front end", "worker": None,
                          "targetFile": None, "files": []}]}
    with pytest.raises(ph.HandoffError) as err:
        ph.select_workers(handoff, CANDIDATES, [], chooser=lambda brief, c: {"worker": "ghost", "probability": 0.9})
    assert err.value.code == "unavailable" and "Laya could not choose" in str(err.value)
    with pytest.raises(ph.HandoffError):
        ph.select_workers(handoff, CANDIDATES, [], chooser=None)


STUB_SMALL = textwrap.dedent("""
    import json, sys
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        req = json.loads(line)
        big = "feature" in req["state"]["body"]
        choice = "large" if big else "small"
        print(json.dumps({"id": req["id"], "result": {"answers": {"decision": {
            "type": "choice", "choice": choice, "probabilities": {choice: 0.9}}}}}), flush=True)
""")


def test_a_small_edit_is_recognised_and_a_feature_is_not(tmp_path):
    adv = _advisor(tmp_path, STUB_SMALL)
    _wait_ready(adv)
    assert adv.is_small_edit("Add a footer to index.html") is True
    assert adv.is_small_edit("Build a whole new feature with several pages") is False
    adv._stop()


def test_laya_python_lives_where_the_platform_puts_a_virtual_environment():
    from aura.central_agent.laya_advisor import default_python

    assert default_python("posix").parts[-2:] == ("bin", "python")
    assert default_python("nt").parts[-2:] == ("Scripts", "python.exe")
