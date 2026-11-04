"""A text source made of a free coding agent, for conversation answers only.

With no text model connected, a question still deserves an answer. A connected, allowed coding agent
can write one (and search the web for it), so it is used as the text source for CHAT ANSWERS and
nothing else: it never proposes plans, never compiles intents and never picks workers (Laya does).

It runs through the same governed `agent.delegate` call as every other worker, with the read-only
research role, in an empty temporary folder, so it has no project to change. The result is the
agent's reply with its terminal chrome removed.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from types import SimpleNamespace

#: Appended to every question put to the agent.
ANSWER_RULES = (
    "Answer in plain markdown. If the question needs current or outside information, use web search "
    "and list the source URL for each claim. If a search tool fails, do not give up: read the "
    "authoritative page or API directly (for example the project's official release page or its "
    "JSON/API endpoint) with a read-only fetch, and cite that URL. Only say you could not confirm "
    "something after those direct reads also fail. Do not create, edit or delete any file, and do not "
    "run commands that change anything."
)


class AgentTextPort:
    """The part of the model-port contract that answering needs, and nothing more."""

    def __init__(self, run: Callable[[str, Callable[[], bool] | None], str | None],
                 worker_id: str, worker_name: str) -> None:
        self._run = run
        self._latency_ms: float | None = None
        self.providers = [SimpleNamespace(id=worker_id, model=f"{worker_name} (coding agent)",
                                          network_class="cloud", base_url="")]

    def complete_json(self, system: str, user: str):  # noqa: ARG002 — agents never compile intents
        return None

    def telemetry(self) -> dict:
        """Who wrote the last answer, in the shape the provider bridge reads."""
        who = self.providers[0]
        return {"lastCall": {"provider": who.id, "model": who.model, "latencyMs": self._latency_ms}}

    def complete_stream(self, system: str, user: str, on_token=None, should_stop=None) -> str | None:
        started = time.monotonic()
        text = self._run(f"{system}\n\n{user}\n\n{ANSWER_RULES}", should_stop)
        self._latency_ms = round((time.monotonic() - started) * 1000, 1)
        if text and on_token is not None:
            on_token(text)
        return text
