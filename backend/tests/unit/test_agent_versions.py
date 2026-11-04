"""Agent version checks: parse, compare, cache, and say nothing rather than guess."""
import json

from aura.workers import versions as v


def test_a_version_is_read_from_the_cli_banner():
    assert v.parse_version("opencode v2.2.2") == "2.2.2"
    assert v.parse_version("codex-cli 0.163.0") == "0.163.0"
    assert v.parse_version("7.5.14\n") == "7.5.14"
    assert v.parse_version("no number here") is None


def test_only_a_higher_release_is_an_update():
    assert v.is_newer("2.3.0", "2.2.9") is True
    assert v.is_newer("2.2.2", "2.2.2") is False
    assert v.is_newer("2.2.1", "2.2.2") is False
    assert v.is_newer("2.10.0", "2.9.0") is True          # numeric, not text, order
    assert v.is_newer(None, "1.0.0") is False and v.is_newer("1.0.0", None) is False


def test_the_report_lists_installed_agents_with_the_update_command(monkeypatch):
    monkeypatch.setattr(v, "_cache", {})
    fetch = lambda url: json.dumps({"version": "2.3.0"})            # noqa: E731
    probe = lambda binary: {"opencode": "2.2.2", "kilo": "7.5.14"}.get(binary)   # noqa: E731
    rows = {r["id"]: r for r in v.agent_versions(fetch=fetch, probe=probe)}
    assert set(rows) == {"opencode", "kilo-code"}                  # not-installed agents are left out
    assert rows["opencode"]["updateAvailable"] is True
    assert rows["opencode"]["updateCommand"] == "npm install -g opencode-ai@latest"
    assert rows["kilo-code"]["updateAvailable"] is False or rows["kilo-code"]["latest"] == "2.3.0"


def test_an_unreachable_registry_means_unknown_not_an_update(monkeypatch):
    monkeypatch.setattr(v, "_cache", {})

    def down(url):
        raise OSError("offline")

    rows = v.agent_versions(fetch=down, probe=lambda b: "1.0.0" if b == "opencode" else None)
    assert rows[0]["latest"] is None and rows[0]["updateAvailable"] is False


def test_the_latest_version_is_cached(monkeypatch):
    monkeypatch.setattr(v, "_cache", {})
    calls = []
    fetch = lambda url: (calls.append(url), json.dumps({"version": "9.9.9"}))[1]   # noqa: E731
    assert v.latest_version("opencode-ai", fetch) == "9.9.9"
    assert v.latest_version("opencode-ai", fetch) == "9.9.9"
    assert len(calls) == 1


def test_a_latest_older_than_the_install_is_unknown_not_up_to_date(monkeypatch):
    monkeypatch.setattr(v, "_cache", {})
    rows = v.agent_versions(fetch=lambda url: json.dumps({"version": "1.19.5"}),
                            probe=lambda b: "2.2.2" if b == "opencode" else None)
    assert rows[0]["installed"] == "2.2.2" and rows[0]["latest"] is None and rows[0]["updateAvailable"] is False
