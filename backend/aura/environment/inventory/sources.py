"""Authoritative inventory sources: what the machine says about itself.

Every source here answers "what is installed" by *reading a record* — a
package database, an application manifest, a registry key, a directory
listing. None of them run the software they describe. That is what lets the
inventory be complete without the scan becoming an execution of everything
on disk.

Each source reports its own availability. A machine without Flatpak yields
``available=False`` for Flatpak, which is a different statement from "no
Flatpak applications are installed" and stays distinguishable all the way to
the operator.

Adding a source means adding a function and registering it. It inherits the
execution boundary automatically, because reading a package database is
still a subprocess and still goes through :mod:`aura.environment.procexec`.
"""
from __future__ import annotations

import configparser
import json
import os
import re
import shlex
import time
from collections.abc import Callable, Iterable
from pathlib import Path

from ..hostplatform import is_macos, is_windows
from ..observability import redact
from ..pathsec import (
    LocationTrust,
    effective_path,
    home_dir,
    location_trust,
    path_sep,
    real_target,
    resolve_executable,
    self_runtime_dirs,
)
from ..procexec import ExecStatus, run_argv
from .identity import (
    InventoryIndex,
    app_key,
    command_key,
    package_key,
    path_key,
)
from .model import (
    Evidence,
    InventoryItem,
    ItemKind,
    SourceKind,
    SourceReport,
    SourceResult,
    TrustLevel,
)

#: Reading a package database is bounded like any other command.
SOURCE_TIMEOUT_MS = 20_000

#: Ceiling per source. Real machines sit far below this; it exists so a
#: corrupted or hostile database cannot exhaust memory. Totals stay truthful
#: even when the list is cut (see SourceReport.truncated).
MAX_ITEMS_PER_SOURCE = 50_000

#: Files read from any one directory when enumerating applications or PATH.
MAX_DIR_ENTRIES = 5_000

#: How many paths are handed to a package manager in one ownership query.
OWNERSHIP_BATCH = 400


def _run(argv: list[str], *, timeout_ms: int = SOURCE_TIMEOUT_MS) -> tuple[ExecStatus, str]:
    outcome = run_argv(
        argv,
        timeout_ms=timeout_ms,
        cwd=str(home_dir()),
        path=effective_path(),
        max_output=8 * 1024 * 1024,
    )
    return outcome.status, outcome.stdout


def _report(name: str, kind: SourceKind, started: float, **kw) -> SourceReport:
    return SourceReport(
        name=name,
        kind=kind,
        duration_ms=int((time.monotonic() - started) * 1000),
        **kw,
    )


def _unavailable(name: str, kind: SourceKind, started: float, reason: str) -> SourceResult:
    return SourceResult(
        report=_report(name, kind, started, available=False, detail=reason)
    )


def _bounded(items: list[InventoryItem], total: int) -> tuple[list[InventoryItem], bool]:
    if total <= MAX_ITEMS_PER_SOURCE:
        return items, False
    return items[:MAX_ITEMS_PER_SOURCE], True


# ── operating-system package databases ──────────────────────────────────


def _os_item(manager: str, name: str, version: str | None, description: str = "") -> InventoryItem:
    item = InventoryItem(
        key=package_key(manager, name),
        name=name,
        display_name=name,
        kind=ItemKind.PACKAGE,
        category="system",
        package_manager=manager,
        package_name=name,
        package_version=version,
        description=description or None,
        installed=True,
        detected=True,
    )
    item.keys.add(package_key(manager, name))
    item.add_evidence(
        Evidence(
            source=manager,
            kind=SourceKind.OS_PACKAGE,
            package=name,
            version=version,
            detail=f"recorded as installed by {manager}",
        )
    )
    return item


def _pacman(started: float) -> SourceResult:
    binary = resolve_executable("pacman")
    if binary is None:
        return _unavailable("pacman", SourceKind.OS_PACKAGE, started, "pacman is not installed")
    status, stdout = _run([binary, "-Q"])
    if status is not ExecStatus.OK:
        return SourceResult(
            _report("pacman", SourceKind.OS_PACKAGE, started, available=True, error="pacman -Q failed")
        )

    explicit: set[str] = set()
    ex_status, ex_out = _run([binary, "-Qe"])
    if ex_status is ExecStatus.OK:
        explicit = {line.split()[0] for line in ex_out.splitlines() if line.strip()}

    items: list[InventoryItem] = []
    for line in stdout.splitlines():
        parts = line.split()
        if not parts:
            continue
        name = parts[0]
        item = _os_item("pacman", name, parts[1] if len(parts) > 1 else None)
        # Explicitly installed packages are things a person chose; the rest
        # arrived as dependencies and are inventory, not intent.
        item.kind = ItemKind.PACKAGE if name in explicit else ItemKind.LIBRARY
        items.append(item)

    total = len(items)
    items, truncated = _bounded(items, total)
    return SourceResult(
        _report(
            "pacman",
            SourceKind.OS_PACKAGE,
            started,
            items=len(items),
            total=total,
            truncated=truncated,
            detail=f"{len(explicit)} explicitly installed",
        ),
        items,
    )


def _dpkg(started: float) -> SourceResult:
    binary = resolve_executable("dpkg-query") or resolve_executable("dpkg")
    if binary is None:
        return _unavailable("dpkg", SourceKind.OS_PACKAGE, started, "dpkg is not installed")
    status, stdout = _run(
        [binary, "-W", "-f=${Package}\\t${Version}\\t${Status}\\t${binary:Summary}\\n"]
    )
    if status is not ExecStatus.OK or not stdout.strip():
        status, stdout = _run([binary, "-l"])
        items = []
        for line in stdout.splitlines():
            if not line.startswith("ii"):
                continue
            parts = line.split()
            if len(parts) >= 3:
                items.append(_os_item("dpkg", parts[1], parts[2]))
        total = len(items)
        items, truncated = _bounded(items, total)
        return SourceResult(
            _report("dpkg", SourceKind.OS_PACKAGE, started, items=len(items), total=total, truncated=truncated),
            items,
        )

    items = []
    for line in stdout.splitlines():
        fields = line.split("\t")
        if len(fields) < 3 or "installed" not in fields[2]:
            continue
        items.append(_os_item("dpkg", fields[0], fields[1], fields[3] if len(fields) > 3 else ""))
    total = len(items)
    items, truncated = _bounded(items, total)
    return SourceResult(
        _report("dpkg", SourceKind.OS_PACKAGE, started, items=len(items), total=total, truncated=truncated),
        items,
    )


