"""Process safety and probe correctness for the environment scanner.

Every test here is portable and deterministic: it builds its own fixture
binaries in a tmp directory and asserts on observed behaviour. None of them
depend on what happens to be installed on the machine running them — those
live in ``tests/integration/test_environment_real_machine.py`` behind an
opt-in marker, because a test that asserts "git is installed" fails for a
contributor rather than telling them something true.

The security tests here launch real child processes and inspect what those
children saw. Grepping the source for ``shell=True`` proves nothing about
whether a secret reached a subprocess.
"""

from __future__ import annotations

import json
import os
import stat
import sys
import time
from pathlib import Path

import pytest

from aura.environment import (
    ALL,
    BY_ID,
    ProbeStatus,
    catalog_entry,
    effective_path,
    entries_for_scan,
    location_trust,
    probe_node,
    probe_result_to_dict,
    resolve_executable,
    scan_environment,
    scan_result_to_dict,
)
from aura.environment.catalog import CatalogEntry, ProbeSpec
from aura.environment.discovery import extract_version
from aura.environment.pathsec import LocationTrust
from aura.environment.probe import _clear_cache, _run_probe
from aura.environment.procexec import (
    MAX_OUTPUT_BYTES,
    ExecStatus,
    run_argv,
    sanitized_env,
)

POSIX_ONLY = pytest.mark.skipif(
    sys.platform == "win32", reason="uses POSIX shell-script fixtures"
)


# ── fixtures ────────────────────────────────────────────────────────────


def write_script(directory: Path, name: str, body: str) -> Path:
    """A runnable fixture program. POSIX shell; see POSIX_ONLY."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(0o755)
    return path


@pytest.fixture()
def bindir(tmp_path: Path) -> Path:
    directory = tmp_path / "bin"
    directory.mkdir()
    return directory


def entry_for(command: str, args: list[str] | None = None, **kw) -> CatalogEntry:
    return CatalogEntry(
        id=kw.pop("id", command),
        name=kw.pop("name", command),
        category="development",
        capabilities=[],
        transport="local-process",
        auth="none",
        license="open-source",
        cross_platform=True,
        maintained=True,
        summary="fixture",
        homepage="https://example.invalid",
        probe=ProbeSpec(command, args if args is not None else ["--version"], **kw),
    )


@pytest.fixture(autouse=True)
def _isolate_cache():
    _clear_cache()
    yield
    _clear_cache()


# ── ENV-002: secrets never reach a probed process ───────────────────────


class TestSecretIsolation:
    def test_sanitized_env_omits_everything_not_allow_listed(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-leak")
        monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "aws-should-not-leak")
        monkeypatch.setenv("SOME_FUTURE_CREDENTIAL", "also-should-not-leak")

        env = sanitized_env(path="/usr/bin")

        assert "ANTHROPIC_API_KEY" not in env
        assert "AWS_SECRET_ACCESS_KEY" not in env
        assert "SOME_FUTURE_CREDENTIAL" not in env
        assert env["PATH"] == "/usr/bin"
        assert "HOME" in env or sys.platform == "win32"

    @POSIX_ONLY
    def test_child_process_does_not_receive_secrets(self, bindir, monkeypatch, tmp_path):
        """Behavioural: run a child and read back what it actually saw."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-leak")
        monkeypatch.setenv("MY_DEPLOY_TOKEN", "tok-should-not-leak")
        sink = tmp_path / "seen-env.txt"
        script = write_script(bindir, "dumpenv", f'env > "{sink}"\necho 1.0.0\n')

        outcome = run_argv([str(script)], timeout_ms=5000)

        assert outcome.status is ExecStatus.OK
        seen = sink.read_text()
        assert "sk-should-not-leak" not in seen
        assert "tok-should-not-leak" not in seen
        assert "ANTHROPIC_API_KEY" not in seen
        assert "MY_DEPLOY_TOKEN" not in seen

    @POSIX_ONLY
    def test_scan_does_not_leak_secrets_into_details(self, monkeypatch):
        monkeypatch.setenv("TEST_SECRET_AURA", "supersecret123")
        result = scan_environment(node_ids=["git"], refresh=True)
        for probe in result.results.values():
            assert "supersecret123" not in probe.detail


# ── ENV-011 / ENV-013 / ENV-015: process safety ─────────────────────────


