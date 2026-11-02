"""Collision-safe temporary sibling names for atomic replace.

A fixed temp name (``config.tmp``, ``file.<pid>.tmp``) is shared by every
thread in a process. Two writers then race: one writer's rename moves the
other's file, so a write can fail or tear. A name that also carries a random
token is unique per call, so no two writers can share one.
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path


def unique_sibling(path: str | Path) -> Path:
    """A temp path in the same directory as ``path``, unique per call."""
    target = Path(path)
    return target.with_name(f"{target.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")


def replace_atomic(tmp: str | Path, dest: str | Path) -> None:
    """``os.replace`` that survives another writer holding ``dest`` open.

    On Windows a rename onto a file that another thread is replacing at that
    instant fails with ``PermissionError`` for a few milliseconds. The write is
    still correct, so it is retried briefly; any other failure, and a failure
    that outlasts the retries, is raised as before.
    """
    import time

    delay = 0.005
    for attempt in range(12):
        try:
            os.replace(tmp, dest)
            return
        except PermissionError:
            if os.name != "nt" or attempt == 11:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 0.25)
