"""A development request is delegated to a coding agent; it is never turned into a file write."""
from aura.central_agent.intent import IntentCompiler


def _compile(message: str):
    return IntentCompiler(mode="heuristic").compile(message)


def test_a_website_improvement_request_is_delegated_not_written_as_a_file():
    intent = _compile(
        "Improve this simple website: make the header and navigation work on phones, and add a "
        "contact form with name, email and message fields and basic validation. "
        "Plain HTML, CSS and JavaScript only.")
    assert intent.requiredCapabilities == ["agent.delegate"]
    assert getattr(intent, "writePath", None) is None


def test_an_explicit_file_write_still_writes_the_file():
    intent = _compile("create a file called notes.txt containing hello world")
    assert intent.requiredCapabilities == ["filesystem.write"]
    assert intent.writePath == "notes.txt"


def test_a_quoted_file_name_with_a_space_is_a_file():
    intent = _compile("write 'my notes.txt' containing hello")
    assert intent.requiredCapabilities == ["filesystem.write"]
    assert intent.writePath == "my notes.txt"


def test_create_a_file_with_a_description_is_delegated_not_written_as_text():
    intent = _compile("Create auth.js with a function login(user, password) that returns true when the password is ok.")
    assert intent.requiredCapabilities == ["agent.delegate"]


def test_with_introduces_literal_text_only_when_it_is_quoted():
    intent = _compile("create a file called notes.txt with 'hello world'")
    assert intent.requiredCapabilities == ["filesystem.write"]
    assert intent.writeContent == "hello world"