def _rpm(started: float) -> SourceResult:
    binary = resolve_executable("rpm")
    if binary is None:
        return _unavailable("rpm", SourceKind.OS_PACKAGE, started, "rpm is not installed")
    status, stdout = _run(
        [binary, "-qa", "--qf", "%{NAME}\\t%{VERSION}-%{RELEASE}\\t%{SUMMARY}\\n"]
    )
    if status is not ExecStatus.OK:
        return SourceResult(
            _report("rpm", SourceKind.OS_PACKAGE, started, available=True, error="rpm -qa failed")
        )
    items = []
    for line in stdout.splitlines():
        fields = line.split("\t")
        if not fields or not fields[0].strip():
            continue
        items.append(
            _os_item("rpm", fields[0], fields[1] if len(fields) > 1 else None, fields[2] if len(fields) > 2 else "")
        )
    total = len(items)
    items, truncated = _bounded(items, total)
    return SourceResult(
        _report("rpm", SourceKind.OS_PACKAGE, started, items=len(items), total=total, truncated=truncated),
        items,
    )


def _apk(started: float) -> SourceResult:
    binary = resolve_executable("apk")
    if binary is None:
        return _unavailable("apk", SourceKind.OS_PACKAGE, started, "apk is not installed")
    status, stdout = _run([binary, "list", "--installed"])
    if status is not ExecStatus.OK:
        return SourceResult(
            _report("apk", SourceKind.OS_PACKAGE, started, available=True, error="apk list failed")
        )
    items = []
    for line in stdout.splitlines():
        head = line.split()[0] if line.split() else ""
        if not head or "-" not in head:
            continue
        name, _, version = head.rpartition("-")
        name = name.rpartition("-")[0] or name
        items.append(_os_item("apk", name, version))
    total = len(items)
    items, truncated = _bounded(items, total)
    return SourceResult(
        _report("apk", SourceKind.OS_PACKAGE, started, items=len(items), total=total, truncated=truncated),
        items,
    )


def _flatpak(started: float) -> SourceResult:
    binary = resolve_executable("flatpak")
    if binary is None:
        return _unavailable("flatpak", SourceKind.APPLICATION, started, "flatpak is not installed")
    status, stdout = _run(
        [binary, "list", "--app", "--columns=application,name,version,origin"]
    )
    if status is not ExecStatus.OK:
        return SourceResult(
            _report("flatpak", SourceKind.APPLICATION, started, available=True, error="flatpak list failed")
        )
    items = []
    for line in stdout.splitlines():
        fields = [f.strip() for f in line.split("\t")]
        if not fields or not fields[0]:
            continue
        app_id = fields[0]
        item = InventoryItem(
            key=app_key(app_id),
            name=fields[1] if len(fields) > 1 and fields[1] else app_id,
            display_name=fields[1] if len(fields) > 1 and fields[1] else app_id,
            kind=ItemKind.APPLICATION,
            category="application",
            package_manager="flatpak",
            package_name=app_id,
            package_version=fields[2] if len(fields) > 2 else None,
            publisher=fields[3] if len(fields) > 3 else None,
            installed=True,
            detected=True,
        )
        item.keys.add(app_key(app_id))
        item.add_evidence(
            Evidence(
                source="flatpak",
                kind=SourceKind.APPLICATION,
                package=app_id,
                version=fields[2] if len(fields) > 2 else None,
                detail="installed as a Flatpak application",
            )
        )
        items.append(item)
    total = len(items)
    items, truncated = _bounded(items, total)
    return SourceResult(
        _report("flatpak", SourceKind.APPLICATION, started, items=len(items), total=total, truncated=truncated),
        items,
    )


def _snap(started: float) -> SourceResult:
    binary = resolve_executable("snap")
    if binary is None:
        return _unavailable("snap", SourceKind.APPLICATION, started, "snap is not installed")
    status, stdout = _run([binary, "list"])
    if status is not ExecStatus.OK:
        return SourceResult(
            _report("snap", SourceKind.APPLICATION, started, available=True, error="snap list failed")
        )
    items = []
    for index, line in enumerate(stdout.splitlines()):
        if index == 0 or not line.strip():
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        name = parts[0]
        item = InventoryItem(
            key=package_key("snap", name),
            name=name,
            display_name=name,
            kind=ItemKind.APPLICATION,
            category="application",
            package_manager="snap",
            package_name=name,
            package_version=parts[1],
            publisher=parts[4] if len(parts) > 4 else None,
            installed=True,
            detected=True,
        )
        item.keys.add(package_key("snap", name))
        item.add_evidence(
            Evidence(
                source="snap",
                kind=SourceKind.APPLICATION,
                package=name,
                version=parts[1],
                detail="installed as a snap",
            )
        )
        items.append(item)
    total = len(items)
    items, truncated = _bounded(items, total)
    return SourceResult(
        _report("snap", SourceKind.APPLICATION, started, items=len(items), total=total, truncated=truncated),
        items,
    )


# ── language package managers ───────────────────────────────────────────


def _language_item(
    manager: str,
    name: str,
    version: str | None,
    *,
    kind: ItemKind = ItemKind.PACKAGE,
    category: str = "development",
    location: str | None = None,
) -> InventoryItem:
    item = InventoryItem(
        key=package_key(manager, name),
        name=name,
        display_name=name,
        kind=kind,
        category=category,
        package_manager=manager,
        package_name=name,
        package_version=version,
        install_location=location,
        installed=True,
        detected=True,
    )
    item.keys.add(package_key(manager, name))
    item.add_evidence(
        Evidence(
            source=manager,
            kind=SourceKind.LANGUAGE_PACKAGE,
            package=name,
            version=version,
            location=location,
            detail=f"installed by {manager}",
        )
    )
    return item


