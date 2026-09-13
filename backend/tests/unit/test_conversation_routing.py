"""Conversation routing — what AURA does with a sentence.

The workspace answered "Can you able to use the connected nodes?" with
"I could not tell what work you want done. Describe the change you want
in the project — for example implement token refresh in src/auth". Two
things were wrong with that, and this file holds both fixes.

The first is classification. A question about what AURA can do is not a
failed engineering task; it is answerable in words, like a greeting, and
it now takes the same conversational path. The deterministic floor here
matters more than usual: with no model configured this IS the classifier,
so an installation without a provider key must still tell the difference
between being asked a question and being given work.

The second is the fallback itself. When AURA genuinely cannot tell what
is wanted, the honest move is to ask — but asking the user to name a
file and a function inverts the product. Choosing files and workers is
AURA's job; the user owns the outcome.

The routing is deliberately conservative in one direction: anything that
asks for an EFFECT stays off the conversational path, so no phrasing can
talk a turn out of planning, authority and approval. `conversational`
carries no capabilities and reaches no executor — see
test_conversational_turn.py.

Run with `python3 -m pytest backend/tests/unit/test_conversation_routing.py`.
"""
import subprocess
from pathlib import Path

import pytest

from aura.approvals import ApprovalLedger
from aura.audit import AuditStore
from aura.central_agent import AgentSessionStore, CentralAgent
from aura.central_agent.intent import (
    heuristic_interpret,
    is_capability_question,
    is_conversational,
    smalltalk_reply,
)
from aura.fabric import FabricConfig

#: The fallback's old demand, and the shape of demand it stood for.
OLD_FALLBACK = "could not tell what work you want done"


def route(message: str) -> str:
    """The category a message lands in, named the way the product means."""
    intent = heuristic_interpret(message)
    if intent.conversational:
        return "conversation"
    if "agent.delegate" in intent.requiredCapabilities:
        return "delegate"
    if intent.needsClarification:
        return "clarify"
    return "capability"


