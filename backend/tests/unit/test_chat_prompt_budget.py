"""A prompt built for a small model must still end with the person's question.

Regression: a 5,500-character cap clipped the END of the user block, which is
where the question sits, so a small model answered something else entirely.
"""
from __future__ import annotations

import pytest

from aura.central_agent.model_routing import fit_text
from aura.central_agent.service import CentralAgent

QUESTION = "USER MESSAGE:\nHow many spaces does PEP 8 want per indentation level?"
STATUS = "Web research returned 2 source(s), numbered [1]..[2]."


def build(budget, **over):
    agent = CentralAgent.__new__(CentralAgent)
    research = {"sources": [{"id": 1, "url": "https://peps.python.org/pep-0008/", "title": "PEP 8", "snippet": "Use 4 spaces."}],
                "evidence": "page text " * 2000}
    from aura.central_agent.research import evidence_block

    args = dict(conversation="CONVERSATION SO FAR:\n" + "old capability line\n" * 400,
                settled="WHAT IS ALREADY SETTLED (shared project context):\n[goal] build a habit tracker\n" * 30,
                status_line=STATUS, evidence=evidence_block(research),
                runtime_block="CONFIGURED RUNTIME:\n" + "provider=ollama; model=m; " * 20,
                question=QUESTION, research=research, budget=budget)
    args.update(over)
    return agent._fit_prompt(**args)


@pytest.mark.parametrize("budget", [2_500, 4_000, 5_500, 12_000])
def test_the_question_and_research_status_survive_every_budget(budget):
    out = build(budget)
    assert out.endswith(QUESTION) and STATUS in out
    assert "Use 4 spaces." in out                      # the real source snippet is kept
    assert len(out) <= budget + 40                     # bounded (a closing fence may add a few chars)
    assert out.count("<untrusted-data") == out.count("</untrusted-data>")   # fences stay balanced


def test_small_prompts_are_left_alone():
    out = build(100_000, conversation="CONVERSATION SO FAR:\nhi", settled="", evidence="")
    assert out == "\n\n".join(["CONVERSATION SO FAR:\nhi", STATUS,
                               "CONFIGURED RUNTIME:\n" + "provider=ollama; model=m; " * 20, QUESTION])


def test_newest_conversation_is_kept_over_oldest():
    conv = "CONVERSATION SO FAR:\n" + "".join(f"turn {i}\n" for i in range(300))
    out = build(2_000, conversation=conv, settled="", evidence="")
    assert "turn 299" in out and "turn 0\n" not in out


def test_fit_text_keeps_the_end():
    text = "A" * 5000 + "THE QUESTION"
    out = fit_text(text, 1000)
    assert len(out) <= 1000 and out.endswith("THE QUESTION") and "trimmed" in out
    assert fit_text("short", 1000) == "short"
