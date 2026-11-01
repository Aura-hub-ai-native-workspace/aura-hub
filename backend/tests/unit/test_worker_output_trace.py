from aura.central_agent.worker_output import clean_worker_output

REPORT = "## Summary\nCreated auth.js.\n\n## Remaining Issues\n\nNone.\n"


def test_the_opencode_trace_after_the_report_is_dropped():
    raw = (REPORT + "\n\n\u2717 Glob \"**/*\" failed\nError: Call mcp__common-context__load_context before any work.\n"
           "\u2699 execute {\"code\":\"x\"}\n\u2190 Write auth.js\nCreated file successfully: auth.js\n$ node -e \"1\"\ncorrect: true\n")
    assert clean_worker_output(raw) == REPORT.strip()


def test_a_review_that_lists_items_with_a_cross_keeps_them():
    review = "Findings:\n\u2717 missing input check in auth.js\n\u2717 no tests\nAURA-REVIEW: CHANGES-REQUIRED"
    assert clean_worker_output(review) == review


def test_colour_codes_and_the_banner_are_still_removed():
    assert clean_worker_output("\x1b[0m> build \u00b7 beam-free\n\x1b[0mAnswer here") == "Answer here"
