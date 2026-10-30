# ADR-001: Physical Engineering is Orchestration, Not Replacement

- **Date:** 2026-09-01
- **Status:** Accepted
- **Context:** AURA Hub is extending toward physical engineering. The question is whether AURA should become a CAD/EDA/simulation tool or remain an orchestration layer.
- **Problem:** Physical engineering spans CAD, electronics, firmware, simulation, and manufacturing. No single tool covers all domains. Building domain-specific tools would be massive scope creep.
- **Decision:** AURA remains the orchestration layer. It connects AI agents with existing engineering tools through governed capabilities. AURA does NOT build a CAD editor, PCB designer, simulator, or IDE.
- **Reason:** AURA's genuine differentiator is cross-domain orchestration with governed execution (Capability Fabric). No existing tool orchestrates across mechanical/electronics/firmware/simulation. Building individual domain tools would replicate existing open-source projects without adding value.
- **Consequences:**
  - AURA agents invoke external tools through Capability Fabric
  - Every engineering tool remains external
  - AURA tracks artifacts, provenance, and dependencies
  - AURA provides the intelligence layer, not the execution engine
- **Rejected Alternatives:**
  - Building a custom CAD kernel (massive scope, OpenCascade already exists)
  - Building a custom EDA tool (KiCad already exists and is excellent)
  - Building a custom simulator (ngspice, CalculiX already exist)
- **Evidence:** Research shows CadQuery, KiCad, ngspice, and PlatformIO are mature, well-maintained, and have automation APIs. No gap exists that requires AURA to build replacements.
