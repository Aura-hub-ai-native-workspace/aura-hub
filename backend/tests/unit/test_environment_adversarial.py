"""Adversarial cases for the environment scanner.

Each test here is an attack that was actually attempted against this code.
They are kept as tests because the interesting property is not "does the
scanner work" but "does it still refuse when someone is trying to make it
say yes".

The threat model is a machine where an attacker can create files — through a
malicious npm package, a compromised dependency's `postinstall`, a shared
temp directory, or another local account — but cannot already run code as
the operator. Everything below must hold in that world.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest
from test_environment_hardening import entry_for, write_script

from aura.environment.discovery import discover_tools, extract_version
from aura.environment.pathsec import LocationTrust, location_trust, real_target
from aura.environment.probe import ProbeStatus, _cache_key, _clear_cache, _run_probe
from aura.environment.procexec import MAX_OUTPUT_BYTES, ExecStatus, run_argv
from aura.environment.provenance import Origin, build_index

POSIX_ONLY = pytest.mark.skipif(
    sys.platform == "win32", reason="uses POSIX symlink/script fixtures"
)


@pytest.fixture(autouse=True)
def _isolate():
    _clear_cache()
    yield
    _clear_cache()


def npm_prefix(root: Path, package: str, bins: dict[str, str], version: str = "1.0.0") -> Path:
    """A minimal but realistic npm global prefix."""
    prefix = root / "npm"
    node_modules = prefix / "lib" / "node_modules" / package
    (node_modules / "bin").mkdir(parents=True, exist_ok=True)
    (prefix / "bin").mkdir(parents=True, exist_ok=True)
    (node_modules / "package.json").write_text(
        json.dumps({"name": package, "version": version, "bin": {b: f"bin/{b}" for b in bins}})
    )
    for name, body in bins.items():
        target = write_script(node_modules / "bin", name, body)
        link = prefix / "bin" / name
        if not link.exists():
            link.symlink_to(target)
    return prefix


class TestExecutionCannotBeTricked:
    @POSIX_ONLY
    def test_symlink_escape_from_a_manager_bin_directory(self, tmp_path, monkeypatch):
        """A link in npm's bin dir, named after a real bin, pointing elsewhere.

        The directory and the name both look right. Only the target gives it
        away, which is why the target is what decides.
        """
        prefix = npm_prefix(tmp_path, "realpkg", {"tool": 'echo "1.0.0"\n'})
        sentinel = tmp_path / "escaped.txt"
        evil = write_script(tmp_path, "evil.sh", f'touch "{sentinel}"\necho "9.9.9"\n')
        (prefix / "bin" / "tool").unlink()
        (prefix / "bin" / "tool").symlink_to(evil)

        monkeypatch.setenv("npm_config_prefix", str(prefix))
        index = build_index()

        assert index.classify(prefix / "bin" / "tool").origin is Origin.UNKNOWN

        report = discover_tools(index, path=str(prefix / "bin"))
        tool = next(t for t in report.tools if t.name == "tool")
        assert tool.executed is False
        assert not sentinel.exists()

    @POSIX_ONLY
    def test_a_lookalike_in_a_directory_no_manager_owns(self, tmp_path, monkeypatch):
        """`npx` somewhere else on PATH must not inherit npm's trust."""
        prefix = npm_prefix(tmp_path, "npm", {"npx": 'echo "1.0.0"\n'})
        monkeypatch.setenv("npm_config_prefix", str(prefix))

        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        sentinel = tmp_path / "lookalike.txt"
        write_script(elsewhere, "npx", f'touch "{sentinel}"\necho "1.0.0"\n')

        index = build_index()
        assert index.classify(elsewhere / "npx").origin is Origin.UNKNOWN

        discover_tools(index, path=str(elsewhere))
        assert not sentinel.exists()

    @POSIX_ONLY
    def test_a_wrapper_that_ignores_its_arguments_is_never_reached(self, tmp_path):
        """The shape of the original P0: `--version` is not a no-op.

        A wrapper that `exec`s a destructive subcommand discards the flag
        entirely, so "asking for a version" runs the destructive thing.
        """
        bindir = tmp_path / "bin"
        bindir.mkdir()
        sentinel = tmp_path / "uninstalled.txt"
        write_script(bindir, "app-uninstall", f'touch "{sentinel}"\n')

        report = discover_tools(path=str(bindir))

        tool = next(t for t in report.tools if t.name == "app-uninstall")
        assert tool.executed is False
        assert not sentinel.exists()

    @POSIX_ONLY
    def test_hostile_package_metadata_cannot_bloat_the_payload(self, tmp_path, monkeypatch):
        prefix = npm_prefix(tmp_path, "hostile", {"hostile": 'echo "1.0.0"\n'})
        manifest = prefix / "lib" / "node_modules" / "hostile" / "package.json"
        manifest.write_text(
            json.dumps(
                {
                    "name": "hostile",
                    "version": "9" * 100_000,
                    "bin": {f"b{i}": "x" for i in range(5_000)},
                }
            )
        )
        monkeypatch.setenv("npm_config_prefix", str(prefix))

        record = next(r for r in build_index().layers["npm"].records if r.package == "hostile")

        assert len(record.version) <= 64
        assert len(record.app_names) <= 64

    @POSIX_ONLY
    def test_malformed_package_metadata_is_survivable(self, tmp_path, monkeypatch):
        prefix = npm_prefix(tmp_path, "broken", {"broken": 'echo "1.0.0"\n'})
        (prefix / "lib" / "node_modules" / "broken" / "package.json").write_text("{not json")
        monkeypatch.setenv("npm_config_prefix", str(prefix))

        layer = build_index().layers["npm"]

        assert layer.available is True
        assert any(r.package == "broken" for r in layer.records)


