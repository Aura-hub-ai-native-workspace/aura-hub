"""Per-provider custom HTTP headers (e.g. ngrok tunnel bypass).

Headers ride the operator-written providers file beside baseUrl — never
hard-coded per host — and must survive parsing intact, including the
refusal of non-dict shapes.
"""
from __future__ import annotations

import json

from aura.central_agent.model_routing import load_providers


def _write(tmp_path, entries):
    p = tmp_path / "providers.json"
    p.write_text(json.dumps({"providers": entries}))
    return str(p)


def test_headers_parsed(tmp_path):
    specs = load_providers(_write(tmp_path, [{
        "id": "t", "baseUrl": "https://x/v1", "model": "m",
        "apiKeyEnv": "K",
        "headers": {"ngrok-skip-browser-warning": "true"},
    }]))
    assert len(specs) == 1
    assert dict(specs[0].headers) == {
        "ngrok-skip-browser-warning": "true"}


def test_missing_headers_defaults_empty(tmp_path):
    specs = load_providers(_write(tmp_path, [{
        "id": "t", "baseUrl": "https://x/v1", "model": "m",
        "apiKeyEnv": "K",
    }]))
    assert specs[0].headers == ()


def test_non_dict_headers_ignored(tmp_path):
    specs = load_providers(_write(tmp_path, [{
        "id": "t", "baseUrl": "https://x/v1", "model": "m",
        "apiKeyEnv": "K", "headers": ["oops"],
    }]))
    assert specs[0].headers == ()