def _npm_global(started: float) -> SourceResult:
    """Read npm's global tree from disk.

    ``npm list -g`` exits non-zero for ordinary conditions and costs a Node
    start-up. The directory layout is the authority, and reading it also
    yields each package's declared commands, which is what lets a PATH entry
    be attributed to its package without running anything.
    """
    from ..provenance import npm_global_prefix

    prefix = npm_global_prefix()
    if prefix is None:
        return _unavailable("npm", SourceKind.LANGUAGE_PACKAGE, started, "npm is not installed")
    root = prefix / "lib" / "node_modules"
    if not root.is_dir():
        root = prefix / "node_modules"
    if not root.is_dir():
        return _unavailable(
            "npm", SourceKind.LANGUAGE_PACKAGE, started, f"no global node_modules under {prefix}"
        )

    package_dirs: list[Path] = []
    try:
        for entry in sorted(root.iterdir()):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            if entry.name.startswith("@"):
                package_dirs.extend(sorted(p for p in entry.iterdir() if p.is_dir()))
            else:
                package_dirs.append(entry)
    except OSError as exc:
        return SourceResult(
            _report("npm", SourceKind.LANGUAGE_PACKAGE, started, available=True, error=str(exc))
        )

    items: list[InventoryItem] = []
    for directory in package_dirs:
        manifest = _read_json(directory / "package.json")
        name = manifest.get("name") if isinstance(manifest.get("name"), str) else directory.name
        version = manifest.get("version") if isinstance(manifest.get("version"), str) else None
        item = _language_item(
            "npm",
            str(name)[:200],
            str(version)[:64] if version else None,
            location=str(directory),
        )
        description = manifest.get("description")
        if isinstance(description, str):
            item.description = description[:300]
        bins = manifest.get("bin")
        if isinstance(bins, str):
            item.provides.add(str(name).split("/")[-1])
        elif isinstance(bins, dict):
            item.provides.update(str(key)[:128] for key in list(bins)[:64])
        item.kind = ItemKind.CLI if item.provides else ItemKind.LIBRARY
        items.append(item)

    total = len(items)
    items, truncated = _bounded(items, total)
    return SourceResult(
        _report(
            "npm",
            SourceKind.LANGUAGE_PACKAGE,
            started,
            items=len(items),
            total=total,
            truncated=truncated,
            detail=f"global prefix {prefix}",
        ),
        items,
    )


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _pip(started: float) -> SourceResult:
    binary = resolve_executable("pip3") or resolve_executable("pip")
    if binary is None:
        return _unavailable("pip", SourceKind.LANGUAGE_PACKAGE, started, "pip is not installed")
    status, stdout = _run([binary, "list", "--format=json", "--disable-pip-version-check"])
    if status is not ExecStatus.OK or not stdout.strip():
        return SourceResult(
            _report("pip", SourceKind.LANGUAGE_PACKAGE, started, available=True, error="pip list failed")
        )
    try:
        records = json.loads(stdout)
    except ValueError:
        return SourceResult(
            _report("pip", SourceKind.LANGUAGE_PACKAGE, started, available=True, error="pip returned invalid JSON")
        )
    items = []
    for record in records if isinstance(records, list) else []:
        if not isinstance(record, dict):
            continue
        name = str(record.get("name", ""))[:200]
        if not name:
            continue
        item = _language_item("pip", name, str(record.get("version"))[:64] if record.get("version") else None)
        item.kind = ItemKind.LIBRARY
        items.append(item)
    total = len(items)
    items, truncated = _bounded(items, total)
    return SourceResult(
        _report("pip", SourceKind.LANGUAGE_PACKAGE, started, items=len(items), total=total, truncated=truncated),
        items,
    )


def _pipx(started: float) -> SourceResult:
    binary = resolve_executable("pipx")
    if binary is None:
        return _unavailable("pipx", SourceKind.LANGUAGE_PACKAGE, started, "pipx is not installed")
    _status, stdout = _run([binary, "list", "--json"])
    try:
        data = json.loads(stdout)
    except ValueError:
        return SourceResult(
            _report("pipx", SourceKind.LANGUAGE_PACKAGE, started, available=True, error="pipx returned no JSON")
        )
    venvs = data.get("venvs") if isinstance(data, dict) else None
    if not isinstance(venvs, dict):
        return SourceResult(
            _report("pipx", SourceKind.LANGUAGE_PACKAGE, started, available=True, error="unfamiliar pipx output")
        )
    items = []
    for package, info in venvs.items():
        meta = info.get("metadata") if isinstance(info, dict) else {}
        main = meta.get("main_package") if isinstance(meta, dict) else {}
        version = main.get("package_version") if isinstance(main, dict) else None
        item = _language_item("pipx", str(package)[:200], str(version)[:64] if version else None, kind=ItemKind.CLI)
        if isinstance(main, dict):
            for raw in main.get("app_paths") or []:
                path = raw.get("__Path__") if isinstance(raw, dict) else raw
                if isinstance(path, str):
                    item.provides.add(os.path.basename(path))
                    item.keys.add(path_key(real_target(path)))
            for app in main.get("apps") or []:
                if isinstance(app, str):
                    item.provides.add(app)
        items.append(item)
    total = len(items)
    items, truncated = _bounded(items, total)
    return SourceResult(
        _report("pipx", SourceKind.LANGUAGE_PACKAGE, started, items=len(items), total=total, truncated=truncated),
        items,
    )


def _uv(started: float) -> SourceResult:
    """uv's tools and the interpreters it manages, read from its own tree."""
    from ..provenance import uv_data_dir, uv_tool_dir

    tool_dir = uv_tool_dir()
    python_dir = uv_data_dir() / "python"
    if not tool_dir.is_dir() and not python_dir.is_dir():
        return _unavailable("uv", SourceKind.LANGUAGE_PACKAGE, started, "uv is not installed")

    items: list[InventoryItem] = []
    if tool_dir.is_dir():
        try:
            for entry in sorted(tool_dir.iterdir()):
                if not entry.is_dir():
                    continue
                item = _language_item("uv", entry.name, None, kind=ItemKind.CLI, location=str(entry))
                bin_dir = entry / ("Scripts" if is_windows() else "bin")
                if bin_dir.is_dir():
                    for command in sorted(bin_dir.iterdir())[:64]:
                        item.provides.add(command.name)
                items.append(item)
        except OSError:
            pass

    if python_dir.is_dir():
        try:
            for entry in sorted(python_dir.iterdir()):
                if not entry.is_dir():
                    continue
                # cpython-3.14.5-linux-x86_64-gnu
                parts = entry.name.split("-")
                version = parts[1] if len(parts) > 1 else None
                item = _language_item(
                    "uv",
                    f"python {version}" if version else entry.name,
                    version,
                    kind=ItemKind.RUNTIME,
                    category="development",
                    location=str(entry),
                )
                item.display_name = f"Python {version}" if version else entry.name
                items.append(item)
        except OSError:
            pass

    total = len(items)
    items, truncated = _bounded(items, total)
    return SourceResult(
        _report("uv", SourceKind.LANGUAGE_PACKAGE, started, items=len(items), total=total, truncated=truncated),
        items,
    )