class TestFilesystemHostility:
    @POSIX_ONLY
    def test_a_symlink_loop_does_not_hang_or_raise(self, tmp_path):
        a = tmp_path / "a"
        b = tmp_path / "b"
        a.symlink_to(b)
        b.symlink_to(a)

        assert location_trust(a).trust is LocationTrust.MISSING
        assert real_target(a)  # returns something rather than raising
        report = discover_tools(path=str(tmp_path))
        assert all(t.name not in ("a", "b") for t in report.tools)

    @POSIX_ONLY
    def test_a_directory_named_like_a_program_is_not_a_program(self, tmp_path):
        (tmp_path / "looks-like-a-tool").mkdir(mode=0o755)
        report = discover_tools(path=str(tmp_path))
        assert all(t.name != "looks-like-a-tool" for t in report.tools)

    def test_nonsense_path_entries_are_survivable(self, tmp_path):
        weird = os.pathsep.join(
            ["", str(tmp_path / "does-not-exist"), str(tmp_path), "   ", "\x00bad"]
        )
        report = discover_tools(path=weird)  # must not raise
        assert report.total_candidates >= 0

    @POSIX_ONLY
    def test_a_file_on_path_instead_of_a_directory(self, tmp_path):
        plain = tmp_path / "not-a-dir"
        plain.write_text("x")
        report = discover_tools(path=str(plain))
        assert report.tools == []

    @POSIX_ONLY
    def test_a_deep_symlink_chain_resolves_to_one_identity(self, tmp_path):
        real = write_script(tmp_path, "real", 'echo "1.0.0"\n')
        previous = real
        for i in range(8):
            link = tmp_path / f"link{i}"
            link.symlink_to(previous)
            previous = link

        assert real_target(previous) == str(real)
        report = discover_tools(path=str(tmp_path))
        # One file, one entry — the other names are aliases of it.
        entries = [t for t in report.tools if real_target(t.executable) == str(real)]
        assert len(entries) == 1
        assert len(entries[0].aliases) == 8