class TestProcessSafety:
    @POSIX_ONLY
    def test_stdin_is_closed_so_a_probe_cannot_prompt(self, bindir, tmp_path):
        sink = tmp_path / "stdin.txt"
        script = write_script(
            bindir,
            "asks",
            f'if [ -t 0 ]; then echo tty > "{sink}"; else echo notty > "{sink}"; fi\n'
            'read -r answer\necho "1.0.0"\n',
        )
        started = time.monotonic()
        outcome = run_argv([str(script)], timeout_ms=5000)
        elapsed = time.monotonic() - started

        assert sink.read_text().strip() == "notty"
        assert outcome.status is ExecStatus.OK
        # It returned rather than blocking on input it will never receive.
        assert elapsed < 4.0

    @POSIX_ONLY
    def test_timeout_kills_the_whole_process_tree(self, bindir, tmp_path):
        marker = tmp_path / "grandchild-survived.txt"
        script = write_script(
            bindir,
            "spawner",
            f'( sleep 4; echo alive > "{marker}" ) &\nsleep 30\n',
        )
        outcome = run_argv([str(script)], timeout_ms=700)

        assert outcome.status is ExecStatus.TIMEOUT
        # If only the direct child were signalled, the grandchild would go on
        # to write the marker after the probe "finished".
        time.sleep(5)
        assert not marker.exists(), "a spawned grandchild outlived the probe"

    @POSIX_ONLY
    def test_timeout_returns_promptly(self, bindir):
        script = write_script(bindir, "slow", "sleep 30\n")
        started = time.monotonic()
        outcome = run_argv([str(script)], timeout_ms=500)
        assert outcome.status is ExecStatus.TIMEOUT
        assert time.monotonic() - started < 10

    @POSIX_ONLY
    def test_enormous_output_is_bounded(self, bindir):
        script = write_script(
            bindir, "flood", 'head -c 20000000 /dev/zero | tr "\\0" "x"\n'
        )
        outcome = run_argv([str(script)], timeout_ms=20000)

        assert len(outcome.stdout.encode()) <= MAX_OUTPUT_BYTES
        assert outcome.truncated is True

    @POSIX_ONLY
    def test_invalid_utf8_does_not_raise(self, bindir):
        script = write_script(bindir, "binary", 'printf "\\xff\\xfe 1.2.3\\n"\n')
        outcome = run_argv([str(script)], timeout_ms=5000)
        assert outcome.status is ExecStatus.OK
        assert extract_version(outcome.output) == "1.2.3"

    def test_missing_executable_is_not_found_not_an_exception(self):
        outcome = run_argv([str(Path("definitely") / "not" / "here")], timeout_ms=1000)
        assert outcome.status is ExecStatus.NOT_FOUND

    @POSIX_ONLY
    def test_non_executable_file_is_denied(self, bindir):
        path = bindir / "notexec"
        path.write_text("#!/bin/sh\necho hi\n")
        path.chmod(0o644)
        outcome = run_argv([str(path)], timeout_ms=1000)
        assert outcome.status in (ExecStatus.DENIED, ExecStatus.NOT_FOUND)

    def test_empty_argv_is_rejected(self):
        assert run_argv([], timeout_ms=1000).status is ExecStatus.ERROR

    def test_no_shell_execution_anywhere_in_the_package(self):
        """A structural backstop for the behavioural tests above."""
        package = Path(__file__).resolve().parents[2] / "aura" / "environment"
        forbidden = ("shell=True", "os.system(", "os.popen(", "subprocess.call(")
        for source in package.glob("*.py"):
            text = source.read_text()
            for needle in forbidden:
                assert needle not in text, f"{source.name} contains {needle}"

    def test_scanning_modules_execute_only_through_procexec(self):
        """Anything that measures the machine must inherit procexec's rules.

        `executor.py` is exempt and asserted separately: installing is a
        long-running async job with different needs, but it still may not
        prompt or leak a process tree.
        """
        import ast

        package = Path(__file__).resolve().parents[2] / "aura" / "environment"
        scanning = {
            "probe.py",
            "discovery.py",
            "provenance.py",
            "ospackages.py",
            "pathsec.py",
            "catalog.py",
            "install.py",
        }
        for name in sorted(scanning):
            tree = ast.parse((package / name).read_text())
            imported = {
                alias.name.split(".")[0]
                for node in ast.walk(tree)
                if isinstance(node, ast.Import)
                for alias in node.names
            } | {
                node.module.split(".")[0]
                for node in ast.walk(tree)
                if isinstance(node, ast.ImportFrom) and node.module
            }
            assert "subprocess" not in imported, f"{name} imports subprocess directly"
            shelled_out = [
                node
                for node in ast.walk(tree)
                if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in ("system", "popen", "spawnl", "spawnv", "execv")
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "os"
            ]
            assert shelled_out == [], f"{name} shells out via os.*"

    def test_install_executor_cannot_prompt_or_leak_a_process_tree(self):
        text = (
            Path(__file__).resolve().parents[2] / "aura" / "environment" / "executor.py"
        ).read_text()
        assert "stdin=asyncio.subprocess.DEVNULL" in text
        assert "_terminate_tree" in text or "killpg" in text


# ── ENV-003 / ENV-014: probe success semantics ──────────────────────────