def _cargo(started: float) -> SourceResult:
    binary = resolve_executable("cargo")
    if binary is None:
        return _unavailable("cargo", SourceKind.LANGUAGE_PACKAGE, started, "cargo is not installed")
    status, stdout = _run([binary, "install", "--list"])
    if status is not ExecStatus.OK:
        return SourceResult(
            _report("cargo", SourceKind.LANGUAGE_PACKAGE, started, available=True, error="cargo install --list failed")
        )
    items: list[InventoryItem] = []
    current: InventoryItem | None = None
    for line in stdout.splitlines():
        if not line.strip():
            continue
        if line[0].isspace():
            if current is not None:
                current.provides.add(line.strip())
            continue
        head = line.strip().rstrip(":").split()
        if not head:
            continue
        current = _language_item(
            "cargo",
            head[0],
            head[1].lstrip("v") if len(head) > 1 else None,
            kind=ItemKind.CLI,
        )
        items.append(current)
    total = len(items)
    items, truncated = _bounded(items, total)
    return SourceResult(
        _report("cargo", SourceKind.LANGUAGE_PACKAGE, started, items=len(items), total=total, truncated=truncated),
        items,
    )


def _homebrew(started: float) -> SourceResult:
    binary = resolve_executable("brew")
    if binary is None:
        return _unavailable("brew", SourceKind.OS_PACKAGE, started, "Homebrew is not installed")
    items: list[InventoryItem] = []
    status, stdout = _run([binary, "list", "--formula", "--versions"])
    if status is ExecStatus.OK:
        for line in stdout.splitlines():
            parts = line.split()
            if parts:
                items.append(_os_item("brew", parts[0], parts[1] if len(parts) > 1 else None))
    cask_status, cask_out = _run([binary, "list", "--cask", "--versions"])
    if cask_status is ExecStatus.OK:
        for line in cask_out.splitlines():
            parts = line.split()
            if not parts:
                continue
            item = _os_item("brew-cask", parts[0], parts[1] if len(parts) > 1 else None)
            item.kind = ItemKind.APPLICATION
            item.category = "application"
            items.append(item)
    total = len(items)
    items, truncated = _bounded(items, total)
    return SourceResult(
        _report("brew", SourceKind.OS_PACKAGE, started, items=len(items), total=total, truncated=truncated),
        items,
    )


# ── applications ────────────────────────────────────────────────────────


def _desktop_entries(started: float) -> SourceResult:
    """Linux GUI applications, from freedesktop .desktop metadata.

    The manifest names the application, its command and its categories, so a
    GUI application is inventoried without launching it.
    """
    roots = [
        Path("/usr/share/applications"),
        Path("/usr/local/share/applications"),
        Path("/var/lib/flatpak/exports/share/applications"),
        home_dir() / ".local/share/applications",
        Path("/var/lib/snapd/desktop/applications"),
    ]
    present = [root for root in roots if root.is_dir()]
    if not present:
        return _unavailable(
            "desktop", SourceKind.APPLICATION, started, "no freedesktop application directories"
        )

    items: list[InventoryItem] = []
    total = 0
    excluded = 0
    for root in present:
        try:
            entries = sorted(root.glob("*.desktop"))[:MAX_DIR_ENTRIES]
        except OSError:
            continue
        for entry in entries:
            total += 1
            parsed = _parse_desktop_entry(entry)
            if parsed is None:
                excluded += 1
                continue
            items.append(parsed)

    unique = len(items)
    items, truncated = _bounded(items, unique)
    where = f"{len(present)} application director{'y' if len(present) == 1 else 'ies'}"
    # `total` counts the files read; the gap between it and `items` is not
    # a silent loss, so the reason is stated rather than left to inference.
    reason = (
        f"; {excluded} entr{'y' if excluded == 1 else 'ies'} are hidden, NoDisplay "
        "or not applications"
        if excluded
        else ""
    )
    return SourceResult(
        _report(
            "desktop",
            SourceKind.APPLICATION,
            started,
            items=len(items),
            total=total,
            truncated=truncated,
            detail=f"{where}{reason}",
        ),
        items,
    )


def _parse_desktop_entry(path: Path) -> InventoryItem | None:
    parser = configparser.RawConfigParser(strict=False, interpolation=None)
    try:
        parser.read_string(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, configparser.Error):
        return None
    if not parser.has_section("Desktop Entry"):
        return None
    section = parser["Desktop Entry"]
    if section.get("Type", "Application") != "Application":
        return None
    if section.get("NoDisplay", "false").strip().lower() == "true":
        return None
    if section.get("Hidden", "false").strip().lower() == "true":
        return None

    identifier = path.stem
    name = (section.get("Name") or identifier).strip()[:200]
    executable = _desktop_exec(section.get("TryExec") or section.get("Exec") or "")
    if executable and _is_launcher(executable):
        executable = None
    command_name = os.path.basename(executable) if executable else None

    item = InventoryItem(
        key=app_key(identifier),
        name=name,
        display_name=name,
        kind=ItemKind.APPLICATION,
        category="application",
        description=(section.get("Comment") or "").strip()[:300] or None,
        install_location=str(path),
        command=command_name,
        installed=True,
        detected=True,
    )
    item.keys.add(app_key(identifier))
    if command_name:
        item.provides.add(command_name)
    if executable and os.path.isabs(executable):
        # The file the entry points at is a stronger identity than its name,
        # and links a launcher to the AppImage or binary it actually starts.
        item.executable_path = executable
        item.keys.add(path_key(real_target(executable)))
    item.add_evidence(
        Evidence(
            source="desktop",
            kind=SourceKind.APPLICATION,
            package=identifier,
            location=str(path),
            detail="declared by a freedesktop application entry",
        )
    )
    return item


#: Field codes a desktop entry may carry (%U, %f, ...). They are arguments
#: for the launcher, not part of the command.
_DESKTOP_FIELD_CODES = re.compile(r"%[fFuUdDnNickvm]")

