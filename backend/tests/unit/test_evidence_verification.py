"""Evidence-present verification for delegated workers.

A process that exits 0 has finished; it has not necessarily done the work.
These tests pin the verdict for each case the brief names, against a real
project directory on disk. The verdict is decided by the executor's own
verify function, not by a mock.
"""

from __future__ import annotations

import asyncio

import pytest

from aura.executors import agent_delegate_verify


@pytest.fixture()
def project(tmp_path):
    (tmp_path / "alpha").mkdir()
    (tmp_path / "alpha" / "a.txt").write_text("alpha A: the fixture line.\n")
    (tmp_path / "empty.txt").write_text("\n\n")
    return tmp_path


def _verify(project, required, stdout, exit_code=0, scope_deviation=False):
    inv = {"context": {"cwd": str(project)},
           "input": {"task": "inspect"} if required is None else {"task": "inspect", "requiredEvidence": required}}
    output = {"stdout": stdout, "exitCode": exit_code}
    if scope_deviation:
        output["scopeDeviation"] = True
        output["scopeCheck"] = {"outside": ["x"]}
    return asyncio.run(agent_delegate_verify(inv, {"output": output}))


def test_exit_zero_with_no_observable_work_is_not_evidence(project):
    v = _verify(project, ["alpha/a.txt"], stdout="")
    assert v["passed"] is False
    assert v["kind"] == "evidence-present"
    assert "alpha/a.txt" in v["detail"]


def test_exit_zero_with_banner_only_output_is_not_evidence(project):
    """CLI chrome names the file it touched but does not show its content."""
    v = _verify(project, ["alpha/a.txt"],
                stdout="[0m> model banner\n→ Read alpha/a.txt\n")
    assert v["passed"] is False


def test_exit_zero_with_the_artifact_content_is_evidence(project):
    v = _verify(project, ["alpha/a.txt"],
                stdout="FINDINGS\nalpha A: the fixture line.\n")
    assert v["passed"] is True
    assert v["kind"] == "evidence-present"


def test_nonzero_exit_fails_even_when_content_appears(project):
    v = _verify(project, ["alpha/a.txt"],
                stdout="alpha A: the fixture line.", exit_code=2)
    assert v["passed"] is False
    assert v["kind"] == "exit-code"


def test_scope_deviation_still_fails_first(project):
    v = _verify(project, ["alpha/a.txt"],
                stdout="alpha A: the fixture line.", scope_deviation=True)
    assert v["passed"] is False


def test_every_required_file_must_be_evidenced(project):
    (project / "alpha" / "b.txt").write_text("alpha B: other line\n")
    v = _verify(project, ["alpha/a.txt", "alpha/b.txt"],
                stdout="alpha A: the fixture line.")
    assert v["passed"] is False
    assert "alpha/b.txt" in v["detail"]


def test_missing_file_fails_closed(project):
    v = _verify(project, ["alpha/missing.txt"], stdout="anything")
    assert v["passed"] is False
    assert "not a file in the project" in v["detail"]


def test_path_escape_is_refused(project):
    v = _verify(project, ["../outside.txt"], stdout="anything")
    assert v["passed"] is False
    assert "not a file in the project" in v["detail"]


def test_absolute_path_is_refused(project):
    v = _verify(project, ["/etc/hostname"], stdout="anything")
    assert v["passed"] is False


def test_empty_artifact_has_no_marker_and_fails(project):
    v = _verify(project, ["empty.txt"], stdout="anything")
    assert v["passed"] is False
    assert "no marker" in v["detail"]


@pytest.mark.parametrize("bad", ["alpha/a.txt", [], [""], [3], {"a": 1}])
def test_malformed_metadata_fails_closed(project, bad):
    v = _verify(project, bad, stdout="alpha A: the fixture line.")
    assert v["passed"] is False
    assert "malformed" in v["detail"]


def test_legacy_task_without_metadata_keeps_process_only_verdict(project):
    """Results and tasks from before this contract still verify as before,
    but the detail says what was checked: the process, not the work."""
    v = _verify(project, None, stdout="")
    assert v["passed"] is True
    assert v["kind"] == "exit-code"
    assert "no evidence" in v["detail"]
