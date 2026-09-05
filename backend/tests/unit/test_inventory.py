"""The complete machine inventory: sources, identity, states and bounds.

The contract these tests hold to is the one that makes the inventory
trustworthy rather than merely large:

  * everything an authoritative source reports is inventoried,
  * nothing is executed to make that true,
  * one installed thing is one item however many sources saw it,
  * two different things are never merged because their names rhyme,
  * and every count says what it means — `total` is the truth, `returned`
    is the page.

Fixtures stand in for package managers so the suite is portable; the real
machine is measured separately in the opt-in integration suite.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

from aura.environment.inventory import (
    InventoryIndex,
    InventoryItem,
    ItemKind,
    SourceKind,
    TrustLevel,
    clear_cache,
    collect_inventory,
    inventory_to_dict,
)
from aura.environment.inventory import sources as inventory_sources
from aura.environment.inventory.identity import (
    command_key,
    package_key,
    path_key,
)
from aura.environment.inventory.model import Evidence

POSIX_ONLY = pytest.mark.skipif(sys.platform == "win32", reason="POSIX fixtures")


@pytest.fixture(autouse=True)
def _isolate():
    clear_cache()
    yield
    clear_cache()


def item(
    name: str,
    *,
    manager: str | None = None,
    version: str | None = None,
    kind: ItemKind = ItemKind.PACKAGE,
    path: str | None = None,
    provides: set[str] | None = None,
) -> InventoryItem:
    entry = InventoryItem(
        key=package_key(manager or "test", name),
        name=name,
        display_name=name,
        kind=kind,
        package_manager=manager,
        package_name=name if manager else None,
        package_version=version,
        executable_path=path,
        installed=True,
        detected=True,
    )
    entry.keys.add(package_key(manager or "test", name))
    if path:
        entry.keys.add(path_key(path))
    entry.provides |= provides or set()
    entry.add_evidence(
        Evidence(
            source=manager or "test",
            kind=SourceKind.OS_PACKAGE,
            package=name,
            version=version,
            detail="fixture",
        )
    )
    return entry


# ── identity and deduplication ──────────────────────────────────────────


class TestIdentity:
    def test_one_thing_seen_twice_is_one_item(self):
        index = InventoryIndex()
        index.add(item("git", manager="pacman", version="2.45.1"))
        index.add(item("git", manager="pacman", version="2.45.1"))
        assert len(index.items) == 1

    def test_the_same_file_under_two_names_is_one_item(self):
        index = InventoryIndex()
        first = item("alpha", manager="npm", path="/opt/tool")
        second = item("beta", manager=None, path="/opt/tool")
        second.keys = {path_key("/opt/tool")}
        index.add(first)
        index.add(second)
        assert len(index.items) == 1
        assert "beta" in index.items[0].aliases

    def test_a_package_claims_the_commands_it_declares(self):
        index = InventoryIndex()
        npm = item("npm", manager="npm", provides={"npm", "npx"})
        index.add(npm)
        for command in npm.provides:
            index.link_command(npm, command)
        assert index.lookup(command_key("npx")) is npm

    def test_unrelated_software_sharing_a_name_stays_separate(self):
        """`ollama` the binary and `ollama` the Python library are not one thing."""
        index = InventoryIndex()
        index.add(item("ollama", manager="pacman", version="0.33.2"))
        index.add(item("ollama", manager="pip", version="0.6.1"))
        assert len(index.items) == 2

    def test_evidence_is_never_dropped_when_merging(self):
        index = InventoryIndex()
        first = item("tool", manager="pacman", version="1.0")
        second = item("tool", manager="pacman", version="1.0")
        second.add_evidence(
            Evidence(source="path", kind=SourceKind.PATH, location="/usr/bin/tool", detail="on PATH")
        )
        index.add(first)
        index.add(second)
        merged = index.items[0]
        assert {e.source for e in merged.evidence} == {"pacman", "path"}

    def test_absorbing_removes_the_item_from_the_results(self):
        index = InventoryIndex()
        owner = item("git", manager="pacman")
        stray = item("git-shell", manager=None, path="/usr/bin/git-shell")
        index.add(owner)
        index.add(stray)
        assert len(index.items) == 2
        index.absorb(stray, owner)
        assert len(index.items) == 1
        assert index.items[0] is owner

    def test_states_are_unions_across_sources(self):
        index = InventoryIndex()
        first = item("tool", manager="pacman")
        second = item("tool", manager="pacman")
        second.verified = True
        index.add(first)
        index.add(second)
        assert index.items[0].installed and index.items[0].verified

    def test_the_more_specific_classification_wins(self):
        index = InventoryIndex()
        index.add(item("chromium", manager="pacman", kind=ItemKind.PACKAGE))
        app = item("chromium", manager="pacman", kind=ItemKind.APPLICATION)
        index.add(app)
        assert index.items[0].kind is ItemKind.APPLICATION

    def test_deduplication_is_linear_not_quadratic(self):
        """A hundred thousand packages must not be compared pairwise."""
        import time

        index = InventoryIndex()
        started = time.monotonic()
        for i in range(100_000):
            index.add(item(f"pkg{i:06d}", manager="pacman", version="1.0"))
        elapsed = time.monotonic() - started
        assert len(index.items) == 100_000
        assert elapsed < 20, f"100k inserts took {elapsed:.1f}s — dedup is not linear"


# ── version evidence ────────────────────────────────────────────────────


class TestVersions:
    def test_a_runtime_version_outranks_a_package_version(self):
        from aura.environment.inventory.identity import choose_version

        entry = item("tool", manager="npm", version="1.2.3")
        entry.add_evidence(
            Evidence(source="probe", kind=SourceKind.PATH, version="1.2.4", detail="ran")
        )
        choose_version(entry)
        assert entry.version == "1.2.4"
        assert entry.package_version == "1.2.3"

    def test_a_disagreement_is_reported_not_resolved_away(self):
        entry = item("tool", manager="npm", version="1.2.3")
        entry.add_evidence(
            Evidence(source="probe", kind=SourceKind.PATH, version="1.2.4", detail="ran")
        )
        assert entry.version_conflict is True
        assert set(entry.versions) == {"1.2.3", "1.2.4"}

    def test_a_distribution_release_suffix_is_not_a_conflict(self):
        """`2.45.1-3` and `2.45.1` are the same software."""
        entry = item("git", manager="pacman", version="2.45.1-3")
        entry.add_evidence(
            Evidence(source="probe", kind=SourceKind.PATH, version="2.45.1", detail="ran")
        )
        assert entry.version_conflict is False

    def test_an_epoch_is_not_a_conflict(self):
        entry = item("tool", manager="dpkg", version="1:2.0.0-1")
        entry.add_evidence(
            Evidence(source="probe", kind=SourceKind.PATH, version="2.0.0", detail="ran")
        )
        assert entry.version_conflict is False


# ── operating-system sources ────────────────────────────────────────────


class TestOsPackageSources:
    def _fake_manager(self, monkeypatch, name: str, output: str):
        monkeypatch.setattr(
            inventory_sources, "resolve_executable", lambda command: f"/fake/{command}"
        )
        monkeypatch.setattr(
            inventory_sources,
            "_run",
            lambda argv, **kw: (inventory_sources.ExecStatus.OK, output),
        )

    def test_pacman_output_is_inventoried(self, monkeypatch):
        self._fake_manager(monkeypatch, "pacman", "git 2.45.1-3\ncurl 8.8.0-1\n")
        result = inventory_sources._pacman(0.0)
        assert result.report.available is True
        assert {i.name for i in result.items} == {"git", "curl"}
        assert result.report.total == 2

    def test_dpkg_output_is_inventoried(self, monkeypatch):
        self._fake_manager(
            monkeypatch, "dpkg", "git\t1:2.45.1-1\tinstall ok installed\tfast scm\n"
        )
        result = inventory_sources._dpkg(0.0)
        assert [i.name for i in result.items] == ["git"]
        assert result.items[0].package_version == "1:2.45.1-1"

    def test_rpm_output_is_inventoried(self, monkeypatch):
        self._fake_manager(monkeypatch, "rpm", "git\t2.45.1-1.fc40\tfast scm\n")
        result = inventory_sources._rpm(0.0)
        assert result.items[0].name == "git"

    def test_flatpak_applications_are_inventoried(self, monkeypatch):
        self._fake_manager(
            monkeypatch, "flatpak", "org.gimp.GIMP\tGIMP\t2.10.38\tflathub\n"
        )
        result = inventory_sources._flatpak(0.0)
        assert result.items[0].kind is ItemKind.APPLICATION
        assert result.items[0].package_name == "org.gimp.GIMP"

    def test_snap_packages_are_inventoried(self, monkeypatch):
        self._fake_manager(
            monkeypatch, "snap", "Name  Version  Rev  Tracking  Publisher\ncode 1.90 1 latest canonical\n"
        )
        result = inventory_sources._snap(0.0)
        assert [i.name for i in result.items] == ["code"]

    def test_a_missing_manager_is_unavailable_not_empty(self, monkeypatch):
        """"Not installed" and "installed nothing" are different statements."""
        monkeypatch.setattr(inventory_sources, "resolve_executable", lambda command: None)
        for source in (
            inventory_sources._pacman,
            inventory_sources._dpkg,
            inventory_sources._rpm,
            inventory_sources._flatpak,
            inventory_sources._snap,
        ):
            result = source(0.0)
            assert result.report.available is False
            assert result.report.detail
            assert result.items == []

    def test_a_corrupted_database_does_not_stop_the_inventory(self, monkeypatch):
        monkeypatch.setattr(
            inventory_sources, "resolve_executable", lambda command: f"/fake/{command}"
        )
        monkeypatch.setattr(
            inventory_sources,
            "_run",
            lambda argv, **kw: (inventory_sources.ExecStatus.FAILED, "\x00\xff garbage"),
        )
        result = inventory_sources._pacman(0.0)
        assert result.report.error
        assert result.items == []


# ── language package managers ───────────────────────────────────────────


class TestLanguageSources:
    @POSIX_ONLY
    def test_npm_global_tree_is_read_from_disk(self, tmp_path, monkeypatch):
        """Reading the tree cannot fail the way `npm list -g` does."""
        prefix = tmp_path / "npm"
        package = prefix / "lib" / "node_modules" / "@scope" / "tool"
        package.mkdir(parents=True)
        (package / "package.json").write_text(
            json.dumps({"name": "@scope/tool", "version": "3.2.1", "bin": {"tool": "bin/tool"}})
        )
        monkeypatch.setenv("npm_config_prefix", str(prefix))

        result = inventory_sources._npm_global(0.0)

        assert result.report.available is True
        entry = result.items[0]
        assert entry.name == "@scope/tool"
        assert entry.package_version == "3.2.1"
        assert entry.provides == {"tool"}

    @POSIX_ONLY
    def test_hostile_npm_metadata_is_bounded(self, tmp_path, monkeypatch):
        prefix = tmp_path / "npm"
        package = prefix / "lib" / "node_modules" / "hostile"
        package.mkdir(parents=True)
        (package / "package.json").write_text(
            json.dumps(
                {
                    "name": "hostile",
                    "version": "9" * 100_000,
                    "bin": {f"b{i}": "x" for i in range(5_000)},
                    "description": "d" * 100_000,
                }
            )
        )
        monkeypatch.setenv("npm_config_prefix", str(prefix))

        entry = inventory_sources._npm_global(0.0).items[0]

        assert len(entry.package_version or "") <= 64
        assert len(entry.provides) <= 64
        assert len(entry.description or "") <= 300

    @POSIX_ONLY
    def test_uv_reports_interpreters_not_its_own_bookkeeping(self, tmp_path, monkeypatch):
        """uv's data directory is not a list of installed Pythons.

        It also holds `.temp`, `.lock` and short names symlinked to full
        ones. Listing it verbatim reported `.temp` as an installed runtime
        with no version, and counted every interpreter twice.
        """
        data = tmp_path / "uv"
        python_dir = data / "python"
        python_dir.mkdir(parents=True)
        real = python_dir / "cpython-3.14.5-linux-x86_64-gnu"
        real.mkdir()
        (python_dir / "cpython-3.14-linux-x86_64-gnu").symlink_to(real)
        (python_dir / "cpython-3.11.15-linux-x86_64-gnu").mkdir()
        (python_dir / ".temp").mkdir()
        (python_dir / ".lock").write_text("")
        monkeypatch.setenv("UV_DATA_DIR", str(data))
        monkeypatch.setenv("UV_TOOL_DIR", str(tmp_path / "no-tools"))

        items = inventory_sources._uv(0.0).items

        assert {i.package_version for i in items} == {"3.14.5", "3.11.15"}
        assert not any(i.name.startswith("python .") for i in items)
        assert all(i.kind is ItemKind.RUNTIME for i in items)

        linked = next(i for i in items if i.package_version == "3.14.5")
        assert "cpython-3.14-linux-x86_64-gnu" in linked.aliases, (
            "the short name is the same interpreter, so it is an alias, not a second item"
        )
        assert linked.install_location == str(real.resolve())

    @POSIX_ONLY
    def test_uv_reports_a_link_that_leaves_its_own_directory(self, tmp_path, monkeypatch):
        """An interpreter uv links to from elsewhere is still installed."""
        data = tmp_path / "uv"
        python_dir = data / "python"
        python_dir.mkdir(parents=True)
        elsewhere = tmp_path / "system-python"
        elsewhere.mkdir()
        (python_dir / "cpython-3.13.1-linux-x86_64-gnu").symlink_to(elsewhere)
        monkeypatch.setenv("UV_DATA_DIR", str(data))
        monkeypatch.setenv("UV_TOOL_DIR", str(tmp_path / "no-tools"))

        items = inventory_sources._uv(0.0).items

        assert [i.package_version for i in items] == ["3.13.1"]
        assert items[0].install_location == str(elsewhere.resolve())

    @POSIX_ONLY
    def test_uv_does_not_report_an_interpreter_that_is_gone(self, tmp_path, monkeypatch):
        """A dangling link is not an installation.

        The directory it names does not exist, so nothing is installed
        there — and an inventory that says otherwise is exactly the
        fabricated evidence this subsystem must never produce.
        """
        data = tmp_path / "uv"
        python_dir = data / "python"
        python_dir.mkdir(parents=True)
        (python_dir / "cpython-3.13.1-linux-x86_64-gnu").symlink_to(tmp_path / "gone")
        monkeypatch.setenv("UV_DATA_DIR", str(data))
        monkeypatch.setenv("UV_TOOL_DIR", str(tmp_path / "no-tools"))

        assert inventory_sources._uv(0.0).items == []

    def test_pip_json_is_inventoried(self, monkeypatch):
        monkeypatch.setattr(inventory_sources, "resolve_executable", lambda c: f"/fake/{c}")
        monkeypatch.setattr(
            inventory_sources,
            "_run",
            lambda argv, **kw: (
                inventory_sources.ExecStatus.OK,
                json.dumps([{"name": "requests", "version": "2.32.3"}]),
            ),
        )
        result = inventory_sources._pip(0.0)
        assert result.items[0].name == "requests"
        assert result.items[0].kind is ItemKind.LIBRARY

    def test_invalid_pip_json_is_survivable(self, monkeypatch):
        monkeypatch.setattr(inventory_sources, "resolve_executable", lambda c: f"/fake/{c}")
        monkeypatch.setattr(
            inventory_sources, "_run", lambda argv, **kw: (inventory_sources.ExecStatus.OK, "{not json")
        )
        result = inventory_sources._pip(0.0)
        assert result.report.error
        assert result.items == []

    def test_pipx_apps_carry_their_paths(self, monkeypatch):
        monkeypatch.setattr(inventory_sources, "resolve_executable", lambda c: f"/fake/{c}")
        payload = {
            "venvs": {
                "demo": {
                    "metadata": {
                        "main_package": {
                            "package_version": "1.0.0",
                            "apps": ["demo"],
                            "app_paths": [{"__Path__": "/home/u/.local/bin/demo"}],
                        }
                    }
                }
            }
        }
        monkeypatch.setattr(
            inventory_sources, "_run", lambda argv, **kw: (inventory_sources.ExecStatus.OK, json.dumps(payload))
        )
        entry = inventory_sources._pipx(0.0).items[0]
        assert entry.package_version == "1.0.0"
        assert "demo" in entry.provides

    def test_cargo_crates_and_their_binaries(self, monkeypatch):
        monkeypatch.setattr(inventory_sources, "resolve_executable", lambda c: f"/fake/{c}")
        monkeypatch.setattr(
            inventory_sources,
            "_run",
            lambda argv, **kw: (inventory_sources.ExecStatus.OK, "ripgrep v14.1.0:\n    rg\n"),
        )
        entry = inventory_sources._cargo(0.0).items[0]
        assert entry.name == "ripgrep"
        assert entry.package_version == "14.1.0"
        assert entry.provides == {"rg"}

    @POSIX_ONLY
    def test_uv_tools_and_managed_interpreters(self, tmp_path, monkeypatch):
        data = tmp_path / "uv"
        (data / "tools" / "ruff" / "bin").mkdir(parents=True)
        (data / "tools" / "ruff" / "bin" / "ruff").write_text("x")
        (data / "python" / "cpython-3.12.7-linux-x86_64-gnu").mkdir(parents=True)
        monkeypatch.setenv("UV_DATA_DIR", str(data))
        monkeypatch.setenv("UV_TOOL_DIR", str(data / "tools"))

        names = {i.name for i in inventory_sources._uv(0.0).items}

        assert "ruff" in names
        assert any("3.12.7" in n for n in names)


# ── applications ────────────────────────────────────────────────────────


class TestApplicationSources:
    @POSIX_ONLY
    def test_a_desktop_entry_becomes_an_application(self, tmp_path, monkeypatch):
        apps = tmp_path / "applications"
        apps.mkdir()
        (apps / "demo.desktop").write_text(
            "[Desktop Entry]\nType=Application\nName=Demo App\nExec=/usr/bin/demo %U\nComment=A demo\n"
        )
        monkeypatch.setattr(
            inventory_sources, "home_dir", lambda: tmp_path, raising=False
        )
        monkeypatch.setattr(Path, "is_dir", Path.is_dir)

        entry = inventory_sources._parse_desktop_entry(apps / "demo.desktop")

        assert entry is not None
        assert entry.display_name == "Demo App"
        assert entry.kind is ItemKind.APPLICATION
        assert entry.command == "demo"

    @POSIX_ONLY
    @pytest.mark.parametrize(
        ("exec_line", "expected"),
        [
            ('"/opt/My App/App.AppImage" %U', "/opt/My App/App.AppImage"),
            ("/usr/bin/htop", "/usr/bin/htop"),
            ("chromium --new-window %U", "chromium"),
            ("env GDK_BACKEND=x11 code %F", "code"),
        ],
    )
    def test_exec_lines_are_parsed_like_a_shell_would(self, exec_line, expected):
        assert inventory_sources._desktop_exec(exec_line) == expected

    @POSIX_ONLY
    def test_a_launcher_is_not_the_application(self, tmp_path):
        """`Exec=/bin/sh -c ...` must not make bash into this application.

        On this distribution `/bin/sh` resolves to `/usr/bin/bash`; taking
        that as identity folded the entire bash package into scrcpy.
        """
        apps = tmp_path / "applications"
        apps.mkdir()
        (apps / "wrapped.desktop").write_text(
            '[Desktop Entry]\nType=Application\nName=Wrapped\nExec=/bin/sh -c "real-app"\n'
        )
        entry = inventory_sources._parse_desktop_entry(apps / "wrapped.desktop")
        assert entry is not None
        assert entry.command is None
        assert entry.executable_path is None
        assert not any(key.startswith("path:") for key in entry.keys)

    @POSIX_ONLY
    def test_hidden_and_nodisplay_entries_are_not_applications(self, tmp_path):
        apps = tmp_path / "applications"
        apps.mkdir()
        (apps / "hidden.desktop").write_text(
            "[Desktop Entry]\nType=Application\nName=Hidden\nNoDisplay=true\n"
        )
        (apps / "link.desktop").write_text("[Desktop Entry]\nType=Link\nName=Link\n")
        assert inventory_sources._parse_desktop_entry(apps / "hidden.desktop") is None
        assert inventory_sources._parse_desktop_entry(apps / "link.desktop") is None

    @POSIX_ONLY
    def test_malformed_application_metadata_is_survivable(self, tmp_path):
        apps = tmp_path / "applications"
        apps.mkdir()
        (apps / "broken.desktop").write_text("not an ini file at all \x00\xff")
        assert inventory_sources._parse_desktop_entry(apps / "broken.desktop") is None

    @POSIX_ONLY
    def test_an_appimage_is_inventoried_and_never_run(self, tmp_path, monkeypatch):
        target = tmp_path / "Applications"
        target.mkdir()
        image = target / "Thing-1.2.AppImage"
        image.write_text("#!/bin/sh\nexit 0\n")
        image.chmod(0o755)
        monkeypatch.setattr(inventory_sources, "home_dir", lambda: tmp_path)

        result = inventory_sources._appimages(0.0)

        entry = next(i for i in result.items if "Thing" in i.name)
        assert entry.installed is True
        assert entry.trust_level is TrustLevel.UNTRUSTED
        assert entry.execution_performed is False


# ── version managers ────────────────────────────────────────────────────


class TestVersionManagers:
    @POSIX_ONLY
    def test_a_runtime_family_is_one_item_not_one_per_version(self, tmp_path, monkeypatch):
        versions = tmp_path / ".pyenv" / "versions"
        for name in ("3.11.9", "3.12.7", "3.13.0"):
            (versions / name).mkdir(parents=True)
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setattr(os.path, "expanduser", lambda p: p.replace("~", str(tmp_path)))

        result = inventory_sources._version_managers(0.0)

        python = next((i for i in result.items if "Python" in i.name), None)
        assert python is not None, "pyenv versions should be one runtime family"
        assert python.kind is ItemKind.RUNTIME
        assert {e.version for e in python.evidence} == {"3.11.9", "3.12.7", "3.13.0"}


# ── PATH enumeration and attribution ────────────────────────────────────


class TestPathEnumeration:
    @POSIX_ONLY
    def test_every_command_on_path_is_inventoried(self, tmp_path):
        bindir = tmp_path / "bin"
        bindir.mkdir()
        for name in ("alpha", "beta"):
            script = bindir / name
            script.write_text("#!/bin/sh\nexit 0\n")
            script.chmod(0o755)

        index = InventoryIndex()
        result = inventory_sources.enumerate_path(index, path=str(bindir))

        assert {i.name for i in index.items} == {"alpha", "beta"}
        assert result.report.items == 2

    @POSIX_ONLY
    def test_a_command_a_package_declares_joins_that_package(self, tmp_path):
        bindir = tmp_path / "bin"
        bindir.mkdir()
        script = bindir / "tool"
        script.write_text("#!/bin/sh\nexit 0\n")
        script.chmod(0o755)

        index = InventoryIndex()
        package = item("mypkg", manager="npm", version="1.0", provides={"tool"})
        index.add(package)
        index.link_command(package, "tool")

        inventory_sources.enumerate_path(index, path=str(bindir))

        assert len(index.items) == 1
        assert index.items[0].executable_path == str(script)
        assert "path" in index.items[0].sources

    @POSIX_ONLY
    def test_a_package_leads_with_its_own_command_and_keeps_the_rest(self, tmp_path):
        """`vercel` installs `vc` and `vercel`; one item, one obvious name.

        Directory order used to decide which command the card led with, so
        the vercel package was shown as `vc` and the wrangler package as
        `cf-wrangler` — and the names it did not pick were dropped, leaving
        an engineer searching the inventory for `wrangler` with no result.
        """
        bindir = tmp_path / "bin"
        bindir.mkdir()
        for name in ("vc", "vercel"):  # `vc` sorts first, deliberately
            script = bindir / name
            script.write_text("#!/bin/sh\nexit 0\n")
            script.chmod(0o755)

        index = InventoryIndex()
        package = item("vercel", manager="npm", version="59.1.3", provides={"vc", "vercel"})
        index.add(package)
        for command in ("vc", "vercel"):
            index.link_command(package, command)

        inventory_sources.enumerate_path(index, path=str(bindir))

        assert len(index.items) == 1, "two commands of one package are not two installations"
        entry = index.items[0]
        assert entry.command == "vercel"
        assert entry.executable_path == str(bindir / "vercel")
        assert "vc" in entry.aliases

    @POSIX_ONLY
    def test_a_package_whose_name_is_no_command_keeps_every_name(self, tmp_path):
        """`@kilocode/cli` installs `kilo` and `kilocode` and neither matches.

        There is no canonical name to prefer, so the first one found leads —
        but the other is still a name this item answers to.
        """
        bindir = tmp_path / "bin"
        bindir.mkdir()
        for name in ("kilo", "kilocode"):
            script = bindir / name
            script.write_text("#!/bin/sh\nexit 0\n")
            script.chmod(0o755)

        index = InventoryIndex()
        package = item("@kilocode/cli", manager="npm", version="7.5.13",
                       provides={"kilo", "kilocode"})
        index.add(package)
        for command in ("kilo", "kilocode"):
            index.link_command(package, command)

        inventory_sources.enumerate_path(index, path=str(bindir))

        assert len(index.items) == 1
        entry = index.items[0]
        assert entry.command == "kilo"
        assert entry.aliases == ["kilocode"]

    @POSIX_ONLY
    def test_a_shadowed_command_is_evidence_not_a_second_item(self, tmp_path):
        first, second = tmp_path / "a", tmp_path / "b"
        for directory in (first, second):
            directory.mkdir()
            script = directory / "dup"
            script.write_text("#!/bin/sh\nexit 0\n")
            script.chmod(0o755)

        index = InventoryIndex()
        inventory_sources.enumerate_path(
            index, path=os.pathsep.join([str(first), str(second)])
        )

        entries = [i for i in index.items if i.name == "dup"]
        assert len(entries) == 1
        assert entries[0].executable_path == str(first / "dup")
        assert entries[0].shadowed == [str(second / "dup")]

    @POSIX_ONLY
    def test_an_untrusted_command_is_inventoried_but_marked(self, tmp_path):
        wide = tmp_path / "open"
        wide.mkdir()
        script = wide / "risky"
        script.write_text("#!/bin/sh\nexit 0\n")
        script.chmod(0o755)
        wide.chmod(0o777)

        index = InventoryIndex()
        inventory_sources.enumerate_path(index, path=str(wide))

        entry = index.items[0]
        assert entry.installed is True
        assert entry.detected is True
        assert entry.verified is False
        assert entry.trust_level is TrustLevel.BLOCKED
        assert entry.trust_reason

    @POSIX_ONLY
    def test_nonsense_path_entries_are_survivable(self, tmp_path):
        index = InventoryIndex()
        weird = os.pathsep.join(["", str(tmp_path / "missing"), "   ", str(tmp_path)])
        result = inventory_sources.enumerate_path(index, path=weird)
        assert result.report.available is True


# ── the whole thing ─────────────────────────────────────────────────────


class TestCollectedInventory:
    def test_nothing_is_executed_to_be_inventoried(self, monkeypatch):
        """The central promise: completeness without execution."""
        calls: list[list[str]] = []
        real = inventory_sources.run_argv

        def recording(argv, **kwargs):
            calls.append(list(argv))
            return real(argv, **kwargs)

        monkeypatch.setattr(inventory_sources, "run_argv", recording)
        inventory = collect_inventory(verify=False)

        assert inventory.items, "expected a populated inventory"
        # Everything executed must be a package manager being *asked*, never
        # an inventoried item being run.
        for argv in calls:
            program = os.path.basename(argv[0]).lower()
            assert program in {
                "pacman", "dpkg", "dpkg-query", "rpm", "apk", "flatpak", "snap",
                "brew", "port", "npm", "pip", "pip3", "pipx", "cargo", "uv",
                "winget", "choco", "scoop",
            }, f"inventory executed {argv[0]!r}"

    def test_every_item_is_installed_and_carries_evidence(self):
        inventory = collect_inventory(verify=False)
        for entry in inventory.items:
            assert entry.installed is True
            assert entry.evidence, f"{entry.name} has no evidence"
            assert entry.sources

    def test_no_two_items_share_an_identity(self):
        inventory = collect_inventory(verify=False)
        seen: dict[str, str] = {}
        for entry in inventory.items:
            for key in entry.keys:
                assert key not in seen, f"{key} claimed by both {seen.get(key)} and {entry.name}"
                seen[key] = entry.name

    def test_unavailable_sources_are_reported_as_such(self):
        inventory = collect_inventory(verify=False)
        for report in inventory.sources:
            if not report.available:
                assert report.detail or report.error, f"{report.name} gave no reason"

    def test_source_totals_are_never_smaller_than_what_was_returned(self):
        inventory = collect_inventory(verify=False)
        for report in inventory.sources:
            if report.available and report.kind is not SourceKind.PATH:
                assert report.total >= report.items


# ── pagination and transport ────────────────────────────────────────────


class TestPagination:
    @pytest.fixture()
    def big(self):
        from aura.environment.inventory.service import Inventory

        return Inventory(
            items=[item(f"pkg{i:05d}", manager="pacman", version="1.0") for i in range(1000)],
            collected_at="now",
        )

    def test_total_is_the_truth_and_returned_is_the_page(self, big):
        payload = inventory_to_dict(big, offset=0, limit=50)
        assert payload["total"] == 1000
        assert payload["returned"] == 50
        assert payload["truncated"] is True

    def test_paging_covers_everything_exactly_once(self, big):
        seen: list[str] = []
        offset = 0
        while True:
            payload = inventory_to_dict(big, offset=offset, limit=250)
            seen.extend(i["name"] for i in payload["items"])
            if not payload["truncated"]:
                break
            offset += payload["returned"]
        assert len(seen) == 1000
        assert len(set(seen)) == 1000

    def test_an_unbounded_request_returns_everything(self, big):
        payload = inventory_to_dict(big, limit=None)
        assert payload["returned"] == 1000
        assert payload["truncated"] is False

    def test_filtering_by_kind_narrows_the_total_too(self, big):
        big.items.append(item("an-app", manager="flatpak", kind=ItemKind.APPLICATION))
        payload = inventory_to_dict(big, kinds={"application"})
        assert payload["total"] == 1
        assert payload["items"][0]["name"] == "an-app"

    def test_search_matches_names_and_packages(self, big):
        payload = inventory_to_dict(big, query="pkg00001")
        assert payload["total"] == 1

    def test_an_offset_past_the_end_is_empty_not_an_error(self, big):
        payload = inventory_to_dict(big, offset=99_999, limit=10)
        assert payload["items"] == []
        assert payload["total"] == 1000

    def test_a_page_is_json_serialisable(self, big):
        json.dumps(inventory_to_dict(big, limit=10))


# ── scale ───────────────────────────────────────────────────────────────


class TestScale:
    @pytest.mark.parametrize("size", [100, 1_000, 10_000])
    def test_large_inventories_stay_correct_and_bounded(self, size):
        from aura.environment.inventory.service import Inventory

        index = InventoryIndex()
        for i in range(size):
            index.add(item(f"pkg{i:06d}", manager="pacman", version="1.0"))
        inventory = Inventory(items=index.items, collected_at="now")

        assert len(inventory.items) == size
        assert inventory.counts["total"] == size

        payload = inventory_to_dict(inventory, limit=200)
        assert payload["total"] == size
        assert payload["returned"] == min(200, size)
        assert len(json.dumps(payload)) < 2_000_000

    def test_a_hundred_thousand_items_serialise_within_bounds(self):
        from aura.environment.inventory.service import Inventory

        inventory = Inventory(
            items=[item(f"pkg{i:06d}", manager="pacman", version="1.0") for i in range(100_000)],
            collected_at="now",
        )
        payload = inventory_to_dict(inventory, limit=200)
        assert payload["total"] == 100_000
        assert payload["returned"] == 200
        # A page is a page however large the machine is.
        assert len(json.dumps(payload)) < 1_000_000
