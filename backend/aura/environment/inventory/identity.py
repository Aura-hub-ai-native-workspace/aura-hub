"""Turning many sources' accounts into one item per installed thing.

The same program is reported by PATH, by the package manager that installed
it, and sometimes by a desktop entry as well. Those are one thing seen three
ways, and the inventory must say so — while never merging two genuinely
different programs that happen to share a name.

Identity is therefore evidence, never resemblance:

``pkg:<manager>:<name>``   the package manager's own record
``path:<realpath>``        the file itself, symlinks resolved
``app:<id>``               a desktop entry or bundle identifier
``cmd:<name>``             a command name — the weakest, and used only
                           where a package *declares* it provides that
                           command, so `npx` joins npm because npm's
                           manifest says so, not because the names rhyme.

Merging is union-find over those keys: each item is registered under every
identity it answers to, and two items that share any identity become one.
That is linear in the number of keys, which matters — a hundred thousand
packages compared pairwise would never finish.
"""
from __future__ import annotations

import os

from .model import Evidence, InventoryItem, ItemKind, TrustLevel


def package_key(manager: str, package: str) -> str:
    return f"pkg:{manager}:{package}".lower()


def path_key(path: str) -> str:
    return f"path:{os.path.normcase(path)}"


def app_key(identifier: str) -> str:
    return f"app:{identifier}".lower()


def command_key(command: str) -> str:
    return f"cmd:{command}".lower()


#: Kinds ranked by how much they say about a thing. When two accounts merge,
#: the more specific classification wins over `unknown`/`package`.
_KIND_RANK = {
    ItemKind.APPLICATION: 0,
    ItemKind.RUNTIME: 1,
    ItemKind.SDK: 2,
    ItemKind.CLI: 3,
    ItemKind.LIBRARY: 4,
    ItemKind.PACKAGE: 5,
    ItemKind.UNKNOWN: 6,
}


class InventoryIndex:
    """Accumulates items from every source into one deduplicated set."""

    def __init__(self) -> None:
        self._by_key: dict[str, InventoryItem] = {}
        self._items: list[InventoryItem] = []
        #: Items folded into another one. Kept by identity rather than by
        #: clearing their keys, because an item with no keys resolves to
        #: itself and would reappear in the results.
        self._absorbed: set[int] = set()

    def add(self, item: InventoryItem) -> InventoryItem:
        """Add an account, merging it into an existing item when they match."""
        existing = None
        for key in item.keys:
            found = self._by_key.get(key)
            if found is not None:
                existing = found
                break

        if existing is None:
            self._items.append(item)
            for key in item.keys:
                self._by_key.setdefault(key, item)
            return item

        _merge_into(existing, item)
        for key in item.keys:
            self._by_key.setdefault(key, existing)
        return existing

    def link_command(self, item: InventoryItem, command: str) -> None:
        """Claim a command name for an item, if nothing else has claimed it.

        Only used where a package's own metadata says it installs that
        command. A later PATH entry with the same name then merges into this
        item rather than becoming a second card.
        """
        self._by_key.setdefault(command_key(command), item)
        item.provides.add(command)
        item.keys.add(command_key(command))

    def lookup(self, key: str) -> InventoryItem | None:
        return self._by_key.get(key)

    def absorb(self, item: InventoryItem, into: InventoryItem) -> InventoryItem:
        """Fold ``item`` into ``into``, and stop reporting it separately."""
        if item is into:
            return into
        _merge_into(into, item)
        for key in item.keys:
            self._by_key[key] = into
        into.keys |= item.keys
        self._absorbed.add(id(item))
        return into

    @property
    def items(self) -> list[InventoryItem]:
        """Every distinct item, in first-seen order."""
        seen: set[int] = set()
        out: list[InventoryItem] = []
        for item in self._items:
            if id(item) in self._absorbed:
                continue
            resolved = self._resolve(item)
            if id(resolved) in self._absorbed or id(resolved) in seen:
                continue
            seen.add(id(resolved))
            out.append(resolved)
        return out

    def _resolve(self, item: InventoryItem) -> InventoryItem:
        for key in item.keys:
            found = self._by_key.get(key)
            if found is not None and found is not item:
                return found
        return item


def _merge_into(target: InventoryItem, other: InventoryItem) -> None:
    """Fold ``other``'s account into ``target``. Evidence is never dropped."""
    for item in other.evidence:
        target.add_evidence(item)

    target.keys |= other.keys
    target.provides |= other.provides

    for alias in [other.name, *other.aliases]:
        if alias and alias != target.name and alias not in target.aliases:
            target.aliases.append(alias)
    for path in other.shadowed:
        if path not in target.shadowed:
            target.shadowed.append(path)

    # Prefer the more specific classification.
    if _KIND_RANK.get(other.kind, 9) < _KIND_RANK.get(target.kind, 9):
        target.kind = other.kind
    if target.category in ("unknown", "") and other.category not in ("unknown", ""):
        target.category = other.category

    # Fill gaps; never overwrite something known with nothing.
    for attribute in (
        "display_name",
        "install_location",
        "executable_path",
        "command",
        "package_manager",
        "package_name",
        "package_version",
        "publisher",
        "description",
        "catalog_id",
    ):
        if not getattr(target, attribute) and getattr(other, attribute):
            setattr(target, attribute, getattr(other, attribute))

    # States are unions: any source establishing a state establishes it.
    for flag in ("installed", "detected", "verified", "usable", "connected"):
        if getattr(other, flag):
            setattr(target, flag, True)
    if other.execution_performed:
        target.execution_performed = True
    if other.execution_allowed:
        target.execution_allowed = True
    if target.trust_level is TrustLevel.UNKNOWN and other.trust_level is not TrustLevel.UNKNOWN:
        target.trust_level = other.trust_level
        target.trust_reason = other.trust_reason


def choose_version(item: InventoryItem) -> None:
    """Settle on the version to lead with, without hiding the others.

    Strongest evidence first, per the inventory contract: what a package
    manager recorded beats what a file's metadata implies, and a version the
    program itself reported beats both — because that is the one that will
    actually run. Everything seen stays in ``versions``.
    """
    runtime = next(
        (e.version for e in item.evidence if e.source == "probe" and e.version), None
    )
    package = next(
        (
            e.version
            for e in item.evidence
            if e.kind.value in ("os-package", "language-package") and e.version
        ),
        None,
    )
    application = next(
        (e.version for e in item.evidence if e.kind.value == "application" and e.version),
        None,
    )
    item.version = runtime or package or application or (item.versions[0] if item.versions else None)
    if package:
        item.package_version = package


def command_evidence(command: str, path: str, source: str, kind, detail: str) -> Evidence:
    return Evidence(source=source, kind=kind, package=None, location=path, detail=detail)
