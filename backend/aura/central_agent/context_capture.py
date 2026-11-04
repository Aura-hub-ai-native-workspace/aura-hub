"""What a chat turn contributes to Shared Context.

Idea exploration is only useful if AURA remembers what was settled. After
each chat turn this module decides, deterministically and visibly, which
statements the person made that should be recorded:

  goal          the first statement of what they want to build
  requirement   "it must work offline", "needs a dark mode"
  decision      "let's use SQLite", "we'll go with React"
  rejected      "I don't want Electron", "not using Firebase"
  constraint    "budget is zero", "must run on a Raspberry Pi"

It never asks a model to summarise (a small local model would make records
up) and records only the person's own words, shortened — so what is stored
is what was said. The turn's result lists exactly what was recorded, and
every record can be removed in the Memory view.
"""

from __future__ import annotations

import hashlib
import re

_I = re.IGNORECASE
_REJECT = re.compile(
    r"\b(i )?(don'?t|do not|won'?t|will not) (want|need|like|use)\b|\bnot (going to )?us(e|ing)\b|"
    r"\b(rule out|skip|avoid|drop|no longer|instead of|rather than|never use)\b|\bno (electron|firebase|cloud|login|accounts?)\b", _I)
#: "<chosen> instead of <rejected>" and "Instead of <rejected>, <chosen>".
_SWITCH = re.compile(r"(?P<chosen>.*?)\b(?:instead of|rather than)\s+(?P<rej>[^.,;!?]+)", _I)
_SWITCH_LEAD = re.compile(r"^\s*(?:instead of|rather than)\s+(?P<rej>[^,;]+)[,;]\s*(?P<chosen>.+)$", _I)
_DECISION = re.compile(
    r"\b(let'?s|we'?ll|we will|i'?ll|i will|i('?ve)? decided( to)?|decided on|go(ing)? with|"
    r"i prefer|we prefer|i choose|choose|pick(ed)?|settle(d)? on|stick(ing)? with)\b.{0,40}"
    r"\b(use|using|go|build|build with|make it|stick|with|on)\b", _I)
_REQUIREMENT = re.compile(
    r"\b(must|should|needs? to|has to|have to|required?|it (will|would) (need|have)|"
    r"(support|include|handle|work(s)? (offline|on|with)|offline|real-?time|multi-?user|"
    r"dark mode|export|import|sync|notifications?|authentication|search))\b", _I)
_CONSTRAINT = re.compile(
    r"\b(budget|deadline|by (monday|tuesday|wednesday|thursday|friday|next|end of)|"
    r"only (have|use)|limited to|no more than|at most|within \d+|must run on|"
    r"raspberry pi|low[- ]end|free tier|no (money|cost))\b", _I)
_IDEA = re.compile(
    r"\b(i (want|would like|wanna|plan|am thinking|'m thinking) (to )?(build|make|create|start|launch)|"
    r"(an? )?(app|tool|product|platform|game|bot|website|service|extension|cli|library) (that|which|for|to)|"
    r"my idea|idea (is|for)|build (me )?(an?|the) )", _I)

MAX_PER_TURN = 5
#: Load-bearing statements first: a decision or a rejection must never be
#: crowded out of a turn by a run of ordinary requirements.
_PRIORITY = {"rejected": 0, "decision": 1, "constraint": 2, "requirement": 3}
MAX_REQUIREMENTS_PER_TURN = 2


def _short(text: str, n: int) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _key(kind: str, text: str) -> str:
    return f"{kind}:{hashlib.sha1(text.lower().encode()).hexdigest()[:10]}"


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", text) if len(s.strip().split()) >= 3]


def capture(message: str, *, counts: dict[str, int], intent: str) -> list[dict]:
    """Records this message should add. ``counts`` is what Shared Context
    already holds, so a goal is only recorded once."""
    text = (message or "").strip()
    if not text or text.endswith("?") and len(text.split()) < 6:
        return []
    out: list[dict] = []
    goal_sentence = None
    if counts.get("goal", 0) == 0 and (intent in ("idea-exploration", "new-project-creation")
                                        or _IDEA.search(text)):
        out.append({"kind": "goal", "title": _short(text, 100), "body": _short(text, 1200),
                    "key": "goal", "pinned": True})
        # The sentence that states the idea is the goal, not also a requirement.
        goal_sentence = next((s for s in _sentences(text) if _IDEA.search(s)), None)
    found: list[tuple[int, int, dict]] = []
    for order, sentence in enumerate(_sentences(text)):
        if sentence == goal_sentence:
            continue
        switch = _SWITCH_LEAD.match(sentence) or _SWITCH.search(sentence)
        if switch:
            # "Build it with Ollama instead of Groq": Groq is what is rejected and
            # Ollama is what is chosen. The whole sentence is not "the rejection".
            rejected = _short(re.sub(r"\s+(please|thanks|thank you)$", "", switch.group("rej").strip(" .!"), flags=_I), 60)
            found.append((_PRIORITY["rejected"], order, {
                "kind": "rejected", "title": _short(f"Not using {rejected}", 100),
                "body": _short(f"Rejected: {rejected}. Said: {sentence}", 400), "key": _key("rejected", rejected)}))
            chosen = re.sub(r"^(now|ok|okay|please|then|and|so)\b[, ]*", "", switch.group("chosen").strip(), flags=_I).strip(" ,.!")
            if len(chosen.split()) >= 2:
                found.append((_PRIORITY["decision"], order, {
                    "kind": "decision", "title": _short(chosen, 100), "body": _short(chosen, 400),
                    "key": _key("decision", chosen)}))
            continue
        if _REJECT.search(sentence):
            kind = "rejected"
        elif _DECISION.search(sentence):
            kind = "decision"
        elif _CONSTRAINT.search(sentence):
            kind = "constraint"
        elif _REQUIREMENT.search(sentence):
            kind = "requirement"
        else:
            continue
        if kind == "requirement" and sentence.endswith("?"):
            continue  # a question about a feature is not yet a requirement
        found.append((_PRIORITY[kind], order, {
            "kind": kind, "title": _short(sentence, 100), "body": _short(sentence, 400),
            "key": _key(kind, sentence)}))
    requirements = 0
    for _prio, _order, rec in sorted(found, key=lambda t: (t[0], t[1])):
        if len(out) >= MAX_PER_TURN:
            break
        if rec["kind"] == "requirement":
            if requirements >= MAX_REQUIREMENTS_PER_TURN:
                continue
            requirements += 1
        out.append(rec)
    return out


__all__ = ["capture"]
