"""Engineering Capability Contracts — extends the Capability Fabric with engineering domains.

These are DECLARED contracts, not yet connected to live executors.
They define the vocabulary that engineering agents can express.

Status labels:
  PROPOSED — declared, no executor yet
  IMPLEMENTED — connected to a real executor
  DEPRECATED — no longer used

The Capability Fabric remains the ONLY governed execution path.
No engineering agent can bypass it.
"""

from __future__ import annotations

from typing import Any

from .domain import (
    CapabilityRisk,
    EngineeringCapability,
    EngineeringDomain,
)

# ── CAD Capabilities ────────────────────────────────────────────────────────

CAD_CAPABILITIES: list[EngineeringCapability] = [
    EngineeringCapability(
        id="cad.create_part",
        name="Create CAD Part",
        description="Generate a new parametric 3D part via CadQuery/FreeCAD",
        domain=EngineeringDomain.MECHANICAL,
        risk=CapabilityRisk.MEDIUM,
        executor="cadquery-executor",
        provider="cadquery",
        input_schema={
            "name": {"type": "string", "required": True},
            "parameters": {"type": "object", "required": False},
            "script": {"type": "string", "required": False, "description": "CadQuery Python script"},
            "outputFormat": {"type": "string", "required": False, "default": "step"},
        },
        output_schema={
            "artifactId": {"type": "string"},
            "filePath": {"type": "string"},
            "format": {"type": "string"},
        },
        verification="read-back",
        status="proposed",
    ),
    EngineeringCapability(
        id="cad.modify_parameter",
        name="Modify CAD Parameter",
        description="Change a parameter on an existing parametric part",
        domain=EngineeringDomain.MECHANICAL,
        risk=CapabilityRisk.MEDIUM,
        executor="cadquery-executor",
        provider="cadquery",
        input_schema={
            "artifactId": {"type": "string", "required": True},
            "parameter": {"type": "string", "required": True},
            "value": {"type": "number", "required": True},
        },
        output_schema={"artifactId": {"type": "string"}, "filePath": {"type": "string"}},
        verification="read-back",
        status="proposed",
    ),
    EngineeringCapability(
        id="cad.export_step",
        name="Export STEP",
        description="Export a CAD model to STEP format for cross-tool exchange",
        domain=EngineeringDomain.MECHANICAL,
        risk=CapabilityRisk.LOW,
        executor="cadquery-executor",
        provider="cadquery",
        input_schema={
            "artifactId": {"type": "string", "required": True},
            "outputPath": {"type": "string", "required": False},
        },
        output_schema={"filePath": {"type": "string"}, "hash": {"type": "string"}},
        verification="exit-code",
        status="proposed",
    ),
    EngineeringCapability(
        id="cad.export_stl",
        name="Export STL",
        description="Export a CAD model to STL for visualization/3D printing",
        domain=EngineeringDomain.MECHANICAL,
        risk=CapabilityRisk.LOW,
        executor="cadquery-executor",
        provider="cadquery",
        input_schema={
            "artifactId": {"type": "string", "required": True},
            "outputPath": {"type": "string", "required": False},
        },
        output_schema={"filePath": {"type": "string"}, "hash": {"type": "string"}},
        verification="exit-code",
        status="proposed",
    ),
]

# ── Electronics Capabilities ─────────────────────────────────────────────────