class TestProbeSemantics:
    @POSIX_ONLY
    def test_error_output_with_non_zero_exit_is_not_verified(self, bindir, monkeypatch):
        write_script(
            bindir,
            "brokentool",
            'echo "error: unrecognized flag --version" >&2\nexit 2\n',
        )
        monkeypatch.setenv("PATH", str(bindir))

        result = _run_probe(entry_for("brokentool"))

        assert result.present is False
        assert result.status is ProbeStatus.FAILED
        assert result.version is None
        assert result.exit_code == 2

    @POSIX_ONLY
    def test_usage_text_is_never_reported_as_a_version(self, bindir, monkeypatch):
        write_script(bindir, "usagetool", 'echo "Usage: usagetool <cmd>"\nexit 0\n')
        monkeypatch.setenv("PATH", str(bindir))

        result = _run_probe(entry_for("usagetool"))

        assert result.status is ProbeStatus.UNVERIFIED
        assert result.present is False
        assert result.version is None

    @POSIX_ONLY
    def test_clean_exit_with_a_version_is_verified(self, bindir, monkeypatch):
        script = write_script(bindir, "goodtool", 'echo "goodtool 4.5.6"\n')
        monkeypatch.setenv("PATH", str(bindir))

        result = _run_probe(entry_for("goodtool"))

        assert result.present is True
        assert result.status is ProbeStatus.VERIFIED
        assert result.version == "4.5.6"
        assert result.executable == str(script)

    @POSIX_ONLY
    def test_version_on_stderr_still_counts(self, bindir, monkeypatch):
        write_script(bindir, "jvmish", 'echo \'openjdk version "21.0.1"\' >&2\n')
        monkeypatch.setenv("PATH", str(bindir))

        result = _run_probe(entry_for("jvmish"))

        assert result.status is ProbeStatus.VERIFIED
        assert result.version == "21.0.1"

    @POSIX_ONLY
    def test_timeout_is_not_reported_as_not_installed(self, bindir, monkeypatch):
        write_script(bindir, "hangs", "sleep 60\n")
        monkeypatch.setenv("PATH", str(bindir))
        monkeypatch.setattr("aura.environment.probe.PROBE_TIMEOUT_MS", 600)

        result = _run_probe(entry_for("hangs"))

        assert result.status is ProbeStatus.TIMEOUT
        assert result.status is not ProbeStatus.NOT_FOUND
        assert result.present is False
        assert result.executable is not None

    @POSIX_ONLY
    def test_a_transient_failure_does_not_decide_the_answer(self, bindir, monkeypatch):
        """A tool that fails once and succeeds on retry is not "failed".

        Observed for real: a Node CLI exited 1 on one run of `--version` and
        0 on the next, which made its card oscillate between Verified and
        Needs attention on a machine nobody had touched.
        """
        marker = bindir / "attempts"
        write_script(
            bindir,
            "flaky",
            f'n=$(cat "{marker}" 2>/dev/null || echo 0)\n'
            f'echo $((n+1)) > "{marker}"\n'
            'if [ "$n" = "0" ]; then echo "transient" >&2; exit 1; fi\n'
            'echo "flaky 2.0.0"\n',
        )
        monkeypatch.setenv("PATH", str(bindir))

        result = _run_probe(entry_for("flaky"))

        assert result.status is ProbeStatus.VERIFIED
        assert result.version == "2.0.0"
        assert marker.read_text().strip() == "2", "expected exactly one retry"

    @POSIX_ONLY
    def test_a_persistent_failure_is_still_a_failure(self, bindir, monkeypatch):
        """The retry must not turn a genuinely broken tool into a working one."""
        marker = bindir / "calls"
        write_script(
            bindir,
            "broken",
            f'echo x >> "{marker}"\necho "nope" >&2\nexit 3\n',
        )
        monkeypatch.setenv("PATH", str(bindir))

        result = _run_probe(entry_for("broken"))

        assert result.status is ProbeStatus.FAILED
        assert result.exit_code == 3
        assert len(marker.read_text().split()) == 2, "expected exactly two attempts"

    @POSIX_ONLY
    def test_a_definitive_outcome_is_not_retried(self, bindir, monkeypatch):
        """Absence is certain; there is nothing to retry."""
        monkeypatch.setenv("PATH", str(bindir))
        result = _run_probe(entry_for("not-here-at-all"))
        assert result.status is ProbeStatus.NOT_FOUND

    def test_absent_tool_is_not_found(self, bindir, monkeypatch):
        monkeypatch.setenv("PATH", str(bindir))
        result = _run_probe(entry_for("nothing-is-called-this-xyz"))
        assert result.status is ProbeStatus.NOT_FOUND
        assert result.executable is None

    @POSIX_ONLY
    def test_probe_uses_the_first_resolving_fallback(self, bindir, monkeypatch):
        write_script(bindir, "second-choice", 'echo "2.0.0"\n')
        monkeypatch.setenv("PATH", str(bindir))

        entry = entry_for("first-choice", fallbacks=("second-choice",))
        result = _run_probe(entry)

        assert result.status is ProbeStatus.VERIFIED
        assert result.executable.endswith("second-choice")


class TestVersionExtraction:
    @pytest.mark.parametrize(
        ("output", "expected"),
        [
            ("git version 2.55.0", "2.55.0"),
            ("go version go1.22.0 linux/amd64", "1.22.0"),
            ('openjdk version "21.0.1" 2023-10-17', "21.0.1"),
            ("Client Version: v1.29.0", "1.29.0"),
            ("Python 3.12.7", "3.12.7"),
            ("Docker version 24.0.7, build afdd53b", "24.0.7"),
            ("1.4.0", "1.4.0"),
            ("v1.2.3-beta.4", "1.2.3-beta.4"),
            ('{"azure-cli": "2.5.1"}', "2.5.1"),
            ("Usage: sometool <cmd>", None),
            ("error: unrecognized flag --version", None),
            ("no numbers here at all", None),
            ("chmod 755 something", None),
            # A number glued inside a word is not a version.
            ("Qwen2.5-Coder assistant", None),
            # Nor is one inside an ASCII-art splash screen.
            ("│  Qwen2.5-Coder  ██╗ ████╗ ██║  │", None),
            ("", None),
        ],
    )
    def test_extraction(self, output, expected):
        assert extract_version(output) == expected


