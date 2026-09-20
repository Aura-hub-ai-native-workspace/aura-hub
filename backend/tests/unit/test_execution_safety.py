"""Fail-closed execution plumbing: unknown outcomes, broken registries,
unverifiable worker pins, tampered identities, and escaping paths.

Each test pins a refusal or degradation that used to be a crash, a
silent success, or an indistinguishable "no workers" answer.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from aura.central_agent.authority import _requested_node_denial
from aura.central_agent.execution import ExecutionController, _outcome_state
from aura.environment.pathsec import FileIdentity
from aura.executors import inside
from aura.fabric.executors import _confine


class TestOutcomeStates:
    @pytest.mark.parametrize("outcome,expected", [
        ("succeeded", "done"),
        ("unverified", "done"),
        ("denied", "denied"),
        ("awaiting-approval", "awaiting-approval"),
        ("failed", "failed"),
        ("unsupported", "blocked"),
    ])
    def test_known_outcomes_map(self, outcome, expected):
        assert _outcome_state(outcome) == expected

    @pytest.mark.parametrize("outcome", ["timed-out", "cancelled", "", "DONE"])
    def test_unknown_outcomes_fail_closed_not_crash(self, outcome):
        assert _outcome_state(outcome) == "failed"


class TestPresentNodesError:
    def _controller(self, host):
        ctrl = ExecutionController.__new__(ExecutionController)
        ctrl._cfg = SimpleNamespace(fabric=SimpleNamespace(host=host))
        ctrl._nodes_error = None
        return ctrl

    def test_registry_failure_named_not_empty(self):
        def boom():
            raise RuntimeError("registry disk gone")

        ctrl = self._controller(SimpleNamespace(present_nodes=boom))
        assert ctrl._present_nodes() == []
        assert ctrl._nodes_error == "registry disk gone"


class TestAuthorityFailClosed:
    def _cfg(self, resolve):
        return SimpleNamespace(
            fabric=SimpleNamespace(host=SimpleNamespace(
                resolve_node=resolve)))

    def _task(self):
        return SimpleNamespace(capabilityId="filesystem.read",
                               nodeId="ghost", input={}, risk="low")

    def test_host_error_denies_pin(self):
        def boom(_cap, _req):
            raise RuntimeError("host exploded")

        reason = _requested_node_denial(self._task(), self._cfg(boom))
        assert reason is not None
        assert "refusing" in reason

    def test_unusable_pin_still_denied(self):
        reason = _requested_node_denial(
            self._task(),
            self._cfg(lambda _cap, _req: {"ok": False,
                                          "reason": "node retired"}))
        assert reason == "node retired"


class TestFileIdentity:
    def _id(self, **kw):
        base = {"device": 1, "inode": 2, "mode": 0o100644, "size": 10,
                "mtime_ns": 5}
        base.update(kw)
        return FileIdentity(**base)

    def test_same_file_matches(self):
        assert self._id().matches(self._id()) is True

    def test_rewritten_in_place_does_not_match(self):
        # Same inode, new bytes: truncate-and-rewrite keeps the file
        # number on most filesystems. Size/mtime must catch it.
        assert self._id().matches(self._id(size=11)) is False
        assert self._id().matches(self._id(mtime_ns=6)) is False

    def test_replaced_file_does_not_match(self):
        assert self._id().matches(self._id(inode=3)) is False

    def test_none_never_matches(self):
        assert self._id().matches(None) is False


class TestConfinement:
    def test_inside_allows_member(self, tmp_path):
        target = tmp_path / "sub" / "f.txt"
        target.parent.mkdir()
        target.write_text("x")
        assert inside(str(tmp_path), "sub/f.txt") == str(target.resolve())

    def test_inside_refuses_escape(self, tmp_path):
        with pytest.raises(ValueError, match="leaves the project"):
            inside(str(tmp_path), "../evil.txt")

    def test_confine_allows_member(self, tmp_path):

        assert _confine(tmp_path, "a/b.txt") == (tmp_path / "a/b.txt").resolve()

    def test_confine_refuses_absolute_and_empty(self, tmp_path):
        with pytest.raises(ValueError):
            _confine(tmp_path, "/etc/passwd")
        with pytest.raises(ValueError):
            _confine(tmp_path, "  ")
