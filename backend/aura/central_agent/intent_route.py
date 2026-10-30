"""Which interaction path a message belongs to.

The existing ``IntentCompiler`` answers "what capabilities does this request
need?" for work. This module answers the question above it — "what is the
person trying to DO right now?" — using the message *and* what is actually
going on: which surface they are on, whether a run is active, whether a plan
exists and is ready. It layers on the compiler (``heuristic_interpret`` is
used to recognise work) rather than competing with it.

Intents (``Intent``): general-question, research-question, idea-exploration,
new-project-creation, project-improvement, plan-generation, plan-editing,
planner-handoff, direct-workspace-execution, environment-query,
workflow-worthy-task, task-status, error-recovery.

Every decision returns an ``action`` that is only ever a *suggestion of an
interaction path*: answer, offer a button, report real status, or execute in
Workspace. Nothing here executes anything, and a chat surface can never
resolve to ``execute`` — a work request typed into chat becomes a pointer to
Workspace.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Literal

Intent = Literal[
    "general-question", "research-question", "idea-exploration",
    "new-project-creation", "project-improvement", "plan-generation",
    "plan-editing", "planner-handoff", "direct-workspace-execution",
    "environment-query", "workflow-worthy-task", "task-status",
    "error-recovery", "needs-clarification",
]
Surface = Literal["general-chat", "project-chat", "workspace", "planner"]
Action = Literal[
    "answer", "offer-create-project", "offer-create-plan", "report-status",
    "execute", "point-to-workspace", "point-to-planner", "report-environment",
    "recover", "clarify",
]

_I = re.IGNORECASE


@dataclass
class RouteState:
    """Facts about the current situation. All default to "nothing going on"."""

    surface: Surface = "general-chat"
    has_project: bool = False
    has_active_run: bool = False
    has_finished_run: bool = False
    has_failed_run: bool = False
    has_plan: bool = False
    #: The conversation has produced a goal and at least one requirement or
    #: decision (see ``readiness``): enough to offer a project or a plan.
    context_records: dict[str, int] = field(default_factory=dict)
    turns: int = 0


@dataclass
class Route:
    intent: Intent
    action: Action
    reason: str
    confidence: float = 0.8
    #: Marks work that benefits from the workflow engine (several stages,
    #: conditions, recovery). A modifier — it never replaces `intent`.
    workflow: bool = False
    question: str | None = None

    def as_dict(self) -> dict:
        return asdict(self)


_STATUS = re.compile(
    r"\b(status|progress|how('s| is| are)( it| that| things| the (run|task|work|build))? "
    r"(going|doing|coming)|is (it|that|the (run|task|work)) (done|finished|complete|still running)|"
    r"what('s| is) (happening|going on|running)|where are we|are we done|"
    r"what (did|has) (it|aura|the (agent|worker)) (do|done)|any (update|news))\b", _I)
_ENV = re.compile(
    r"\b(what (tools|runtimes|languages|software) (do i|are|have|is)|"
    r"(is|are) \S+ installed|do i have \S+ installed|installed (on|in) (this|my) (machine|computer|system)|"
    r"which (version|worker|agents?) (of|is|are)|environment (status|check)|"
    r"(node|python|git|docker|rust|cargo|npm|go|java)\s+version)\b", _I)
_RECOVER = re.compile(
    r"\b(retry|try again|re-?run|resume|continue (where|from|the)|pick (it )?up|"
    r"that (failed|didn'?t work|broke)|it failed|fix (the|that) (error|failure)|"
    r"what went wrong)\b", _I)
_HANDOFF = re.compile(
    r"\b(send (it |the plan |this )?to workspace|run (the|this) plan|execute (the|this) plan|"
    r"start (the|this) plan|hand (it|the plan) off)\b", _I)
_PLAN_EDIT = re.compile(
    r"\b((edit|change|update|revise|rewrite|reorder|reprioriti[sz]e|split|merge) (the |this |that )?"
    r"(plan|task|tasks|step|steps)|(add|remove|drop|delete) (a |the )?(task|step)|"
    r"move (task|step) )\b", _I)
_PLAN_GEN = re.compile(
    r"\b((make|create|write|draft|build|give me|generate|put together) (me )?(a |an |the )?"
    r"(implementation |project |execution )?(plan|roadmap|breakdown|task list)|"
    r"plan (this|it|that|the project|the build)|break (this|it|that) (down|into)|"
    r"break down (the|this)|how (should|would) we (build|implement|structure) (this|it))\b", _I)
_NEW_PROJECT = re.compile(
    r"\b((create|start|begin|set up|kick off|make) (a |my |the )?(new )?(project|repo|repository|app|application)|"
    r"turn (this|it|that) into (a |an )?(project|app)|let'?s (start|build|make) (it|this|that|the project)|"
    r"i('m| am)? ready to (build|start)|start building)\b", _I)
_IDEA = re.compile(
    r"\b(i (want|would like|wanna|plan|am thinking|'m thinking) (to )?(build|make|create|start|launch)|"
    r"(my|an?) idea|what if (we|i|there)|i('ve| have) (an? )?idea|thinking (about|of) (building|making)|"
    r"how (could|can|might) (i|we) (build|make|do)|would (it|this) (be )?(feasible|possible|worth)|"
    r"is (it|this) (feasible|possible|a good idea)|(app|tool|product|startup|platform|service) (that|which|for|to) )", _I)
_IMPROVE = re.compile(
    r"\b(improve|optimi[sz]e|refactor|clean ?up|speed up|harden|modernis?e|upgrade|"
    r"make (it|this|the \w+) (faster|better|cleaner|safer|more \w+)|reduce (the )?(bundle|latency|size|complexity))\b", _I)
_RESEARCH = re.compile(
    r"\b(latest|current(ly)?|newest|recent|as of|compare|comparison|versus|vs\.?|alternatives?|"
    r"state of|benchmarks?|market|competitors?|trends?|best (practice|way|library|framework|tool)|"
    r"pros and cons|what are the (options|differences)|research|look up|find out|sources?)\b", _I)
_WORK = re.compile(
    r"\b(implement|add|create|write|build|make|fix|refactor|generate|scaffold|delete|remove|rename|"
    r"update|install|run|execute|deploy|commit|push|migrate|convert|port)\b"
    r".{0,80}\b(file|files|function|class|component|test|tests|endpoint|api|app|page|script|module|"
    r"feature|bug|code|readme|config|folder|directory|calculator|project|dependency|package)\b", _I | re.DOTALL)
_WORKFLOW = re.compile(
    r"\b(then|after that|afterwards|once (it|that|done)|if (it|that|they) fail|on failure|"
    r"for each|every (night|day|week|hour)|nightly|daily|weekly|pipeline|in parallel|"
    r"step by step|stages?|retry (up to|until)|until (it|they|all|tests?) pass|multi-?step)\b", _I)
_VAGUE = re.compile(r"^(it|this|that|do it|go|yes|ok|okay|sure|continue|more|and\??|so\??)\W*$", _I)


def _clauses(text: str) -> int:
    return len([c for c in re.split(r"[;,.]|\band\b|\bthen\b", text, flags=_I) if len(c.split()) >= 3])


def readiness(ctx: dict[str, int]) -> dict[str, bool]:
    """Whether the discussion has developed enough to offer the next step.

    Based on what the conversation actually produced (records in Shared
    Context), not on a message count: a stated goal AND at least one
    requirement, decision or constraint is enough for a project; a project
    needs those plus a second shaped note, or a persisted origin (the idea the
    project was created from), to offer a plan.
    """
    shaped = (ctx.get("requirement", 0) + ctx.get("decision", 0)
              + ctx.get("constraint", 0) + ctx.get("architecture", 0))
    has_goal = ctx.get("goal", 0) > 0
    return {
        "project": has_goal and shaped >= 1,
        "plan": has_goal and (shaped >= 2 or (shaped >= 1 and ctx.get("origin", 0) > 0)),
    }


def classify_route(message: str, state: RouteState | None = None) -> Route:
    """Decide the interaction path for ``message`` in ``state``."""
    st = state or RouteState()
    text = (message or "").strip()
    chat = st.surface in ("general-chat", "project-chat")
    if not text:
        return Route("needs-clarification", "clarify", "empty message", 1.0,
                     question="What would you like to do?")
    if _VAGUE.match(text) and st.turns == 0 and not st.has_active_run:
        return Route("needs-clarification", "clarify",
                     "too little to act on, and nothing earlier to refer to", 0.9,
                     question="Could you say a little more about what you'd like?")

    # Questions about what is happening never start anything.
    if _STATUS.search(text):
        return Route("task-status", "report-status",
                     "asks how the work is going" + ("" if st.has_active_run or st.has_finished_run
                                                     else " (no run exists yet)"), 0.9)
    if _ENV.search(text):
        return Route("environment-query", "report-environment",
                     "asks about the machine's tools", 0.85)
    if _RECOVER.search(text) and (st.has_failed_run or st.has_finished_run or st.has_active_run):
        return Route("error-recovery", "point-to-workspace" if chat else "recover",
                     "asks to continue or retry earlier work", 0.85)
    if _HANDOFF.search(text):
        return Route("planner-handoff", "point-to-planner" if chat else "execute",
                     "asks to run a plan in Workspace", 0.9)
    if _PLAN_EDIT.search(text) and (st.has_plan or st.surface == "planner"):
        return Route("plan-editing", "point-to-planner" if chat else "answer",
                     "asks to change the plan", 0.85)

    ready = readiness(st.context_records)
    if _PLAN_GEN.search(text):
        return Route("plan-generation", "offer-create-plan",
                     "asks for a plan" + ("" if ready["plan"] else
                                          " (the idea is still being shaped; the plan will say what is assumed)"), 0.9)
    if _NEW_PROJECT.search(text) and st.surface == "general-chat":
        return Route("new-project-creation", "offer-create-project",
                     "wants to start a project; creating one needs a click and a name", 0.9)

    is_work = bool(_WORK.search(text))
    multi = bool(_WORKFLOW.search(text)) or _clauses(text) >= 4
    if is_work and not _IDEA.search(text):
        if chat:
            return Route("direct-workspace-execution", "point-to-workspace",
                         "a request to change files; chat only talks, Workspace does the work",
                         0.85, workflow=multi)
        if multi:
            return Route("workflow-worthy-task", "execute",
                         "several stages or conditions: structured execution helps", 0.8, workflow=True)
        return Route("direct-workspace-execution", "execute", "a direct task for Workspace", 0.85)

    if _IDEA.search(text):
        return Route("idea-exploration", "answer", "developing an idea; stays a conversation", 0.8)
    if _IMPROVE.search(text) and st.has_project:
        return Route("project-improvement", "answer" if chat else "execute",
                     "wants the project made better", 0.75)
    if _RESEARCH.search(text):
        return Route("research-question", "answer", "needs current or comparative evidence", 0.8)
    return Route("general-question", "answer", "a question to answer", 0.7)


__all__ = ["Route", "RouteState", "classify_route", "readiness"]
