"""The node catalogue — what AURA knows how to look for.

A port of packages/connected-environment/src/{catalog,capabilities,agents}.ts.

The entries themselves are **data**, and they are carried as data:
`catalog_data.json` is generated from the TypeScript catalogue rather than
transcribed, because 105 hand-copied entries is 105 chances to introduce a
silent difference in a probe command. `tests/test_catalog_parity.py`
regenerates it from the reference and diffs, so drift is caught rather
than assumed absent.

Two properties of this module are load-bearing:

  * **CATALOGUE ORDER IS A BEHAVIOURAL CONTRACT.** When several present
    nodes provide the same capability and the caller named none, routing
    takes the first in this order. Reordering the file changes which tool
    runs.
  * **A probe command comes from here, never from a request.** A client
    can ask "probe the node called `docker`"; it can never ask "run this
    string".
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Literal

TransportKind = Literal["internal", "local-process", "http", "api-key", "oauth"]
InstallMethod = Literal["npm-global", "pipx", "cargo", "gh-extension", "system-package"]
InstallPrivilege = Literal["user", "root"]

_DATA_FILE = Path(__file__).with_name("catalog_data.json")


@dataclass(frozen=True)
class ProbeSpec:
    command: str
    args: tuple[str, ...] = ()


@dataclass(frozen=True)
class CatalogInstallSpec:
    method: InstallMethod
    package: str
    privilege: InstallPrivilege
    distro: dict[str, str]


@dataclass(frozen=True)
class CatalogEntry:
    id: str
    name: str
    category: str
    capabilities: tuple[str, ...]
    transport: TransportKind
    auth: str
    license: str
    cross_platform: bool
    maintained: bool
    summary: str
    homepage: str
    probe: ProbeSpec | None = None
    endpoint: str | None = None
    install: CatalogInstallSpec | None = None


@dataclass(frozen=True)
class AgentMeta:
    role: str
    label: str
    focus: str
    icon: str


def _load() -> dict:
    with _DATA_FILE.open(encoding="utf-8") as f:
        return json.load(f)


def _entry(raw: dict) -> CatalogEntry:
    probe = raw.get("probe")
    install = raw.get("install")
    return CatalogEntry(
        id=raw["id"],
        name=raw["name"],
        category=raw["category"],
        capabilities=tuple(raw.get("capabilities") or ()),
        transport=raw["transport"],
        auth=raw["auth"],
        license=raw["license"],
        cross_platform=bool(raw.get("crossPlatform")),
        maintained=bool(raw.get("maintained")),
        summary=raw.get("summary", ""),
        homepage=raw.get("homepage", ""),
        probe=(
            ProbeSpec(command=probe["command"], args=tuple(probe.get("args") or ()))
            if probe
            else None
        ),
        endpoint=raw.get("endpoint"),
        install=(
            CatalogInstallSpec(
                method=install["method"],
                package=install["package"],
                privilege=install["privilege"],
                distro=dict(install.get("distro") or {}),
            )
            if install
            else None
        ),
    )


_RAW = _load()

# Order preserved from the source file — see the module docstring.
CATALOG: tuple[CatalogEntry, ...] = tuple(_entry(e) for e in _RAW["CATALOG"])
CATEGORY_LABELS: dict[str, str] = dict(_RAW["CATEGORY_LABELS"])
# Capability id -> what the job IS, phrased as a job rather than a brand.
# This indirection is what makes a new integration additive.
CAPABILITIES: dict[str, str] = dict(_RAW["CAPABILITIES"])
AGENTS: dict[str, AgentMeta] = {
    role: AgentMeta(**meta) for role, meta in _RAW["AGENTS"].items()
}
AGENT_ROLES: tuple[str, ...] = tuple(AGENTS)

_BY_ID = {e.id: e for e in CATALOG}


def catalog_entry(node_id: str) -> CatalogEntry | None:
    return _BY_ID.get(node_id)


def describe_capability(capability_id: str) -> str | None:
    return CAPABILITIES.get(capability_id)


@cache
def entries_providing(capability_id: str) -> tuple[CatalogEntry, ...]:
    """Every catalogued node that declares this capability, in order."""
    return tuple(e for e in CATALOG if capability_id in e.capabilities)


def is_connectable(entry: CatalogEntry) -> bool:
    """Would clicking Connect do anything?

    The single source of truth for that question. `oauth` is always false:
    catalogued for planning, with no connector built.
    """
    if entry.transport == "oauth":
        return False
    if entry.transport == "internal":
        return True
    if entry.transport == "local-process":
        return entry.probe is not None
    if entry.transport == "http":
        return entry.endpoint is not None
    # api-key: routed into the already-shipped BYOAK provider system.
    return entry.transport == "api-key"