# ── ENV-004 / ENV-020: PATH resolution and hijack resistance ────────────


class TestPathSecurity:
    def test_effective_path_preserves_inherited_order(self, monkeypatch, tmp_path):
        first = tmp_path / "first"
        second = tmp_path / "second"
        first.mkdir()
        second.mkdir()
        monkeypatch.setenv("PATH", os.pathsep.join([str(first), str(second)]))

        parts = effective_path().split(os.pathsep)

        assert parts[0] == str(first)
        assert parts[1] == str(second)

    def test_effective_path_deduplicates(self, monkeypatch, tmp_path):
        d = tmp_path / "dup"
        d.mkdir()
        monkeypatch.setenv("PATH", os.pathsep.join([str(d), str(d), str(d)]))
        parts = effective_path().split(os.pathsep)
        assert parts.count(str(d)) == 1

    @POSIX_ONLY
    def test_resolution_follows_path_order_not_a_preferred_directory(
        self, monkeypatch, tmp_path
    ):
        """ENV-020: what AURA reports must be what the shell would run."""
        early = tmp_path / "early"
        late = tmp_path / "late"
        early.mkdir()
        late.mkdir()
        write_script(early, "twoplaces", 'echo "1.0.0"\n')
        write_script(late, "twoplaces", 'echo "2.0.0"\n')
        monkeypatch.setenv("PATH", os.pathsep.join([str(early), str(late)]))

        assert resolve_executable("twoplaces") == str(early / "twoplaces")

    @POSIX_ONLY
    def test_broken_symlink_does_not_resolve(self, bindir, monkeypatch):
        (bindir / "ghost").symlink_to(bindir / "nothing-here")
        monkeypatch.setenv("PATH", str(bindir))
        assert resolve_executable("ghost") is None

    @POSIX_ONLY
    def test_non_executable_file_does_not_resolve(self, bindir, monkeypatch):
        path = bindir / "plain"
        path.write_text("not a program")
        path.chmod(0o644)
        monkeypatch.setenv("PATH", str(bindir))
        assert resolve_executable("plain") is None

    @POSIX_ONLY
    def test_world_writable_directory_is_never_executed(self, tmp_path, monkeypatch):
        """The classic hijack: a directory any local user can rewrite."""
        evil = tmp_path / "evil"
        evil.mkdir()
        marker = tmp_path / "pwned.txt"
        write_script(evil, "git", f'echo "git version 9.9.9"\ntouch "{marker}"\n')
        evil.chmod(0o777)  # world-writable, no sticky bit
        monkeypatch.setenv("PATH", str(evil))

        verdict = location_trust(evil / "git")
        assert verdict.trust is LocationTrust.WORLD_WRITABLE

        result = _run_probe(entry_for("git"))

        assert result.status is ProbeStatus.BLOCKED
        assert result.present is False
        assert not marker.exists(), "a blocked probe still executed the binary"
        # The refusal names the file, so the operator can see the hijack.
        assert str(evil) in result.detail

    @POSIX_ONLY
    def test_world_writable_file_is_never_executed(self, bindir, monkeypatch):
        script = write_script(bindir, "loose", 'echo "1.0.0"\n')
        script.chmod(0o777)
        monkeypatch.setenv("PATH", str(bindir))

        assert location_trust(script).trust is LocationTrust.WORLD_WRITABLE
        assert _run_probe(entry_for("loose")).status is ProbeStatus.BLOCKED

    @POSIX_ONLY
    def test_setuid_binary_is_never_executed(self, bindir, monkeypatch):
        script = write_script(bindir, "escalate", 'echo "1.0.0"\n')
        script.chmod(script.stat().st_mode | stat.S_ISUID)
        monkeypatch.setenv("PATH", str(bindir))

        assert location_trust(script).trust is LocationTrust.SETUID
        assert _run_probe(entry_for("escalate")).status is ProbeStatus.BLOCKED

    @POSIX_ONLY
    def test_ordinary_user_directory_is_trusted(self, bindir):
        script = write_script(bindir, "fine", 'echo "1.0.0"\n')
        assert location_trust(script).trust is LocationTrust.TRUSTED

    def test_probe_result_always_carries_the_resolved_path(self, bindir, monkeypatch):
        """ENV-004: a version with no path behind it hides a PATH surprise."""
        if sys.platform == "win32":
            pytest.skip("POSIX fixture")
        write_script(bindir, "pathful", 'echo "3.2.1"\n')
        monkeypatch.setenv("PATH", str(bindir))
        payload = probe_result_to_dict(_run_probe(entry_for("pathful")))
        assert payload["executable"] == str(bindir / "pathful")


# Windows and macOS behaviour now has a suite of its own
# (test_cross_platform.py), which drives the whole subsystem through
# `hostplatform.simulate()` instead of patching one module's constant.


# ── ENV-007 / ENV-008: catalog integrity ────────────────────────────────


