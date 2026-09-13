"""Reading a reviewer's verdict out of bounded worker output.

A worker's text is DATA. This module never lets it grant anything: the
only question it answers is whether AURA should dispatch remediation
work that is ALREADY in the plan and already governed. Both answers are
safe by construction —

  "nothing to fix"  → AURA skips a dispatch it was authorised to make;
  anything else     → AURA does the work it was going to do anyway.

So a forged verdict can at most cause extra governed work, never skip
verification, never satisfy an acceptance criterion, and never approve
anything. Acceptance still requires the review task itself to be done
AND verified against its task contract.

AURA asks the reviewing worker for one marker line and reads only that.
Prose is not parsed for sentiment: a paragraph that happens to contain
"looks good" is not a verdict, and treating it as one would be exactly
the kind of inference this codebase refuses to make.
"""

from __future__ import annotations

import re

#: The line AURA asks a reviewing worker to end with. Anchored to line
#: starts so it cannot be smuggled in mid-sentence by quoted content.
MARKER = "AURA-REVIEW:"
_VERDICT_RE = re.compile(
    r"^\s*(?:[-*>#\s]*)AURA-REVIEW:\s*(PASS|CHANGES-REQUIRED)\b",
    re.IGNORECASE | re.MULTILINE)

#: How much of a worker's output is inspected. The marker is requested at
#: the end; a runtime that buries it under megabytes of log is not
#: reporting a verdict AURA can rely on.
MAX_SCAN_CHARS = 20_000

CLEAN = "clean"
FINDINGS = "findings"
UNREADABLE = "unreadable"


def review_verdict(stdout: str) -> str:
    """CLEAN / FINDINGS / UNREADABLE for one reviewer's bounded output.

    UNREADABLE covers no marker, a malformed marker, and — deliberately —
    CONFLICTING markers: output containing both verdicts is not a verdict,
    and picking one would let quoted text decide.
    """
    text = (stdout or "")[-MAX_SCAN_CHARS:]
    found = {m.group(1).upper() for m in _VERDICT_RE.finditer(text)}
    if found == {"PASS"}:
        return CLEAN
    if found == {"CHANGES-REQUIRED"}:
        return FINDINGS
    return UNREADABLE


def should_run_after(verdicts: list[str]) -> tuple[bool, str]:
    """Does remediation need to run, given every dependency's verdict?

    Returns (run, why). Fails toward running: only an unambiguous "every
    reviewer reported nothing" skips the dispatch.
    """
    if not verdicts:
        return True, "no upstream verdict was available"
    if any(v == UNREADABLE for v in verdicts):
        return True, ("the review did not end with a verdict AURA could "
                      "read, so the follow-up work was carried out rather "
                      "than assumed unnecessary")
    if any(v == FINDINGS for v in verdicts):
        return True, "the review reported findings to address"
    return False, "the review reported no findings to address"


def verdict_instruction() -> str:
    """The line AURA appends to a review brief. Requesting the marker is
    what makes the verdict readable at all; nothing infers it."""
    return (
        "\n\nFinish your reply with exactly one line, on its own, in this "
        f"form:\n{MARKER} PASS\nor\n{MARKER} CHANGES-REQUIRED\n"
        "Use CHANGES-REQUIRED if you found anything that should be fixed, "
        "and list those findings above the line."
    )


__all__ = ["CLEAN", "FINDINGS", "MARKER", "UNREADABLE", "review_verdict",
           "should_run_after", "verdict_instruction"]
