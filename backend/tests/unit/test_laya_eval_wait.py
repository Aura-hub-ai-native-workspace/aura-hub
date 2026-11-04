"""The eval harness's shadow wait is bounded, so a bad env value cannot
disable the wait (zero or NaN) or hold a run open indefinitely."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_PATH = Path(__file__).resolve().parents[2] / "scripts" / "laya_shadow_eval.py"


def _load():
    spec = importlib.util.spec_from_file_location("laya_shadow_eval", _PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ev = _load()


@pytest.mark.parametrize("raw,expected", [
    (None, 180.0),
    ("60", 60.0),
    ("0.5", 0.5),
    ("900", 900.0),
    ("5000", 900.0),
    ("0", 180.0),
    ("-3", 180.0),
    ("nan", 180.0),
    ("inf", 180.0),
    ("soon", 180.0),
    ("", 180.0),
])
def test_eval_wait_is_bounded_and_falls_back(raw, expected):
    assert ev.eval_wait_seconds(raw) == expected
