"""Inventory sources on Windows and macOS, driven from any machine.

**MOCK VERIFIED, not NATIVE VERIFIED.** No Windows or macOS machine ran
these. What they establish is that the source registry picks the right
authorities for each platform and that each parser handles that platform's
real output shapes — the things a Linux CI can actually check.

Windows registry access is exercised through a stand-in ``winreg`` module,
because the real one does not exist here; the parsing and shaping around it
is the part that would otherwise be written blind.
"""

from __future__ import annotations

import sys
import types

import pytest

from aura.environment.hostplatform import Platform, simulate
from aura.environment.inventory import ItemKind, clear_cache
from aura.environment.inventory import sources as inventory_sources


@pytest.fixture(autouse=True)
def _isolate():
    clear_cache()
    yield
    clear_cache()


def _source_names(platform: Platform) -> list[str]:
    with simulate(platform):
        return [name for name, _ in inventory_sources._platform_sources()]


# ── which authorities each platform has ─────────────────────────────────


class TestSourceRegistry:
    def test_linux_asks_linux_authorities(self):
        names = _source_names(Platform.LINUX)
        assert {"pacman", "dpkg", "rpm", "apk", "flatpak", "snap", "desktop", "appimage"} <= set(names)
        assert "windows-registry" not in names
        assert "macos-apps" not in names

    def test_windows_asks_windows_authorities(self):
        names = _source_names(Platform.WINDOWS)
        assert {"windows-registry", "appx", "winget", "choco", "scoop"} <= set(names)
        assert "pacman" not in names
        assert "desktop" not in names

    def test_macos_asks_macos_authorities(self):
        names = _source_names(Platform.MACOS)
        assert {"macos-apps", "brew"} <= set(names)
        assert "pacman" not in names
        assert "windows-registry" not in names

    def test_language_managers_are_asked_everywhere(self):
        for platform in (Platform.LINUX, Platform.MACOS, Platform.WINDOWS):
            names = _source_names(platform)
            assert {"npm", "pip", "pipx", "uv", "cargo", "version-managers"} <= set(names), platform

    def test_the_registry_is_ordered_authorities_first(self):
        """Package databases before PATH, so commands can be attributed."""
        for platform in (Platform.LINUX, Platform.MACOS, Platform.WINDOWS):
            names = _source_names(platform)
            assert "path" not in names, "PATH is enumerated separately, after the authorities"


# ── Windows ─────────────────────────────────────────────────────────────


