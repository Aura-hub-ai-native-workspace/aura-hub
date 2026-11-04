"""Laya, the CEO's decision model: the choices it makes for a plan.

It picks the worker for a step, says whether a change is small, and answers the typed questions
the plan changes ask (laya_plan). It never authorises anything: it chooses only among workers the
owner's policy already allows. The model loads once in a worker process (laya_worker.py). Until it
is ready the advisor answers nothing, and any failure turns it off without raising.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
from pathlib import Path

def default_python(os_name: str | None = None) -> Path:
    """Where Laya's own Python lives: a virtual environment under AURA's home (a different layout on Windows)."""
    layout = ("Scripts", "python.exe") if (os_name or os.name) == "nt" else ("bin", "python")
    return Path.home().joinpath(".aura", "laya-venv", *layout)


DEFAULT_PYTHON = default_python()
WORKER = Path(__file__).with_name("laya_worker.py")

#: Laya's answer is used only at or above this confidence; below it the usual rule decides.
MIN_CONFIDENCE = 0.75

#: Small edits go to this worker by default, when it is allowed and eligible.
SMALL_EDIT_WORKER = "opencode"
SMALL_INSTRUCTIONS = "Is the change described in `body` a small edit?"
SMALL_CRITERIA = {
    "small": "one file or a few lines: add a footer, change a colour, rename something, fix a typo, create one small file",
    "large": "a feature, a new page, several files, or a build with more than one part",
}

#: The only variables the worker needs: where it runs and where the model cache lives.
_ENV_KEYS = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "XDG_CACHE_HOME", "HF_HOME",
             "HUGGINGFACE_HUB_CACHE", "TRANSFORMERS_CACHE",
             # what a Windows Python needs to start at all
             "SYSTEMROOT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATHEXT", "COMSPEC")


def _new_group() -> dict:
    """Own process group, so the worker can be stopped with anything it started."""
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def _worker_env() -> dict[str, str]:
    env = {k: os.environ[k] for k in _ENV_KEYS if k in os.environ}
    env["USE_TF"] = "0"
    return env


#: Small edits go to this worker by default, when it is allowed and eligible.
SMALL_EDIT_WORKER = "opencode"
SMALL_INSTRUCTIONS = "Is the change described in `body` a small edit?"
SMALL_CRITERIA = {
    "small": "one file or a few lines: add a footer, change a colour, rename something, fix a typo, create one small file",
    "large": "a feature, a new page, several files, or a build with more than one part",
}


class LayaAdvisor:
    def __init__(self, python: str | None = None, script: Path = WORKER,
                 reply_timeout_s: float = 30.0, ready_timeout_s: float = 900.0) -> None:
        self._python = python or os.environ.get("AURA_LAYA_PYTHON") or str(DEFAULT_PYTHON)
        self._script = script
        self._reply_timeout_s = reply_timeout_s
        self._ready_timeout_s = ready_timeout_s
        self._state = "cold"           # cold | loading | ready | failed | disabled
        self._proc: subprocess.Popen | None = None
        self._lines: queue.Queue = queue.Queue()
        self._lock = threading.Lock()
        self._seq = 0

    @property
    def state(self) -> str:
        return self._state

    def warm(self) -> None:
        """Start loading the model in the background. Safe to call repeatedly."""
        with self._lock:
            if self._state != "cold":
                return
            self._state = "loading"
        threading.Thread(target=self._start, name="laya-advisor-start", daemon=True).start()

    def _start(self) -> None:
        if not Path(self._python).exists():
            self._state = "disabled"
            return
        try:
            proc = subprocess.Popen([self._python, str(self._script)], stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
                                    env=_worker_env(), **_new_group())
        except OSError:
            self._state = "failed"
            return
        self._proc = proc
        threading.Thread(target=self._pump, args=(proc,), daemon=True).start()
        try:
            first = json.loads(self._lines.get(timeout=self._ready_timeout_s))
        except (queue.Empty, ValueError):
            first = {}
        self._state = "ready" if first.get("ready") else "failed"
        if self._state == "failed":
            self._stop()

    def _pump(self, proc: subprocess.Popen) -> None:
        for line in proc.stdout or []:
            self._lines.put(line)

    def is_small_edit(self, brief: str) -> bool:
        """Whether Laya is confident the change is a small edit (one file or a few lines)."""
        pick = self.ask_choice(brief, SMALL_INSTRUCTIONS, SMALL_CRITERIA)
        return pick is not None and pick[0] == "small" and pick[1] >= MIN_CONFIDENCE

    def choose_worker(self, brief: str, candidates: list[dict]) -> dict | None:
        """Laya picks one of the allowed workers for a step: {"worker", "probability"}.

        ``candidates`` are the workers the owner's policy already allows, so Laya can
        only choose among them; it never authorises a worker. None when Laya is not
        ready, cannot answer, or names a worker that is not in the list.
        """
        allowed = {c["id"]: f"{c.get('name') or c['id']}: {c.get('description') or 'coding agent'}"
                   for c in candidates}
        if not allowed:
            return None
        questions = {"worker": {
            "type": "choice",
            "instructions": "Which coding agent should carry out the step described in `body`?",
            "criteria": allowed,
        }}
        reply = self._ask({"body": brief[:4000]}, questions)
        answer = ((reply or {}).get("result") or {}).get("answers", {}).get("worker") or {}
        worker = answer.get("choice")
        if worker not in allowed:
            return None
        probability = float((answer.get("probabilities") or {}).get(worker, 0.0))
        return {"worker": worker, "probability": round(probability, 2)}

    def ask_choice(self, brief: str, instructions: str, criteria: dict[str, str]) -> tuple[str, float] | None:
        """Laya picks one of ``criteria`` for ``brief``: (choice, probability), or None."""
        if not criteria:
            return None
        questions = {"decision": {"type": "choice", "instructions": instructions, "criteria": criteria}}
        reply = self._ask({"body": brief[:4000]}, questions)
        answer = ((reply or {}).get("result") or {}).get("answers", {}).get("decision") or {}
        choice = answer.get("choice")
        if choice not in criteria:
            return None
        return choice, float((answer.get("probabilities") or {}).get(choice, 0.0))

    def _ask(self, state: dict, questions: dict) -> dict | None:
        """One request to the worker process. None when it is not ready or fails."""
        if self._state == "cold":
            self.warm()
            return None
        if self._state != "ready":
            return None
        with self._lock:
            self._seq += 1
            request = {"id": self._seq, "state": state, "questions": questions}
            try:
                assert self._proc is not None and self._proc.stdin is not None
                self._proc.stdin.write(json.dumps(request) + "\n")
                self._proc.stdin.flush()
                reply = self._read_reply(self._seq)
            except (OSError, AssertionError, ValueError):
                reply = None
            if reply is None:
                self._state = "failed"
                self._stop()
            return reply

    def _read_reply(self, seq: int) -> dict | None:
        while True:
            try:
                reply = json.loads(self._lines.get(timeout=self._reply_timeout_s))
            except (queue.Empty, ValueError):
                return None
            if reply.get("id") == seq:
                return reply if "result" in reply else None
            if "error" in reply and reply.get("id") in (None, seq):
                return None

    def _stop(self) -> None:
        proc, self._proc = self._proc, None
        if proc is not None and proc.poll() is None:
            proc.kill()


_advisor: LayaAdvisor | None = None


def laya_advisor() -> LayaAdvisor:
    global _advisor
    if _advisor is None:
        _advisor = LayaAdvisor()
    return _advisor
