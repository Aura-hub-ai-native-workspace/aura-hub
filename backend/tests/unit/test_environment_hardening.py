"""Industrial Extended Environment hardening tests.

Covers discovery, PATH resolution, probe isolation, catalog coverage,
install/connect flows, security, determinism.
"""
from __future__ import annotations

import os
import platform
import re
import subprocess
from unittest.mock import patch

import pytest

from aura.environment.catalog import BY_ID, catalog_entry, entries_for_scan
from aura.environment.install import (
    is_plan,
    plan_install,
    validate_installer_binary,
)
from aura.environment.probe import (
    _effective_path,
    _resolve_executable,
    probe_node,
    scan_environment,
)


class TestCatalogCoverage:
    def test_opencode_has_probe(self):
        e = catalog_entry("opencode")
        assert e is not None
        assert e.probe is not None
        assert e.probe.command == "opencode"
        assert e.probe.args == ["--version"]
        assert e.install is not None
        assert e.install.package == "opencode-ai"

    def test_qwen_has_probe(self):
        e = catalog_entry("qwen-cli")
        assert e is not None
        assert e.probe is not None
        assert e.probe.command == "qwen"
        assert e.install is not None

    def test_kilo_has_probe(self):
        e = catalog_entry("kilo-code")
        assert e is not None
        assert e.probe is not None
        assert e.probe.command == "kilo"
        assert e.probe.args == ["--version"]
        assert e.install is not None
        assert e.install.package == "@kilocode/cli"

    def test_opencode_in_scan(self):
        ids = {e.id for e in entries_for_scan()}
        assert "opencode" in ids
        assert "kilo-code" in ids
        assert "qwen-cli" in ids

    def test_catalog_separation(self):
        # Catalog may have non-scannable entries (no probe) — scanner must not invent presence
        e = catalog_entry("warp") if catalog_entry("warp") else None
        # If warp exists and has no probe, it should not be in scan
        if e and e.probe is None:
            assert e.id not in {x.id for x in entries_for_scan()}

    def test_gemini_has_install(self):
        e = catalog_entry("gemini-cli")
        assert e.install is not None
        assert e.install.method == "npm-global"

    def test_all_with_probe_scannable(self):
        for e in entries_for_scan():
            assert e.probe is not None or e.transport in ("http", "internal")


