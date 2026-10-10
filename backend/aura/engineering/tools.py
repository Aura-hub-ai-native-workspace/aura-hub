"""Engineering Tool Registry — discovers and tracks external engineering tools.

A tool is an external application that AURA can orchestrate through the
Capability Fabric. The registry knows:
- What tools exist (catalog)
- Which are installed (detection)
- What they can do (capabilities)
- How to invoke them (invocation method)

Detection is lazy — tools are probed on demand, not at startup.
"""

from __future__ import annotations

import shlex
from pathlib import Path
from typing import Any

from ..config import aura_path
from ..environment.procexec import ExecStatus, run_argv
from ..jsonutil import read_json_file, write_json_atomic
from .domain import (
    EngineeringDomain,
    ToolAvailability,
    ToolRecord,
    now_iso,
)

#: Detection probes are cheap liveness checks, not work. Ten seconds, the
#: budget the previous shell=True call used.
DETECTION_TIMEOUT_MS = 10_000

# ── Catalog: known engineering tools ────────────────────────────────────────

ENGINEERING_TOOLS: list[ToolRecord] = [
    ToolRecord(
        id="cadquery",
        name="CadQuery",
        provider="cadquery",
        domain=EngineeringDomain.MECHANICAL,
        executable="python",
        capabilities=["cad.create_part", "cad.modify_parameter", "cad.export_step", "cad.export_stl"],
        detection_method="python -c \"import cadquery; print(cadquery.__version__)\"",
        invocation_method="python-script",
        documentation_url="https://cadquery.readthedocs.io/",
        license="Apache-2.0",
        headless_support=True,
        cross_platform=True,
        metadata={"description": "Python parametric CAD scripting framework (OpenCascade-backed)"},
    ),
    ToolRecord(
        id="freecad",
        name="FreeCAD",
        provider="freecad",
        domain=EngineeringDomain.MECHANICAL,
        executable="freecadcmd",
        capabilities=["cad.export_step", "cad.export_stl", "cad.interactive"],
        detection_method="freecadcmd --version",
        invocation_method="cli",
        documentation_url="https://wiki.freecad.org/",
        license="LGPL-2.1",
        headless_support=True,
        cross_platform=True,
        metadata={"description": "Open-source parametric 3D CAD modeler"},
    ),
    ToolRecord(
        id="openscad",
        name="OpenSCAD",
        provider="openscad",
        domain=EngineeringDomain.MECHANICAL,
        executable="openscad",
        capabilities=["cad.export_stl"],
        detection_method="openscad --version",
        invocation_method="cli",
        documentation_url="https://openscad.org/",
        license="GPL-2.0",
        headless_support=True,
        cross_platform=True,
        metadata={"description": "Programmers solid 3D CAD modeller (CSG-only, no STEP)"},
    ),
    ToolRecord(
        id="kicad",
        name="KiCad",
        provider="kicad",
        domain=EngineeringDomain.ELECTRONICS,
        executable="kicad-cli",
        capabilities=[
            "electronics.export_gerber",
            "electronics.export_drill",
            "electronics.generate_bom",
            "electronics.run_drc",
            "electronics.run_erc",
        ],
        detection_method="kicad-cli --version",
        invocation_method="cli",
        documentation_url="https://dev-docs.kicad.org/",
        license="GPL-2.0",
        headless_support=True,
        cross_platform=True,
        metadata={"description": "Open-source EDA suite — schematic, PCB, Gerber, BOM"},
    ),
    ToolRecord(
        id="kicad-ipc",
        name="KiCad IPC API",
        provider="kicad",
        domain=EngineeringDomain.ELECTRONICS,
        executable="kicad",
        capabilities=[
            "electronics.create_schematic",
            "electronics.create_pcb",
            "electronics.run_drc",
        ],
        detection_method="python -c \"import kicad_python\"",
        invocation_method="ipc-api",
        documentation_url="https://dev-docs.kicad.org/en/apis-and-binding/ipc-api/index.html",
        license="GPL-2.0",
        headless_support=False,  # requires running KiCad instance
        cross_platform=True,
        metadata={"description": "KiCad Protobuf IPC API for interactive automation (KiCad 9+)"},
    ),
    ToolRecord(
        id="ngspice",
        name="ngspice",
        provider="ngspice",
        domain=EngineeringDomain.SIMULATION,
        executable="ngspice",
        capabilities=["simulation.run_spice"],
        detection_method="ngspice --version",
        invocation_method="cli",
        documentation_url="https://ngspice.sourceforge.io/",
        license="GPL-2.0",
        headless_support=True,
        cross_platform=True,
        metadata={"description": "Open-source SPICE circuit simulator"},
    ),
    ToolRecord(
        id="platformio",
        name="PlatformIO",
        provider="platformio",
        domain=EngineeringDomain.FIRMWARE,
        executable="pio",
        capabilities=[
            "device.create_project",
            "device.build",
            "device.flash",
            "device.monitor",
        ],
        detection_method="pio --version",
        invocation_method="cli",
        documentation_url="https://docs.platformio.org/",
        license="Apache-2.0",
        headless_support=True,
        cross_platform=True,
        metadata={"description": "Cross-platform embedded development build system"},
    ),
    ToolRecord(
        id="esptool",
        name="esptool.py",
        provider="espressif",
        domain=EngineeringDomain.FIRMWARE,
        executable="esptool.py",
        capabilities=["device.flash", "device.erase"],
        detection_method="esptool.py version",
        invocation_method="cli",
        documentation_url="https://docs.espressif.com/projects/esptool/",
        license="GPL-2.0",
        headless_support=True,
        cross_platform=True,
        metadata={"description": "ESP32/ESP8266 flash tool"},
    ),
]


