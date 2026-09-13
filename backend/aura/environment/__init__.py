"""Environment package — workspace node discovery, probing, and installation.

This package provides the canonical Python implementation of the Connected
Environment subsystem, matching the TypeScript @aura/connected-environment package.

The canonical path for workspace features:
  - Scan: discover which catalogued nodes are present on this machine
  - Probe: check the current state of a specific node
  - Install: governed installation through the Capability Fabric

Security: all commands come from catalog data, never from caller input; all
execution goes through :mod:`aura.environment.procexec`; and an executable
discovered on PATH is only ever run when :mod:`aura.environment.pathsec` says
its location is tamper-resistant and :mod:`aura.environment.provenance` can
name the package a person installed to put it there.
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
from .discovery import (
    DiscoveredTool,
    DiscoveryReport,
    ToolStatus,
    discover_tools,
    discovered_to_dict,
    extract_version,
)
from .install import (
    INSTALLER_BINARIES,
    InstallPlan,
    NoInstallPlan,
    NoUninstallPlan,
    UninstallPlan,
    UninstallPlanResult,
    is_plan,
    is_uninstall_plan,
    plan_install,
    plan_uninstall,
    validate_installer_binary,
)
from .ospackages import OsInventory, discover_os_packages
from .pathsec import (
    LocationTrust,
    effective_path,
    location_trust,
    real_target,
    resolve_executable,
)
from .probe import (
    ProbeResult,
    ProbeStatus,
    ScanResult,
    probe_node,
    probe_result_to_dict,
    scan_environment,
    scan_result_to_dict,
)
from .procexec import ExecOutcome, ExecStatus, run_argv, sanitized_env
from .provenance import Origin, Provenance, ProvenanceIndex, build_index

__all__ = [
    "ALL",
    "BY_ID",
    "CatalogEntry",
    "DiscoveredTool",
    "DiscoveryReport",
    "ExecOutcome",
    "ExecStatus",
    "InstallSpec",
    "InstallPlan",
    "INSTALLER_BINARIES",
    "LocationTrust",
    "NoInstallPlan",
    "NoUninstallPlan",
    "UninstallPlan",
    "UninstallPlanResult",
    "Origin",
    "OsInventory",
    "ProbeResult",
    "ProbeSpec",
    "ProbeStatus",
    "Provenance",
    "ProvenanceIndex",
    "ScanResult",
    "ToolStatus",
    "build_index",
    "catalog_entry",
    "discover_os_packages",
    "discover_tools",
    "discovered_to_dict",
    "effective_path",
    "entries_for_scan",
    "entries_with_capability",
    "extract_version",
    "is_connectable",
    "is_plan",
    "is_uninstall_plan",
    "location_trust",
    "plan_install",
    "plan_uninstall",
    "probe_node",
    "probe_result_to_dict",
    "real_target",
    "resolve_executable",
    "run_argv",
    "sanitized_env",
    "scan_environment",
    "scan_result_to_dict",
    "validate_installer_binary",
]