class TestCatalogIntegrity:
    def test_ids_are_unique(self):
        ids = [e.id for e in ALL]
        assert len(ids) == len(set(ids))

    def test_every_local_process_entry_has_a_probe(self):
        """ENV-008: a probe-less entry vanished from scan *and* not-installed."""
        missing = [
            e.id for e in ALL if e.transport == "local-process" and e.probe is None
        ]
        assert missing == []

    def test_every_entry_is_reachable_by_the_scanner(self):
        scannable = {e.id for e in entries_for_scan()}
        unreachable = {
            e.id
            for e in ALL
            if e.transport in ("local-process", "http", "internal")
            and e.id not in scannable
        }
        assert unreachable == set()

    def test_netlify_is_detectable(self):
        entry = catalog_entry("netlify")
        assert entry is not None
        assert entry.probe is not None
        assert entry.probe.command == "netlify"
        assert entry in entries_for_scan()

    def test_http_endpoints_are_loopback_only(self):
        """A scan measures this machine; it never becomes an outbound call."""
        for entry in ALL:
            if entry.transport != "http":
                continue
            assert entry.endpoint is not None
            assert entry.endpoint.startswith(
                ("http://127.0.0.1", "http://localhost", "http://[::1]")
            ), f"{entry.id} points off-machine"

    def test_typescript_oracle_parity(self):
        """Every node the desktop renders must be one the backend can measure.

        The frontend builds its node list from `catalog.ts`. An id present
        there and absent here is a node that sits at "not checked yet" for
        the life of the session.
        """
        catalog_ts = (
            Path(__file__).resolve().parents[3]
            / "packages"
            / "connected-environment"
            / "src"
            / "catalog.ts"
        )
        if not catalog_ts.exists():
            pytest.skip("TypeScript oracle not present in this checkout")

        import re

        text = catalog_ts.read_text()
        scannable_ts = set()
        for line in text.splitlines():
            match = re.search(r"id:\s*'([^']+)'", line)
            if not match:
                continue
            if "probe:" in line or "endpoint:" in line or "transport: 'internal'" in line:
                scannable_ts.add(match.group(1))

        missing = sorted(scannable_ts - set(BY_ID))
        assert missing == [], f"detectable in the TS catalog but not in Python: {missing}"

    def test_every_entry_has_a_deliberate_detection_strategy(self):
        """No entry may exist without a decided way of detecting it.

        The catalog is what the desktop renders. An entry with no detection
        story is a node that sits at "not checked yet" forever, which is how
        Netlify disappeared from both the scan and the not-installed view.
        """
        for entry in ALL:
            if entry.transport == "internal":
                assert entry.probe is None and entry.endpoint is None
            elif entry.transport == "local-process":
                assert entry.probe is not None, f"{entry.id} has no probe"
                assert entry.probe.args, f"{entry.id} probes with no arguments"
            elif entry.transport == "http":
                assert entry.endpoint is not None, f"{entry.id} has no endpoint"
                assert entry.probe is None
            else:
                pytest.fail(f"{entry.id} has an undecided transport {entry.transport!r}")

    def test_gui_applications_declare_platform_specific_candidates(self):
        """A single command name cannot describe a browser or an editor.

        These are the entries where one name is wrong on two platforms out
        of three, so they must carry per-platform candidates or admit they
        are not cross-platform.
        """
        gui = {"chrome", "chromium", "firefox", "brave", "edge", "vscode", "cursor"}
        for node_id in gui:
            entry = catalog_entry(node_id)
            assert entry is not None
            candidates = entry.probe.candidates
            if entry.cross_platform:
                assert any("/Applications/" in c for c in candidates), f"{node_id}: no macOS path"
                assert any(
                    c.lower().endswith((".exe", ".cmd")) for c in candidates
                ), f"{node_id}: no Windows path"

    def test_platform_specific_tools_say_so(self):
        assert catalog_entry("xcode").cross_platform is False

    def test_no_entry_probes_with_a_destructive_verb(self):
        """Probe arguments are read-only by construction, not by hope."""
        forbidden = {
            "install", "uninstall", "remove", "delete", "update", "upgrade",
            "publish", "deploy", "push", "login", "logout", "init", "start",
            "stop", "restart", "run", "exec", "clean", "prune", "reset",
        }
        for entry in ALL:
            if entry.probe is None:
                continue
            verbs = {arg.lower().lstrip("-") for arg in entry.probe.args}
            overlap = verbs & forbidden
            assert not overlap, f"{entry.id} probes with {overlap}"

    def test_install_specs_name_only_allow_listed_managers(self):
        from aura.environment import INSTALLER_BINARIES

        for entry in ALL:
            if entry.install is None:
                continue
            assert entry.install.method in {"npm-global", "system-package", "pipx", "cargo"}
            if entry.install.method == "npm-global":
                assert "npm" in INSTALLER_BINARIES


# ── ENV-018 / ENV-023: counts describe reality ──────────────────────────


class TestProductionConfiguration:
    """ENV-027: the shipped configuration must be the tested one."""

    def test_the_discovery_budget_is_not_reduced_under_test(self):
        import ast

        from aura.environment.discovery import MAX_UNKNOWN_PROBE
        from aura.environment.probe import _default_max_probe

        assert _default_max_probe() == MAX_UNKNOWN_PROBE

        source = (
            Path(__file__).resolve().parents[2] / "aura" / "environment" / "probe.py"
        ).read_text()
        tree = ast.parse(source)
        sniffing = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and node.value == "PYTEST_CURRENT_TEST"
        ]
        assert sniffing == [], "production behaviour still changes under pytest"

    def test_the_budget_can_be_overridden_explicitly(self, monkeypatch):
        from aura.environment.probe import _default_max_probe

        monkeypatch.setenv("AURA_ENV_MAX_PROBE", "3")
        assert _default_max_probe() == 3
        monkeypatch.setenv("AURA_ENV_MAX_PROBE", "not-a-number")
        assert _default_max_probe() > 0

    def test_probe_timeout_leaves_headroom_for_slow_runtimes(self):
        """ENV-005: the old 4s budget was inside the noise of a Node CLI."""
        from aura.environment.probe import PROBE_TIMEOUT_MS

        assert PROBE_TIMEOUT_MS >= 10_000