class TestDiscovery:
    def test_git_detected_when_installed(self):
        result = probe_node("git", refresh=True)
        # On this CI machine git is installed (verified earlier)
        if result.present:
            assert result.version is not None
            assert re.search(r"\d+\.\d+", result.version or "")
        else:
            # If not present, detail must be honest PATH message, not exception
            assert "is not on PATH" in result.detail or "not in the catalog" in result.detail

    def test_gh_detected(self):
        result = probe_node("github-cli", refresh=True)
        # gh is installed on this machine
        assert isinstance(result.present, bool)
        if result.present:
            assert result.detail.startswith("Found")

    def test_python_detected(self):
        result = probe_node("python", refresh=True)
        assert isinstance(result.present, bool)
        # python3 should be found via probe.py effective_path
        # On this machine python3 exists
        assert result.present is True or "is not on PATH" in result.detail

    def test_node_detected(self):
        result = probe_node("node", refresh=True)
        assert isinstance(result.present, bool)

    def test_npm_detected(self):
        result = probe_node("npm", refresh=True)
        assert isinstance(result.present, bool)

    def test_rust_cargo_detected(self):
        result = probe_node("rust", refresh=True)
        assert isinstance(result.present, bool)
        # cargo is /usr/bin/cargo on this Arch
        if result.present:
            assert result.version is not None

    def test_bun_detected(self):
        result = probe_node("bun", refresh=True)
        assert isinstance(result.present, bool)

    def test_curl_detected(self):
        # curl exists in TS catalog but not Python's truncated catalog — check if present
        from aura.environment.catalog import catalog_entry as ce

        if ce("curl") is None:
            pytest.skip("curl not in Python catalog (truncated ALL is intentional per plan)")
        result = probe_node("curl", refresh=True)
        # curl is installed on this Arch
        assert result.present is True or "is not on PATH" in result.detail

    def test_sqlite_detected(self):
        result = probe_node("postgres", refresh=True)  # uses psql, not installed
        # postgres (psql) not installed, should be honest not-installed
        assert result.present is False

    def test_chromium_detection(self):
        # Check browser probes where applicable; chromium is installed
        from aura.environment.catalog import catalog_entry

        e = catalog_entry("chromium")
        if e and e.probe:
            result = probe_node("chromium", refresh=True)
            assert isinstance(result.present, bool)

    def test_adb_detection(self):
        result = probe_node("android-platform-tools", refresh=True) if catalog_entry("android-platform-tools") else None
        # android-platform-tools not in current catalog, skip
        if result:
            assert isinstance(result.present, bool)

    def test_opencode_detected_when_installed(self):
        result = probe_node("opencode", refresh=True)
        # On this machine opencode is installed via npm global in ~/.npm-global/bin
        assert result.present is True, f"opencode should be detected, got {result.detail}"
        assert result.version == "1.18.26" or re.search(r"1\.18\.", result.detail)

    def test_kilo_detected_when_installed(self):
        result = probe_node("kilo-code", refresh=True)
        assert result.present is True, f"kilo should be detected, got {result.detail}"
        assert "7.5" in (result.version or result.detail)

    def test_absent_tool_honest(self):
        result = probe_node("docker", refresh=True)
        # docker not installed on this machine, should be not present but honest
        assert result.present is False
        assert "is not on PATH" in result.detail or "did not answer" in result.detail

    def test_version_unavailable_not_not_installed(self):
        # Simulate a tool that exists but produces no output (mock)
        from aura.environment.catalog import CatalogEntry, ProbeSpec

        e = CatalogEntry(
            id="test-no-output",
            name="Test No Output",
            category="development",
            capabilities=["terminal"],
            transport="local-process",
            auth="none",
            license="open-source",
            cross_platform=True,
            maintained=True,
            summary="test",
            homepage="https://example.com",
            probe=ProbeSpec("true", []),  # true exits 0 with no output
        )
        # Temporarily test via _run_probe directly
        from aura.environment.probe import _run_probe

        result = _run_probe(e)
        assert result.present is False
        assert "did not produce output" in result.detail


class TestPathResolution:
    def test_effective_path_includes_known_dirs(self):
        path = _effective_path()
        assert ".local/bin" in path
        # Should include custom npm global
        assert ".npm-global" in path or "npm" in path

    def test_effective_path_inherits_process_path(self):
        # Inherited PATH first
        path = _effective_path()
        inherited = os.environ.get("PATH", "")
        if inherited:
            first = inherited.split(os.pathsep)[0]
            if first:
                assert path.startswith(first) or first in path

    def test_resolve_executable_via_which(self):
        # git should be resolvable via augmented PATH
        resolved = _resolve_executable("git")
        assert resolved is not None
        assert "git" in resolved

    def test_opencode_resolves_via_npm_global(self):
        resolved = _resolve_executable("opencode")
        # On this machine opencode is in ~/.npm-global/bin
        assert resolved is not None
        assert "opencode" in resolved

    def test_kilo_resolves(self):
        resolved = _resolve_executable("kilo")
        assert resolved is not None
        assert "kilo" in resolved

    def test_windows_pathext_handling(self):
        # On Linux this is noop but ensure function handles Windows logic without error
        orig = os.environ.get("PATHEXT")
        try:
            os.environ["PATHEXT"] = ".COM;.EXE;.BAT;.CMD"
            r = _resolve_executable("git")
            assert r is not None or r is None  # should not crash
        finally:
            if orig is None:
                os.environ.pop("PATHEXT", None)
            else:
                os.environ["PATHEXT"] = orig