class ToolRegistry:
    """Manages engineering tool records with detection and availability.

    Provides:
    - Register/deregister tools
    - Detect tool availability (lazy)
    - Query tools by domain, capability, availability
    - Persist detection results
    """

    def __init__(self, home: Path | None = None) -> None:
        self._home = home or aura_path()
        self._file = self._home / "engineering-tools.json"
        self._tools: dict[str, ToolRecord] = {}
        self._load_catalog()
        self.load()

    def _load_catalog(self) -> None:
        """Load the built-in catalog of known engineering tools."""
        for tool in ENGINEERING_TOOLS:
            self._tools[tool.id] = tool

    def load(self) -> None:
        """Load persisted detection results."""
        data = read_json_file(self._file, {"tools": [], "version": 1})
        for td in data.get("tools", []):
            tid = td.get("id", "")
            if tid in self._tools:
                existing = self._tools[tid]
                # Merge persisted detection results into catalog entry
                if td.get("availability"):
                    existing.availability = ToolAvailability(td["availability"])
                if td.get("detectedVersion"):
                    existing.detected_version = td["detectedVersion"]
                if td.get("lastDetected"):
                    existing.last_detected = td["lastDetected"]

    def save(self) -> None:
        """Persist detection results."""
        self._file.parent.mkdir(parents=True, exist_ok=True)
        # Only persist tools that have been detected (not the full catalog)
        detectable = [
            t.to_dict() for t in self._tools.values()
            if t.availability != ToolAvailability.UNKNOWN
        ]
        data = {
            "version": 1,
            "tools": detectable,
        }
        write_json_atomic(self._file, data)

    # ── Detection ───────────────────────────────────────────────────────

    def detect(self, tool_id: str) -> ToolRecord | None:
        """Detect whether a tool is installed and its version."""
        tool = self._tools.get(tool_id)
        if not tool:
            return None
        if not tool.detection_method:
            tool.availability = ToolAvailability.UNKNOWN
            return tool

        try:
            # Detection goes through the ONE execution boundary
            # (environment.procexec) like every other governed call. It used
            # to run the catalog's detection string with shell=True, which
            # put a shell in front of a catalog-supplied command and gave
            # up secret isolation, stdin isolation, output bounds and
            # process-tree cleanup — the exact loss
            # tests/unit/test_execution_boundary.py exists to prevent.
            argv = shlex.split(tool.detection_method)
            result = run_argv(argv, timeout_ms=DETECTION_TIMEOUT_MS)
            if result.status is ExecStatus.OK and result.exit_code == 0:
                tool.availability = ToolAvailability.INSTALLED
                tool.detected_version = _extract_version(result.stdout)
                tool.last_detected = now_iso()
            else:
                tool.availability = ToolAvailability.MISSING
                tool.detected_version = ""
                tool.last_detected = now_iso()
        except (ValueError, OSError):
            # A detection string that will not split, or an unreadable PATH
            # entry, is an undetectable tool — not a crash.
            tool.availability = ToolAvailability.MISSING
            tool.detected_version = ""
            tool.last_detected = now_iso()

        self.save()
        return tool

    def detect_all(self) -> dict[str, ToolRecord]:
        """Detect all registered tools."""
        for tool_id in list(self._tools.keys()):
            self.detect(tool_id)
        return dict(self._tools)

    # ── Queries ─────────────────────────────────────────────────────────

    def get(self, tool_id: str) -> ToolRecord | None:
        return self._tools.get(tool_id)

    def list_tools(
        self,
        domain: EngineeringDomain | None = None,
        availability: ToolAvailability | None = None,
        capability: str | None = None,
    ) -> list[ToolRecord]:
        results = list(self._tools.values())
        if domain:
            results = [t for t in results if t.domain == domain]
        if availability:
            results = [t for t in results if t.availability == availability]
        if capability:
            results = [t for t in results if capability in t.capabilities]
        return results

    def installed_tools(self) -> list[ToolRecord]:
        return self.list_tools(availability=ToolAvailability.INSTALLED)

    def missing_tools(self) -> list[ToolRecord]:
        return self.list_tools(availability=ToolAvailability.MISSING)

    def tools_for_capability(self, capability_id: str) -> list[ToolRecord]:
        """Find tools that provide a specific capability."""
        return [
            t for t in self._tools.values()
            if capability_id in t.capabilities
        ]

    def register(self, tool: ToolRecord) -> None:
        """Register a custom tool."""
        self._tools[tool.id] = tool
        self.save()

    def remove(self, tool_id: str) -> bool:
        if tool_id not in self._tools:
            return False
        del self._tools[tool_id]
        self.save()
        return True

    # ── Summary ─────────────────────────────────────────────────────────

    def summary(self) -> dict[str, Any]:
        installed = sum(1 for t in self._tools.values() if t.availability == ToolAvailability.INSTALLED)
        missing = sum(1 for t in self._tools.values() if t.availability == ToolAvailability.MISSING)
        unknown = sum(1 for t in self._tools.values() if t.availability == ToolAvailability.UNKNOWN)
        return {
            "totalTools": len(self._tools),
            "installed": installed,
            "missing": missing,
            "unknown": unknown,
            "byDomain": _count_by_domain(self._tools),
        }


def _extract_version(output: str) -> str:
    """Best-effort version extraction from CLI output."""
    import re
    match = re.search(r"[\d]+\.[\d]+[\.\d]*", output)
    return match.group(0) if match else ""


def _count_by_domain(tools: dict[str, ToolRecord]) -> dict[str, int]:
    from collections import defaultdict
    counts: dict[str, int] = defaultdict(int)
    for tool in tools.values():
        counts[tool.domain.value] += 1
    return dict(counts)
