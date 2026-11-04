"""JSON extraction from model replies, and what a failure reports.

The old extraction took everything from the first brace to the last, so a
reply with a trailing brace in prose became unparseable ("Extra data"). A
truncated reply could also yield a nested fragment in place of the whole.
"""

from __future__ import annotations

import json

import pytest

from aura.central_agent.model_routing import (
    ModelResponseError,
    _extract_json_object,
    _response_diagnostics,
)


def _parses(text: str) -> bool:
    match, _ = _extract_json_object(text)
    if match is None:
        return False
    try:
        json.loads(match)
    except ValueError:
        return False
    return True


class TestExtraction:
    @pytest.mark.parametrize("text", [
        '{"tasks": [{"id": "a"}], "acceptance": []}',
        '{"tasks": [{"id": "a"}]}\nNote: use {placeholder} if needed.',
        'Use {x} first, then {"tasks": [{"id": "a"}]}',
        '```json\n{"tasks": [{"id": "a"}]}\n```\nDone {ok}',
        '{"description": "use } and { here", "id": "a"}',
        '{"description": "say \\"hi\\" }", "id": "a"}',
    ])
    def test_valid_replies_extract_and_parse(self, text):
        assert _parses(text)

    def test_trailing_brace_in_prose_no_longer_breaks_a_valid_object(self):
        match, status = _extract_json_object(
            '{"tasks": []}\nSee {notes}.')
        assert json.loads(match) == {"tasks": []}
        assert status == "balanced"

    def test_truncated_reply_yields_no_nested_fragment(self):
        match, status = _extract_json_object('{"tasks": [{"id": "a"}')
        assert status == "unbalanced"
        assert match.startswith('{"tasks"')

    def test_malformed_outer_object_does_not_yield_a_nested_one(self):
        text = '{"a": {"b": 1} "c": 2}'
        match, status = _extract_json_object(text)
        assert status == "invalid"
        assert match == text

    def test_unescaped_quote_keeps_the_observed_parser_error(self):
        """The live 27B failure class: a bad string literal inside an object.
        The parser's error text is the evidence and must stay."""
        match, status = _extract_json_object(
            '{"tasks": [{"id": "a", "description": "use "x" here"}]}')
        assert status == "invalid"
        with pytest.raises(json.JSONDecodeError) as err:
            json.loads(match)
        assert "Expecting ',' delimiter" in str(err.value)

    def test_no_object_reports_none(self):
        assert _extract_json_object("no braces at all") == (None, "none")


class TestFailureReporting:
    def test_diagnostics_hold_sizes_and_offsets_not_reply_text(self):
        raw = "SECRET-REPLY-TEXT " * 20
        diag = _response_diagnostics(
            raw, {"finish_reason": "stop"}, "invalid",
            json.JSONDecodeError("Expecting ',' delimiter", raw, 2120))
        assert diag == {
            "responseChars": len(raw), "finishReason": "stop",
            "extraction": "invalid", "parseErrorOffset": 2120,
            "parseErrorKind": "JSONDecodeError",
        }
        assert "SECRET-REPLY-TEXT" not in json.dumps(diag)

    def test_error_message_and_repr_never_carry_reply_text(self):
        err = ModelResponseError("provider JSON did not parse",
                                 diagnostics={"responseChars": 3},
                                 raw="SECRET-REPLY-TEXT")
        assert "SECRET-REPLY-TEXT" not in str(err)
        assert "SECRET-REPLY-TEXT" not in repr(err)
        assert err.raw == "SECRET-REPLY-TEXT"