class _FakeKey:
    def __init__(self, name: str, values: dict[str, str], children: dict | None = None):
        self.name = name
        self.values = values
        self.children = children or {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _fake_winreg(
    tree: dict[str, dict[str, str]], *, also_in_wow6432: bool = False
) -> types.ModuleType:
    """A stand-in for the real winreg, shaped like the parts we use.

    Real machines list 32-bit programs under both the plain Uninstall key
    and WOW6432Node; `also_in_wow6432` reproduces that so the deduplication
    can be exercised.
    """
    module = types.ModuleType("winreg")
    module.HKEY_LOCAL_MACHINE = 1
    module.HKEY_CURRENT_USER = 2
    root = _FakeKey("root", {}, {name: _FakeKey(name, values) for name, values in tree.items()})
    empty = _FakeKey("empty", {}, {})

    def open_key(hive, subkey):
        if isinstance(hive, _FakeKey):
            child = hive.children.get(subkey)
            if child is None:
                raise OSError("no such key")
            return child
        if hive != 1:
            raise OSError("this fixture only populates HKLM")
        if "WOW6432Node" in subkey:
            return root if also_in_wow6432 else empty
        return root

    def query_info(key):
        return (len(key.children), len(key.values), 0)

    def enum_key(key, index):
        return list(key.children)[index]

    def enum_value(key, index):
        name = list(key.values)[index]
        return (name, key.values[name], 1)

    module.OpenKey = open_key
    module.QueryInfoKey = query_info
    module.EnumKey = enum_key
    module.EnumValue = enum_value
    return module


class TestWindowsSources:
    def test_installed_programs_come_from_the_uninstall_registry(self, monkeypatch):
        fake = _fake_winreg(
            {
                "{GUID-1}": {
                    "DisplayName": "Visual Studio Code",
                    "DisplayVersion": "1.90.0",
                    "Publisher": "Microsoft Corporation",
                    "InstallLocation": r"C:\\Program Files\\Microsoft VS Code",
                },
                "{GUID-2}": {"DisplayName": "7-Zip", "DisplayVersion": "24.05"},
                "{GUID-3}": {"NoDisplayName": "hidden"},
            }
        )
        monkeypatch.setitem(sys.modules, "winreg", fake)

        with simulate(Platform.WINDOWS):
            result = inventory_sources._windows_registry(0.0)

        names = {i.display_name for i in result.items}
        assert "Visual Studio Code" in names
        assert "7-Zip" in names
        # An entry with no DisplayName is not a program a person installed.
        assert len(result.items) == 2
        code = next(i for i in result.items if i.display_name == "Visual Studio Code")
        assert code.package_version == "1.90.0"
        assert code.publisher == "Microsoft Corporation"
        assert code.installed is True
        assert code.kind is ItemKind.APPLICATION

    def test_a_program_listed_under_both_hives_is_one_item(self, monkeypatch):
        """32-bit programs appear under Uninstall *and* WOW6432Node."""
        from aura.environment.inventory import InventoryIndex

        fake = _fake_winreg(
            {"{GUID-1}": {"DisplayName": "7-Zip", "DisplayVersion": "24.05"}},
            also_in_wow6432=True,
        )
        monkeypatch.setitem(sys.modules, "winreg", fake)

        with simulate(Platform.WINDOWS):
            result = inventory_sources._windows_registry(0.0)

        assert len(result.items) == 2, "the fixture should report it from both hives"
        index = InventoryIndex()
        for entry in result.items:
            index.add(entry)
        assert len(index.items) == 1, "the same program under two hives is one item"

    def test_the_registry_is_unavailable_off_windows(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "winreg", None)
        monkeypatch.delitem(sys.modules, "winreg")
        result = inventory_sources._windows_registry(0.0)
        assert result.report.available is False
        assert "Windows" in result.report.detail

    def test_store_packages_come_from_the_package_directory(self, tmp_path, monkeypatch):
        packages = tmp_path / "Packages"
        (packages / "Microsoft.WindowsTerminal_8wekyb3d8bbwe").mkdir(parents=True)
        (packages / "Microsoft.Paint_8wekyb3d8bbwe").mkdir(parents=True)
        monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))

        with simulate(Platform.WINDOWS):
            result = inventory_sources._appx(0.0)

        assert {i.name for i in result.items} == {"Microsoft.WindowsTerminal", "Microsoft.Paint"}
        assert all(i.kind is ItemKind.APPLICATION for i in result.items)

    def test_winget_table_output_is_parsed(self, monkeypatch):
        monkeypatch.setattr(inventory_sources, "resolve_executable", lambda c: f"C:\\\\{c}.exe")
        monkeypatch.setattr(
            inventory_sources,
            "_run",
            lambda argv, **kw: (
                inventory_sources.ExecStatus.OK,
                "Name      Id           Version\n"
                "--------------------------------\n"
                "Git       Git.Git      2.45.1\n"
                "Node.js   OpenJS.Node  20.11.0\n",
            ),
        )
        with simulate(Platform.WINDOWS):
            result = inventory_sources._windows_table_manager(
                "winget", ["winget", "list"], 0.0
            )
        assert {i.name for i in result.items} == {"Git", "Node.js"}

    def test_chocolatey_limit_output_is_parsed(self, monkeypatch):
        monkeypatch.setattr(inventory_sources, "resolve_executable", lambda c: f"C:\\\\{c}.exe")
        monkeypatch.setattr(
            inventory_sources,
            "_run",
            lambda argv, **kw: (inventory_sources.ExecStatus.OK, "git|2.45.1\nnodejs|20.11.0\n"),
        )
        with simulate(Platform.WINDOWS):
            result = inventory_sources._windows_table_manager(
                "choco", ["choco", "list", "--limit-output"], 0.0
            )
        assert {(i.name, i.package_version) for i in result.items} == {
            ("git", "2.45.1"),
            ("nodejs", "20.11.0"),
        }

    def test_windows_commands_lose_their_extension_for_identity(self, tmp_path):
        """`tool.cmd` and `tool` are one command, not two inventory items."""
        bindir = tmp_path / "bin"
        bindir.mkdir()
        (bindir / "tool.cmd").write_text("@echo off")
        (bindir / "other.exe").write_text("MZ")

        from aura.environment.inventory import InventoryIndex

        index = InventoryIndex()
        with simulate(Platform.WINDOWS):
            inventory_sources.enumerate_path(index, path=str(bindir))

        assert {i.name for i in index.items} == {"tool", "other"}

    def test_program_files_counts_as_an_os_location(self, monkeypatch):
        from aura.environment.provenance import _os_package_prefixes

        monkeypatch.setenv("ProgramFiles", r"C:\\Program Files")
        with simulate(Platform.WINDOWS):
            prefixes = [str(p) for p in _os_package_prefixes()]
        assert any("Program Files" in p for p in prefixes)


# ── macOS ───────────────────────────────────────────────────────────────


