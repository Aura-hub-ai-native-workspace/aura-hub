"""Git actions are graded by what they do (F-13).

Reading repository state is read-only; creating a branch changes the
repository, like staging and committing. The tool table once graded branch
creation `low-risk`. Nothing enforces on that grade today, but a label that
understates a mutation is a latent hole: the first consumer to trust it would
treat a branch change as harmless. The fabric manifest, which does enforce,
already grades the mutating capabilities correctly; both are pinned here.
"""

from __future__ import annotations

import pytest

from aura.capabilities.tools import TOOL_SPECS
from aura.fabric.manifest import all_capabilities

GIT = {a["name"]: a for a in TOOL_SPECS["git"]["actions"]}


@pytest.mark.parametrize("name", ["status", "diff", "log", "branch-list"])
def test_reading_actions_are_read_only_and_have_a_fixed_command(name):
    assert GIT[name]["risk"] == "read-only"
    assert GIT[name]["argv"], "a read action runs a fixed argv, never a composed command"


@pytest.mark.parametrize("name", ["branch-create", "stage", "commit"])
def test_actions_that_change_the_repository_are_at_least_modify(name):
    assert GIT[name]["risk"] == "modify"


_ORDER = ["read-only", "low-risk", "modify", "destructive", "irreversible"]


def test_push_and_hard_reset_are_never_graded_below_modify():
    """Pinned as a floor, not an exact label: the tool table grades push
    `modify` while the manifest (which enforces) grades it high and
    irreversible. The floor keeps either from sliding toward harmless."""
    assert _ORDER.index(GIT["push"]["risk"]) >= _ORDER.index("modify")
    assert GIT["reset-hard"]["risk"] == "destructive"


def test_mutating_actions_have_no_command_template():
    """Planning metadata only: resolution refuses them instead of composing a
    command from caller input."""
    for name in ("branch-create", "stage", "commit", "push", "reset-hard"):
        assert GIT[name]["argv"] == []


def test_the_fabric_manifest_grades_git_capabilities_by_effect():
    caps = {c.id: c for c in all_capabilities()}
    for read_only in ("git.status", "git.diff"):
        assert caps[read_only].risk == "low"
        assert list(caps[read_only].permissions) == ["project.read"]
    for mutating in ("git.branch", "git.commit"):
        assert caps[mutating].risk == "medium"
        assert "project.write" in caps[mutating].permissions
    assert caps["git.push"].risk == "high"
    assert caps["git.push"].irreversible is True
