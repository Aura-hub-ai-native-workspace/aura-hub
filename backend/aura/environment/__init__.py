"""Environment package — workspace node discovery, probing, and installation.

This package provides the canonical Python implementation of the Connected
Environment subsystem, matching the TypeScript @aura/connected-environment package.

The canonical path for workspace features:
  - Scan: discover which catalogued nodes are present on this machine
  - Probe: check the current state of a specific node
  - Install: governed installation through the Capability Fabric

Security: All commands come from catalog data, never from caller input.
"""
from __future__ import annotations

from .catalog import (
    ALL,
    BY_ID,
    CatalogEntry,
    InstallSpec,
    ProbeSpec,
    catalog_entry,
    entries_for_scan,
    entries_with_capability,
    is_connectable,
)
from .install import (
    INSTALLER_BINARIES,
    InstallPlan,
    NoInstallPlan,
    is_plan,
    plan_install,
    validate_installer_binary,
)
from .probe import (
    ScanResult,
    probe_node,
    probe_result_to_dict,
    scan_environment,
    scan_result_to_dict,
)

__all__ = [
    "ALL",
    "BY_ID",
    "CatalogEntry",
    "InstallSpec",
    "InstallPlan",
    "INSTALLER_BINARIES",
    "NoInstallPlan",
    "ProbeSpec",
    "ScanResult",
    "catalog_entry",
    "entries_for_scan",
    "entries_with_capability",
    "is_connectable",
    "is_plan",
    "plan_install",
    "probe_node",
    "scan_environment",
    "probe_result_to_dict",
    "scan_result_to_dict",
    "validate_installer_binary",
]
