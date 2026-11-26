"""Registry of worker processes run on the host, without a container (issue #112).

A container is attributable by its labels; a host process is not. Each
host worker is recorded when it starts and removed when it ends:
``$AURA_HOME/run/workers/<entry-id>.json`` with the owning instance, the
pid and its start identity, so a reused pid is never mistaken for it.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path

from .procident import start_identity


def workers_dir(home: str | Path) -> Path:
    return Path(home) / "run" / "workers"


def register(home: str | Path, instance_id: str, pid: int, *, binary: str = "",
             invocation: str = "") -> str | None:
    """Record a host worker. Returns the entry id, or None if it could not be recorded."""
    try:
        d = workers_dir(home)
        d.mkdir(parents=True, exist_ok=True)
        entry_id = uuid.uuid4().hex
        record = {"id": entry_id, "instance": instance_id, "pid": pid,
                  "pgid": pid if os.name != "nt" else None,
                  "startIdentity": start_identity(pid), "binary": binary,
                  "invocation": invocation,
                  "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        tmp = d / f".{entry_id}.tmp"
        tmp.write_text(json.dumps(record), encoding="utf-8")
        os.replace(tmp, d / f"{entry_id}.json")
        return entry_id
    except OSError:
        return None


def unregister(home: str | Path, entry_id: str | None) -> None:
    if not entry_id:
        return
    try:
        (workers_dir(home) / f"{entry_id}.json").unlink()
    except OSError:
        pass


def entries(home: str | Path) -> list[dict]:
    out = []
    d = workers_dir(home)
    if not d.is_dir():
        return out
    for f in sorted(d.glob("*.json")):
        try:
            rec = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            out.append({"id": f.stem, "_unreadable": True})
            continue
        if isinstance(rec, dict):
            rec.setdefault("id", f.stem)
            out.append(rec)
    return out
