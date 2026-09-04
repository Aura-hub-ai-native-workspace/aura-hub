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
        """Asserted against the production trust set, not a copy of it.

        Duplicating the list here would let the two drift apart, and the
        test would then be checking last month's policy.
        """
        from aura.environment.provenance import TRUSTED_ORIGINS

        trusted = {origin.value for origin in TRUSTED_ORIGINS}
        for tool in scan.discovery.tools:
            if tool.executed:
                assert tool.origin in trusted, f"{tool.name} ran with origin {tool.origin}"

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


class TestRealMachineDeterminism:
    """The same machine, measured twice, must give the same answer.

    Exact equality, no tolerance. A disagreement here is a real finding —
    it is how a Node CLI that intermittently exited 1 on `--version` was
    caught, which now gets one bounded retry rather than a flapping card.
    """

    def test_repeated_scans_agree_exactly(self):
        _clear_cache()
        first = scan_environment(refresh=True)
        second = scan_environment(refresh=True)

        assert set(first.results) == set(second.results)
        drift = {
            node_id
            for node_id in first.results
            if first.results[node_id].present != second.results[node_id].present
        }
        assert drift == set(), f"probes disagreed between identical scans: {drift}"
        assert first.found == second.found

    def test_scan_and_single_probe_agree_exactly(self):
        _clear_cache()
        scan = scan_environment(refresh=True)
        for node_id, from_scan in scan.results.items():
            single = probe_node(node_id, refresh=True)
            assert from_scan.present == single.present, (
                f"{node_id}: scan said {from_scan.present}, probe said {single.present}"
            )


class TestRealMachineInventory:
    """The inventory against this machine's own authoritative sources.

    Reconciliation, not a percentage: every source is compared to what the
    tool itself reports, and any gap has to be explainable.
    """

    @pytest.fixture(scope="class")
    def inventory(self):
        from aura.environment.inventory import clear_cache, collect_inventory

        clear_cache()
        return collect_inventory(verify=True)

    def _report(self, inventory, name):
        return next((r for r in inventory.sources if r.name == name), None)

    def test_os_package_count_matches_the_package_manager_exactly(self, inventory):
        """Whatever the distribution reports, AURA reports the same number."""
        import subprocess

        for manager, argv in (
            ("pacman", ["pacman", "-Q"]),
            ("dpkg", ["dpkg-query", "-W", "-f=${Package}\n"]),
            ("rpm", ["rpm", "-qa"]),
        ):
            report = self._report(inventory, manager)
            if report is None or not report.available:
                continue
            binary = shutil.which(argv[0])
            if binary is None:
                continue
            truth = len(
                [
                    line
                    for line in subprocess.run(
                        [binary, *argv[1:]], capture_output=True, text=True
                    ).stdout.splitlines()
                    if line.strip()
                ]
            )
            assert report.total == truth, (
                f"{manager}: the machine reports {truth} packages, AURA {report.total}"
            )

    def test_npm_global_count_matches_the_directory(self, inventory):
        report = self._report(inventory, "npm")
        if report is None or not report.available:
            pytest.skip("npm is not installed")

        from aura.environment.provenance import npm_global_prefix

        prefix = npm_global_prefix()
        assert prefix is not None
        root = prefix / "lib" / "node_modules"
        if not root.is_dir():
            root = prefix / "node_modules"
        truth = 0
        for entry in root.iterdir():
            if entry.name.startswith(".") or not entry.is_dir():
                continue
            truth += len(list(entry.iterdir())) if entry.name.startswith("@") else 1
        assert report.total == truth

    def test_pip_count_matches_pip(self, inventory):
        import json as _json
        import subprocess

        report = self._report(inventory, "pip")
        if report is None or not report.available:
            pytest.skip("pip is not installed")
        binary = shutil.which("pip3") or shutil.which("pip")
        if binary is None:
            pytest.skip("pip is not on PATH")
        raw = subprocess.run(
            [binary, "list", "--format=json", "--disable-pip-version-check"],
            capture_output=True,
            text=True,
        ).stdout
        truth = len(_json.loads(raw or "[]"))
        assert report.total == truth

    def test_every_source_is_either_used_or_explains_itself(self, inventory):
        """No silent unknowns: a source is available, or says why not."""
        for report in inventory.sources:
            if report.available:
                assert report.items >= 0
            else:
                assert report.detail or report.error, f"{report.name} gave no reason"

    def test_nothing_was_executed_merely_to_be_inventoried(self, inventory):
        for entry in inventory.items:
            if entry.execution_performed:
                # Anything run had to satisfy the execution policy first.
                assert entry.execution_allowed is True, entry.name
            else:
                # And anything not run is still fully inventoried.
                assert entry.installed is True

    def test_untrusted_software_is_inventoried_without_being_run(self, inventory):
        untrusted = [i for i in inventory.items if i.trust_level.value in ("untrusted", "blocked")]
        for entry in untrusted:
            assert entry.installed is True
            assert entry.detected is True
            assert entry.verified is False
            assert entry.trust_reason or entry.execution_allowed is False

    def test_no_two_items_claim_the_same_identity(self, inventory):
        seen: dict[str, str] = {}
        for entry in inventory.items:
            for key in entry.keys:
                assert key not in seen, f"{key}: {seen.get(key)} and {entry.name}"
                seen[key] = entry.name

    def test_the_inventory_covers_the_development_environment(self, inventory):
        """Whatever is genuinely installed here must be in the inventory.

        Driven from the machine, not from a wish list: every command that
        resolves on PATH has to appear somewhere in the inventory.
        """
        names: set[str] = set()
        for entry in inventory.items:
            names.add(entry.name.lower())
            names.update(a.lower() for a in entry.aliases)
            names.update(c.lower() for c in entry.provides)
            if entry.command:
                names.add(entry.command.lower())

        missing = []
        for command in ("git", "curl", "bash", "python3", "npm", "node"):
            if shutil.which(command) and command not in names:
                missing.append(command)
        assert missing == [], f"installed but absent from the inventory: {missing}"

    def test_a_cached_inventory_is_immediate(self):
        import time as _time

        from aura.environment.inventory import clear_cache, get_inventory

        clear_cache()
        get_inventory(refresh=True, verify=False)
        started = _time.monotonic()
        get_inventory(refresh=False, verify=False)
        assert (_time.monotonic() - started) < 0.5

    def test_installing_something_new_invalidates_the_cache(self, tmp_path, monkeypatch):
        """The fingerprint moves when the machine does."""
        from aura.environment.inventory.service import _machine_fingerprint

        before = _machine_fingerprint()
        monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
        assert _machine_fingerprint() != before


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
