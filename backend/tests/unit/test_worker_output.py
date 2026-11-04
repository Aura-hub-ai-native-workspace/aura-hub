"""Worker output cleanup — chrome goes, findings and failures stay.

Representative captured shapes: a Kilo run that answered, one that errored,
one with no answer, and a multi-worker answer. Each shape is the real one
(colour codes, banner line, tool-trace line), copied from a real run.
"""

from __future__ import annotations

from aura.central_agent.worker_output import clean_worker_output

REAL_KILO_RUN = (
    "[0m\n"
    "> code · nvidia/nemotron-3-ultra-550b-a55b:free\n"
    "[0m\n"
    "[0m→ [0mRead alpha/b.txt\n"
    "## FINDINGS\n"
    "- The file `alpha/b.txt` contains a single line: \"alpha B: independent fixture file for worker B.\"\n"
)


def test_chrome_is_removed_and_the_finding_kept():
    out = clean_worker_output(REAL_KILO_RUN)
    assert "alpha B: independent fixture file for worker B." in out
    assert "## FINDINGS" in out
    assert "nemotron" not in out          # banner gone
    assert "→" not in out                 # tool trace gone
    assert "\x1b" not in out and "[0m" not in out  # colour codes gone


def test_an_error_is_kept_not_hidden():
    error = "[0m\n> code · model:x\nError: could not read alpha/missing.txt: ENOENT\n"
    out = clean_worker_output(error)
    assert "Error: could not read alpha/missing.txt: ENOENT" in out


def test_chrome_only_output_is_empty_not_a_success():
    assert clean_worker_output("[0m\n> code · model:x\n[0m→ [0mRead a.txt\n") == ""


def test_empty_input_stays_empty():
    assert clean_worker_output("") == ""


def test_a_real_arrow_in_a_finding_is_kept():
    """Only the trace shape is removed: an arrow inside a sentence is content."""
    text = "The flow is A → B, then the result is written."
    assert clean_worker_output(text) == text


def test_a_sentence_that_starts_with_an_arrow_is_kept():
    """The trace shape is a capitalised verb and one target; prose is not."""
    text = "→ Two findings follow.\n- first finding"
    assert "→ Two findings follow." in clean_worker_output(text)


def test_multiple_findings_survive_intact():
    text = "- one\n- two\n- three"
    assert clean_worker_output(text) == text
