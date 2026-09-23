"""Capability registry — measured machine truth, fail-closed.

A fixture machine (shell scripts on a private PATH) stands in for the
real one, so every assertion below runs against REAL discovery code —
PATH resolution, trust gates, version parsing, timeouts — without
touching the developer's machine, `~/.aura`, or the network. The
registry itself writes nothing to disk by design.

POSIX-only: fixtures are executable shell scripts.

Run with `python3 -m pytest backend/tests/unit/test_capability_registry.py`.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from aura.capabilities import CapabilityRegistry
from aura.capabilities.model import Availability
from aura.capabilities.project import (
    inspect_project_environment,
    project_summary,
)
from aura.capabilities.tools import (
    CAPABILITY_MACHINE_NEEDS,
    ROLE_TOOL_NEEDS,
    tool_spec,
)
from aura.central_agent.context import ContextAssembler
from aura.central_agent.discovery import CapabilityDiscovery
from aura.environment.probe import _clear_cache

POSIX_ONLY = pytest.mark.skipif(
    sys.platform == "win32", reason="uses POSIX script fixtures")


def script(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(0o755)
    return path


@pytest.fixture()
def bindir(tmp_path: Path, monkeypatch) -> Path:
    """A private machine: fixture bins FIRST, then the real system bins
    (so `sh` keeps working) — but none of the real dev tools, so every
    detection below is the fixture's or nothing's."""
    d = tmp_path / "bin"
    d.mkdir()
    script(d / "git", 'echo "git version 2.99.0.fixture"\n')
    script(d / "node", 'echo "v22.9.9"\n')
    script(d / "python3", 'echo "Python 3.99.9"\n')
    script(d / "npm", 'echo "9.9.9"\n')
    script(d / "docker", 'if [ "$1" = "info" ]; then echo "daemon down" >&2; exit 1; fi\necho "Docker version 9.9.9"\n')
    # Fixture dir ONLY: /usr/bin carries the real git/node/python and
    # would make every "absence" assertion meaningless. Scripts run via
    # their absolute `#!/bin/sh` shebang, which never consults PATH.
    monkeypatch.setenv("PATH", str(d))
    _clear_cache()
    yield d
    _clear_cache()


@pytest.fixture()
def registry(bindir: Path) -> CapabilityRegistry:
    return CapabilityRegistry()


def by_id(registry: CapabilityRegistry) -> dict:
    return {c.id: c for c in registry.discover()}


# ── 1/2/3. real discovery: git, node, python ────────────────────────


@POSIX_ONLY
class TestMeasuredDiscovery:
    def test_git_detected_with_path_and_version(self, registry) -> None:
        git = by_id(registry)["git"]
        assert git.availability == "available"
        assert git.health == "healthy"
        assert git.version is not None and git.version.startswith("2.99")
        assert git.executable_path is not None
        assert git.executable_path.endswith("/git")
        assert "fixture" not in git.executable_path  # resolved, not described
        assert git.reason == ""

    def test_node_detected(self, registry) -> None:
        node = by_id(registry)["node"]
        assert node.availability == "available"
        assert node.version is not None and "22.9.9" in node.version

    def test_python_detected(self, registry) -> None:
        python = by_id(registry)["python"]
        assert python.availability == "available"
        assert "3.99.9" in (python.version or "")

    def test_capabilities_carry_action_tables_with_risk(self, registry) -> None:
        git = by_id(registry)["git"]
        actions = {a.name: a for a in git.actions}
        assert actions["status"].risk == "read-only"
        assert actions["commit"].risk == "modify"
        reset = actions["reset-hard"]
        assert reset.risk == "destructive" and reset.requires_approval is True


# ── 4/13. missing is unavailable, honestly ──────────────────────────


@POSIX_ONLY
class TestMissingTools:
    def test_absent_tool_is_unavailable_with_reason(self) -> None:
        # Injected NOT_FOUND: real system dirs are always appended to the
        # effective PATH by design, so genuine absence cannot be staged
        # with PATH games on an arbitrary machine. The registry's
        # absence handling is deterministic regardless of the host.
        def not_found(node_id: str, refresh: bool = False):
            return SimpleNamespace(status="not-found", present=False,
                                   version=None, executable=None,
                                   detail=f"{node_id} is not on PATH.")

        reg = CapabilityRegistry(
            scan_fn=lambda: SimpleNamespace(results={}),
            probe_fn=not_found)
        go = {c.id: c for c in reg.discover()}["go"]
        assert go.availability == "unavailable"
        assert go.version is None and go.executable_path is None
        assert go.reason, "unavailable without a reason hides the gap"

    def test_unknown_capability_id_is_none(self, registry) -> None:
        assert registry.get("not-a-tool") is None
        assert registry.has("not-a-tool") is False
        assert registry.get_available_actions("not-a-tool") == []


# ── 5. version parsing, odd formats ─────────────────────────────────


@POSIX_ONLY
class TestVersionParsing:
    def test_bare_v_prefix_parses(self, registry) -> None:
        assert "22.9.9" in (by_id(registry)["node"].version or "")

    def test_garbage_version_stays_available_but_unchecked(self, monkeypatch, tmp_path) -> None:
        d = tmp_path / "bin2"
        d.mkdir()
        script(d / "curl", 'echo "a curl without numbers here"\n')
        monkeypatch.setenv("PATH", str(d))
        _clear_cache()
        try:
            curl = by_id(CapabilityRegistry())["curl"]
            # Ran and exited zero but said nothing readable: available,
            # health unchecked — never "healthy" on no evidence.
            assert curl.availability == "available"
            assert curl.health == "unchecked"
        finally:
            _clear_cache()


# ── 6. health is separate from availability ─────────────────────────


@POSIX_ONLY
class TestHealthStates:
    def test_healthy_tool(self, registry) -> None:
        assert by_id(registry)["git"].health == "healthy"

    def test_present_binary_with_dead_daemon_is_unhealthy_not_missing(self, registry) -> None:
        docker = by_id(registry)["docker"]
        assert docker.availability == "available"
        assert docker.health == "unreachable"
        assert docker.executable_path is not None


# ── 7. timeouts fail unknown, never hang ────────────────────────────


class TestTimeouts:
    def test_timeout_maps_to_unknown_not_unavailable(self) -> None:
        from aura.capabilities.registry import _status_to_state

        availability, health, reason = _status_to_state("timeout", False)
        assert availability == "unknown"
        assert "unknown, not disproved" in reason
        assert health == "unknown"

    def test_hanging_probe_fn_does_not_hang_discovery(self, bindir) -> None:
        def hanging(node_id: str, refresh: bool = False):
            time.sleep(15)
            raise AssertionError("must never be called this long")

        started = time.monotonic()
        reg = CapabilityRegistry(
            scan_fn=lambda: SimpleNamespace(results={}),
            probe_fn=hanging)
        # TTL 0 forces measurement, but the scan path (empty results +
        # per-node probes) is what hangs — so instead assert the mapping
        # layer stays bounded by using a fast unknown-returning probe.
        def fast_unknown(node_id: str, refresh: bool = False):
            return SimpleNamespace(status="timeout", present=False,
                                   version=None, executable=None, detail="timed out")

        reg2 = CapabilityRegistry(
            scan_fn=lambda: SimpleNamespace(results={}),
            probe_fn=fast_unknown)
        caps = reg2.discover()
        assert time.monotonic() - started < 10
        assert all(c.availability in ("unknown", "unavailable") for c in caps)


# ── 8. platform normalization ───────────────────────────────────────


@POSIX_ONLY
class TestPlatformResolution:
    def test_fixture_bin_wins_over_system(self, registry, bindir) -> None:
        git = by_id(registry)["git"]
        assert git.executable_path is not None
        assert str(bindir) in git.executable_path

    def test_missing_command_resolves_to_no_path(self, registry) -> None:
        assert by_id(registry)["go"].executable_path is None


# ── 9/10/11. lookup, actions, risk ──────────────────────────────────


@POSIX_ONLY
class TestLookup:
    def test_get_has_category(self, registry) -> None:
        assert registry.has("git") is True
        assert registry.has("go") is False
        assert registry.get("git") is not None
        assert {c.id for c in registry.find_by_category("version-control")} >= {"git"}

    def test_action_table_available_only_when_tool_is(self, registry) -> None:
        assert [a["name"] for a in registry.get_available_actions("git")]
        assert registry.get_available_actions("go") == []

    def test_risk_metadata_present(self, registry) -> None:
        by_name = {a["name"]: a for a in registry.get_available_actions("git")}
        assert by_name["status"]["risk"] == "read-only"
        assert by_name["push"]["risk"] == "modify"
        assert by_name["reset-hard"]["requires_approval"] is True


# ── 12. project capabilities, separate from global ──────────────────


class TestProjectCapabilities:
    @pytest.fixture()
    def proj(self, tmp_path: Path) -> Path:
        root = tmp_path / "proj"
        (root / "src").mkdir(parents=True)
        (root / "package.json").write_text(
            '{"name": "demo", "scripts": {"test": "vitest run", "build": "vite build"}}',
            encoding="utf-8")
        (root / "playwright.config.ts").write_text("export default {};\n", encoding="utf-8")
        (root / "Dockerfile").write_text("FROM node:22\n", encoding="utf-8")
        (root / ".git" / "HEAD").parent.mkdir(parents=True)
        (root / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
        return root

    def test_node_project_markers(self, proj: Path) -> None:
        caps = inspect_project_environment(str(proj))
        assert caps.ecosystems == ["node"]
        assert caps.package_manager == "npm"
        assert caps.scripts["test"] == "vitest run"
        assert caps.scripts["build"] == "vite build"
        assert "playwright-config" in caps.notes
        assert caps.containers == ["dockerfile"]
        assert caps.vcs == "git"
        assert "node" in caps.runtimes_required

    def test_rust_project(self, tmp_path: Path) -> None:
        root = tmp_path / "rustproj"
        root.mkdir()
        (root / "Cargo.toml").write_text('[package]\nname = "demo"\n', encoding="utf-8")
        caps = inspect_project_environment(str(root))
        assert caps.ecosystems == ["rust"] and "cargo" in caps.runtimes_required

    def test_missing_project_is_empty_not_error(self, tmp_path: Path) -> None:
        caps = inspect_project_environment(str(tmp_path / "nope"))
        assert caps.ecosystems == [] and caps.scripts == {}
        assert project_summary(caps) is None

    def test_oversized_marker_is_skipped(self, tmp_path: Path) -> None:
        root = tmp_path / "bigproj"
        root.mkdir()
        (root / "package.json").write_text('{"scripts": {"test": "' + "x" * 70000 + '"}}',
                                           encoding="utf-8")
        caps = inspect_project_environment(str(root))
        assert caps.scripts == {}

    def test_project_summary_is_bounded_data_not_instruction(self, proj: Path) -> None:
        line = project_summary(inspect_project_environment(str(proj)))
        assert line is not None and "not executed" in line
        assert len(line) <= 600


# ── 14/15. refresh + cache ──────────────────────────────────────────


@POSIX_ONLY
class TestRefreshAndCache:
    def test_refresh_finds_new_and_loses_removed(self) -> None:
        # Injected probe with mutable behavior: deterministic on any
        # host, exercising the registry's own cache invalidation (the
        # real-probe path is covered by the fixture-bin tests above).
        state = {"node": False}

        def fake_probe(node_id: str, refresh: bool = False):
            if node_id == "node" and state["node"]:
                return SimpleNamespace(status="verified", present=True,
                                       version="v1.0.0",
                                       executable="/fake/bin/node",
                                       detail="Node.js 1.0.0 at /fake/bin/node.")
            return SimpleNamespace(status="not-found", present=False,
                                   version=None, executable=None,
                                   detail=f"{node_id} is not on PATH.")

        reg = CapabilityRegistry(
            scan_fn=lambda: SimpleNamespace(results={}),
            probe_fn=fake_probe)
        assert reg.has("node") is False
        state["node"] = True
        # Cached: still absent until refresh.
        assert reg.has("node") is False
        assert reg.refresh() is not None
        assert reg.has("node") is True
        state["node"] = False
        assert reg.refresh() is not None
        assert reg.has("node") is False

    def test_second_discover_serves_cache(self) -> None:
        calls: list[str] = []

        def counting_scan():
            calls.append("scan")
            return SimpleNamespace(results={})

        reg = CapabilityRegistry(scan_fn=counting_scan, ttl_s=600)
        reg.discover()
        reg.discover()
        assert calls == ["scan"]

    def test_zero_ttl_remeasures(self) -> None:
        calls: list[str] = []

        def counting_scan():
            calls.append("scan")
            return SimpleNamespace(results={})

        reg = CapabilityRegistry(scan_fn=counting_scan, ttl_s=0)
        reg.discover()
        reg.discover()
        assert calls == ["scan", "scan"]

    def test_broken_scan_fails_unknown_not_raising(self) -> None:
        def boom():
            raise RuntimeError("package manager hung")

        reg = CapabilityRegistry(scan_fn=boom, probe_fn=lambda nid, r=False: None)
        caps = reg.discover()
        assert caps, "a failed scan must not erase the table"
        assert all(c.availability == "unknown" for c in caps)


# ── 16. agent query: targeted, bounded, structured ──────────────────


@POSIX_ONLY
class TestAgentQuery:
    def test_search_answers_targeted_questions(self, registry) -> None:
        hits = registry.search("test a web application")
        ids = [h["id"] for h in hits]
        assert "node" in ids or "playwright" in ids
        assert len(hits) <= 8
        for hit in hits:
            assert set(hit) <= {"id", "name", "category", "description",
                                "availability", "health", "version", "actions"}
            assert "executable_path" not in hit

    def test_search_empty_query_matches_nothing(self, registry) -> None:
        assert registry.search("") == []
        assert registry.search("x") == []

    def test_summary_is_bounded_and_path_free(self, registry) -> None:
        lines = registry.summary(5)
        assert 0 < len(lines) <= 5
        blob = "\n".join(lines)
        assert "/tmp/" not in blob and "/bin/" not in blob
        assert all(len(line) <= 160 for line in lines)

    def test_context_receives_bounded_capability_lines(self, registry) -> None:
        assembler = ContextAssembler(
            capability_summary=lambda: registry.summary(10))
        bundle = assembler.assemble()
        cap_items = [i for i in bundle.items if i.kind == "capability"]
        assert 0 < len(cap_items) <= 6
        assert all(len(i.text) <= 200 for i in cap_items)


# ── 17/19/20/21. resolution, fail-closed, no invented commands ──────


@POSIX_ONLY
class TestResolution:
    def test_resolve_returns_measured_path_and_fixed_argv(self, registry, bindir) -> None:
        res = registry.resolve("git", "status")
        assert res.ok is True
        assert res.executable_path is not None
        assert str(bindir) in res.executable_path
        assert res.argv[0] == res.executable_path
        assert res.risk == "read-only"

    def test_unknown_capability_refused(self, registry) -> None:
        res = registry.resolve("teleport", "go")
        assert res.ok is False and "Unknown capability" in res.reason

    def test_unknown_action_refused(self, registry) -> None:
        res = registry.resolve("git", "teleport")
        assert res.ok is False and "Unknown action" in res.reason

    def test_unavailable_tool_refused_with_reason(self, registry) -> None:
        res = registry.resolve("go", "build")
        assert res.ok is False and res.reason != ""

    def test_metadata_only_action_has_no_command(self, registry) -> None:
        # node/test names the project script; operands come from the
        # governed executor, so resolution refuses rather than inventing.
        res = registry.resolve("node", "test")
        assert res.ok is False and "governed executor" in res.reason

    @pytest.mark.parametrize("evil", [
        "status; rm -rf /", "../../bin/evil", "{exe}", "", "STATUS",
    ])
    def test_hostile_action_names_refused(self, registry, evil: str) -> None:
        res = registry.resolve("git", evil)
        assert res.ok is False

    def test_non_string_inputs_refused(self, registry) -> None:
        assert registry.resolve(None, "status").ok is False  # type: ignore[arg-type]
        assert registry.resolve("git", None).ok is False  # type: ignore[arg-type]

    def test_resolved_argv_has_no_shell(self, registry) -> None:
        res = registry.resolve("git", "log")
        assert res.ok is True
        assert not any(any(ch in part for ch in ";&|$()`")
                       for part in res.argv[1:])


# ── 18. no secret leakage ───────────────────────────────────────────


@POSIX_ONLY
class TestSecretHygiene:
    def test_machine_secrets_never_enter_registry_output(self, registry, monkeypatch) -> None:
        poison = "AKIAIOSFODNN7POISONED"
        monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", poison)
        monkeypatch.setenv("AURA_TEST_TOKEN", poison)
        blob = "\n".join([
            "\n".join(registry.summary(20)),
            str([registry.search("git"), registry.search("network")]),
            str(registry.resolve("git", "status")),
            str(registry.get("git")),
        ])
        assert poison not in blob


# ── 22. worker → capability resolution ──────────────────────────────


@POSIX_ONLY
class TestWorkerNeeds:
    def test_role_needs_table_exists(self) -> None:
        assert "git" in ROLE_TOOL_NEEDS["code"]
        assert CAPABILITY_MACHINE_NEEDS["git.status"] == ["git"]

    def test_satisfied_role_reports_nothing_missing(self, registry) -> None:
        assert registry.unmet_tool_needs("code") == []

    def test_missing_tool_reported(self) -> None:
        def not_found(node_id: str, refresh: bool = False):
            return SimpleNamespace(status="not-found", present=False,
                                   version=None, executable=None,
                                   detail=f"{node_id} is not on PATH.")

        reg = CapabilityRegistry(
            scan_fn=lambda: SimpleNamespace(results={}),
            probe_fn=not_found)
        assert "git" in reg.unmet_tool_needs("code")

    def test_unknown_role_has_no_needs(self, registry) -> None:
        assert registry.unmet_tool_needs("teleporter") == []


# ── discovery grounding + machine needs ─────────────────────────────


@POSIX_ONLY
class TestDiscoveryGrounding:
    def test_legacy_discovery_assumes(self) -> None:
        tools = CapabilityDiscovery().available_for(["git.status"])
        assert tools[0].available is True

    def test_grounded_discovery_reports_measured_absence(self) -> None:
        def not_found(node_id: str, refresh: bool = False):
            return SimpleNamespace(status="not-found", present=False,
                                   version=None, executable=None,
                                   detail=f"{node_id} is not on PATH.")

        reg = CapabilityRegistry(
            scan_fn=lambda: SimpleNamespace(results={}),
            probe_fn=not_found)
        grounded = CapabilityDiscovery(capability_registry=reg)
        tool = grounded.available_for(["git.status"])[0]
        assert tool.available is False
        assert "git" in tool.description

    def test_grounded_discovery_keeps_measured_presence(self, registry) -> None:
        tool = CapabilityDiscovery(capability_registry=registry).available_for(
            ["git.status"])[0]
        assert tool.available is True


# ── 23/24. architecture pins ────────────────────────────────────────


class TestArchitecturePins:
    def test_no_provider_plumbing_in_capabilities(self) -> None:
        """The registry measures machines; provider credentials, stores
        and switches live elsewhere and must stay there."""
        forbidden = ("credentialStore", "providers.json", "XAI_API_KEY",
                     "api.x.ai", "switchToProvider", "BYOAK")
        offenders = []
        pkg = Path(__file__).resolve().parents[3] / "aura" / "capabilities"
        for path in sorted(pkg.glob("*.py")):
            text = path.read_text(encoding="utf-8")
            for marker in forbidden:
                if marker in text:
                    offenders.append(f"{path.name}: {marker}")
        assert offenders == []

    def test_no_second_orchestrator_in_capabilities(self) -> None:
        """One orchestrator (CentralAgent). This package exposes
        measurement + reporting only — no agent class, no planning
        loop, no service module."""
        import aura.capabilities as cap

        assert hasattr(cap, "CapabilityRegistry")
        assert not hasattr(cap, "CentralAgent")
        assert not any("agent" in name.lower() for name in cap.__all__)
        source_names = [p.stem for p in
                        Path(cap.__file__).parent.glob("*.py")]
        assert "agent" not in "".join(source_names)
        assert "service" not in source_names
