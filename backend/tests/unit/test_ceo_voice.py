from aura.central_agent.ceo_voice import MAX_BRIEF_CHARS, assignment_line, handoff_line


def test_assignment_quotes_the_brief_and_shortens_long_ones():
    assert assignment_line("build the front end") == "Next step: build the front end"
    long = assignment_line("x " * 400)
    assert long.startswith("Next step: ") and long.endswith("…")
    assert len(long) <= len("Next step: ") + MAX_BRIEF_CHARS


def test_handoff_reports_success_failure_and_denial_in_plain_words():
    assert handoff_line("OpenCode", "done", "Wrote index.html") == "OpenCode finished the step. Wrote index.html"
    assert "not verify" in handoff_line("Kilo Code", "unverified", None)
    assert "waiting for your Allow" in handoff_line("Claude Code", "denied", None)
    assert "could not finish" in handoff_line("OpenCode", "timeout", "")


def test_missing_worker_name_still_reads_well():
    assert handoff_line("", "done", None).startswith("The worker finished")
