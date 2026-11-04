"""Model detection and the optional small-model recommendation."""

from __future__ import annotations

from aura.central_agent.model_status import (
    RECOMMENDED_MODEL, detect_local_runtime, model_status, recommend_local_model,
)

TAGS = {"models": [
    {"name": "qwen2.5-coder:1.5b", "size": 986_000_000, "details": {"parameter_size": "1.5B"}},
    {"name": "nomic-embed-text:latest", "size": 274_000_000, "details": {}}]}


def local_with(models=None, running=True, installed=True):
    return {"runtime": "ollama", "installed": installed, "running": running,
            "models": models or [], "state": "ready" if models else "running-no-models"}


def test_a_running_runtime_reports_its_real_models():
    got = detect_local_runtime(probe=lambda url, t: TAGS, which=lambda n: "/usr/bin/ollama")
    assert got["state"] == "ready" and got["running"]
    assert [m["name"] for m in got["models"]] == ["qwen2.5-coder:1.5b", "nomic-embed-text:latest"]
    assert got["models"][1]["embeddingOnly"] is True and got["models"][0]["sizeMB"] > 900


def test_an_installed_but_stopped_runtime_is_not_called_running():
    got = detect_local_runtime(probe=lambda *_: None, which=lambda n: "/usr/bin/ollama")
    assert got["state"] == "installed-not-running" and got["running"] is False


def test_no_runtime_at_all():
    got = detect_local_runtime(probe=lambda *_: None, which=lambda n: None)
    assert got["state"] == "not-installed" and got["models"] == []


def test_recommendation_checks_hardware_and_only_then_offers_a_command():
    ok = recommend_local_model(local_with(), ram_gb=16, free_gb=50)
    assert ok["model"] == RECOMMENDED_MODEL and ok["compatible"] and ok["command"] == f"ollama pull {RECOMMENDED_MODEL}"
    assert ok["required"] is False and "optional" in ok["note"].lower()
    no_disk = recommend_local_model(local_with(), ram_gb=16, free_gb=1)
    assert not no_disk["compatible"] and "command" not in no_disk and "disk" in no_disk["problems"][0]
    no_ram = recommend_local_model(local_with(), ram_gb=2, free_gb=50)
    assert not no_ram["compatible"] and "RAM" in no_ram["problems"][0]
    no_runtime = recommend_local_model(local_with(installed=False, running=False), ram_gb=16, free_gb=50)
    assert not no_runtime["compatible"] and "command" not in no_runtime


def test_nothing_is_recommended_when_a_usable_local_model_exists():
    assert recommend_local_model(local_with([{"name": "qwen3:4b", "embeddingOnly": False}])) is None


def test_an_embedding_only_runtime_still_gets_the_recommendation():
    rec = recommend_local_model(local_with([{"name": "nomic-embed-text", "embeddingOnly": True}]),
                                ram_gb=16, free_gb=50)
    assert rec and rec["compatible"]


def test_status_without_any_provider_says_so_and_still_works():
    status = model_status([], local=local_with(running=False, installed=False),
                          recommendation=lambda l: {"model": RECOMMENDED_MODEL, "required": False})
    assert status["laya"]["configured"] is False and status["laya"]["usable"] is False
    assert "No reasoning model" in status["laya"]["note"]
    assert status["recommendation"]["required"] is False


def test_an_installed_local_model_that_is_not_configured_says_configure_not_install():
    status = model_status([], local=local_with([{"name": "qwen3:4b", "embeddingOnly": False}]))
    assert status["recommendation"]["needsConfiguration"] is True
    assert status["recommendation"]["model"] == "qwen3:4b"


def test_a_configured_local_provider_needs_no_recommendation():
    providers = [{"id": "ollama-local", "networkClass": "local", "enabled": True, "circuit": "closed"}]
    status = model_status(providers, local=local_with([{"name": "qwen3:4b", "embeddingOnly": False}]))
    assert status["recommendation"] is None and status["local"]["configured"] is True
    assert status["laya"]["usable"] is True


def test_an_open_circuit_means_not_usable():
    providers = [{"id": "p", "networkClass": "cloud", "enabled": True, "circuit": "open"}]
    assert model_status(providers, local=local_with())["laya"]["usable"] is False