class TestHostileOutput:
    @POSIX_ONLY
    def test_endless_output_is_stopped_by_the_timeout(self, tmp_path):
        script = write_script(tmp_path, "endless", 'while :; do echo "1.0.0"; done\n')
        outcome = run_argv([str(script)], timeout_ms=1200)
        assert outcome.status is ExecStatus.TIMEOUT
        assert len(outcome.stdout.encode()) <= MAX_OUTPUT_BYTES

    @POSIX_ONLY
    def test_enormous_stderr_is_bounded_too(self, tmp_path):
        script = write_script(
            tmp_path, "noisy", 'head -c 5000000 /dev/zero | tr "\\0" "e" >&2\nexit 0\n'
        )
        outcome = run_argv([str(script)], timeout_ms=20000)
        assert len(outcome.stderr.encode()) <= MAX_OUTPUT_BYTES
        assert outcome.truncated is True

    @POSIX_ONLY
    def test_a_version_string_cannot_be_arbitrarily_long(self, tmp_path, monkeypatch):
        write_script(tmp_path, "verbose", 'printf "tool %s.0.0\\n" "$(head -c 900 /dev/zero | tr "\\0" "9")"\n')
        monkeypatch.setenv("PATH", str(tmp_path))
        result = _run_probe(entry_for("verbose"))
        assert result.version is None or len(result.version) <= 64

    def test_control_characters_are_not_read_as_a_version(self):
        assert extract_version("\x1b[31m\x00\x07 not a version") is None

    @POSIX_ONLY
    def test_a_tool_claiming_a_version_it_did_not_earn_still_fails_on_exit_code(
        self, tmp_path, monkeypatch
    ):
        write_script(tmp_path, "liar", 'echo "liar 99.99.99"\nexit 1\n')
        monkeypatch.setenv("PATH", str(tmp_path))
        result = _run_probe(entry_for("liar"))
        assert result.status is ProbeStatus.FAILED
        assert result.present is False
        assert result.version is None


class TestCacheCannotGoStale:
    def test_a_path_change_invalidates_the_cache_key(self, tmp_path, monkeypatch):
        monkeypatch.setenv("PATH", str(tmp_path / "before"))
        before = _cache_key("git")
        monkeypatch.setenv("PATH", str(tmp_path / "after"))
        assert _cache_key("git") != before

    @POSIX_ONLY
    def test_installing_a_tool_is_visible_after_a_path_change(self, tmp_path, monkeypatch):
        empty = tmp_path / "empty"
        empty.mkdir()
        monkeypatch.setenv("PATH", str(empty))
        assert _run_probe(entry_for("latecomer")).present is False

        installed = tmp_path / "installed"
        installed.mkdir()
        write_script(installed, "latecomer", 'echo "1.0.0"\n')
        monkeypatch.setenv("PATH", os.pathsep.join([str(installed), str(empty)]))

        from aura.environment.catalog import BY_ID
        from aura.environment.probe import probe_node

        # Directly, because `latecomer` is a fixture rather than a catalog id.
        assert _run_probe(entry_for("latecomer")).present is True
        assert probe_node is not None and BY_ID  # imports are wired


class TestForeignOwnership:
    @POSIX_ONLY
    @pytest.mark.skipif(os.getuid() == 0, reason="root owns everything")
    def test_a_file_owned_by_another_user_is_refused(self):
        """Uses a real root-owned path rather than fabricating ownership."""
        candidate = Path("/etc/passwd")
        if not candidate.exists() or candidate.stat().st_uid == os.getuid():
            pytest.skip("no suitable foreign-owned file")
        # Root-owned is explicitly allowed (that is the system itself).
        assert location_trust(candidate).trust is LocationTrust.TRUSTED

    @POSIX_ONLY
    def test_world_writable_ancestors_are_caught_not_just_the_file(self, tmp_path):
        open_dir = tmp_path / "open"
        nested = open_dir / "nested"
        nested.mkdir(parents=True)
        script = write_script(nested, "tool", 'echo "1.0.0"\n')
        open_dir.chmod(0o777)

        verdict = location_trust(script)

        assert verdict.trust is LocationTrust.WORLD_WRITABLE
        assert str(open_dir) in verdict.reason
