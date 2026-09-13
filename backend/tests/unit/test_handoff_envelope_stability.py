"""A handoff envelope must render identically on the leg that requests
approval and the leg that resumes it.

The envelope becomes part of the dependent task's input, and the
approval on record is bound to that input. The two legs do not hold the
same evidence object: the first has the worker's live stdout, the second
rebuilds from a persisted, length-bounded copy. When the envelope quotes
"N more characters", N is computed from whatever copy is at hand — so
the resumed envelope differed from the approved one, the Fabric refused
the grant as "a different action than the one requested", and the run
parked again on an approval the human had already decided. Nothing could
grant it a second time, so a multi-worker plan could not finish.

The body bytes were always identical. Only the count moved.
"""
from aura.central_agent.handoff import (
    MAX_ENVELOPE_CHARS,
    MAX_SOURCE_CHARS,
    UpstreamEvidence,
    build_envelope,
)
from aura.central_agent.service import CentralAgent
from aura.contracts.agent import AgentSession

LONG = "".join(f"line {i} of real worker output\n" for i in range(900))
assert len(LONG) > MAX_ENVELOPE_CHARS, "fixture must exceed the persist bound"


def _live_record() -> dict:
    """Shape written by ExecutionController._record_verified_output."""
    return {
        "task_id": "implement",
        "node_id": "opencode",
        "agent": "OpenCode",
        "stdout": LONG,
        "stdout_chars": len(LONG),
        "scope_paths": [],
        "changed_paths": [],
        "invocation_ids": ["inv-1"],
        "approval_ids": [],
    }


def _evidence(rec: dict) -> UpstreamEvidence:
    return UpstreamEvidence(
        task_id=rec["task_id"], node_id=rec["node_id"], agent=rec["agent"],
        stdout=rec["stdout"], stdout_chars=int(rec.get("stdout_chars") or 0),
        scope_paths=list(rec["scope_paths"]),
        changed_paths=list(rec["changed_paths"]),
        invocation_ids=list(rec["invocation_ids"]),
        approval_ids=list(rec["approval_ids"]))


def _round_trip(rec: dict) -> dict:
    """Persist and restore exactly as a parked session does."""
    session = AgentSession(sessionId="agt-x", createdAt="t", updatedAt="t")
    CentralAgent._stash_verified(session, {"implement": rec})
    return CentralAgent._restored_verified(session)["implement"]


class TestEnvelopeSurvivesPersistence:
    def test_restored_envelope_is_byte_identical_to_the_live_one(self):
        live = build_envelope([_evidence(_live_record())])["text"]
        restored = build_envelope([_evidence(_round_trip(_live_record()))])["text"]
        assert restored == live, (
            "the resumed leg would present a different task input than the "
            "one the human approved")

    def test_the_notice_quotes_the_original_length_not_the_stored_copy(self):
        restored = build_envelope(
            [_evidence(_round_trip(_live_record()))])["text"]
        assert f"{len(LONG) - MAX_SOURCE_CHARS} more characters" in restored

    def test_persistence_records_the_original_length(self):
        stored = _round_trip(_live_record())
        assert stored["stdout_chars"] == len(LONG)
        assert len(stored["stdout"]) < len(LONG), "fixture was not bounded"

    def test_short_output_is_untouched_and_unannotated(self):
        rec = _live_record()
        rec["stdout"] = "brief\n"
        rec["stdout_chars"] = len(rec["stdout"])
        live = build_envelope([_evidence(rec)])["text"]
        assert "truncated" not in live
        assert build_envelope([_evidence(_round_trip(rec))])["text"] == live

    def test_unrecorded_length_falls_back_to_the_text_in_hand(self):
        """Evidence persisted before stdout_chars existed still renders —
        bounded by what it has, rather than raising."""
        rec = _live_record()
        rec.pop("stdout_chars")
        text = build_envelope([_evidence(rec)])["text"]
        assert f"{len(LONG) - MAX_SOURCE_CHARS} more characters" in text
