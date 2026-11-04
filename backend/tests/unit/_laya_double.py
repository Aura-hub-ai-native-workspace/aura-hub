"""A ready stand-in for Laya in handoff tests: it picks the first allowed agent."""
from __future__ import annotations


class ReadyLaya:
    state = "ready"

    def warm(self) -> None:
        pass

    def ask_choice(self, brief, instructions, criteria):
        return None  # no plan changes

    def choose_worker(self, brief, candidates):
        if not candidates:
            return None
        return {"worker": candidates[0]["id"], "probability": 0.9}


def use_ready_laya(monkeypatch) -> None:
    import aura.central_agent.laya_advisor as adv

    monkeypatch.setattr(adv, "laya_advisor", lambda: ReadyLaya())
