"""Windows and macOS behaviour, driven deterministically from any machine.

**These are MOCK VERIFIED, not NATIVE VERIFIED.** No Windows or macOS machine
ran them. What they do verify is real: every platform decision the scanner
makes is routed through :mod:`aura.environment.hostplatform`, so
``simulate()`` puts the whole subsystem — PATH construction, ``PATHEXT``
resolution, package-manager selection, provenance roots, trust policy — on
the other operating system for the length of a test, against a filesystem
laid out the way that system lays one out.

What simulation cannot reach is stated where it matters: the kernel is still
Linux, so a real ``.exe`` still cannot execute and Windows ACLs still do not
exist. Tests here therefore assert on *decisions* (which file was chosen,
which manager was asked, which directory was searched), never on the result
of running a Windows binary.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from aura.environment import ospackages
from aura.environment.discovery import discover_tools
from aura.environment.hostplatform import Platform, current, is_windows, path_sep, simulate
from aura.environment.pathsec import (
    LocationTrust,
    effective_path,
    location_trust,
    resolve_executable,
)
from aura.environment.probe import _clear_cache
from aura.environment.provenance import Origin, build_index


@pytest.fixture(autouse=True)
def _isolate():
    _clear_cache()
    yield
    _clear_cache()


def touch(path: Path, content: str = "x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    path.chmod(0o755)
    return path


# ── the seam itself ─────────────────────────────────────────────────────


class TestPlatformSeam:
    def test_simulation_moves_the_whole_subsystem(self):
        native = current()
        with simulate(Platform.WINDOWS):
            assert is_windows() is True
            assert path_sep() == ";"
        assert current() is native

    def test_simulation_does_not_leak_between_contexts(self):
        with simulate(Platform.MACOS):
            assert current() is Platform.MACOS
        assert current() is not Platform.MACOS

    def test_every_platform_decision_uses_the_seam(self):
        """No module may re-derive the platform for itself.

        A stray ``sys.platform`` comparison is invisible to `simulate()`, so
        the code path it guards would never be exercised from here.
        """
        import ast

        package = Path(__file__).resolve().parents[2] / "aura" / "environment"
        allowed = {"hostplatform.py"}
        offenders: list[str] = []
        for source in sorted(package.glob("*.py")):
            if source.name in allowed:
                continue
            tree = ast.parse(source.read_text())
            for node in ast.walk(tree):
                if (
                    isinstance(node, ast.Attribute)
                    and node.attr == "platform"
                    and isinstance(node.value, ast.Name)
                    and node.value.id == "sys"
                ):
                    offenders.append(f"{source.name} reads sys.platform directly")
                if (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "system"
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "platform"
                ):
                    offenders.append(f"{source.name} calls platform.system()")
        assert offenders == [], "\n  ".join(offenders)


# ── Windows ─────────────────────────────────────────────────────────────


class TestWindowsResolution:
    def test_pathext_is_applied_per_directory(self, tmp_path, monkeypatch):
        """The OS tries every extension in one directory before moving on.

        Getting this backwards picks a far ``foo.exe`` over a near
        ``foo.cmd``, which is how a scanner ends up reporting a version from
        a program the shell would never have run.
        """
        near, far = tmp_path / "near", tmp_path / "far"
        touch(near / "tool.cmd")
        touch(far / "tool.exe")
        monkeypatch.setenv("PATHEXT", ".COM;.EXE;.BAT;.CMD")

        with simulate(Platform.WINDOWS):
            resolved = resolve_executable("tool", ";".join([str(near), str(far)]))

        assert resolved == str(near / "tool.cmd")

    def test_pathext_order_is_respected_within_a_directory(self, tmp_path, monkeypatch):
        here = tmp_path / "bin"
        touch(here / "tool.cmd")
        touch(here / "tool.exe")
        monkeypatch.setenv("PATHEXT", ".EXE;.CMD")

        with simulate(Platform.WINDOWS):
            assert resolve_executable("tool", str(here)) == str(here / "tool.exe")

        monkeypatch.setenv("PATHEXT", ".CMD;.EXE")
        with simulate(Platform.WINDOWS):
            assert resolve_executable("tool", str(here)) == str(here / "tool.cmd")

    def test_an_extensionless_match_still_wins_when_present(self, tmp_path, monkeypatch):
        here = tmp_path / "bin"
        touch(here / "tool")
        touch(here / "tool.exe")
        monkeypatch.setenv("PATHEXT", ".EXE")
        with simulate(Platform.WINDOWS):
            assert resolve_executable("tool", str(here)) == str(here / "tool")

    def test_lowercase_extensions_resolve(self, tmp_path, monkeypatch):
        here = tmp_path / "bin"
        touch(here / "tool.cmd")
        monkeypatch.setenv("PATHEXT", ".CMD")
        with simulate(Platform.WINDOWS):
            assert resolve_executable("tool", str(here)) == str(here / "tool.cmd")

    def test_path_is_split_on_semicolons(self, tmp_path, monkeypatch):
        first, second = tmp_path / "a", tmp_path / "b"
        first.mkdir()
        second.mkdir()
        monkeypatch.setenv("PATH", f"{first};{second}")
        with simulate(Platform.WINDOWS):
            parts = effective_path().split(";")
        assert str(first) in parts and str(second) in parts

    def test_installer_directories_are_searched(self, tmp_path, monkeypatch):
        appdata = tmp_path / "AppData" / "Roaming"
        (appdata / "npm").mkdir(parents=True)
        (tmp_path / "ProgramData" / "chocolatey" / "bin").mkdir(parents=True)
        (tmp_path / "home" / "scoop" / "shims").mkdir(parents=True)

        monkeypatch.setenv("PATH", str(tmp_path))
        monkeypatch.setenv("APPDATA", str(appdata))
        monkeypatch.setenv("ProgramData", str(tmp_path / "ProgramData"))
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path / "home"))
        monkeypatch.setenv("HOME", str(tmp_path / "home"))
        monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))

        with simulate(Platform.WINDOWS):
            path = effective_path()

        assert str(appdata / "npm") in path
        assert str(tmp_path / "ProgramData" / "chocolatey" / "bin") in path

    def test_trust_does_not_apply_posix_bits_on_windows(self, tmp_path):
        """POSIX mode bits do not describe Windows ACLs.

        Applying them there would refuse ordinary files; the protection on
        Windows is identity pinning at the execution boundary instead.
        """
        target = touch(tmp_path / "tool.exe")
        target.chmod(0o777)  # world-writable — refused on POSIX
        assert location_trust(target).trust is LocationTrust.WORLD_WRITABLE
        with simulate(Platform.WINDOWS):
            assert location_trust(target).trust is LocationTrust.TRUSTED

    def test_npm_global_bin_is_the_prefix_itself(self, tmp_path, monkeypatch):
        """On Windows npm links into ``<prefix>``, not ``<prefix>/bin``."""
        prefix = tmp_path / "npm"
        (prefix / "node_modules" / "demo").mkdir(parents=True)
        (prefix / "node_modules" / "demo" / "package.json").write_text(
            json.dumps({"name": "demo", "version": "1.0.0", "bin": {"demo": "demo.js"}})
        )
        touch(prefix / "demo.cmd")
        monkeypatch.setenv("npm_config_prefix", str(prefix))

        with simulate(Platform.WINDOWS):
            index = build_index()
            provenance = index.classify(prefix / "demo.cmd")

        assert provenance.origin is Origin.NPM_GLOBAL
        assert provenance.package == "demo"

    def test_windows_extensions_are_stripped_for_identity(self, tmp_path, monkeypatch):
        """``tool.cmd`` and ``tool`` are one command, not two cards."""
        here = tmp_path / "bin"
        touch(here / "mytool.cmd")
        monkeypatch.setenv("PATHEXT", ".CMD")
        with simulate(Platform.WINDOWS):
            report = discover_tools(path=str(here))
        assert [t.name for t in report.tools] == ["mytool"]

    def test_windows_asks_windows_package_managers(self, tmp_path, monkeypatch):
        asked: list[str] = []
        monkeypatch.setattr(
            ospackages, "resolve_executable", lambda name: f"/fake/{name}"
        )

        def fake_run(argv):
            asked.append(Path(argv[0]).name)
            return ospackages.ExecStatus.OK, ""

        monkeypatch.setattr(ospackages, "_run", fake_run)
        with simulate(Platform.WINDOWS):
            ospackages.discover_os_packages()

        assert asked == ["winget", "choco", "scoop"]

    def test_winget_table_output_is_parsed(self):
        table = (
            "Name                 Id              Version\n"
            "-------------------------------------------\n"
            "Git                  Git.Git         2.45.1\n"
            "Node.js              OpenJS.NodeJS   20.11.0\n"
        )
        packages = ospackages._parse_headered_table(table, "winget")
        names = {p.package for p in packages}
        assert {"Git", "Node.js"} <= names

    def test_process_tree_termination_uses_taskkill_on_windows(self):
        """Structural: POSIX process groups do not exist on Windows."""
        source = (
            Path(__file__).resolve().parents[2]
            / "aura"
            / "environment"
            / "procexec.py"
        ).read_text()
        assert "taskkill" in source
        assert "CREATE_NEW_PROCESS_GROUP" in source


class TestWindowsCatalog:
    def test_browsers_and_editors_offer_windows_candidates(self):
        from aura.environment import catalog_entry

        for node_id in ("chrome", "chromium", "firefox", "brave", "edge", "vscode", "cursor"):
            entry = catalog_entry(node_id)
            assert entry is not None and entry.probe is not None
            assert any(
                candidate.lower().endswith((".exe", ".cmd"))
                for candidate in entry.probe.candidates
            ), f"{node_id} has no Windows candidate"

    def test_powershell_falls_back_to_windows_powershell(self):
        from aura.environment import catalog_entry

        candidates = catalog_entry("powershell").probe.candidates
        assert candidates[0] == "pwsh"
        assert "powershell" in candidates

    def test_python_falls_back_to_the_windows_interpreter_name(self):
        from aura.environment import catalog_entry

        assert "python" in catalog_entry("python").probe.candidates

    def test_windows_environment_keeps_the_variables_a_child_needs(self, monkeypatch):
        """A Windows child cannot load system DLLs without SYSTEMROOT."""
        from aura.environment.procexec import sanitized_env

        monkeypatch.setenv("SYSTEMROOT", r"C:\\Windows")
        monkeypatch.setenv("PATHEXT", ".COM;.EXE")
        monkeypatch.setenv("SOME_TOKEN", "must-not-leak-anywhere")
        with simulate(Platform.WINDOWS):
            env = sanitized_env(path="C:\\bin")
        assert env["SYSTEMROOT"] == r"C:\\Windows"
        assert env["PATHEXT"] == ".COM;.EXE"
        assert "SOME_TOKEN" not in env


# ── macOS ───────────────────────────────────────────────────────────────


class TestMacos:
    def test_applications_directory_is_searched(self, tmp_path, monkeypatch):
        apps = tmp_path / "Applications"
        apps.mkdir()
        monkeypatch.setenv("PATH", str(tmp_path))
        monkeypatch.setattr(
            "aura.environment.pathsec._EXTRA_MACOS", (str(apps),), raising=False
        )
        with simulate(Platform.MACOS):
            assert str(apps) in effective_path()

    def test_homebrew_cellar_counts_as_an_os_package(self, tmp_path, monkeypatch):
        cellar = Path("/opt/homebrew/Cellar")
        with simulate(Platform.MACOS):
            index = build_index()
            provenance = index.classify(cellar / "ripgrep" / "14.1.0" / "bin" / "rg")
        assert provenance.origin is Origin.OS_PACKAGE
        assert provenance.trusted is True

    def test_the_same_path_is_not_trusted_on_linux(self):
        """The Cellar is only meaningful on macOS."""
        index = build_index()
        provenance = index.classify(Path("/opt/homebrew/Cellar/ripgrep/14.1.0/bin/rg"))
        assert provenance.origin is Origin.UNKNOWN

    def test_macos_asks_brew(self, monkeypatch):
        asked: list[str] = []
        monkeypatch.setattr(ospackages, "resolve_executable", lambda name: f"/fake/{name}")

        def fake_run(argv):
            asked.append(Path(argv[0]).name)
            return ospackages.ExecStatus.OK, ""

        monkeypatch.setattr(ospackages, "_run", fake_run)
        with simulate(Platform.MACOS):
            ospackages.discover_os_packages()
        assert asked[0] == "brew"

    def test_brew_versions_output_is_parsed(self):
        packages = ospackages._parse_two_column("ripgrep 14.1.0\njq 1.7.1\n", "brew")
        assert {(p.package, p.version) for p in packages} == {
            ("ripgrep", "14.1.0"),
            ("jq", "1.7.1"),
        }

    def test_app_bundle_candidates_are_absolute_paths(self):
        from aura.environment import catalog_entry

        for node_id in ("chrome", "chromium", "firefox", "brave", "edge"):
            bundles = [
                c for c in catalog_entry(node_id).probe.candidates if "/Applications/" in c
            ]
            assert bundles, f"{node_id} has no macOS bundle candidate"
            for bundle in bundles:
                assert os.path.isabs(bundle)

    def test_a_macos_bundle_resolves_when_it_exists(self, tmp_path, monkeypatch):
        """An absolute candidate is used as given, not searched for on PATH."""
        bundle = touch(
            tmp_path / "Applications" / "Demo.app" / "Contents" / "MacOS" / "Demo"
        )
        with simulate(Platform.MACOS):
            assert resolve_executable(str(bundle), "") == str(bundle)


# ── Linux ───────────────────────────────────────────────────────────────


class TestLinux:
    def test_linux_asks_distribution_package_managers(self, monkeypatch):
        asked: list[str] = []
        monkeypatch.setattr(ospackages, "resolve_executable", lambda name: f"/fake/{name}")

        def fake_run(argv):
            asked.append(Path(argv[0]).name)
            return ospackages.ExecStatus.OK, ""

        monkeypatch.setattr(ospackages, "_run", fake_run)
        with simulate(Platform.LINUX):
            ospackages.discover_os_packages()

        assert asked == ["pacman", "dpkg", "rpm", "apk", "flatpak", "snap"]

    @pytest.mark.parametrize(
        ("parser", "text", "expected"),
        [
            (ospackages._parse_dpkg, "ii  git  2.45.1  amd64  fast scm", ("git", "2.45.1")),
            (ospackages._parse_rpm, "git\t2.45.1-1.fc40", ("git", "2.45.1-1.fc40")),
        ],
    )
    def test_distro_output_is_parsed(self, parser, text, expected):
        packages = parser(text)
        assert (packages[0].package, packages[0].version) == expected

    def test_linux_uses_a_colon_separator(self):
        with simulate(Platform.LINUX):
            assert path_sep() == ":"