#: Programs that run *other* programs. When a desktop entry's Exec is one of
#: these, the real application is inside its arguments and cannot be read out
#: reliably, so the entry contributes no command or file identity at all.
#:
#: This matters more than it looks: `scrcpy.desktop` runs `/bin/sh -c ...`,
#: and on this distribution `/bin/sh` resolves to `/usr/bin/bash`. Taking
#: that as the application's identity folded the entire bash package into
#: scrcpy — two unrelated things merged because one launched the other.
_LAUNCHERS = frozenset(
    {
        "sh", "bash", "dash", "zsh", "fish", "ksh", "csh", "tcsh",
        "env", "sudo", "pkexec", "doas", "nohup", "setsid", "systemd-run",
        "python", "python2", "python3", "perl", "ruby", "node", "java",
        "flatpak", "snap", "xdg-open", "gtk-launch", "gio", "kioclient",
        "wine", "steam", "proot", "bwrap", "firejail",
    }
)


def _is_launcher(executable: str) -> bool:
    """True when this program starts something else rather than being it."""
    name = os.path.basename(executable).lower()
    if name in _LAUNCHERS:
        return True
    # `/bin/sh` is a symlink to whatever the distribution uses; judge the
    # file it actually resolves to as well as the name that was written.
    return os.path.basename(real_target(executable)).lower() in _LAUNCHERS


def _desktop_exec(value: str) -> str | None:
    """The program a desktop entry starts.

    ``Exec`` is shell-quoted, so a path containing spaces arrives in quotes
    and a naive split yields ``ZCode.AppImage"`` — a command that matches
    nothing. Field codes are stripped first because they are arguments.
    """
    cleaned = _DESKTOP_FIELD_CODES.sub("", value).strip()
    if not cleaned:
        return None
    try:
        parts = shlex.split(cleaned)
    except ValueError:
        parts = cleaned.split()
    if not parts:
        return None
    # `env FOO=bar prog` and similar wrappers name the real program later.
    index = 0
    while index < len(parts) - 1 and (parts[index] in ("env", "/usr/bin/env") or "=" in parts[index]):
        index += 1
    return parts[index]


def _macos_applications(started: float) -> SourceResult:
    """macOS ``.app`` bundles, read from their Info.plist.

    MOCK VERIFIED only — see tests/unit/test_inventory_cross_platform.py.
    """
    roots = [Path("/Applications"), home_dir() / "Applications", Path("/System/Applications")]
    present = [root for root in roots if root.is_dir()]
    if not present:
        return _unavailable("macos-apps", SourceKind.APPLICATION, started, "no application folders")

    items: list[InventoryItem] = []
    total = 0
    for root in present:
        try:
            bundles = sorted(root.glob("*.app"))[:MAX_DIR_ENTRIES]
        except OSError:
            continue
        for bundle in bundles:
            total += 1
            info = _read_plist(bundle / "Contents" / "Info.plist")
            identifier = info.get("CFBundleIdentifier") or bundle.stem
            name = info.get("CFBundleDisplayName") or info.get("CFBundleName") or bundle.stem
            version = info.get("CFBundleShortVersionString") or info.get("CFBundleVersion")
            item = InventoryItem(
                key=app_key(str(identifier)),
                name=str(name)[:200],
                display_name=str(name)[:200],
                kind=ItemKind.APPLICATION,
                category="application",
                install_location=str(bundle),
                package_name=str(identifier),
                installed=True,
                detected=True,
            )
            item.keys.add(app_key(str(identifier)))
            if version:
                item.add_evidence(
                    Evidence(
                        source="macos-apps",
                        kind=SourceKind.APPLICATION,
                        package=str(identifier),
                        version=str(version)[:64],
                        location=str(bundle),
                        detail="application bundle metadata",
                    )
                )
            else:
                item.add_evidence(
                    Evidence(
                        source="macos-apps",
                        kind=SourceKind.APPLICATION,
                        package=str(identifier),
                        location=str(bundle),
                        detail="application bundle",
                    )
                )
            items.append(item)

    unique = len(items)
    items, truncated = _bounded(items, unique)
    return SourceResult(
        _report("macos-apps", SourceKind.APPLICATION, started, items=len(items), total=total, truncated=truncated),
        items,
    )


def _read_plist(path: Path) -> dict:
    """Read an Info.plist without shelling out to `defaults`."""
    try:
        import plistlib

        with open(path, "rb") as handle:
            data = plistlib.load(handle)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _appimages(started: float) -> SourceResult:
    """AppImages in the places people keep them. Identified, never run."""
    roots = [
        home_dir() / "Applications",
        home_dir() / ".local/bin",
        home_dir() / ".local/lib",
        home_dir() / "Downloads",
        Path("/opt"),
    ]
    present = [root for root in roots if root.is_dir()]
    if not present:
        return _unavailable("appimage", SourceKind.APPLICATION, started, "no AppImage locations")

    items: list[InventoryItem] = []
    for root in present:
        try:
            entries = sorted(root.iterdir())[:MAX_DIR_ENTRIES]
        except OSError:
            continue
        for entry in entries:
            if not entry.name.lower().endswith(".appimage"):
                continue
            try:
                if not entry.is_file():
                    continue
            except OSError:
                continue
            name = entry.stem
            item = InventoryItem(
                key=path_key(real_target(entry)),
                name=name[:200],
                display_name=name[:200],
                kind=ItemKind.APPLICATION,
                category="application",
                install_location=str(entry),
                executable_path=str(entry),
                installed=True,
                detected=True,
                trust_level=TrustLevel.UNTRUSTED,
                trust_reason="a self-contained AppImage: inventoried, never executed",
            )
            item.keys.add(path_key(real_target(entry)))
            item.add_evidence(
                Evidence(
                    source="appimage",
                    kind=SourceKind.APPLICATION,
                    location=str(entry),
                    detail="AppImage bundle on disk",
                )
            )
            items.append(item)

    total = len(items)
    items, truncated = _bounded(items, total)
    return SourceResult(
        _report("appimage", SourceKind.APPLICATION, started, items=len(items), total=total, truncated=truncated),
        items,
    )


# ── Windows ─────────────────────────────────────────────────────────────


