"""A chat reply cannot claim what nothing did.

Capability names that were once injected into the chat prompt became "steps" the
model reported as done ("mission.start", "ready for deployment"). Now: the
catalogue is not in the chat prompt, and any such claim in a reply is flagged.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from aura.central_agent.claims import audit_chat_reply, claims_note

KNOWN = {"mission.start", "mission.approve", "project.create"}


# ── the audit itself (unit) ──────────────────────────────────────────────
def test_a_real_capability_name_is_still_only_a_name():
    note = claims_note("Run mission.start to begin.", KNOWN)
    assert note and "`mission.start`" in note and "not something that was run here" in note
    assert "not in the catalogue" not in note


def test_an_invented_tool_name_is_called_out_as_not_in_the_catalogue():
    audit = audit_chat_reply("Use mission.start then project.deploy-production.", KNOWN)
    assert audit["invented"] == ["project.deploy-production"]
    assert "not in the catalogue at all" in claims_note("Use project.deploy-production.", KNOWN)


@pytest.mark.parametrize("claim", [
    "This plan ensures the project is ready for deployment.",
    "The app is production-ready.",
    "The site has been deployed successfully.",
    "All tests pass.",
    "The build succeeded and everything is working.",
    "I verified the file works.",
])
def test_completion_and_readiness_claims_are_unsupported_in_a_chat(claim):
    note = claims_note(claim)
    assert note and "are not established" in note and "no build, test, deployment" in note


@pytest.mark.parametrize("honest", [
    "I can draft a plan for GREETING.md; nothing has been run.",
    "You could add a test later, and then check whether the build passes.",
    "Workspace is where AURA carries out work.",
    "A markdown file with the word Hello would meet that requirement.",
])
def test_honest_statements_are_left_alone(honest):
    assert claims_note(honest, KNOWN) is None


def test_invented_workspace_and_exit_commands_are_caught_too():
    audit = audit_chat_reply("Use `workspace.exit` and then project.exit.", KNOWN)
    assert audit["capabilities"] == ["workspace.exit", "project.exit"]
    assert audit["invented"] == ["workspace.exit", "project.exit"]


def test_ordinary_dotted_text_is_not_mistaken_for_a_tool():
    assert claims_note("See README.md and example.com or version 1.2.3.", KNOWN) is None


# ── the rewritten answer (what the person reads) ─────────────────────────
from aura.central_agent.claims import (  # noqa: E402
    LABEL_INLINE, LABEL_LINE, PSEUDOCODE_HEADER, rewrite_unsupported_commands)


def test_an_invented_shell_command_is_labelled_pseudocode_in_the_block_itself():
    reply = "To leave, run:\n\n```sh\nworkspace.exit\n```\n\nThat is all."
    text, names = rewrite_unsupported_commands(reply, KNOWN)
    assert names == ["workspace.exit"]
    assert PSEUDOCODE_HEADER in text and LABEL_LINE + "workspace.exit" in text
    assert "```sh\nworkspace.exit\n```" not in text            # no executable-looking copy remains
    assert text.startswith("To leave, run:") and text.rstrip().endswith("That is all.")


def test_a_real_shell_line_in_the_same_block_is_kept_as_written():
    text, names = rewrite_unsupported_commands("```bash\nls -la\nproject.exit\npip install groq\n```", KNOWN)
    assert names == ["project.exit"]
    assert "\nls -la\n" in text and "\npip install groq\n" in text
    assert LABEL_LINE + "project.exit" in text


def test_an_inline_command_and_a_bare_name_are_labelled_once_each():
    text, names = rewrite_unsupported_commands("Use the `project.exit` command, then mission.start.", KNOWN)
    assert text == ("Use the `project.exit`" + LABEL_INLINE + " command, then mission.start" + LABEL_INLINE + ".")
    assert names == ["project.exit", "mission.start"]


def test_ordinary_programming_examples_are_left_exactly_as_written():
    reply = ("```python\nimport requests\nsession = requests.Session()\nr = session.get(url)\n"
             "project.create('x')\nagent.run(task)\n```\n"
             "In JavaScript, `session.get(url)` and `os.path.join` are normal, as is `client.chat.completions.create`.\n"
             "```js\nworkspace.exit(0)\n```")
    text, names = rewrite_unsupported_commands(reply, KNOWN)
    assert text == reply and names == []


@pytest.mark.parametrize("plain", [
    "Edit project.json and workspace.yaml, then open agent.py.",
    "See https://www.project.example.com/tool.dev and tool.io for details.",
    "Contact worker@example.com or visit docs.agent.ai.",
    "Version 1.2.3 of README.md is in memory.db.",
])
def test_file_names_urls_and_domains_are_not_commands(plain):
    assert rewrite_unsupported_commands(plain, KNOWN) == (plain, [])


def test_a_reply_with_nothing_to_label_is_returned_unchanged():
    reply = "A mutex lets one thread at a time use a shared resource."
    assert rewrite_unsupported_commands(reply, KNOWN) == (reply, [])
    assert rewrite_unsupported_commands("", KNOWN) == ("", [])


def test_rewriting_twice_changes_nothing_more():
    once, _ = rewrite_unsupported_commands("Run `project.exit` or\n```sh\nworkspace.exit\n```", KNOWN)
    twice, names = rewrite_unsupported_commands(once, KNOWN)
    assert twice.count(LABEL_INLINE) == once.count(LABEL_INLINE) and twice.count(PSEUDOCODE_HEADER) <= 2


# ── through the real chat path (integration, fake model server) ──────────
REPLY = ("Here is the plan:\n1. Approve it with `mission.approve`.\n2. Start with mission.start.\n"
         "This plan ensures the project is ready for deployment.")


class _Model(BaseHTTPRequestHandler):
    prompts: list[str] = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps({"data": [{"id": "m"}]}).encode()
        self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
        type(self).prompts.append(json.dumps(req["messages"]))
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        self.wfile.write(("data: " + json.dumps({"choices": [{"delta": {"content": REPLY}}]}) + "\n\ndata: [DONE]\n\n").encode())


@pytest.fixture()
def client(tmp_path, monkeypatch):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Model)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    _Model.prompts = []
    home = tmp_path / "home"
    (home / "agent").mkdir(parents=True)
    (home / "agent" / "providers.settings.json").write_text(json.dumps({"active": {
        "providerId": "ollama", "model": "m", "callable": True,
        "baseUrl": f"http://127.0.0.1:{srv.server_address[1]}/v1"}}))
    monkeypatch.setenv("AURA_HOME", str(home))
    monkeypatch.delenv("AURA_SEARCH_ENDPOINT", raising=False)
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    yield TestClient(create_app())
    srv.shutdown()


def test_the_capability_catalogue_is_not_in_the_chat_prompt(client):
    client.post("/agent/chat", json={"message": "Make a plan for GREETING.md.", "projectId": "p1", "surface": "project-chat"})
    sent = _Model.prompts[-1]
    assert "[capability" not in sent and "risk low" not in sent and "risk medium" not in sent
    assert "Nothing has been executed in this chat" in sent       # the rule is in the system prompt


def test_a_model_reply_with_tool_names_and_a_readiness_claim_is_flagged_not_silently_kept(client):
    r = client.post("/agent/chat", json={"message": "Make a plan for GREETING.md.", "projectId": "p1",
                                         "surface": "project-chat"}).json()["result"]
    text = r["summary"]
    # The final answer the person reads: each name is labelled where it appears,
    # not left looking executable with a footnote after it.
    assert "`mission.approve` (an illustrative name, not a real command)" in text
    assert "mission.start (an illustrative name, not a real command)" in text
    assert "not something that was run here" not in text            # the old footnote is gone
    assert "Note: statements such as" in text and "are not established" in text   # readiness claim
    assert any("mission.approve" in c for c in r["unsupportedClaims"])
    assert any("ready for deployment" in c for c in r["unsupportedClaims"])


def test_nothing_ran_and_the_result_says_no_action_was_taken(client):
    r = client.post("/agent/chat", json={"message": "Make a plan for GREETING.md.", "projectId": "p1",
                                         "surface": "project-chat"}).json()["result"]
    assert "Nothing was run or changed" in r["summary"] or "no build, test, deployment" in r["summary"]
    assert r["status"] == "completed"
