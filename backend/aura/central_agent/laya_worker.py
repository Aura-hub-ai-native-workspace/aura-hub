#!/usr/bin/env python3
"""Laya decision worker: a long-lived process that keeps the model loaded.

Runs under the Laya environment (~/.aura/laya-venv), not the AURA backend's own
interpreter, so the model's libraries stay separate. Protocol, one JSON object per
line: a request ``{"id", "state", "questions"}`` on stdin gets one reply on stdout,
``{"id", "result"}`` or ``{"id", "error"}``. The first line is ``{"ready": true}`` once
the model is loaded, or ``{"ready": false, "error": ...}`` if it cannot be.
"""

import json
import os
import sys

# Keep stdout for the protocol only: anything a library prints goes to stderr.
_out = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
os.environ.setdefault("USE_TF", "0")
MODEL = os.environ.get("AURA_LAYA_MODEL", "convaiinnovations/laya-multilingual")


def emit(obj: dict) -> None:
    _out.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _out.flush()


def main() -> int:
    try:
        import laya

        agent = laya.load(MODEL)
    except Exception as exc:  # noqa: BLE001 — reported to the caller, never raised
        emit({"ready": False, "error": f"{type(exc).__name__}: {str(exc)[:200]}"})
        return 1
    emit({"ready": True})
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            emit({"error": "bad request"})
            continue
        try:
            emit({"id": req.get("id"), "result": agent.predict(req["state"], req["questions"])})
        except Exception as exc:  # noqa: BLE001
            emit({"id": req.get("id"), "error": f"{type(exc).__name__}: {str(exc)[:200]}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