def _windows_registry(started: float) -> SourceResult:
    """Installed programs, from the Windows uninstall registry.

    MOCK VERIFIED only — no Windows machine ran this.
    """
    try:
        import winreg  # type: ignore[import-not-found]
    except ImportError:
        return _unavailable(
            "windows-registry", SourceKind.OS_PACKAGE, started, "not running on Windows"
        )

    roots = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]
    items: list[InventoryItem] = []
    for hive, subkey in roots:
        try:
            with winreg.OpenKey(hive, subkey) as handle:
                count = winreg.QueryInfoKey(handle)[0]
                for index in range(min(count, MAX_ITEMS_PER_SOURCE)):
                    try:
                        name = winreg.EnumKey(handle, index)
                        with winreg.OpenKey(handle, name) as entry:
                            values = _registry_values(winreg, entry)
                    except OSError:
                        continue
                    display = values.get("DisplayName")
                    if not display:
                        continue
                    item = InventoryItem(
                        key=app_key(str(values.get("BundleIdentifier") or name)),
                        name=str(display)[:200],
                        display_name=str(display)[:200],
                        kind=ItemKind.APPLICATION,
                        category="application",
                        package_manager="windows",
                        package_name=name,
                        package_version=str(values.get("DisplayVersion"))[:64] if values.get("DisplayVersion") else None,
                        publisher=str(values.get("Publisher"))[:200] if values.get("Publisher") else None,
                        install_location=str(values.get("InstallLocation")) if values.get("InstallLocation") else None,
                        installed=True,
                        detected=True,
                    )
                    item.keys.add(app_key(str(values.get("BundleIdentifier") or name)))
                    item.add_evidence(
                        Evidence(
                            source="windows-registry",
                            kind=SourceKind.OS_PACKAGE,
                            package=name,
                            version=item.package_version,
                            location=item.install_location,
                            detail="listed in the Windows uninstall registry",
                        )
                    )
                    items.append(item)
        except OSError:
            continue

    total = len(items)
    items, truncated = _bounded(items, total)
    return SourceResult(
        _report(
            "windows-registry",
            SourceKind.OS_PACKAGE,
            started,
            items=len(items),
            total=total,
            truncated=truncated,
        ),
        items,
    )


def _registry_values(winreg, entry) -> dict:
    values: dict = {}
    try:
        count = winreg.QueryInfoKey(entry)[1]
    except OSError:
        return values
    for index in range(min(count, 64)):
        try:
            name, value, _ = winreg.EnumValue(entry, index)
        except OSError:
            break
        values[name] = value
    return values


def _windows_table_manager(
    name: str, argv: list[str], started: float, kind: SourceKind = SourceKind.OS_PACKAGE
) -> SourceResult:
    binary = resolve_executable(argv[0])
    if binary is None:
        return _unavailable(name, kind, started, f"{argv[0]} is not installed")
    status, stdout = _run([binary, *argv[1:]])
    if status is not ExecStatus.OK or not stdout.strip():
        return SourceResult(_report(name, kind, started, available=True, error=f"{name} listed nothing"))
    items = []
    for line in stdout.splitlines():
        stripped = line.strip()
        if not stripped or set(stripped) <= set("-_= "):
            continue
        parts = stripped.replace("|", " ").split()
        if not parts or parts[0].lower() in ("name", "installed"):
            continue
        item = _os_item(name, parts[0][:200], parts[1][:64] if len(parts) > 1 else None)
        item.kind = ItemKind.APPLICATION
        item.category = "application"
        items.append(item)
    total = len(items)
    items, truncated = _bounded(items, total)
    return SourceResult(
        _report(name, kind, started, items=len(items), total=total, truncated=truncated), items
    )


def _appx(started: float) -> SourceResult:
    """Windows Store / MSIX packages. MOCK VERIFIED only."""
    if not is_windows():
        return _unavailable("appx", SourceKind.APPLICATION, started, "not running on Windows")
    root = os.environ.get("LOCALAPPDATA")
    if not root:
        return _unavailable("appx", SourceKind.APPLICATION, started, "no LOCALAPPDATA")
    packages = Path(root) / "Packages"
    if not packages.is_dir():
        return _unavailable("appx", SourceKind.APPLICATION, started, "no AppX package directory")
    items = []
    try:
        entries = sorted(packages.iterdir())[:MAX_DIR_ENTRIES]
    except OSError as exc:
        return SourceResult(_report("appx", SourceKind.APPLICATION, started, available=True, error=str(exc)))
    for entry in entries:
        if not entry.is_dir():
            continue
        family = entry.name
        name = family.split("_")[0]
        item = InventoryItem(
            key=app_key(family),
            name=name[:200],
            display_name=name[:200],
            kind=ItemKind.APPLICATION,
            category="application",
            package_manager="appx",
            package_name=family,
            install_location=str(entry),
            installed=True,
            detected=True,
        )
        item.keys.add(app_key(family))
        item.add_evidence(
            Evidence(
                source="appx",
                kind=SourceKind.APPLICATION,
                package=family,
                location=str(entry),
                detail="installed as a Windows Store package",
            )
        )
        items.append(item)
    total = len(items)
    items, truncated = _bounded(items, total)
    return SourceResult(
        _report("appx", SourceKind.APPLICATION, started, items=len(items), total=total, truncated=truncated),
        items,
    )


# ── version managers ────────────────────────────────────────────────────

_VERSION_MANAGERS: tuple[tuple[str, str, str], ...] = (
    ("pyenv", "~/.pyenv/versions", "Python"),
    ("nvm", "~/.nvm/versions/node", "Node.js"),
    ("fnm", "~/.local/share/fnm/node-versions", "Node.js"),
    ("volta", "~/.volta/tools/image/node", "Node.js"),
    ("rbenv", "~/.rbenv/versions", "Ruby"),
    ("asdf", "~/.asdf/installs", "runtime"),
    ("mise", "~/.local/share/mise/installs", "runtime"),
    ("sdkman", "~/.sdkman/candidates", "JVM"),
    ("rustup", "~/.rustup/toolchains", "Rust"),
)