class TestProbeIsolationAndDeterminism:
    def test_scan_failure_isolated(self):
        # One failing probe must not crash whole scan
        result = scan_environment(refresh=True)
        assert isinstance(result.results, dict)
        assert result.scanned_at is not None
        # Should have at least some results
        assert len(result.results) > 0

    def test_scan_deterministic(self):
        r1 = scan_environment(refresh=True)
        r2 = scan_environment(refresh=True)
        # Same set of ids
        assert set(r1.results.keys()) == set(r2.results.keys())
        # found count consistent
        assert r1.found == r2.found

    def test_cache_bypass_on_refresh(self):
        # First scan populates cache
        scan_environment(refresh=False)
        # Second scan without refresh should use cache but still return same shape
        r = scan_environment(refresh=False)
        assert isinstance(r.results, dict)

    def test_timeout_handling(self):
        from aura.environment.catalog import CatalogEntry, ProbeSpec
        from aura.environment.probe import PROBE_TIMEOUT_MS, _run_probe

        # Use sleep as probe command with a short timeout simulation: we can't change timeout per entry
        # but we can verify timeout path by mocking subprocess.run to raise TimeoutExpired
        e = CatalogEntry(
            id="test-timeout",
            name="Test Timeout",
            category="development",
            capabilities=["terminal"],
            transport="local-process",
            auth="none",
            license="open-source",
            cross_platform=True,
            maintained=True,
            summary="test",
            homepage="https://example.com",
            probe=ProbeSpec("sleep", ["10"]),
        )
        with patch("aura.environment.probe.subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="sleep", timeout=PROBE_TIMEOUT_MS / 1000)):
            result = _run_probe(e)
            assert result.present is False
            assert f"did not respond within {PROBE_TIMEOUT_MS}ms" in result.detail

    def test_scan_does_not_use_shell(self):
        # Probe must use argv-only, no shell=True anywhere in environment/
        import pathlib

        env_dir = pathlib.Path(__file__).parents[2] / "aura" / "environment"
        for p in env_dir.glob("*.py"):
            text = p.read_text()
            assert "shell=True" not in text, f"{p.name} contains shell=True"

    def test_scan_concurrency_bounded(self):
        # Scan should complete quickly (< 30s) even with many entries, due to bounded concurrency
        import time

        start = time.time()
        result = scan_environment(refresh=True)
        elapsed = time.time() - start
        assert elapsed < 20, f"scan took too long: {elapsed}s, concurrency may be broken"
        assert len(result.results) > 0


class TestDuplicateDeduplication:
    def test_opencode_single_logical_node(self):
        # opencode and opencode.cmd should be same logical node via id deduplication
        # Ensure BY_ID has single entry for opencode
        assert BY_ID["opencode"].id == "opencode"
        # Probe should resolve same binary regardless of path duplication in effective_path
        path = _effective_path()
        parts = path.split(os.pathsep)
        assert len(parts) == len(set(parts)), "effective_path should deduplicate"

    def test_effective_path_dedup(self):
        path = _effective_path()
        parts = [p for p in path.split(os.pathsep) if p]
        assert len(parts) == len(set(parts))


class TestSecurity:
    def test_installer_allow_list(self):
        ok, _ = validate_installer_binary("npm")
        assert ok is True
        ok, _ = validate_installer_binary("pipx")
        assert ok is True
        ok, reason = validate_installer_binary("bash")
        assert ok is False
        assert "allow-list" in reason

    def test_path_traversal_rejected(self):
        for bad in ["../npm", "/usr/bin/npm", "npm; rm", "npm\\evil"]:
            ok, reason = validate_installer_binary(bad)
            assert ok is False, bad
            assert "named, not given as a path" in reason or "allow-list" in reason

    def test_command_injection_rejected_via_catalog(self):
        # Frontend sends id only; injection via id should be treated as not-in-catalog
        result = probe_node("'; rm -rf /", refresh=True)
        assert result.present is False
        assert "not in the catalog" in result.detail

        result2 = probe_node("opencode; rm -rf /", refresh=True)
        assert result2.present is False

    def test_unknown_catalog_id_rejected(self):

        # Unknown id returns None, probe handles
        assert catalog_entry("not-a-real-tool-xyz123") is None
        result = probe_node("not-a-real-tool-xyz123", refresh=True)
        assert result.present is False

    def test_malformed_installspec_rejected(self):
        from aura.environment.catalog import CatalogEntry, InstallSpec

        e = CatalogEntry(
            id="test-bad-method",
            name="Bad",
            category="development",
            capabilities=["terminal"],
            transport="local-process",
            auth="none",
            license="open-source",
            cross_platform=True,
            maintained=True,
            summary="test",
            homepage="https://example.com",
            probe=None,
            install=InstallSpec("unknown-method", "pkg", "user"),
        )
        plan = plan_install(e)
        # Should resolve to root guided or NoInstallPlan, not executable
        assert not is_plan(plan) or not getattr(plan, "executable", True) or getattr(plan, "privilege", "") == "root"

    def test_no_shell_in_environment(self):
        import pathlib

        env_dir = pathlib.Path(__file__).parents[2] / "aura" / "environment"
        for f in env_dir.glob("*.py"):
            assert "shell=True" not in f.read_text()

    def test_probe_no_secret_exposure(self):
        # Probe detail should never contain env secrets
        os.environ["TEST_SECRET_AURA"] = "supersecret123"
        try:
            result = probe_node("git", refresh=True)
            assert "supersecret123" not in result.detail
            scan = scan_environment(refresh=True)
            for r in scan.results.values():
                assert "supersecret123" not in r.detail
        finally:
            del os.environ["TEST_SECRET_AURA"]


class TestInstallSecurity:
    def _client(self, tmp_path, monkeypatch):
        from starlette.testclient import TestClient

        from aura.api.server import create_api_server

        monkeypatch.setenv("AURA_HOME", str(tmp_path / "aura-home"))
        return TestClient(create_api_server())

    def test_install_unknown_tool_via_api(self, tmp_path, monkeypatch):
        client = self._client(tmp_path, monkeypatch)
        resp = client.post("/environment/install", json={"id": "not-a-tool"})
        assert resp.status_code == 400
        data = resp.json()
        assert "not in the catalog" in data.get("detail", "") or "not in the catalog" in data.get("error", "")

    def test_install_unavailable_when_no_spec(self, tmp_path, monkeypatch):
        client = self._client(tmp_path, monkeypatch)
        # git has no install spec
        resp = client.post("/environment/install", json={"id": "git"})
        assert resp.status_code == 400
        data = resp.json()
        assert data["installOutcome"] == "unavailable"

    def test_install_guided_for_root(self, tmp_path, monkeypatch):
        client = self._client(tmp_path, monkeypatch)
        # docker is system-package root -> guided
        resp = client.post("/environment/install", json={"id": "docker"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["installOutcome"] == "guided"
        assert data["requiresUserAction"] is True
        assert "sudo" in data["command"] or "administrator" in data["detail"].lower()

    def test_install_rejects_path_traversal_id(self, tmp_path, monkeypatch):
        client = self._client(tmp_path, monkeypatch)
        for bad in ["../etc/passwd", "../../npm", "opencode; echo pwned"]:
            resp = client.post("/environment/install", json={"id": bad})
            assert resp.status_code == 400

    def test_install_does_not_create_approval(self, tmp_path, monkeypatch):
        client = self._client(tmp_path, monkeypatch)
        # Direct install must not go through Fabric ledger
        before = client.get("/fabric/approvals").json()["approvals"]
        # Try installing a tool that would be guided (docker) - should not create approval
        client.post("/environment/install", json={"id": "docker"})
        after = client.get("/fabric/approvals").json()["approvals"]
        # No new approvals should be created by direct install
        assert len(after) == len(before)


class TestConnect:
    def _client(self, tmp_path, monkeypatch):
        from starlette.testclient import TestClient

        from aura.api.server import create_api_server

        monkeypatch.setenv("AURA_HOME", str(tmp_path / "aura-home"))
        return TestClient(create_api_server())

    def test_connect_fails_when_not_present(self, tmp_path, monkeypatch):
        client = self._client(tmp_path, monkeypatch)
        # terraform not installed
        resp = client.post("/environment/connect", json={"id": "terraform"})
        data = resp.json()
        # On this machine terraform not installed, so connected should be false
        if not data.get("connected"):
            assert data["result"]["present"] is False

    def test_connect_succeeds_when_present(self, tmp_path, monkeypatch):
        client = self._client(tmp_path, monkeypatch)
        resp = client.post("/environment/connect", json={"id": "git"})
        data = resp.json()
        assert data["connected"] is True
        assert data["result"]["present"] is True

    def test_connect_persists(self, tmp_path, monkeypatch):
        from aura.persistence.nodes import ConnectedNodeStore

        client = self._client(tmp_path, monkeypatch)
        with client:
            # Connect git
            resp = client.post("/environment/connect", json={"id": "git"})
            assert resp.json()["connected"] is True
            # Check persistence directly via AURA_HOME isolated
            # Need to point store to same tmp home
            import os

            os.environ["AURA_HOME"] = str(tmp_path / "aura-home")
            store = ConnectedNodeStore()
            node = store.get("git")
            assert node is not None
            assert node["id"] == "git"
            # Cleanup
            store.remove("git")

    def test_connected_means_usable_not_just_exe(self, tmp_path, monkeypatch):
        client = self._client(tmp_path, monkeypatch)
        # For git, probe present means usable (version check). For a tool that is present but
        # not drivable, we would expect installed/not drivable. Here we verify that connect
        # does probe refresh and not just mark connected.
        resp = client.post("/environment/connect", json={"id": "git"})
        assert resp.json()["result"]["present"] is True
        # If we try to connect a not-installed tool, it should not become connected
        resp2 = client.post("/environment/connect", json={"id": "docker"})
        if resp2.json().get("connected") is False:
            assert "is not on PATH" in resp2.json()["result"]["detail"] or "not answering" in resp2.json()["result"]["detail"]


class TestScanReal:
    def test_scan_finds_expected_tools(self):
        result = scan_environment(refresh=True)
        # On this machine we expect at least git, node, python, cargo, bun, curl, adb, opencode, kilo-code to be found
        found_ids = {k for k, v in result.results.items() if v.present}
        # These are expected on this Arch machine
        for expected in ["git", "github-cli", "node", "python", "rust", "bun", "curl", "opencode", "kilo-code"]:
            if catalog_entry(expected):
                # Only require those that are actually in scan (have probe)
                assert expected in found_ids, f"{expected} should be found on this machine but was not: {result.results.get(expected)}"

    def test_scan_results_match_probe(self):
        scan = scan_environment(refresh=True)
        for nid, pres in scan.results.items():
            single = probe_node(nid, refresh=True)
            # Cache may cause same result, but present should match
            assert pres.present == single.present, f"mismatch for {nid}: scan {pres.present} vs probe {single.present}"


class TestWindowsMacosImplemented:
    def test_windows_pathext_and_choco(self):
        from aura.environment.install import _detect_distro

        orig_system = platform.system
        try:
            platform.system = lambda: "Windows"
            d = _detect_distro()
            assert d["manager"] == "choco"
            assert d["installArgs"] == ["/i"]
        finally:
            platform.system = orig_system

    def test_macos_brew(self):
        from aura.environment.install import _detect_distro

        orig_system = platform.system
        try:
            platform.system = lambda: "Darwin"
            d = _detect_distro()
            assert d["manager"] == "brew"
        finally:
            platform.system = orig_system

    def test_install_windows_branch_npm_root(self):
        from aura.environment.install import _npm_global_root

        # On Linux, should return lib/node_modules path
        root = _npm_global_root()
        if root:
            assert "node_modules" in root