ELECTRONICS_CAPABILITIES: list[EngineeringCapability] = [
    EngineeringCapability(
        id="electronics.create_schematic",
        name="Create Schematic",
        description="Generate a schematic in KiCad",
        domain=EngineeringDomain.ELECTRONICS,
        risk=CapabilityRisk.MEDIUM,
        executor="kicad-executor",
        provider="kicad",
        input_schema={
            "name": {"type": "string", "required": True},
            "components": {"type": "object", "required": False},
        },
        output_schema={"artifactId": {"type": "string"}, "filePath": {"type": "string"}},
        verification="read-back",
        status="proposed",
    ),
    EngineeringCapability(
        id="electronics.create_pcb",
        name="Create PCB Layout",
        description="Create PCB layout from schematic netlist",
        domain=EngineeringDomain.ELECTRONICS,
        risk=CapabilityRisk.MEDIUM,
        executor="kicad-executor",
        provider="kicad",
        input_schema={
            "schematicId": {"type": "string", "required": True},
        },
        output_schema={"artifactId": {"type": "string"}, "filePath": {"type": "string"}},
        verification="read-back",
        status="proposed",
    ),
    EngineeringCapability(
        id="electronics.run_drc",
        name="Run Design Rule Check",
        description="Run DRC on a PCB layout",
        domain=EngineeringDomain.ELECTRONICS,
        risk=CapabilityRisk.LOW,
        executor="kicad-executor",
        provider="kicad",
        input_schema={"pcbId": {"type": "string", "required": True}},
        output_schema={"result": {"type": "string"}, "violations": {"type": "number"}},
        verification="exit-code",
        status="proposed",
    ),
    EngineeringCapability(
        id="electronics.run_erc",
        name="Run Electrical Rule Check",
        description="Run ERC on a schematic",
        domain=EngineeringDomain.ELECTRONICS,
        risk=CapabilityRisk.LOW,
        executor="kicad-executor",
        provider="kicad",
        input_schema={"schematicId": {"type": "string", "required": True}},
        output_schema={"result": {"type": "string"}, "violations": {"type": "number"}},
        verification="exit-code",
        status="proposed",
    ),
    EngineeringCapability(
        id="electronics.generate_bom",
        name="Generate BOM",
        description="Generate bill of materials from schematic",
        domain=EngineeringDomain.ELECTRONICS,
        risk=CapabilityRisk.LOW,
        executor="kicad-executor",
        provider="kicad",
        input_schema={"schematicId": {"type": "string", "required": True}},
        output_schema={"artifactId": {"type": "string"}, "filePath": {"type": "string"}},
        verification="exit-code",
        status="proposed",
    ),
    EngineeringCapability(
        id="electronics.export_gerber",
        name="Export Gerber Files",
        description="Export manufacturing Gerber files from PCB",
        domain=EngineeringDomain.ELECTRONICS,
        risk=CapabilityRisk.HIGH,
        executor="kicad-executor",
        provider="kicad",
        input_schema={"pcbId": {"type": "string", "required": True}},
        output_schema={"artifactId": {"type": "string"}, "directoryPath": {"type": "string"}},
        verification="exit-code",
        irreversible=True,
        status="proposed",
    ),
]

# ── Device / Embedded Capabilities ──────────────────────────────────────────

DEVICE_CAPABILITIES: list[EngineeringCapability] = [
    EngineeringCapability(
        id="device.detect",
        name="Detect Devices",
        description="Discover connected development devices",
        domain=EngineeringDomain.FIRMWARE,
        risk=CapabilityRisk.LOW,
        executor="platformio-executor",
        provider="platformio",
        input_schema={},
        output_schema={"devices": {"type": "object"}},
        verification="exit-code",
        status="proposed",
    ),
    EngineeringCapability(
        id="device.build",
        name="Build Firmware",
        description="Compile firmware for target platform",
        domain=EngineeringDomain.FIRMWARE,
        risk=CapabilityRisk.LOW,
        executor="platformio-executor",
        provider="platformio",
        input_schema={
            "projectPath": {"type": "string", "required": True},
            "environment": {"type": "string", "required": False},
        },
        output_schema={"artifactId": {"type": "string"}, "binaryPath": {"type": "string"}},
        verification="exit-code",
        status="proposed",
    ),
    EngineeringCapability(
        id="device.flash",
        name="Flash Firmware to Device",
        description="Write firmware to a physical device (⚠ CRITICAL PHYSICAL ACTION)",
        domain=EngineeringDomain.FIRMWARE,
        risk=CapabilityRisk.CRITICAL_PHYSICAL,
        executor="platformio-executor",
        provider="platformio",
        input_schema={
            "firmwarePath": {"type": "string", "required": True},
            "port": {"type": "string", "required": True},
        },
        output_schema={"result": {"type": "string"}},
        verification="exit-code",
        irreversible=True,
        status="proposed",
    ),
    EngineeringCapability(
        id="device.monitor",
        name="Monitor Device Serial",
        description="Stream serial output from a connected device",
        domain=EngineeringDomain.FIRMWARE,
        risk=CapabilityRisk.LOW,
        executor="platformio-executor",
        provider="platformio",
        input_schema={
            "port": {"type": "string", "required": True},
            "baud": {"type": "number", "required": False},
        },
        output_schema={"stream": {"type": "string"}},
        verification=None,
        status="proposed",
    ),
]