def _version_managers(started: float) -> SourceResult:
    """Runtime families, not one card per shim.

    A version manager holds several builds of the same runtime. Listing each
    as separate software would bury the machine in near-duplicates; the
    useful statement is "Python, managed by pyenv, these versions installed,
    this one active".
    """
    items: list[InventoryItem] = []
    found_any = False
    for manager, pattern, family in _VERSION_MANAGERS:
        root = Path(os.path.expanduser(pattern))
        if not root.is_dir():
            continue
        found_any = True
        try:
            versions = sorted(entry.name for entry in root.iterdir() if entry.is_dir())
        except OSError:
            continue
        if not versions:
            continue
        item = InventoryItem(
            key=f"vm:{manager}:{family}".lower(),
            name=f"{family} ({manager})",
            display_name=f"{family} — {manager}",
            kind=ItemKind.RUNTIME,
            category="development",
            package_manager=manager,
            install_location=str(root),
            description=f"{len(versions)} version(s) managed by {manager}",
            installed=True,
            detected=True,
        )
        item.keys.add(f"vm:{manager}:{family}".lower())
        for version in versions[:64]:
            item.add_evidence(
                Evidence(
                    source=manager,
                    kind=SourceKind.VERSION_MANAGER,
                    package=family,
                    version=version,
                    location=str(root / version),
                    detail=f"{family} {version} installed by {manager}",
                )
            )
        item.version = versions[-1]
        items.append(item)

    if not found_any:
        return _unavailable(
            "version-managers", SourceKind.VERSION_MANAGER, started, "no version managers installed"
        )
    return SourceResult(
        _report(
            "version-managers",
            SourceKind.VERSION_MANAGER,
            started,
            items=len(items),
            total=len(items),
        ),
        items,
    )


# ── the registry ────────────────────────────────────────────────────────

SourceFn = Callable[[float], SourceResult]


def _platform_sources() -> list[tuple[str, SourceFn]]:
    """Which sources are worth asking on this platform."""
    common: list[tuple[str, SourceFn]] = [
        ("npm", _npm_global),
        ("pip", _pip),
        ("pipx", _pipx),
        ("uv", _uv),
        ("cargo", _cargo),
        ("version-managers", _version_managers),
    ]
    if is_windows():
        return [
            ("windows-registry", _windows_registry),
            ("appx", _appx),
            ("winget", lambda s: _windows_table_manager("winget", ["winget", "list", "--disable-interactivity"], s)),
            ("choco", lambda s: _windows_table_manager("choco", ["choco", "list", "--local-only", "--limit-output"], s)),
            ("scoop", lambda s: _windows_table_manager("scoop", ["scoop", "list"], s)),
            *common,
        ]
    if is_macos():
        return [
            ("macos-apps", _macos_applications),
            ("brew", _homebrew),
            *common,
        ]
    return [
        ("pacman", _pacman),
        ("dpkg", _dpkg),
        ("rpm", _rpm),
        ("apk", _apk),
        ("flatpak", _flatpak),
        ("snap", _snap),
        ("desktop", _desktop_entries),
        ("appimage", _appimages),
        *common,
    ]


def collect_sources(only: Iterable[str] | None = None) -> list[SourceResult]:
    """Ask every applicable source what is installed.

    One source failing never stops the others: a corrupted database or a
    hung manager becomes an unavailable source with a reason, and the rest
    of the inventory is still produced.
    """
    wanted = set(only) if only else None
    results: list[SourceResult] = []
    for name, source in _platform_sources():
        if wanted is not None and name not in wanted:
            continue
        started = time.monotonic()
        try:
            results.append(source(started))
        except Exception as exc:
            results.append(
                SourceResult(
                    _report(name, SourceKind.OS_PACKAGE, started, available=False, error=redact(str(exc)))
                )
            )
    return results


# ── PATH enumeration and package↔command attribution ────────────────────


def _skip_reason(directory: str) -> str | None:
    posix = os.path.normcase(os.path.normpath(directory)).replace("\\", "/") + "/"
    for marker in ("/.pyenv/", "/.rbenv/", "/.nodenv/", "/.asdf/", "/.nvm/versions/", "/.rustup/toolchains/"):
        if marker in posix:
            return "a version-manager tree, inventoried as a runtime family instead"
    if os.path.normcase(os.path.normpath(directory)) in self_runtime_dirs():
        return "the Python environment AURA itself is running in"
    return None


def enumerate_path(index: InventoryIndex, path: str | None = None) -> SourceResult:
    """Every command the machine can actually run, attributed where possible.

    This is the source that makes the inventory an engineer's inventory: it
    is what ``$PATH`` would find, in the order it would find it. Commands
    already claimed by a package become that package's evidence rather than
    a separate item, so ``/usr/bin/git`` joins the ``git`` package instead of
    doubling it.
    """
    started = time.monotonic()
    search = path if path is not None else effective_path()
    seen_dirs: set[str] = set()
    skipped: list[str] = []
    scanned = 0
    total_files = 0
    not_programs = 0
    shadowed = 0
    by_command: dict[str, InventoryItem] = {}
    unowned: list[InventoryItem] = []

    for raw in search.split(path_sep()):
        if not raw:
            continue
        directory = os.path.normpath(os.path.expanduser(raw))
        # Deduplicate by the directory the path actually resolves to. On a
        # usr-merged distribution `/bin`, `/sbin` and `/usr/sbin` are all
        # symlinks to `/usr/bin`, so a naive name comparison enumerates the
        # same 2,900 files four times over.
        key = os.path.normcase(real_target(directory))
        if key in seen_dirs:
            continue
        seen_dirs.add(key)
        reason = _skip_reason(directory)
        if reason:
            skipped.append(f"{directory}: {reason}")
            continue
        if not os.path.isdir(directory):
            continue
        scanned += 1

        try:
            entries = sorted(os.scandir(directory), key=lambda e: e.name)
        except OSError:
            continue

        for entry in entries[:MAX_DIR_ENTRIES]:
            total_files += 1
            command = _command_name(entry.name)
            if not command or not _is_program(entry):
                not_programs += 1
                continue

            existing = by_command.get(command)
            if existing is not None:
                # Same name later on PATH: it exists, but can never run.
                if entry.path not in existing.shadowed:
                    existing.shadowed.append(entry.path)
                shadowed += 1
                continue

            target = real_target(entry.path)
            owner = index.lookup(command_key(command)) or index.lookup(path_key(target))
            if owner is not None:
                # A package already claims this command; record where it is.
                owner.detected = True
                if not owner.executable_path:
                    owner.executable_path = entry.path
                owner.command = owner.command or command
                owner.keys.add(path_key(target))
                # The package told us it exists; PATH tells us whether it is
                # safe to run. Without this the item stays trust-unknown and
                # is never eligible for verification, so every npm-installed
                # tool stopped at `installed`.
                if owner.trust_level is TrustLevel.UNKNOWN:
                    verdict = location_trust(entry.path)
                    owner.trust_level = (
                        TrustLevel.TRUSTED
                        if verdict.trust is LocationTrust.TRUSTED
                        else TrustLevel.BLOCKED
                    )
                    owner.trust_reason = verdict.reason
                owner.add_evidence(
                    Evidence(
                        source="path",
                        kind=SourceKind.PATH,
                        location=entry.path,
                        detail=f"available as `{command}` on PATH",
                    )
                )
                by_command[command] = owner
                continue

            item = _path_item(command, entry.path, target)
            by_command[command] = item
            unowned.append(item)

    for item in unowned:
        index.add(item)

    # Every file examined is accounted for: a command, a shadowed duplicate
    # of one, or not a program at all. The arithmetic is stated so the gap
    # between "files seen" and "commands found" is never left to inference.
    detail = (
        f"{scanned} director{'y' if scanned == 1 else 'ies'} enumerated; "
        f"{total_files} entries examined = {len(by_command)} distinct commands "
        f"+ {shadowed} shadowed duplicates + {not_programs} not executable"
    )
    if skipped:
        detail += f"; {len(skipped)} director{'y' if len(skipped) == 1 else 'ies'} skipped"
    return SourceResult(
        _report(
            "path",
            SourceKind.PATH,
            started,
            items=len(by_command),
            total=total_files,
            detail=detail,
        ),
        unowned,
    )


