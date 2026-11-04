"""AURA's side of the shared common-context protocol, on the project's `common-context.json`.

The same file and lock protocol the built-in store (packages/ai-service/src/commonContext) and the
agents use, so every worker on a project sees what the others did. A run follows the protocol for the
workers: it LOADS the brief before each task, CHECKPOINTS after each task, records FAILURES, and
SAVES a summary when the run ends. Everything here is best-effort: shared context helps a worker, it
is never a gate, so no failure in this module may break or delay a run.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

STORE_FILE = "common-context.json"
SCHEMA_VERSION = 2
_LOCK_STALE_S = 10.0
_LOCK_WAIT_S = 5.0
AGENT = "aura-ceo"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _empty() -> dict:
    return {"version": SCHEMA_VERSION, "created": _now(), "contexts": {}, "sessions": [], "failures": [],
            "claims": {}, "broadcasts": [], "patterns": {"works": [], "fails": []}}


def _normalize(raw: object) -> dict:
    data = raw if isinstance(raw, dict) else _empty()
    base = _empty()
    for key, default in base.items():
        if not isinstance(data.get(key), type(default)):
            data[key] = default
    data["version"] = SCHEMA_VERSION
    return data


class _Locked:
    """The store's cross-process lock: an O_EXCL `<file>.lock`, stale after 10 seconds."""

    def __init__(self, path: Path) -> None:
        self.lock = Path(f"{path}.lock")
        self.token = f"{os.getpid()}-{time.time_ns()}"

    def __enter__(self) -> "_Locked":
        deadline = time.monotonic() + _LOCK_WAIT_S
        while True:
            try:
                fd = os.open(self.lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.write(fd, self.token.encode())
                os.close(fd)
                return self
            except FileExistsError:
                try:
                    if time.time() - self.lock.stat().st_mtime > _LOCK_STALE_S:
                        self.lock.unlink()
                        continue
                except OSError:
                    continue
                if time.monotonic() > deadline:
                    raise TimeoutError("shared context is locked by another process")
                time.sleep(0.02)

    def __exit__(self, *exc: object) -> None:
        try:
            if self.lock.read_text(encoding="utf-8").strip() == self.token:
                self.lock.unlink()
        except OSError:
            pass


def _transact(project_dir: str, fn, persist: bool):
    path = Path(project_dir) / STORE_FILE
    with _Locked(path):
        try:
            data = _normalize(json.loads(path.read_text(encoding="utf-8"))) if path.is_file() else _empty()
        except (OSError, ValueError):
            data = _empty()
        out = fn(data)
        if persist:
            tmp = path.with_name(f"{STORE_FILE}.{os.getpid()}.tmp")
            tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
            os.chmod(tmp, 0o600)
            tmp.replace(path)
        return out


def _clip(text: str, n: int) -> str:
    return text if len(text) <= n else text[:n]


def load_brief(project_dir: str | None, budget: int = 3000) -> str:
    """What the other agents recorded on this project, short enough to put in a brief. Empty if nothing."""
    if not project_dir or not Path(project_dir).is_dir():
        return ""
    try:
        def read(d: dict) -> str:
            lines: list[str] = []
            for s in [s for s in d["sessions"] if s.get("status") == "completed"][-3:]:
                lines.append(f'Session "{s.get("title", "")}": {_clip(str(s.get("accomplished", "")), 300)}'
                             + (f' Next: {_clip(str(s.get("next_steps", "")), 200)}' if s.get("next_steps") else ""))
            recent = sorted(d["contexts"].items(), key=lambda kv: str(kv[1].get("updated", "")), reverse=True)[:10]
            for key, c in recent:
                lines.append(f'{key} ({c.get("agent", "?")}): {_clip(str(c.get("value", "")), 300)}')
            for f in d["failures"][-5:]:
                lines.append(f'Failed approach: {_clip(str(f.get("approach", "")), 150)} — {_clip(str(f.get("why_failed", "")), 200)}')
            return "\n".join(lines)
        text = _transact(project_dir, read, persist=False)
    except Exception:  # noqa: BLE001 — shared context helps; it never gates
        return ""
    return _clip(text, budget)


def checkpoint(project_dir: str | None, key: str, value: str, agent: str = AGENT) -> None:
    """Save a fact under `key`, keeping the previous value in its history."""
    if not project_dir or not Path(project_dir).is_dir() or not key:
        return
    try:
        def write(d: dict) -> None:
            prior = d["contexts"].get(key)
            history = ([*prior.get("history", []), {"value": prior.get("value", ""), "agent": prior.get("agent", ""),
                                                    "updated": prior.get("updated", "")}][-20:] if prior else [])
            d["contexts"][key] = {"value": _clip(value, 20000), "tags": ["aura-run"], "agent": agent,
                                  "updated": _now(), "history": history}
        _transact(project_dir, write, persist=True)
    except Exception:  # noqa: BLE001
        pass


def record_failure(project_dir: str | None, approach: str, why: str, agent: str = AGENT) -> None:
    if not project_dir or not Path(project_dir).is_dir():
        return
    try:
        def write(d: dict) -> None:
            d["failures"].append({"approach": _clip(approach, 1000), "why_failed": _clip(why, 2000),
                                  "agent": agent, "timestamp": _now()})
            d["patterns"]["fails"] = [*d["patterns"]["fails"], _clip(approach, 200)][-50:]
        _transact(project_dir, write, persist=True)
    except Exception:  # noqa: BLE001
        pass


def save_summary(project_dir: str | None, title: str, accomplished: str, next_steps: str = "",
                 learned: str = "", decisions: str = "", agent: str = AGENT) -> None:
    """Close this run's session with a summary the next agent reads first."""
    if not project_dir or not Path(project_dir).is_dir():
        return
    try:
        def write(d: dict) -> None:
            d["sessions"].append({
                "id": f"{agent}-{int(time.time())}", "title": _clip(title, 200), "status": "completed",
                "accomplished": _clip(accomplished, 20000), "learned": _clip(learned, 20000),
                "decisions": _clip(decisions, 20000), "next_steps": _clip(next_steps, 20000),
                "checkpoint": "", "agent": agent, "timestamp": _now(), "heartbeat": _now(), "ended_at": _now()})
        _transact(project_dir, write, persist=True)
    except Exception:  # noqa: BLE001
        pass
