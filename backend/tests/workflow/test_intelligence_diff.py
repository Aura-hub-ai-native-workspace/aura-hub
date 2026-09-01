"""Intelligence-node differential — frozen @aura/intelligence classifiers.

The KeywordIntentClassifier and TemplatePromptEnhancer are deterministic in
the TypeScript oracle; their Python ports must agree EXACTLY (type,
confidence to 1e-6, rationale, alternatives, enhanced text, system hints,
directives) across a vector battery. This is genuine TS-oracle parity.

The model-backed runners (groq / generate-*) have NO engine-level oracle
(the frozen TS workflow engine skips those types), so they are covered by
contract tests with a scripted port instead — see test_intelligence_nodes.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aura.workflow.intelligence import (  # noqa: E402
    KeywordIntentClassifier,
    TemplatePromptEnhancer,
)

DRIVER = Path(__file__).parents[1] / "differential" / "ts_driver.mjs"
ENV = {
    "TSREF_INTENTCLS": "/tmp/opencode/tsref/intentcls.mjs",
    "TSREF_PROMPTENH": "/tmp/opencode/tsref/promptenh.mjs",
}

VECTORS = [
    "write me a test",
    "hello",
    "fix the bug in foo.py",
    "summarize this document tl;dr",
    "where is the config file located?",
    "can you explain how auth works?",
    "/deploy production now",
    "convert this json to yaml",
    "",
    "translate hello into french, keep it brief",
    "search for all TODO comments and make a detailed report",
]


def _run_oracle(texts: list[str]) -> list[dict]:
    if not all(Path(p).exists() for p in ENV.values()):
        pytest.skip("TS oracle bundles missing; run rebuild-oracle-bundles.mjs")
    env = {**os.environ, **ENV}
    proc = subprocess.run(
        ["node", str(DRIVER), "intentops"],
        input=json.dumps({"func": "intentops", "input": {"texts": texts}}),
        capture_output=True, text=True, timeout=30, env=env)
    assert proc.returncode == 0, f"intentops rc={proc.returncode}: {proc.stderr[-300:]}"
    return json.loads(proc.stdout)


def _norm(frame: dict) -> dict:
    intent = frame["intent"]
    return {
        "type": intent["type"],
        "confidence": round(intent["confidence"], 6),
        "rationale": intent["rationale"],
        "alternatives": [{"type": a["type"], "confidence": round(a["confidence"], 6)}
                         for a in intent.get("alternatives") or []],
        "enhanced": frame["enhanced"],
        "systemHints": frame["systemHints"],
        "directives": frame["directives"],
    }


def test_classifier_and_enhancer_match_ts_oracle():
    oracle = _run_oracle(VECTORS)
    classifier = KeywordIntentClassifier()
    enhancer = TemplatePromptEnhancer()
    problems: list[str] = []
    for text, ts_frame in zip(VECTORS, oracle):
        py_intent = classifier.classify(text)
        py_prompt = enhancer.enhance(text, py_intent)
        py_frame = _norm({
            "intent": py_intent,
            "enhanced": py_prompt["enhanced"],
            "systemHints": py_prompt.get("systemHints"),
            "directives": py_prompt.get("directives"),
        })
        ts_norm = _norm(ts_frame)
        if py_frame != ts_norm:
            problems.append(f"{text!r}:\n  TS={ts_norm}\n  PY={py_frame}")
    assert not problems, "\n".join(problems)
