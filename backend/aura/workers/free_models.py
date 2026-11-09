"""Which free OpenCode model a worker runs on, and moving on when one is out.

OpenCode's free models come and go ("free for a limited time") and are rate
limited, so a run that names no model gets one from a ladder, and a run that
hits a capacity limit is retried on the next rung. A model that ran out rests
for a while, so the next task does not walk into the same wall.

The ladder holds only free models whose published terms say they do not train
on what is sent: zero retention first, then 30-day retention without training.
Models that may train on the code (Pulse, MiMo, Big Pickle, Flint) or that say
not to send confidential data (Nemotron) are never chosen automatically.
Only models the installed OpenCode actually lists are used.

Set AURA_FREE_MODELS=off to leave the model to OpenCode.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from collections.abc import Callable

from ..config import aura_home
from ..jsonutil import write_json_atomic

#: Privacy order: zero retention and no training, then 30-day retention and no training.
PRIVATE_FREE_LADDER: tuple[str, ...] = (
    "opencode/glm-5.3-flash-free",
    "opencode/deepseek-v4.1-flash-free",
    "opencode/beam-free",
    "opencode/crouton-alpha-free",
)
COOLDOWN_S = 30 * 60
LIST_TTL_S = 10 * 60
#: Output that means "this model cannot take the work right now", not "the work failed".
_CAPACITY = re.compile(
    r"rate.?limit|too many requests|\b429\b|quota|usage limit|overloaded|"
    r"insufficient (balance|credits?)|model (is )?(not found|unavailable|no longer)|"
    r"no longer (free|available)|free (tier|period) (has )?ended",
    re.IGNORECASE)

_lock = threading.Lock()
_listed: dict[str, tuple[float, list[str]]] = {}


def enabled() -> bool:
    return os.environ.get("AURA_FREE_MODELS", "").strip().lower() not in ("off", "0", "false")


def is_capacity_failure(output: str) -> bool:
    """Only an error line counts: a worker that merely discusses HTTP 429 in
    its work must not have a good run thrown away and repeated."""
    return any("error" in line.lower() and _CAPACITY.search(line)
               for line in (output or "")[-4000:].splitlines())


def _list_models(binary: str) -> list[str]:
    from ..environment.procexec import ExecStatus, run_argv

    out = run_argv([binary, "models"], timeout_ms=60_000)
    if out.status is not ExecStatus.OK:
        return []
    return [line.strip() for line in out.stdout.splitlines() if "/" in line.strip()]


def available(binary: str = "opencode",
              lister: Callable[[str], list[str]] | None = None) -> list[str]:
    """The models this OpenCode lists, cached for a few minutes."""
    with _lock:
        cached = _listed.get(binary)
        if cached and time.monotonic() - cached[0] < LIST_TTL_S:
            return cached[1]
    try:
        models = (lister or _list_models)(binary)
    except Exception:  # noqa: BLE001 — no list means OpenCode picks, nothing breaks
        models = []
    if models:  # a failed or slow lookup is tried again next time, not remembered
        with _lock:
            _listed[binary] = (time.monotonic(), models)
    return models


def _cooldown_file():
    return aura_home() / "model-cooldowns.json"


def _cooldowns() -> dict[str, float]:
    try:
        raw = json.loads(_cooldown_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    now = time.time()
    return {m: float(t) for m, t in raw.items() if isinstance(t, (int, float)) and t > now}


def cool_down(model: str, seconds: float = COOLDOWN_S) -> None:
    """Rest a model that ran out, for this and later tasks."""
    with _lock:
        rests = _cooldowns()
        rests[model] = time.time() + seconds
        try:
            _cooldown_file().parent.mkdir(parents=True, exist_ok=True)
            write_json_atomic(_cooldown_file(), rests)
        except OSError:
            pass


def pick(binary: str = "opencode", exclude: tuple[str, ...] = (),
         lister: Callable[[str], list[str]] | None = None) -> str | None:
    """The first private free model that is listed, not resting and not excluded."""
    if not enabled():
        return None
    listed = set(available(binary, lister))
    resting = _cooldowns()
    for model in PRIVATE_FREE_LADDER:
        if model in listed and model not in resting and model not in exclude:
            return model
    return None


def with_model(args: list[str], model: str) -> list[str]:
    """The same arguments with `--model` set to `model`."""
    out = list(args)
    if "--model" in out:
        i = out.index("--model")
        if i + 1 < len(out):
            out[i + 1] = model
            return out
    # Before the task text, which is always last.
    return [*out[:-1], "--model", model, out[-1]] if out else ["--model", model]