# ── Simulation Capabilities ─────────────────────────────────────────────────

SIMULATION_CAPABILITIES: list[EngineeringCapability] = [
    EngineeringCapability(
        id="simulation.run_spice",
        name="Run SPICE Simulation",
        description="Execute a SPICE circuit simulation via ngspice",
        domain=EngineeringDomain.SIMULATION,
        risk=CapabilityRisk.LOW,
        executor="ngspice-executor",
        provider="ngspice",
        input_schema={
            "netlistPath": {"type": "string", "required": True},
            "analysisType": {"type": "string", "required": False},
        },
        output_schema={"artifactId": {"type": "string"}, "resultsPath": {"type": "string"}},
        verification="exit-code",
        status="proposed",
    ),
    EngineeringCapability(
        id="simulation.inspect_result",
        name="Inspect Simulation Results",
        description="Read and interpret simulation output data",
        domain=EngineeringDomain.SIMULATION,
        risk=CapabilityRisk.LOW,
        executor="internal",
        provider="aura",
        input_schema={"artifactId": {"type": "string", "required": True}},
        output_schema={"summary": {"type": "string"}, "metrics": {"type": "object"}},
        verification=None,
        status="proposed",
    ),
]


# ── Capability Registry ─────────────────────────────────────────────────────

ALL_ENGINEERING_CAPABILITIES: list[EngineeringCapability] = (
    CAD_CAPABILITIES
    + ELECTRONICS_CAPABILITIES
    + DEVICE_CAPABILITIES
    + SIMULATION_CAPABILITIES
)

_CAPABILITY_MAP: dict[str, EngineeringCapability] = {
    c.id: c for c in ALL_ENGINEERING_CAPABILITIES
}


def get_engineering_capability(cap_id: str) -> EngineeringCapability | None:
    """Look up an engineering capability by ID."""
    return _CAPABILITY_MAP.get(cap_id)


def list_engineering_capabilities(
    domain: EngineeringDomain | None = None,
    status: str | None = None,
    risk: CapabilityRisk | None = None,
) -> list[EngineeringCapability]:
    """List engineering capabilities with optional filters."""
    results = list(ALL_ENGINEERING_CAPABILITIES)
    if domain:
        results = [c for c in results if c.domain == domain]
    if status:
        results = [c for c in results if c.status == status]
    if risk:
        results = [c for c in results if c.risk == risk]
    return results


def engineering_capabilities_summary() -> dict[str, Any]:
    """Summary of all engineering capabilities."""
    proposed = sum(1 for c in ALL_ENGINEERING_CAPABILITIES if c.status == "proposed")
    implemented = sum(1 for c in ALL_ENGINEERING_CAPABILITIES if c.status == "implemented")
    return {
        "total": len(ALL_ENGINEERING_CAPABILITIES),
        "proposed": proposed,
        "implemented": implemented,
        "byDomain": {
            "mechanical": len([c for c in ALL_ENGINEERING_CAPABILITIES if c.domain == EngineeringDomain.MECHANICAL]),
            "electronics": len([c for c in ALL_ENGINEERING_CAPABILITIES if c.domain == EngineeringDomain.ELECTRONICS]),
            "firmware": len([c for c in ALL_ENGINEERING_CAPABILITIES if c.domain == EngineeringDomain.FIRMWARE]),
            "simulation": len([c for c in ALL_ENGINEERING_CAPABILITIES if c.domain == EngineeringDomain.SIMULATION]),
        },
    }