class TestCounts:
    def test_found_excludes_aura_internal_nodes(self):
        result = scan_environment(refresh=True)
        internal = {e.id for e in ALL if e.transport == "internal"}
        present_internal = {
            node_id
            for node_id, probe in result.results.items()
            if probe.present and node_id in internal
        }
        assert present_internal, "internal nodes should still report as present"
        assert result.found == sum(
            1
            for node_id, probe in result.results.items()
            if probe.present and node_id not in internal
        )

    def test_not_installed_count_is_the_total_not_the_page(self):
        """ENV-018: the count used to be the length of the truncated list."""
        result = scan_environment(refresh=True)
        payload = scan_result_to_dict(result)
        assert payload["notInstalledCount"] == result.not_installed_total
        assert payload["notInstalledCount"] >= len(payload["notInstalled"])

    def test_not_installed_covers_every_absent_catalog_node(self):
        result = scan_environment(refresh=True)
        absent = {
            e.id
            for e in ALL
            if e.category != "hub"
            and e.transport != "internal"
            and not result.results.get(e.id, None)
            or (
                e.category != "hub"
                and e.transport != "internal"
                and e.id in result.results
                and not result.results[e.id].present
            )
        }
        assert result.not_installed_total == len(absent)

    def test_serialised_payload_is_json_safe(self):
        payload = scan_result_to_dict(scan_environment(refresh=True))
        json.dumps(payload)  # must not raise
        for probe in payload["results"].values():
            assert isinstance(probe["present"], bool)
            assert isinstance(probe["status"], str)


# ── ENV-026: determinism, with no tolerance for drift ───────────────────


class TestDeterminism:
    """Determinism, asserted against fixtures rather than the host.

    The equivalent checks against the real machine live in the opt-in
    integration suite: a portable test must not depend on which tools a
    contributor happens to have, nor fail because one of them lost a race
    with its own update check.
    """

    @POSIX_ONLY
    def test_repeated_probes_of_a_fixture_agree_exactly(self, bindir, monkeypatch):
        write_script(bindir, "steady", 'echo "steady 1.2.3"\n')
        monkeypatch.setenv("PATH", str(bindir))

        results = [_run_probe(entry_for("steady")) for _ in range(5)]

        assert {(r.status, r.version, r.executable) for r in results} == {
            (ProbeStatus.VERIFIED, "1.2.3", str(bindir / "steady"))
        }

    @POSIX_ONLY
    def test_repeated_discovery_of_a_fixture_agrees_exactly(self, tmp_path, monkeypatch):
        from aura.environment.discovery import discover_tools

        bindir = tmp_path / "bin"
        for name in ("alpha", "beta", "gamma"):
            write_script(bindir, name, f'echo "{name} 1.0.0"\n')

        signatures = set()
        for _ in range(4):
            report = discover_tools(path=str(bindir))
            signatures.add(
                tuple(
                    (t.name, t.status, t.version, t.executed, tuple(t.aliases))
                    for t in report.tools
                )
            )

        assert len(signatures) == 1, "discovery disagreed with itself on identical input"

    @POSIX_ONLY
    def test_concurrent_probes_of_a_fixture_agree_exactly(self, bindir, monkeypatch):
        from concurrent.futures import ThreadPoolExecutor

        write_script(bindir, "steady", 'echo "steady 1.2.3"\n')
        monkeypatch.setenv("PATH", str(bindir))

        with ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(lambda _: _run_probe(entry_for("steady")), range(32)))

        assert {(r.status, r.version) for r in results} == {(ProbeStatus.VERIFIED, "1.2.3")}

    def test_concurrent_scans_return_one_consistent_answer(self):
        """ENV-005: identical scans must not disagree under load."""
        from concurrent.futures import ThreadPoolExecutor

        ids = [e.id for e in entries_for_scan()][:12]
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(
                pool.map(lambda _: scan_environment(node_ids=ids, refresh=False), range(4))
            )

        baseline = {k: v.present for k, v in results[0].results.items()}
        for other in results[1:]:
            assert {k: v.present for k, v in other.results.items()} == baseline


# ── ENV-026 / error isolation ───────────────────────────────────────────