def _command_name(filename: str) -> str:
    if filename.startswith("."):
        return ""
    if is_windows():
        stem, ext = os.path.splitext(filename)
        if ext.lower() in (".exe", ".cmd", ".bat", ".com", ".ps1"):
            return stem
    return filename


def _is_program(entry: os.DirEntry) -> bool:
    try:
        if not entry.is_file():
            return False
    except OSError:
        return False
    if is_windows():
        return True
    try:
        return os.access(entry.path, os.X_OK)
    except OSError:
        return False


def _path_item(command: str, path: str, target: str) -> InventoryItem:
    verdict = location_trust(path)
    item = InventoryItem(
        key=path_key(target),
        name=command,
        display_name=command,
        kind=ItemKind.CLI,
        category="unknown",
        executable_path=path,
        install_location=os.path.dirname(path),
        command=command,
        installed=True,
        detected=True,
        trust_level=(
            TrustLevel.TRUSTED if verdict.trust is LocationTrust.TRUSTED else TrustLevel.BLOCKED
        ),
        trust_reason=verdict.reason,
    )
    item.keys.add(path_key(target))
    item.keys.add(command_key(command))
    item.provides.add(command)
    item.add_evidence(
        Evidence(
            source="path",
            kind=SourceKind.PATH,
            location=path,
            detail=f"found as `{command}` on PATH",
        )
    )
    return item


def attribute_system_commands(index: InventoryIndex, items: Iterable[InventoryItem]) -> int:
    """Ask the OS package manager which package owns each unattributed command.

    One batched query instead of one per file — a few hundred milliseconds
    for a few thousand binaries, and it turns ``/usr/bin/git`` into evidence
    for the ``git`` package rather than a card of its own. Nothing is
    executed to establish this.
    """
    # Applications count too: a desktop entry and the package that installed
    # it are one thing, and only the package knows the version. Restricting
    # this to CLIs left Chromium listed twice — once as an application, once
    # as a package.
    candidates = [
        item
        for item in items
        if item.executable_path and not item.package_manager
    ]
    if not candidates:
        return 0

    if is_windows() or is_macos():
        return 0

    pacman = resolve_executable("pacman")
    dpkg = resolve_executable("dpkg-query") or resolve_executable("dpkg")
    if pacman is None and dpkg is None:
        return 0

    attributed = 0
    paths = [item.executable_path for item in candidates if item.executable_path]
    by_path = {item.executable_path: item for item in candidates}

    for start in range(0, len(paths), OWNERSHIP_BATCH):
        batch = paths[start : start + OWNERSHIP_BATCH]
        if pacman is not None:
            status, stdout = _run([pacman, "-Qo", *batch], timeout_ms=SOURCE_TIMEOUT_MS)
            if status is not ExecStatus.OK and not stdout.strip():
                continue
            for line in stdout.splitlines():
                # "/usr/bin/git is owned by git 2.55.0-1"
                if " is owned by " not in line:
                    continue
                file_part, _, owner = line.partition(" is owned by ")
                owner_parts = owner.split()
                if not owner_parts:
                    continue
                item = by_path.get(file_part.strip())
                if item is None:
                    continue
                _attribute(index, item, "pacman", owner_parts[0], owner_parts[1] if len(owner_parts) > 1 else None)
                attributed += 1
        elif dpkg is not None:
            status, stdout = _run([dpkg, "-S", *batch], timeout_ms=SOURCE_TIMEOUT_MS)
            for line in stdout.splitlines():
                package, _, file_part = line.partition(": ")
                item = by_path.get(file_part.strip())
                if item is None or not package:
                    continue
                _attribute(index, item, "dpkg", package.split(":")[0], None)
                attributed += 1
    return attributed


def _attribute(
    index: InventoryIndex, item: InventoryItem, manager: str, package: str, version: str | None
) -> None:
    """Fold a PATH command into the package that owns it."""
    owner = index.lookup(package_key(manager, package))
    if owner is None:
        item.package_manager = manager
        item.package_name = package
        item.package_version = version
        item.keys.add(package_key(manager, package))
        item.add_evidence(
            Evidence(
                source=manager,
                kind=SourceKind.OS_PACKAGE,
                package=package,
                version=version,
                detail=f"owned by the {manager} package {package}",
            )
        )
        return

    owner.detected = True
    owner.command = owner.command or item.command
    if item.command and item.command != owner.name and item.command not in owner.aliases:
        owner.aliases.append(item.command)
    # A package installs several commands; the one worth leading with is the
    # one named after the package. Without this the `python` package can end
    # up presenting `/usr/bin/idle` as its executable.
    if _prefer_executable(owner, item):
        owner.executable_path = item.executable_path
        owner.command = item.command
    index.absorb(item, owner)


def _prefer_executable(owner: InventoryItem, candidate: InventoryItem) -> bool:
    if not candidate.executable_path:
        return False
    if not owner.executable_path:
        return True
    package = (owner.package_name or owner.name).lower()
    current = (owner.command or "").lower()
    offered = (candidate.command or "").lower()
    if current == package:
        return False
    if offered == package:
        return True
    # Otherwise prefer the command that reads as the package's own name.
    return offered.startswith(package) and not current.startswith(package)