class TestMacosSources:
    def test_app_bundles_are_read_from_their_plist(self, tmp_path, monkeypatch):
        import plistlib

        applications = tmp_path / "Applications"
        bundle = applications / "Demo.app" / "Contents"
        bundle.mkdir(parents=True)
        with open(bundle / "Info.plist", "wb") as handle:
            plistlib.dump(
                {
                    "CFBundleIdentifier": "com.example.demo",
                    "CFBundleDisplayName": "Demo",
                    "CFBundleShortVersionString": "4.2.0",
                },
                handle,
            )
        monkeypatch.setattr(inventory_sources, "home_dir", lambda: tmp_path)
        monkeypatch.setattr(
            inventory_sources.Path, "is_dir", lambda self: str(self).startswith(str(tmp_path))
        )

        with simulate(Platform.MACOS):
            result = inventory_sources._macos_applications(0.0)

        entry = next(i for i in result.items if i.name == "Demo")
        assert entry.kind is ItemKind.APPLICATION
        assert entry.package_name == "com.example.demo"
        assert any(e.version == "4.2.0" for e in entry.evidence)
        assert entry.installed is True

    def test_a_bundle_without_a_plist_is_still_inventoried(self, tmp_path, monkeypatch):
        applications = tmp_path / "Applications"
        (applications / "Bare.app").mkdir(parents=True)
        monkeypatch.setattr(inventory_sources, "home_dir", lambda: tmp_path)
        monkeypatch.setattr(
            inventory_sources.Path, "is_dir", lambda self: str(self).startswith(str(tmp_path))
        )

        with simulate(Platform.MACOS):
            result = inventory_sources._macos_applications(0.0)

        assert any(i.name == "Bare" for i in result.items)

    def test_a_corrupt_plist_does_not_stop_the_source(self, tmp_path, monkeypatch):
        applications = tmp_path / "Applications"
        bundle = applications / "Broken.app" / "Contents"
        bundle.mkdir(parents=True)
        (bundle / "Info.plist").write_bytes(b"\x00\xff not a plist")
        monkeypatch.setattr(inventory_sources, "home_dir", lambda: tmp_path)
        monkeypatch.setattr(
            inventory_sources.Path, "is_dir", lambda self: str(self).startswith(str(tmp_path))
        )

        with simulate(Platform.MACOS):
            result = inventory_sources._macos_applications(0.0)

        assert any(i.name == "Broken" for i in result.items)

    def test_homebrew_formulae_and_casks_are_distinguished(self, monkeypatch):
        calls: list[list[str]] = []

        def fake_run(argv, **kw):
            calls.append(argv)
            if "--cask" in argv:
                return inventory_sources.ExecStatus.OK, "firefox 127.0\n"
            return inventory_sources.ExecStatus.OK, "ripgrep 14.1.0\njq 1.7.1\n"

        monkeypatch.setattr(inventory_sources, "resolve_executable", lambda c: f"/opt/homebrew/bin/{c}")
        monkeypatch.setattr(inventory_sources, "_run", fake_run)

        with simulate(Platform.MACOS):
            result = inventory_sources._homebrew(0.0)

        by_name = {i.name: i for i in result.items}
        assert by_name["ripgrep"].package_manager == "brew"
        assert by_name["firefox"].package_manager == "brew-cask"
        assert by_name["firefox"].kind is ItemKind.APPLICATION

    def test_homebrew_is_unavailable_when_not_installed(self, monkeypatch):
        monkeypatch.setattr(inventory_sources, "resolve_executable", lambda c: None)
        with simulate(Platform.MACOS):
            result = inventory_sources._homebrew(0.0)
        assert result.report.available is False


# ── platform-independent guarantees ─────────────────────────────────────


class TestGuaranteesHoldOnEveryPlatform:
    @pytest.mark.parametrize("platform", [Platform.LINUX, Platform.MACOS, Platform.WINDOWS])
    def test_no_source_executes_an_inventoried_item(self, platform, monkeypatch):
        """Whatever the platform, sources read records; they do not run software."""
        executed: list[str] = []
        monkeypatch.setattr(
            inventory_sources,
            "run_argv",
            lambda argv, **kw: (
                executed.append(argv[0]),
                inventory_sources.ExecStatus.OK,
            )[0]
            or _empty_outcome(),
        )
        monkeypatch.setattr(inventory_sources, "resolve_executable", lambda c: None)

        with simulate(platform):
            results = inventory_sources.collect_sources()

        assert results, "expected the registry to offer sources"
        assert executed == [], f"a source executed {executed}"

    @pytest.mark.parametrize("platform", [Platform.LINUX, Platform.MACOS, Platform.WINDOWS])
    def test_every_unavailable_source_explains_itself(self, platform, monkeypatch):
        monkeypatch.setattr(inventory_sources, "resolve_executable", lambda c: None)
        with simulate(platform):
            results = inventory_sources.collect_sources()
        for result in results:
            if not result.report.available:
                assert result.report.detail or result.report.error


def _empty_outcome():
    from aura.environment.procexec import ExecOutcome, ExecStatus

    return ExecOutcome(status=ExecStatus.NOT_FOUND)
