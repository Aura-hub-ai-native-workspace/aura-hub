"""Settings that let the backend run inside a container (docs/DOCKER.md)."""

from __future__ import annotations

import pytest

from aura.central_agent import model_status
from aura.config import DEFAULT_OLLAMA_URL, bind_host, ollama_base_url


@pytest.mark.parametrize("raw, expected", [
    ("", DEFAULT_OLLAMA_URL),
    ("   ", DEFAULT_OLLAMA_URL),
    ("http://ollama:11434", "http://ollama:11434"),
    ("ollama:11434", "http://ollama:11434"),
    ("http://host.docker.internal:11434/", "http://host.docker.internal:11434"),
    ("https://gpu.college.edu:11434/v1", "https://gpu.college.edu:11434"),
    ("https://ai.college.edu/ollama/v1/", "https://ai.college.edu/ollama"),
])
def test_ollama_base_url(monkeypatch, raw, expected):
    monkeypatch.setenv("AURA_OLLAMA_BASE_URL", raw)
    assert ollama_base_url() == expected


def test_ollama_base_url_unset(monkeypatch):
    monkeypatch.delenv("AURA_OLLAMA_BASE_URL", raising=False)
    assert ollama_base_url() == "http://127.0.0.1:11434"


def test_detect_local_runtime_probes_configured_url(monkeypatch):
    monkeypatch.setenv("AURA_OLLAMA_BASE_URL", "http://ollama:11434")
    seen = []
    model_status.detect_local_runtime(
        probe=lambda url, timeout: seen.append(url) or None,
        which=lambda name: None)
    assert seen == ["http://ollama:11434/api/tags"]


def test_bind_host_defaults_to_loopback(monkeypatch):
    monkeypatch.delenv("AURA_BIND_HOST", raising=False)
    assert bind_host() == "127.0.0.1"
    monkeypatch.setenv("AURA_BIND_HOST", "0.0.0.0")
    assert bind_host() == "0.0.0.0"