class TestErrorIsolation:
    def test_one_broken_probe_never_sinks_the_scan(self, monkeypatch):
        real = _run_probe
        calls = {"n": 0}

        def exploding(entry):
            calls["n"] += 1
            if entry.id == "git":
                raise RuntimeError("probe blew up")
            return real(entry)

        monkeypatch.setattr("aura.environment.probe._run_probe", exploding)
        result = scan_environment(refresh=True)

        assert len(result.results) == len(entries_for_scan())
        assert result.results["git"].present is False
        assert calls["n"] > 1

    def test_discovery_failure_never_sinks_the_scan(self, monkeypatch):
        monkeypatch.setattr(
            "aura.environment.probe._discovery_layer",
            lambda *a, **k: (_ for _ in ()).throw(RuntimeError("discovery exploded")),
        )
        result = scan_environment(refresh=True)
        assert len(result.results) > 0
        assert result.discovery is not None
        assert result.discovery.tools == []

    def test_unknown_node_id_is_reported_not_raised(self):
        result = probe_node("no-such-node-at-all")
        assert result.present is False
        assert result.status is ProbeStatus.UNSUPPORTED


# ── ENV-006 / ENV-025: API behaviour ────────────────────────────────────


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path / "aura-home"))
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    with TestClient(create_app()) as test_client:
        yield test_client


