"""Read-only operating-system package inventory.

Bounded, but honest about it. The previous implementation returned the first
eighty lines of ``pacman -Q`` and labelled the result an inventory; because
that output is sorted, a machine with a thousand packages reported only the
ones beginning with "a". Here the ceiling is explicit — ``total``,
``returned`` and ``truncated`` always accompany the list — and the budget is
spent on packages the caller actually asked about before it is spent on the
alphabet.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, field
from typing import Any

from .pathsec import effective_path, home_dir, resolve_executable
from .procexec import ExecStatus, run_argv

OS_INVENTORY_TIMEOUT_MS = 8000
DEFAULT_LIMIT = 300


@dataclass
class OsPackage:
    manager: str
    package: str
    version: str | None = None


@dataclass
class OsInventory:
    manager: str | None = None
    packages: list[OsPackage] = field(default_factory=list)
    total: int = 0
    truncated: bool = False
    available: bool = True
    error: str = ""


def _run(argv: list[str]) -> tuple[ExecStatus, str]:
    outcome = run_argv(
        argv,
        timeout_ms=OS_INVENTORY_TIMEOUT_MS,
        cwd=str(home_dir()),
        path=effective_path(),
    )
    return outcome.status, outcome.stdout


def _parse_two_column(text: str, manager: str) -> list[OsPackage]:
    packages: list[OsPackage] = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            packages.append(OsPackage(manager, parts[0], parts[1]))
        elif parts:
            packages.append(OsPackage(manager, parts[0], None))
    return packages


def _parse_dpkg(text: str) -> list[OsPackage]:
    packages: list[OsPackage] = []
    for line in text.splitlines():
        if not line.startswith("ii"):
            continue
        parts = line.split()
        if len(parts) >= 3:
            packages.append(OsPackage("dpkg", parts[1], parts[2]))
    return packages


def _parse_rpm(text: str) -> list[OsPackage]:
    packages: list[OsPackage] = []
    for line in text.splitlines():
        if "\t" in line:
            name, _, version = line.partition("\t")
            packages.append(OsPackage("rpm", name.strip(), version.strip() or None))
    return packages


def _parse_headered_table(text: str, manager: str) -> list[OsPackage]:
    """winget/choco/scoop style tables: skip the header and rule lines."""
    packages: list[OsPackage] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or set(stripped) <= set("-_= "):
            continue
        parts = stripped.split()
        if parts[0].lower() in ("name", "installed"):
            continue
        packages.append(OsPackage(manager, parts[0], parts[1] if len(parts) > 1 else None))
    return packages


def _candidate_managers() -> list[tuple[str, list[str], Any]]:
    if sys.platform == "darwin":
        return [
            ("brew", ["brew", "list", "--versions"], lambda t: _parse_two_column(t, "brew")),
            ("port", ["port", "installed"], lambda t: _parse_two_column(t, "port")),
        ]
    if sys.platform == "win32":
        return [
            ("winget", ["winget", "list", "--disable-interactivity"],
             lambda t: _parse_headered_table(t, "winget")),
            ("choco", ["choco", "list", "--local-only", "--limit-output"],
             lambda t: _parse_two_column(t.replace("|", " "), "choco")),
            ("scoop", ["scoop", "list"], lambda t: _parse_headered_table(t, "scoop")),
        ]
    return [
        ("pacman", ["pacman", "-Q"], lambda t: _parse_two_column(t, "pacman")),
        ("dpkg", ["dpkg", "-l"], _parse_dpkg),
        ("rpm", ["rpm", "-qa", "--qf", "%{NAME}\\t%{VERSION}-%{RELEASE}\\n"], _parse_rpm),
        ("apk", ["apk", "list", "--installed"], lambda t: _parse_two_column(t, "apk")),
        ("flatpak", ["flatpak", "list", "--app", "--columns=application,version"],
         lambda t: _parse_two_column(t, "flatpak")),
        ("snap", ["snap", "list"], lambda t: _parse_headered_table(t, "snap")),
    ]


def discover_os_packages(
    *,
    limit: int = DEFAULT_LIMIT,
    of_interest: set[str] | None = None,
) -> OsInventory:
    """The first OS package manager that answers, bounded and self-describing.

    ``of_interest`` names the tools the caller cares about; those packages are
    kept first so a truncated inventory still answers "did the distribution
    install docker?" rather than listing three hundred packages beginning
    with "a".
    """
    interest = {name.lower() for name in (of_interest or set())}
    last_error = ""

    for manager, argv, parse in _candidate_managers():
        binary = resolve_executable(argv[0])
        if binary is None:
            continue
        status, stdout = _run([binary, *argv[1:]])
        if not stdout.strip():
            if status is not ExecStatus.OK:
                last_error = f"{manager} exited without output"
            continue
        try:
            packages = parse(stdout)
        except Exception as exc:
            last_error = f"{manager} output could not be parsed: {exc}"
            continue
        if not packages:
            continue

        total = len(packages)
        if interest and total > limit:
            relevant = [p for p in packages if _matches_interest(p.package, interest)]
            rest = [p for p in packages if not _matches_interest(p.package, interest)]
            packages = (relevant + rest)[:limit]
        else:
            packages = packages[:limit]

        return OsInventory(
            manager=manager,
            packages=packages,
            total=total,
            truncated=total > len(packages),
            available=True,
        )

    return OsInventory(
        manager=None,
        available=False,
        error=last_error or "no supported operating-system package manager answered",
    )


def _matches_interest(package: str, interest: set[str]) -> bool:
    lower = package.lower()
    if lower in interest:
        return True
    # Distributions decorate names (docker-ce, python3-requests, nodejs-lts).
    stem = lower.split(":")[0]
    return any(stem == name or stem.startswith(f"{name}-") or stem.endswith(f"-{name}") for name in interest)


def inventory_to_dict(inventory: OsInventory) -> dict[str, Any]:
    return {
        "manager": inventory.manager,
        "available": inventory.available,
        "returned": len(inventory.packages),
        "total": inventory.total,
        "truncated": inventory.truncated,
        "error": inventory.error or None,
    }


def packages_to_list(inventory: OsInventory) -> list[dict[str, Any]]:
    return [
        {"manager": p.manager, "package": p.package, "version": p.version}
        for p in inventory.packages
    ]
