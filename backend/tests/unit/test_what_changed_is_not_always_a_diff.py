"""'what changed' asks for a git diff only about the repository, not about an outside subject."""
import pytest

from aura.central_agent.requested import read_only_request


@pytest.mark.parametrize("text", [
    "what changed?", "what has changed", "what changed in the repo", "what changed in my code",
    "show me the diff", "git diff",
])
def test_these_ask_for_the_working_tree_diff(text):
    assert read_only_request(text) == ("git.diff", {})


@pytest.mark.parametrize("text", [
    "What is the latest stable version of Node.js, and what changed in it?",
    "what changed in Python 3.13", "what changed in the last Kubernetes release",
])
def test_these_do_not(text):
    assert read_only_request(text) is None
