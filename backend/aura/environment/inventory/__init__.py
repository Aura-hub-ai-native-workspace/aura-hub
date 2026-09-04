"""Complete machine inventory — what is installed, from authoritative sources.

The entry point is :func:`get_inventory`. See :mod:`.service` for the
collection order and :mod:`.sources` for what counts as authoritative.
"""
from __future__ import annotations

from .identity import InventoryIndex, app_key, command_key, package_key, path_key
from .model import (
    Evidence,
    InventoryItem,
    ItemKind,
    SourceKind,
    SourceReport,
    SourceResult,
    TrustLevel,
)
from .service import (
    INVENTORY_TTL_MS,
    Inventory,
    clear_cache,
    collect_inventory,
    find_by_catalog_id,
    get_inventory,
    inventory_to_dict,
    machine_changed,
)
from .sources import collect_sources, enumerate_path

__all__ = [
    "INVENTORY_TTL_MS",
    "Evidence",
    "Inventory",
    "InventoryIndex",
    "InventoryItem",
    "ItemKind",
    "SourceKind",
    "SourceReport",
    "SourceResult",
    "TrustLevel",
    "app_key",
    "clear_cache",
    "collect_inventory",
    "collect_sources",
    "command_key",
    "enumerate_path",
    "find_by_catalog_id",
    "get_inventory",
    "inventory_to_dict",
    "machine_changed",
    "package_key",
    "path_key",
]
