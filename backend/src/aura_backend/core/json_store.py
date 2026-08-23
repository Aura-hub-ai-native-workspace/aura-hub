"""Atomic JSON persistence primitive.

The reference backend persists state as JSON files under the AURA home
directory. This module is the single write path for that state in the
Python backend: write-to-temp, fsync, rename — a reader never observes a
half-written file, and a crash leaves either the old or the new content.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any


def read_json(path: Path, default: Any = None) -> Any:
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except json.JSONDecodeError:
        # Corrupted persistence is surfaced as the default, never a crash;
        # rebuild/recovery semantics belong to the owning subsystem.
        return default


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class JsonStore:
    """A named JSON document with process-local write serialization."""

    def __init__(self, path: Path, default: Any = None):
        self.path = path
        self._default = default
        self._lock = threading.Lock()

    def load(self) -> Any:
        return read_json(self.path, self._default)

    def save(self, value: Any) -> None:
        with self._lock:
            atomic_write_json(self.path, value)

    def update(self, fn) -> Any:
        """Read-modify-write under the lock; returns the new value."""
        with self._lock:
            value = read_json(self.path, self._default)
            value = fn(value)
            atomic_write_json(self.path, value)
            return value