class TestEnvironmentApi:
    def test_scan_returns_the_documented_shape(self, client):
        payload = client.post("/environment/scan", json={"ids": ["git"]}).json()
        assert set(payload) >= {"results", "scannedAt", "found"}
        assert isinstance(payload["found"], int)

    @pytest.mark.parametrize(
        "body",
        [b"not json", b"[1,2,3]", b'{"ids": "git"}', b'{"ids": 5}', b'{"ids": [1, 2]}', b"null"],
    )
    def test_malformed_bodies_do_not_error(self, client, body):
        response = client.post(
            "/environment/scan", content=body, headers={"content-type": "application/json"}
        )
        assert response.status_code == 200

    def test_probe_rejects_an_empty_id_without_raising(self, client):
        payload = client.post("/environment/probe", json={}).json()
        assert payload["result"]["present"] is False

    def test_probe_of_an_unknown_id_is_a_normal_answer(self, client):
        payload = client.post("/environment/probe", json={"id": "../../etc/passwd"}).json()
        assert payload["result"]["present"] is False
        assert payload["result"]["status"] == "unsupported"

    def test_scan_does_not_block_the_event_loop(self, client):
        """ENV-006: the handler must hand its work to a worker thread."""
        import threading

        done = threading.Event()
        latencies: list[float] = []

        def full_scan():
            client.post("/environment/scan", json={"refresh": True})
            done.set()

        worker = threading.Thread(target=full_scan)
        worker.start()
        try:
            time.sleep(0.3)
            for _ in range(4):
                if done.is_set():
                    break
                started = time.monotonic()
                assert client.get("/health").status_code in (200, 404)
                latencies.append(time.monotonic() - started)
        finally:
            worker.join(timeout=120)

        if latencies:
            assert max(latencies) < 5.0, f"event loop stalled: {latencies}"

    @pytest.mark.parametrize(
        "origin",
        [
            "tauri://localhost",       # Linux and macOS
            "http://tauri.localhost",  # Windows
            "https://tauri.localhost",
            "http://localhost:1420",   # the Vite dev server
            "http://127.0.0.1:1420",
        ],
    )
    def test_every_desktop_origin_passes_preflight(self, client, origin):
        """The desktop cannot read the machine inventory it cannot request.

        `http://tauri.localhost` is a Tauri v2 window's origin on Windows,
        and it was missing from the middleware's own origin list while being
        present in the module-level pattern beside it — so the Environment
        screen worked on Linux and failed preflight on Windows.
        """
        response = client.options(
            "/environment/inventory",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert response.status_code == 200, response.text
        assert response.headers["access-control-allow-origin"] == origin

    @pytest.mark.parametrize(
        "origin",
        ["http://evil.example", "https://tauri.localhost.evil.example", "null"],
    )
    def test_foreign_origins_are_refused(self, client, origin):
        response = client.options(
            "/environment/inventory",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert "access-control-allow-origin" not in response.headers

    def test_install_rejects_an_id_outside_the_catalog(self, client):
        response = client.post("/environment/install", json={"id": "../../evil"})
        assert response.status_code == 400
        assert "catalog" in response.json()["detail"].lower()

    def test_connect_rejects_an_id_outside_the_catalog(self, client):
        response = client.post("/environment/connect", json={"id": "nope"})
        assert response.status_code == 400
        assert response.json()["connected"] is False


class TestInstallSecurity:
    def test_installer_allow_list_rejects_arbitrary_binaries(self):
        from aura.environment import validate_installer_binary

        allowed, _ = validate_installer_binary("npm")
        assert allowed is True
        for hostile in ("rm", "/bin/sh", "curl", "bash", "../npm", "npm; rm -rf /"):
            allowed, reason = validate_installer_binary(hostile)
            assert allowed is False, f"{hostile} was allowed"
            assert reason

    def test_install_command_comes_from_the_catalog_only(self):
        from aura.environment import is_plan, plan_install

        entry = catalog_entry("gemini-cli")
        plan = plan_install(entry)
        assert is_plan(plan)
        assert plan.bin == "npm"
        assert entry.install.package in plan.args

    def test_root_installs_are_guided_not_executed(self):
        from aura.environment import is_plan, plan_install

        entry = catalog_entry("docker")
        plan = plan_install(entry)
        if is_plan(plan):
            assert plan.privilege == "root"


class TestUninstallSecurity:
    def test_uninstall_command_comes_from_the_catalog_only(self):
        from aura.environment import is_uninstall_plan, plan_uninstall

        entry = catalog_entry("gemini-cli")
        plan = plan_uninstall(entry)
        assert is_uninstall_plan(plan)
        assert plan.bin == "npm"
        assert plan.args == ["uninstall", "--global", "@google/gemini-cli"]
        assert entry.install.package in plan.args

    def test_uninstall_argv_never_uses_shell(self):
        from pathlib import Path

        root = Path(__file__).resolve().parents[2]
        for rel in (
            "aura/environment/executor.py",
            "aura/environment/install.py",
            "aura/api/server.py",
        ):
            text = (root / rel).read_text()
            assert "shell=True" not in text, f"{rel} must never use shell=True"
            assert "os.system" not in text, f"{rel} must never use os.system"

    def test_uninstall_stdin_is_closed(self):
        from pathlib import Path

        text = (Path(__file__).resolve().parents[2] / "aura" / "environment" / "executor.py").read_text()
        assert "stdin=asyncio.subprocess.DEVNULL" in text

    def test_root_uninstalls_are_guided_not_executed(self):
        from aura.environment import is_uninstall_plan, plan_uninstall

        entry = catalog_entry("docker")
        plan = plan_uninstall(entry)
        if is_uninstall_plan(plan):
            assert plan.privilege == "root"
            assert plan.executable is False

    def test_uninstall_rejects_an_id_outside_the_catalog(self, client):
        response = client.post("/environment/uninstall", json={"id": "../../evil"})
        assert response.status_code == 400
        body = response.json()
        assert body.get("uninstallOutcome") in ("failed", "unavailable")
        assert "catalog" in (body.get("detail") or "").lower()

    def test_uninstall_outcome_is_never_faked(self, client):
        # Unknown id must not report uninstalled.
        response = client.post("/environment/uninstall", json={"id": "nope-not-a-node"})
        assert response.status_code == 400
        assert response.json().get("uninstallOutcome") != "uninstalled"

    def test_human_uninstall_needs_no_approval_header(self, client):
        # Direct human path bypasses the Fabric approval gate by design.
        # The endpoint must answer with an uninstallOutcome, never an approval redirect.
        response = client.post("/environment/uninstall", json={"id": "gemini-cli"})
        body = response.json()
        assert "uninstallOutcome" in body
        assert "awaiting-approval" not in str(body).lower()

    def test_uninstall_plan_uses_allowlisted_binary_only(self):
        from aura.environment import is_uninstall_plan, plan_uninstall, validate_installer_binary

        for node_id in ("gemini-cli", "pnpm"):
            entry = catalog_entry(node_id)
            if entry is None or entry.install is None:
                continue
            plan = plan_uninstall(entry)
            if is_uninstall_plan(plan) and plan.executable:
                allowed, _ = validate_installer_binary(plan.bin)
                assert allowed is True, f"{plan.bin} for {node_id} is not allow-listed"

    def test_system_package_uninstall_is_guided(self):
        from aura.environment import is_uninstall_plan, plan_uninstall

        entry = catalog_entry("docker")
        assert entry is not None and entry.install is not None
        plan = plan_uninstall(entry)
        # Root-tier removals must never auto-execute.
        if is_uninstall_plan(plan):
            assert plan.executable is False
            assert "sudo" in plan.command or "administrator" in plan.why.lower()

    def test_install_exit0_probe_absent_is_unverified_never_installed(self, client, monkeypatch):
        import aura.environment as env_mod
        import aura.environment.executor as executor_mod
        from aura.environment.probe import ProbeResult, ProbeStatus

        async def fake_run_ok(plan, timeout_ms=None, **kwargs):
            return executor_mod.InstallRun(status="ok", exit_code=0, stdout="ok")

        def fake_probe(node_id, refresh=False):
            return ProbeResult(present=False, detail="not found", status=ProbeStatus.NOT_FOUND)

        # Server imports run_install_plan and probe_node inside the handler
        # from aura.environment.executor and aura.environment, so patch there.
        monkeypatch.setattr(executor_mod, "run_install_plan", fake_run_ok)
        monkeypatch.setattr(env_mod, "probe_node", fake_probe)

        # Use a catalog node with a user-space plan so we reach verification.
        response = client.post("/environment/install", json={"id": "gemini-cli"})
        body = response.json()
        assert body.get("installOutcome") == "unverified", body
        assert body.get("installOutcome") != "installed"

    def test_uninstall_exit0_probe_still_present_is_unverified_never_removed(self, client, monkeypatch):
        import aura.environment as env_mod
        import aura.environment.executor as executor_mod
        from aura.environment.probe import ProbeResult, ProbeStatus

        async def fake_run_ok(plan, timeout_ms=None, **kwargs):
            return executor_mod.InstallRun(status="ok", exit_code=0, stdout="ok")

        def fake_probe(node_id, refresh=False):
            return ProbeResult(present=True, detail="still here", version="1.0.0", status=ProbeStatus.VERIFIED)

        monkeypatch.setattr(executor_mod, "run_uninstall_plan", fake_run_ok)
        monkeypatch.setattr(env_mod, "probe_node", fake_probe)

        response = client.post("/environment/uninstall", json={"id": "gemini-cli"})
        body = response.json()
        assert body.get("uninstallOutcome") == "unverified", body
        assert body.get("uninstallOutcome") != "uninstalled"
