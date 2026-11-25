"""AURA's six permanent specialist agents.

A specialist is an AURA identity, not a coding tool. OpenCode and Kilo Code
are the runtimes that carry a specialist's work out; AURA owns who the
specialist is, what it is accountable for, and which task it is given.

What this module is, deliberately:

- A CLOSED registry of six identities with a fixed runtime assignment.
- A DETERMINISTIC mapping from a task (its worker role and its brief) to
  the one specialist accountable for it. No model call, no scoring: the
  same task always resolves to the same specialist, so a run record that
  names a specialist can be reproduced.
- ADVISORY for routing, exactly like worker_match: the assigned runtime is
  the preferred worker when it is eligible. Eligibility, billing policy,
  the allow-list, exclusions for an independent review and Fabric routing
  all still decide. When the assigned runtime cannot take the task, the
  existing selection (Laya, then catalogue order) picks another eligible
  worker and the run says so; the specialist identity does not change.

It imports nothing beyond the standard library.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

OPENCODE = "opencode"
KILO = "kilo-code"


@dataclass(frozen=True)
class Specialist:
    id: str
    name: str
    #: Worker (catalogue) id of the runtime this specialist runs on.
    runtime: str
    focus: str
    responsibilities: tuple[str, ...]

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "runtime": self.runtime,
            "focus": self.focus,
            "responsibilities": list(self.responsibilities),
        }


SPECIALISTS: tuple[Specialist, ...] = (
    Specialist(
        id="researcher", name="Researcher", runtime=OPENCODE,
        focus="Understands the request and reports findings with evidence.",
        responsibilities=(
            "Understand requirements",
            "Research technologies and documentation",
            "Investigate existing codebases",
            "Discover appropriate tools",
            "Identify technical constraints",
            "Report findings with evidence",
        ),
    ),
    Specialist(
        id="planner", name="Planner", runtime=OPENCODE,
        focus="Turns a request into an executable, dependency-ordered plan.",
        responsibilities=(
            "Convert requests into structured missions",
            "Break missions into executable tasks",
            "Establish dependencies and parallel work",
            "Allocate tasks to agents",
            "Track completion and update the plan",
        ),
    ),
    Specialist(
        id="frontend-builder", name="Frontend Builder", runtime=OPENCODE,
        focus="Builds the interface: components, styling, interaction.",
        responsibilities=(
            "UI architecture",
            "React and TypeScript development",
            "Component implementation, styling and interaction",
            "Accessibility and responsive behaviour",
            "Frontend testing",
        ),
    ),
    Specialist(
        id="backend-builder", name="Backend Builder", runtime=KILO,
        focus="Builds services, data and business logic.",
        responsibilities=(
            "API implementation",
            "Database integration and data integrity",
            "Business logic",
            "Authentication and authorization",
            "Service integration",
            "Backend testing",
        ),
    ),
    Specialist(
        id="debugger", name="Debugger", runtime=KILO,
        focus="Reproduces failures, finds the root cause and verifies the fix.",
        responsibilities=(
            "Diagnose failures",
            "Inspect logs and traces",
            "Reproduce bugs",
            "Identify root causes",
            "Implement or delegate corrections",
            "Verify fixes",
        ),
    ),
    Specialist(
        id="reviewer-fixer", name="Reviewer / Fixer", runtime=KILO,
        focus="Reviews the work, requests corrections and verifies the deliverable.",
        responsibilities=(
            "Review implementation quality",
            "Inspect security and reliability",
            "Detect incomplete requirements",
            "Review frontend and backend integration",
            "Validate tests",
            "Verify the final deliverable",
        ),
    ),
)

_BY_ID = {s.id: s for s in SPECIALISTS}

#: Roles whose specialist does not depend on the brief.
_ROLE_SPECIALIST = {
    "research": "researcher",
    "documentation": "researcher",
    "planning": "planner",
    "review": "reviewer-fixer",
    "testing": "reviewer-fixer",
}

#: A code task that is about a failure belongs to the Debugger.
_DEBUG = re.compile(
    r"\b(debug\w*|bug|bugs|crash\w*|traceback|stack ?trace|exception|regression|"
    r"root cause|reproduce\w*|failing|fails|failure|broken|not working|doesn'?t work|"
    r"error|errors|diagnos\w*|troubleshoot\w*)\b",
    re.IGNORECASE,
)

_NOT_A_FAILURE = re.compile(
    r"\berror[- ](handling|handler\w*|message\w*|page\w*|boundar\w+|state\w*|toast\w*|response\w*|code\w*)\b",
    re.IGNORECASE,
)

#: A code task that is about the interface belongs to the Frontend Builder.
_FRONTEND = re.compile(
    r"\b(frontend|front-end|front end|ui|ux|react|vue|svelte|angular|next\.?js|component\w*|"
    r"css|scss|tailwind|styl\w+|html|jsx|tsx|layout|responsive|accessib\w*|a11y|"
    r"button\w*|modal|dialog|form|navbar|sidebar|header|footer|page|pages|screen\w*|"
    r"theme|dark mode|animation\w*|icon\w*|landing|dashboard|colou?r\w*|font\w*)\b",
    re.IGNORECASE,
)

#: Words that mark service-side work even when an interface word also appears.
_BACKEND = re.compile(
    r"\b(backend|back-end|back end|api|apis|endpoint\w*|server|database|db|sql|postgres\w*|"
    r"sqlite|mysql|mongo\w*|redis|migration\w*|schema|orm|auth\w*|jwt|oauth|session\w*|"
    r"queue\w*|worker\w*|cron|webhook\w*|service\w*|middleware|route handler\w*|"
    r"fastapi|django|flask|express|starlette|graphql|grpc|business logic)\b",
    re.IGNORECASE,
)


def all_specialists() -> list[Specialist]:
    return list(SPECIALISTS)


def specialist(specialist_id: str | None) -> Specialist | None:
    return _BY_ID.get(str(specialist_id or ""))


def execution_guidance(specialist_id: str | None, *, task: str = "",
                       verification_kind: str = "",
                       verification_description: str = "") -> str:
    """Describe the accountable AURA specialist to the delegated runtime.

    This is task context, not an authority grant: the Fabric, policy engine,
    task scope and approval checks remain the only execution controls.
    """
    who = specialist(specialist_id)
    if who is None:
        return ""
    responsibilities = "; ".join(who.responsibilities)
    details = [
        f"AURA SPECIALIST: {who.name}\n"
        f"Focus: {who.focus}\n"
        f"Accountable for: {responsibilities}.\n"
        "Work only within the delegated task and AURA's existing permissions, "
        "approval requirements, and file scope. Report concrete evidence and "
        "distinguish completed checks from checks not run. This role guidance "
        "does not grant additional tools or permissions."
    ]
    if task.strip():
        details.append(f"Task assignment: {task.strip()[:1200]}")
        details.append(
            "Expected deliverable: complete only this assignment; identify "
            "changed files or produced outputs and summarize the result.")
    if verification_kind or verification_description:
        details.append(
            "AURA verification requirement: "
            f"{verification_kind or 'unspecified'}"
            + (f" — {verification_description.strip()[:600]}"
               if verification_description.strip() else "")
            + ". State evidence relevant to this check; a worker claim alone "
            "does not make the check pass.")
    return "\n".join(details)


def specialist_for(role: str | None, brief: str = "") -> Specialist | None:
    """The specialist accountable for a task, or None.

    None is a real answer: a task with no worker role, or the routing-only
    ``execute`` role (the operator's own command on a terminal), is nobody's
    specialist work and is never labelled as if it were.
    """
    if not role or role == "execute":
        return None
    fixed = _ROLE_SPECIALIST.get(role)
    if fixed:
        return _BY_ID[fixed]
    if role != "code":
        return None
    # "Add error handling" builds something; it does not chase a failure.
    text = _NOT_A_FAILURE.sub(" ", brief or "")
    if _DEBUG.search(text):
        return _BY_ID["debugger"]
    front = len(_FRONTEND.findall(text))
    back = len(_BACKEND.findall(text))
    if front > back:
        return _BY_ID["frontend-builder"]
    return _BY_ID["backend-builder"]


def roster(present_worker_ids: set[str] | None = None) -> list[dict]:
    """The six specialists with the real availability of each one's runtime.

    ``present_worker_ids`` is the set of worker ids AURA can dispatch to right
    now. ``runtimeAvailable`` is True only when the assigned runtime is in it;
    None (unknown) when the caller could not read the worker registry — never
    a guessed "available".
    """
    out = []
    for s in SPECIALISTS:
        item = s.as_dict()
        item["runtimeAvailable"] = None if present_worker_ids is None else s.runtime in present_worker_ids
        out.append(item)
    return out
