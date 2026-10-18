"""Clarification lifecycle — a session waiting on the user must be
distinguishable from one that is planning, and must resume cleanly.

Real central agent over the real session store and audit trail; only the
model layer is deterministic (heuristic mode). Reuses the slice fixture so
the governance spine is the one production uses.
"""

from __future__ import annotations

from test_central_agent_slice import env  # noqa: F401  (fixture)


def test_clarification_persists_pending_question_and_runs_nothing(env):
    home, audit, _, _, agent = env
    before = len(audit.load())
    result = agent.submit("flurb the bazzle quux", session_id="agt-c1a2c3d4e5f6")
    assert result.outcome == "needs-clarification"
    assert result.status == "planning"
    session = agent.sessions.load("agt-c1a2c3d4e5f6")
    assert session is not None
    # The waiting state is identifiable: a stored question, not just a label.
    assert session.pendingQuestion
    assert session.pendingQuestion == result.summary
    # Waiting for the user executes nothing.
    assert len(audit.load()) == before


def test_answer_consumes_pending_question_and_resumes(env):
    home, audit, _, _, agent = env
    agent.submit("flurb the bazzle quux", session_id="agt-0badc0ffee01")
    # Production continuation: the desktop sends /agent/sessions/{id}/message,
    # which loads the session and continues it.
    result = agent.message("agt-0badc0ffee01", "list my workflows")
    session = agent.sessions.load("agt-0badc0ffee01")
    # The answer is folded into the original request, not treated as new.
    assert any("Clarification answer" in m.content
               for m in session.messages if m.role == "user")
    # No stale question lingers: either the session ran, or whatever is
    # pending now is the FRESH question produced by this answer.
    if result.outcome == "needs-clarification":
        assert session.pendingQuestion == result.summary
    else:
        assert session.pendingQuestion is None
        assert result.status in ("completed", "failed", "awaiting-approval", "verifying")


def test_direct_submit_with_existing_id_leaves_original_pending(env):
    """Documented contract (sessions.create): a caller-supplied id that is
    already taken is never reused, so a plain submit cannot hijack or
    overwrite a session. Continuation must go through message()."""
    home, audit, _, _, agent = env
    agent.submit("flurb the bazzle quux", session_id="agt-5eedc0ffee02")
    agent.submit("list my workflows", session_id="agt-5eedc0ffee02")
    original = agent.sessions.load("agt-5eedc0ffee02")
    assert original.pendingQuestion  # the original waiting state is untouched
