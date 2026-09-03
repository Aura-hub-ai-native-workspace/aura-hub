"""Opt-in checks against the machine this actually runs on.

These are deliberately separated from the unit suite. A test that asserts
"git is installed" tells a contributor whose machine differs that *they* are
broken, which is both wrong and useless in CI. Everything here is skipped
unless ``AURA_ENV_REAL_MACHINE=1`` is set.

What they check is the shape of the answer against the machine's own truth —
"whatever `command -v git` resolves to is what AURA reports" — never a
hard-coded list of tools.

Run with::

    AURA_ENV_REAL_MACHINE=1 uv run pytest tests/integration/test_environment_real_machine.py -v
"""

from __future__ import annotations

import os
import shutil
import sys
import time

import pytest

from aura.environment import (
    ALL,
    ProbeStatus,
    probe_node,
    scan_environment,
    scan_result_to_dict,
)
from aura.environment.discovery import ToolStatus
from aura.environment.pathsec import effective_path, real_target
from aura.environment.probe import _clear_cache

pytestmark = pytest.mark.skipif(
    os.environ.get("AURA_ENV_REAL_MACHINE") != "1",
    reason="set AURA_ENV_REAL_MACHINE=1 to measure the host machine",
)


@pytest.fixture(scope="module")
def scan():
    _clear_cache()
    return scan_environment(refresh=True)


class TestAgreesWithTheShell:
    def test_every_found_tool_resolves_where_the_shell_would_find_it(self, scan):
        """AURA's answer must be the file this machine would actually run.

        The oracle is `effective_path()` rather than the raw ``PATH``. The
        one deliberate difference between them is AURA's own interpreter
        directory: a backend started from its virtualenv has that first on
        PATH, and reporting AURA's own Python as the machine's Python would
        be measuring the scanner instead of the machine. That exclusion is
        asserted directly below.
        """
        search = effective_path()
        mismatches = []
        for node_id, result in scan.results.items():
            if result.status is not ProbeStatus.VERIFIED or not result.executable:
                continue
            entry = next(e for e in ALL if e.id == node_id)
            if entry.probe is None or entry.transport != "local-process":
                continue
            for candidate in entry.probe.candidates:
                if os.path.dirname(candidate):
                    continue
                found = shutil.which(candidate, path=search)
                if found is None:
                    continue
                if real_target(found) != real_target(result.executable):
                    mismatches.append((node_id, found, result.executable))
                break
        assert mismatches == [], f"AURA reported a different file than the shell: {mismatches}"

    def test_auras_own_runtime_is_not_reported_as_the_machines(self):
        """AURA measures the machine, not the interpreter it is running in."""
        own_bin = os.path.dirname(sys.executable)
        for entry in effective_path().split(os.pathsep):
            assert os.path.normpath(entry) != os.path.normpath(own_bin)

    def test_absent_commands_are_reported_absent(self, scan):
        wrong = []
        for node_id, result in scan.results.items():
            entry = next(e for e in ALL if e.id == node_id)
            if entry.transport != "local-process" or entry.probe is None:
                continue
            resolvable = any(
                shutil.which(c) if not os.path.dirname(c) else os.path.exists(os.path.expandvars(c))
                for c in entry.probe.candidates
            )
            if not resolvable and result.status is not ProbeStatus.NOT_FOUND:
                wrong.append((node_id, result.status))
        assert wrong == [], f"nothing resolves for these, yet they were not NOT_FOUND: {wrong}"


class TestSafetyOnTheRealMachine:
    def test_nothing_without_provenance_was_executed(self, scan):
        """The P0, against whatever this machine actually has installed."""
        assert scan.discovery is not None
        violations = [
            (t.name, t.executable)
            for t in scan.discovery.tools
            if t.executed and t.origin == "unknown"
        ]
        assert violations == [], f"executed binaries with no provenance: {violations}"

    def test_every_executed_tool_had_a_package_behind_it(self, scan):
        for tool in scan.discovery.tools:
            if tool.executed:
                assert tool.origin in {
                    "npm-global",
                    "pipx",
                    "cargo",
                    "venv",
                    "os-package",
                    "catalog",
                }, f"{tool.name} ran with origin {tool.origin}"

    def test_no_probe_left_a_stray_process(self, scan):
        """Nothing AURA started should still be running afterwards."""
        if sys.platform == "win32":
            pytest.skip("POSIX process inspection")
        time.sleep(1)
        # Our own process group should not have accumulated children.
        children = os.popen(f"pgrep -P {os.getpid()} 2>/dev/null").read().split()
        assert len(children) < 5, f"probe children outlived the scan: {children}"


class TestInventoryQuality:
    def test_no_duplicate_logical_tools(self, scan):
        """One real tool, one entry — checked by resolved path and package."""
        seen_paths: dict[str, str] = {}
        seen_packages: dict[tuple[str, str], str] = {}
        duplicates = []
        for tool in scan.discovery.tools:
            if tool.real_path in seen_paths:
                duplicates.append((tool.name, seen_paths[tool.real_path], tool.real_path))
            seen_paths[tool.real_path] = tool.name
            if tool.manager and tool.package:
                key = (tool.manager, tool.package)
                if key in seen_packages:
                    duplicates.append((tool.name, seen_packages[key], str(key)))
                seen_packages[key] = tool.name
        assert duplicates == [], f"the same tool appears more than once: {duplicates}"

    def test_catalog_tools_do_not_reappear_as_unknown(self, scan):
        catalog_paths = {
            real_target(r.executable)
            for r in scan.results.values()
            if r.executable and os.path.isabs(r.executable)
        }
        overlap = [t.name for t in scan.discovery.tools if t.real_path in catalog_paths]
        assert overlap == [], f"catalog tools listed again as discovered: {overlap}"

    def test_verified_tools_all_carry_a_version_and_a_path(self, scan):
        for tool in scan.discovery.tools:
            if tool.status is ToolStatus.VERIFIED:
                assert tool.version, f"{tool.name} is verified with no version"
                assert tool.executable, f"{tool.name} is verified with no path"

    def test_counts_match_the_payload(self, scan):
        payload = scan_result_to_dict(scan)
        assert payload["discoveredCount"] == len(payload["discovered"])
        assert payload["verifiedCount"] == sum(
            1 for t in payload["discovered"] if t["status"] == "verified"
        )
        assert payload["notInstalledCount"] >= len(payload["notInstalled"])


class TestRealMachinePerformance:
    def test_cold_refresh_scan_is_bounded(self):
        _clear_cache()
        started = time.monotonic()
        scan_environment(refresh=True)
        elapsed = time.monotonic() - started
        # Generous: correctness and safety come first, but a scan that takes
        # minutes is a defect regardless.
        assert elapsed < 60, f"cold scan took {elapsed:.1f}s"

    def test_cached_scan_is_much_faster_than_a_refresh(self):
        _clear_cache()
        started = time.monotonic()
        scan_environment(refresh=True)
        cold = time.monotonic() - started

        started = time.monotonic()
        scan_environment(refresh=False)
        cached = time.monotonic() - started

        assert cached < max(cold / 2, 1.0), f"cache saved nothing: cold {cold:.1f}s, cached {cached:.1f}s"

    def test_repeated_probes_are_stable(self):
        first = probe_node("git", refresh=True)
        for _ in range(3):
            again = probe_node("git", refresh=True)
            assert again.present == first.present
            assert again.version == first.version
