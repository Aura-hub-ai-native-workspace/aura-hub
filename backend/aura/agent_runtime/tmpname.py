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
    """``os.replace`` that survives another writer holding ``dest`` (see ``jsonutil.replace_with_retry``)."""
    from ..jsonutil import replace_with_retry

    replace_with_retry(tmp, dest)