def governed_agent(home: Path) -> tuple[CentralAgent, AuditStore]:
    """A real agent over the real governance spine.

    Deliberately permissive: the host grants every permission and the
    executors are the real ones, so nothing in this fixture is what
    stops a destructive request. If a message reached an executor, it
    WOULD run — which is the only way the safety tests below can mean
    anything.
    """
    from aura.executors import all_executors
    from aura.fabric import CapabilityFabric, FabricHost

    class _PermissiveHost(FabricHost):
        def permissions_for(self, _cap, _ctx):
            return {"read": True, "write": True, "execute": True,
                    "autonomous": True, "network": True}

        def node_available(self, _cap):
            return True

        async def request_approval(self, _req, _ctx):
            return False

    audit = AuditStore(home / "audit" / "trail.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)
    fabric = CapabilityFabric(_PermissiveHost())
    fabric.attach_audit_store(audit.load, audit.append)
    fabric.attach_approval_store(lambda: [], lambda x: None)
    fabric._ledger = ledger
    execs = {e.capabilityId: e for e in all_executors(home)}
    for exe in execs.values():
        try:
            fabric.register(exe)
        except Exception:  # noqa: BLE001 — unregistered stays unsupported
            pass
    cfg = FabricConfig(fabric=fabric, policy_config={},
                       permissions={"read": True, "write": True},
                       executors=execs, audit_store=audit, ledger=ledger)
    return (CentralAgent(fabric_cfg=cfg,
                         session_store=AgentSessionStore(home)), audit)


class TestCapabilityQuestions:
    """Asking what AURA can do is a question, not a failed task."""

    @pytest.mark.parametrize("message", [
        # The message from the report, ungrammatical exactly as typed.
        "Can you able to use the connected nodes?",
        "Can you use the connected workers?",
        "can you use the connected nodes",
        "Are you able to run things on my machine?",
        "Do you support GitHub?",
        "Are you capable of working with this repo?",
        "Do you know how to use git?",
        "Can you work with the tools I connected?",
        "Do you have access to my project?",
    ])
    def test_is_answered_not_interrogated(self, message: str) -> None:
        intent = heuristic_interpret(message)

        assert is_capability_question(message) is True
        assert is_conversational(message) is True
        assert intent.conversational is True
        assert intent.needsClarification is False
        assert intent.clarificationQuestion is None
        # Answering costs nothing and touches nothing.
        assert intent.requiredCapabilities == []

    def test_never_reaches_the_generic_failure_fallback(self) -> None:
        intent = heuristic_interpret("Can you able to use the connected nodes?")
        assert OLD_FALLBACK not in (intent.clarificationQuestion or "")
        assert intent.ambiguity != "impossible"

    def test_the_offline_answer_says_what_happens_next(self) -> None:
        """No model configured is the case that was broken, so the
        deterministic reply has to carry the whole answer."""
        reply = smalltalk_reply("Can you able to use the connected nodes?")

        assert reply is not None
        lowered = reply.lower()
        # It answers the question, and describes the supervision loop.
        assert "yes" in lowered
        assert "connected" in lowered
        assert "check the result" in lowered or "verify" in lowered
        # It claims no measurement it never took.
        for invented in ["opencode", "claude code", "6 workers", "currently connected"]:
            assert invented not in lowered

    def test_the_offline_answer_does_not_demand_implementation_detail(self) -> None:
        reply = smalltalk_reply("Can you use the connected workers?") or ""
        assert "src/" not in reply
        assert "file path" not in reply.lower()
        # It says the opposite, in fact.
        assert "do not need to name files" in reply.lower()


class TestPoliteRequestsAreStillWork:
    """A request wearing a question mark is still a request."""

    @pytest.mark.parametrize("message", [
        "Can you fix the login bug?",
        "Are you able to fix the authentication bug?",
        "Could you refactor the session handling?",
        "Can you check the project for security problems?",
    ])
    def test_stays_on_the_delegation_path(self, message: str) -> None:
        assert is_capability_question(message) is False
        assert route(message) == "delegate"

    @pytest.mark.parametrize("message", [
        "Can you delete the branch?",
        "Can you deploy this?",
        "Could you push my commits?",
    ])
    def test_an_effect_never_takes_the_conversational_path(self, message: str) -> None:
        """The conversational path owns no executor, so nothing that
        asks for an effect may be routed onto it — that is the only way
        this classifier could be used to skip authority."""
        intent = heuristic_interpret(message)
        assert is_capability_question(message) is False
        assert intent.conversational is False


class TestEngineeringRequestsAssignAWorker:
    """The four shapes from the report, none naming a file or a worker."""

    @pytest.mark.parametrize("message", [
        "Check why login is failing",
        "Fix the authentication bug",
        "Run the tests and fix failures",
        "Inspect the project and tell me what is wrong",
        "Look into the slow startup",
        "Figure out what is breaking the build",
        "Audit the project for security problems",
    ])
    def test_routes_to_a_worker(self, message: str) -> None:
        intent = heuristic_interpret(message)

        assert route(message) == "delegate"
        assert intent.requiredCapabilities == ["agent.delegate"]
        assert intent.needsClarification is False
        # Delegation is approval-sensitive, and says so before it runs.
        assert intent.approvalLikely is True

    @pytest.mark.parametrize("message", [
        "Check why login is failing",
        "Inspect the project and tell me what is wrong",
    ])
    def test_hands_the_worker_the_user_s_own_words(self, message: str) -> None:
        """The task contract must carry the intent the user expressed,
        not a paraphrase of it — a rewritten goal is how a delegation
        quietly becomes a different job."""
        intent = heuristic_interpret(message)

        assert intent.delegateTask == message
        assert intent.goal == message
        assert intent.surface == "project"

    def test_the_result_must_be_verified_not_merely_finished(self) -> None:
        intent = heuristic_interpret("Fix the authentication bug")
        assert "verified" in intent.expectedOutcome.lower()

    @pytest.mark.parametrize("message", [
        "Why is login failing?",
        "What is wrong with the build?",
        "Why are the tests failing?",
    ])
    def test_a_question_about_a_failure_is_an_inspection(self, message: str) -> None:
        """Question-shaped, but answering it means reading the project.
        A guess would be the only alternative."""
        assert route(message) == "delegate"

    def test_no_file_or_worker_needs_naming(self) -> None:
        """The point of the whole change: none of these mention a path,
        a function or a runtime, and all of them are actionable."""
        for message in ["Fix the authentication bug", "Check why login is failing"]:
            intent = heuristic_interpret(message)
            assert intent.needsClarification is False
            # No scope was stated, so none is invented.
            assert intent.delegateScope == []


class TestOrdinaryQuestionsStayOffTheDispatchPath:
    """Reading the repository is work; asking about the world is not."""

    @pytest.mark.parametrize("message", [
        "Explain this function",
        "What does this project do",
        "Which languages are here",
    ])
    def test_never_dispatches_a_worker(self, message: str) -> None:
        assert route(message) != "delegate"

    def test_smalltalk_still_answers(self) -> None:
        assert route("Hi") == "conversation"
        assert route("thanks") == "conversation"
        assert route("what can you do") == "conversation"


class TestTheAmbiguousFallback:
    """When AURA truly cannot tell, it asks — usefully."""

    def test_still_asks_rather_than_guessing(self) -> None:
        intent = heuristic_interpret("flurb the bazzle")
        assert intent.needsClarification is True
        assert intent.clarificationQuestion

    def test_asks_for_the_outcome_not_the_implementation(self) -> None:
        question = heuristic_interpret("flurb the bazzle").clarificationQuestion or ""
        lowered = question.lower()

        assert OLD_FALLBACK not in lowered
        # No file, no function, no worker name is demanded of the user.
        for demand in ["src/", "file", "function", "path", "worker name"]:
            assert demand not in lowered
        # It asks for the outcome, and says who does the rest.
        assert "different once it is done" in lowered or "outcome" in lowered

    def test_keeps_the_user_s_intent_in_play(self) -> None:
        """A clarification that discards the request makes the user
        start over; this one carries the goal forward."""
        intent = heuristic_interpret("flurb the bazzle")
        assert intent.goal == "flurb the bazzle"


class TestNoParallelRouting:
    """One classifier, and it is this one."""

    def test_the_conversational_floor_is_the_only_gate(self) -> None:
        """`is_conversational` is what both the heuristic path and the
        model-validation path consult, so a capability question is
        classified the same way with or without a model."""
        from aura.central_agent import intent as mod

        source = (mod.__file__ or "")
        assert source.endswith("intent.py")
        assert is_conversational("Can you use the connected workers?") is True
        assert is_conversational("Fix the login bug") is False

    def test_conversation_grants_nothing(self) -> None:
        for message in ["Hi", "Can you use the connected nodes?", "Do you support GitHub?"]:
            intent = heuristic_interpret(message)
            assert intent.conversational is True
            assert intent.requiredCapabilities == []
            assert intent.approvalLikely is False


class TestKnownCapabilitiesAnswerThemselves:
    """A capability AURA already has is not an investigation.

    Adding `check` to the work vocabulary — which is what lets "Check
    why login is failing" reach a worker — also swept up "Check git
    status", a question the `git.status` executor answers directly,
    read-only and with no approval. Dispatching a worker for it is not
    unsafe, but it is slower, costlier and asks the user to approve
    something AURA never needed permission for.

    The rule that fixes it recognises the capability SHAPE, not the
    word "check", and it routes to the EXISTING capability rather than
    answering in a branch of its own.
    """

    @pytest.mark.parametrize("message", [
        "Check git status",
        "Show me git status",
        "What is the current git status?",
        "check the git status",
        "git status",
        "Can you check git status?",
        "what's the git status",
        "What is the status of the git repo?",
        "Show the git status of the project",
        "tell me the current git status.",
    ])
    def test_uses_the_direct_read_only_capability(self, message: str) -> None:
        intent = heuristic_interpret(message)

        assert intent.requiredCapabilities == ["git.status"]
        assert route(message) == "capability"
        # Read-only means read-only: no worker, no approval, no scope.
        assert "agent.delegate" not in intent.requiredCapabilities
        assert intent.approvalLikely is False
        assert intent.needsClarification is False
        assert "Read-only" in intent.constraints
        assert intent.goal == message.strip()

    @pytest.mark.parametrize("message", [
        # Investigation, which is what a worker is for.
        "Check why login is failing",
        "Inspect the repository for authentication problems",
        "Check the project and fix the login bug",
        # The capability plus something else. The something else is the
        # whole reason this must NOT match: answering only the first
        # half would silently drop the rest of the request.
        "Check git status and fix the failing tests",
        "Check the git history and fix the regression",
        "Check git status, then refactor the session handling",
    ])
    def test_investigation_still_reaches_a_worker(self, message: str) -> None:
        intent = heuristic_interpret(message)

        assert route(message) == "delegate"
        assert intent.requiredCapabilities == ["agent.delegate"]
        # The worker is handed what the user actually said, whole.
        assert intent.delegateTask == message.strip()

    def test_the_word_check_alone_decides_nothing(self) -> None:
        """The rule keys on the capability, not on a verb. `check`
        appears in both columns above and settles neither."""
        assert heuristic_interpret(
            "Check git status").requiredCapabilities == ["git.status"]
        assert heuristic_interpret(
            "Check why login is failing").requiredCapabilities == ["agent.delegate"]

    @pytest.mark.parametrize("message", [
        "Delete the git status file",
        "Reset the git status",
        "Commit the git status output",
    ])
    def test_naming_the_capability_never_grants_an_effect(
            self, message: str) -> None:
        """Saying "git status" inside a destructive sentence reaches the
        READ-ONLY capability at most — never `git.commit`, never
        `filesystem.write`, never a worker.

        These land on `git.status` through the older, looser git-status
        rule that predates this change (verified against HEAD: it routes
        them identically). The looseness is untouched here because it is
        outside this change and harmless in this direction — the wrong
        answer is a status report, not a deletion. What matters, and
        what is pinned, is that no effect capability is ever reached.
        """
        intent = heuristic_interpret(message)

        assert intent.requiredCapabilities in ([], ["git.status"])
        for granted in intent.requiredCapabilities:
            assert granted == "git.status", f"effect capability granted: {granted}"
        assert intent.approvalLikely is False

    def test_no_second_route_was_added(self) -> None:
        """The direct rule yields to the capability branch that already
        existed — it does not answer on its own. Proof: the intent it
        produces is byte-identical to the one the untouched phrasing
        has always produced."""
        already_worked = heuristic_interpret("Show me git status")
        newly_fixed = heuristic_interpret("Check git status")

        assert newly_fixed.requiredCapabilities == already_worked.requiredCapabilities
        assert newly_fixed.surface == already_worked.surface
        assert newly_fixed.constraints == already_worked.constraints
        assert newly_fixed.expectedOutcome == already_worked.expectedOutcome
        assert newly_fixed.approvalLikely == already_worked.approvalLikely


class TestEffectFramedCapabilityQuestionsCannotAct:
    """"Are you able to delete the branch?" — asked, not ordered.

    An explicit ability frame ("able to", "capable of", "support") lifts
    the effect-verb veto, because said out loud those sentences ask a
    yes/no question. That is a deliberate policy choice and it is only
    defensible because of what it CANNOT do, so this class pins the
    consequence rather than the classification: whichever non-executing
    branch these land on, nothing runs.

    The safety is structural, not procedural. `_converse()` returns
    before the planner, the authority checker and the Fabric exist for
    that turn, so it owns no executor and has no way to perform work.
    These tests run against a fully permissive host with the real
    executors registered — nothing in the fixture would stop a
    destructive call, so an empty audit trail means the call never
    happened.
    """

    #: Effect verbs wearing an ability frame, and effect verbs wearing a
    #: plain polite frame. They take different routes on purpose; the
    #: claim under test is that neither route executes.
    EFFECT_FRAMED = [
        "Are you able to delete the branch?",
        "Are you able to deploy?",
        "Could you push my commits?",
        "Do you support deleting branches?",
        "Can you reset the repository?",
    ]

    @pytest.fixture()
    def home(self, tmp_path: Path) -> Path:
        return tmp_path

    @pytest.mark.parametrize("message", EFFECT_FRAMED)
    def test_nothing_is_performed_verified_or_run(
            self, message: str, home: Path) -> None:
        agent, audit = governed_agent(home)

        result = agent.submit(message)

        assert result.performed == []
        assert result.verified == []
        assert result.runId is None
        assert result.evidence is None

    @pytest.mark.parametrize("message", EFFECT_FRAMED)
    def test_no_approval_and_no_audit_record_is_created(
            self, message: str, home: Path) -> None:
        """An approval request is itself a claim that work is about to
        happen. None is made, because none is pending."""
        agent, audit = governed_agent(home)

        agent.submit(message)

        assert audit.load() == []
        types = [e.type for e in agent.bus.tail]
        assert "approval.required" not in types
        assert "execution.started" not in types
        assert "plan.created" not in types

    @pytest.mark.parametrize("message", EFFECT_FRAMED)
    def test_no_worker_run_is_created(self, message: str, home: Path) -> None:
        agent, audit = governed_agent(home)

        agent.submit(message)
        session = agent.sessions.load(agent.sessions.last_session_id)

        assert session is not None
        assert not session.activePlan
        assert session.activePlanId is None
        assert "agent.delegate" not in (
            heuristic_interpret(message).requiredCapabilities)

    @pytest.mark.parametrize("message", EFFECT_FRAMED)
    def test_the_planner_authority_and_fabric_are_never_reached(
            self, message: str, home: Path) -> None:
        """The structural claim, asserted directly: the conversational
        path has no executor because it never reaches one."""
        agent, audit = governed_agent(home)
        called: list[str] = []
        agent.planner.plan = lambda *a, **k: called.append("plan")  # type: ignore[assignment]
        agent.authority.check_plan = lambda *a, **k: called.append("authority")  # type: ignore[assignment]

        agent.submit(message)

        assert called == []

    def test_no_destructive_operation_reaches_a_real_repository(
            self, home: Path) -> None:
        """Mutation evidence. A real git repo with a real branch, a real
        file and a real commit — asked, in every effect-framed shape, to
        destroy each of them. Afterwards everything is still there."""
        import shutil

        git = shutil.which("git")
        if git is None:
            pytest.skip("git is not installed")

        project = home / "project"
        project.mkdir()
        keep = project / "keep.txt"
        keep.write_text("do not delete me\n")

        def run(*args: str) -> None:
            subprocess.run([git, "-C", str(project), *args],
                           check=True, capture_output=True, text=True)

        run("init", "-q")
        run("config", "user.email", "t@example.com")
        run("config", "user.name", "Test")
        run("add", "keep.txt")
        run("commit", "-q", "-m", "seed")
        run("branch", "doomed")
        head_before = subprocess.run(
            [git, "-C", str(project), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True).stdout.strip()

        agent, audit = governed_agent(home)
        for message in [*self.EFFECT_FRAMED,
                        "Are you able to delete keep.txt?",
                        "Do you support deleting the doomed branch?",
                        "Are you able to reset this repository to an empty tree?"]:
            agent.submit(message, project_path=str(project))

        branches = subprocess.run(
            [git, "-C", str(project), "branch", "--format=%(refname:short)"],
            check=True, capture_output=True, text=True).stdout.split()
        head_after = subprocess.run(
            [git, "-C", str(project), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True).stdout.strip()

        assert "doomed" in branches, "a branch was deleted by a question"
        assert keep.exists(), "a tracked file was deleted by a question"
        assert keep.read_text() == "do not delete me\n"
        assert head_after == head_before, "history moved for a question"
        assert audit.load() == []

    def test_the_classification_split_is_visible_and_pinned(self) -> None:
        """Which branch each shape takes, recorded so that moving one of
        them onto an executing path fails here first. An ability frame
        answers in words; a plain polite frame asks what is wanted.
        Neither performs the effect."""
        assert route("Are you able to delete the branch?") == "conversation"
        assert route("Are you able to deploy?") == "conversation"
        assert route("Do you support deleting branches?") == "conversation"
        assert route("Could you push my commits?") == "clarify"
        assert route("Can you reset the repository?") == "clarify"

    def test_a_plain_imperative_is_not_softened_by_any_of_this(self) -> None:
        """The frames above are questions. Orders are not, and they must
        not be routed into a path that cannot carry them out."""
        for message in ["Delete the branch", "Deploy this", "Push my commits"]:
            intent = heuristic_interpret(message)
            assert intent.conversational is False
