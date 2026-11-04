# Physical Engineering Research Ledger

Persistent record of research findings. Each entry captures a discovery
with source, confidence, and implementation consequence.

## Format

Each entry has:
- **id**: Unique research identifier
- **topic**: What was researched
- **source**: Where the finding came from
- **sourceUrl**: Link to source
- **researchedAt**: Date researched
- **finding**: What was discovered
- **confidence**: high / medium / low / uncertain
- **applicability**: How this applies to AURA
- **limitations**: Known limitations
- **implementationConsequence**: What this means for implementation
- **status**: verified / inferred / proposed / blocked

---

## CAD Research

### research-cadquery-001
- **Topic:** CadQuery programmatic CAD
- **Source:** official documentation
- **SourceUrl:** https://cadquery.readthedocs.io/en/latest/intro.html
- **ResearchedAt:** 2026-09-01
- **Finding:** CadQuery is a pure Python library wrapping OpenCascade (OCP). Exports STEP, STL, AMF, 3MF, SVG, DXF. No GUI dependency — runs as a Python package. Can import STEP files. Parametric modeling via workplane-based API.
- **Confidence:** high
- **Applicability:** Primary programmatic CAD provider for agent-generated models.
- **Limitations:** Depends on OCP (OpenCascade Python bindings). Large dependency. No native assembly constraint solver — assemblies are composed programmatically.
- **ImplementationConsequence:** CadQuery executor should be a `local-process` capability that runs Python scripts. Models are generated as Python code and executed in a subprocess.
- **Status:** verified

### research-cadquery-002
- **Topic:** CadQuery file format support
- **Source:** official documentation
- **SourceUrl:** https://cadquery.readthedocs.io/en/latest/importexport.html
- **ResearchedAt:** 2026-09-01
- **Finding:** Export: STEP, STL, AMF, 3MF, SVG, DXF, VRML, TJS. Import: STEP, BREP, SVG, DXF, AMF, TJS. STEP is the primary parametric exchange format.
- **Confidence:** high
- **Applicability:** STEP is the primary interoperability format between CAD tools.
- **Limitations:** STL is mesh-only (loses parametric data). B-Rep data preserved in STEP.
- **ImplementationConsequence:** Use STEP as the canonical CAD artifact format. STL for visualization only.
- **Status:** verified

### research-freecad-001
- **Topic:** FreeCAD headless mode
- **Source:** official wiki
- **SourceUrl:** https://wiki.freecad.org/Headless_FreeCAD
- **ResearchedAt:** 2026-09-01
- **Finding:** FreeCAD can run headless via `freecadcmd` or `FreeCADCmd`. GUI-dependent modules (PartDesignGui, SketcherGui) crash without display. Core Part, Mesh, Import, Export work headless.
- **Confidence:** high
- **Applicability:** FreeCAD suitable for STEP/STL export and advanced operations, but NOT for full parametric modeling headless.
- **Limitations:** GUI modules crash. Some workbenches unavailable. Community addon (mnesarco) improves headless support.
- **ImplementationConsequence:** Use FreeCAD for visualization/interactive operations. Use CadQuery for programmatic model generation.
- **Status:** verified

### research-freecad-002
- **Topic:** FreeCAD CLI capabilities
- **Source:** official documentation + forum
- **SourceUrl:** https://forum.freecad.org/viewtopic.php?t=101183
- **ResearchedAt:** 2026-09-01
- **Finding:** `freecadcmd` can run Python scripts that import Part, create geometry, export STEP/STL. Headless scripting for parametric models is feasible but limited to non-GUI workbenches.
- **Confidence:** medium
- **Applicability:** Can serve as a fallback STEP processor when CadQuery is unavailable.
- **Limitations:** Slower startup than CadQuery. Less reliable for complex operations.
- **ImplementationConsequence:** Implement as secondary CAD provider, not primary.
- **Status:** verified

### research-openscad-001
- **Topic:** OpenSCAD CLI automation
- **Source:** official documentation
- **SourceUrl:** https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/Using_OpenSCAD_in_a_command_line_environment
- **ResearchedAt:** 2026-09-01
- **Finding:** OpenSCAD supports CLI: `openscad -o output.stl input.scad`. Can export STL, OFF, AMF, 3MF, CSG. CSG-only (no B-Rep). No STEP export.
- **Confidence:** high
- **Applicability:** Limited — CSG-only, no STEP. Useful for simple parametric 3D printing models.
- **Limitations:** No B-Rep, no STEP, no IGES. CSG-only limits complexity.
- **ImplementationConsequence:** Not recommended as primary CAD provider. Consider for specific use cases.
- **Status:** verified

### research-onshape-001
- **Topic:** Onshape REST API
- **Source:** official documentation
- **SourceUrl:** https://onshape-public.github.io/docs/api-intro/
- **ResearchedAt:** 2026-09-01
- **Finding:** Comprehensive REST API. Full CRUD on documents, parts, assemblies, configurations. OAuth authentication. Cloud-only (no local mode). Rate limits apply.
- **Confidence:** high
- **Applicability:** Excellent for cloud-based professional workflows. REST API is the most mature of any CAD tool.
- **Limitations:** Cloud-only. Requires internet. OAuth complexity. Rate limits.
- **ImplementationConsequence:** Long-term provider for cloud-based professional workflows. Not for Phase 1.
- **Status:** verified

---

## EDA Research

### research-kicad-001
- **Topic:** KiCad IPC API
- **Source:** official documentation
- **SourceUrl:** https://dev-docs.kicad.org/en/apis-and-binding/ipc-api/index.html
- **ResearchedAt:** 2026-09-01
- **Finding:** New Protobuf-based API introduced in KiCad 9 (Feb 2025). Requires running KiCad instance with API server enabled. Python bindings via `kicad-python` package. Legacy SWIG bindings still available.
- **Confidence:** high
- **Applicability:** Primary EDA integration target. IPC API enables programmatic schematic/PCB manipulation.
- **Limitations:** Requires running KiCad instance (not fully headless). API is in "public beta" state.
- **ImplementationConsequence:** KiCad executor needs running KiCad instance. Use CLI for headless export operations.
- **Status:** verified

### research-kicad-002
- **Topic:** KiCad CLI export capabilities
- **Source:** community + documentation
- **SourceUrl:** https://dev-docs.kicad.org/en/apis-and-binding/index.html
- **ResearchedAt:** 2026-09-01
- **Finding:** KiCad CLI can export Gerber, drill files, BOM (CSV), netlist, STEP (3D board). `kicad-cli pcb export gerber`, `kicad-cli sch export bom`.
- **Confidence:** high
- **Applicability:** CLI export enables headless manufacturing output generation.
- **Limitations:** CLI export only — no interactive editing without GUI.
- **ImplementationConsequence:** Use CLI for manufacturing exports (Gerber, BOM, drill). Use IPC API for interactive operations.
- **Status:** verified

### research-kicad-003
- **Topic:** KiCad Python SWIG bindings (legacy)
- **Source:** official documentation
- **SourceUrl:** https://dev-docs.kicad.org/en/apis-and-binding/pcbnew/index.html
- **ResearchedAt:** 2026-09-01
- **Finding:** Legacy SWIG-based Python bindings for pcbnew. Still available in KiCad 9 and 10. Can manipulate PCB files programmatically. Runs within KiCad's Python environment.
- **Confidence:** high
- **Applicability:** Fallback for PCB manipulation if IPC API is insufficient.
- **Limitations:** Deprecated in favor of IPC API. Tied to KiCad's internal Python.
- **ImplementationConsequence:** Use IPC API primarily. SWIG bindings as fallback.
- **Status:** verified

---

## Embedded Research

### research-platformio-001
- **Topic:** PlatformIO CLI automation
- **Source:** official documentation
- **SourceUrl:** https://docs.platformio.org/en/latest/core.html
- **ResearchedAt:** 2026-09-01
- **Finding:** PlatformIO Core is a CLI tool: `pio run` (build), `pio run -t upload` (flash), `pio device monitor` (serial). Cross-platform. Python API available via `platformio` package. Supports ESP32, STM32, Arduino, and many more.
- **Confidence:** high
- **Applicability:** Primary embedded development orchestration target.
- **Limitations:** Requires PlatformIO installed. Build times can be significant.
- **ImplementationConsequence:** PlatformIO executor wraps CLI commands. Detection via `pio --version`.
- **Status:** verified

### research-espidf-001
- **Topic:** ESP-IDF CLI automation
- **Source:** official documentation
- **SourceUrl:** https://docs.espressif.com/projects/esp-idf/en/stable/esp32/
- **ResearchedAt:** 2026-09-01
- **Finding:** ESP-IDF provides `idf.py build`, `idf.py flash`, `idf.py monitor`. Python-based CLI wrapper. CMake build system. Cross-platform.
- **Confidence:** high
- **Applicability:** Alternative embedded provider, more ESP32-specific than PlatformIO.
- **Limitations:** ESP32-only (vs PlatformIO's multi-platform). Requires ESP-IDF environment setup.
- **ImplementationConsequence:** Secondary embedded provider. PlatformIO is preferred for multi-platform support.
- **Status:** verified

---

## Simulation Research

### research-ngspice-001
- **Topic:** ngspice simulation
- **Source:** official website
- **SourceUrl:** https://ngspice.sourceforge.io/
- **ResearchedAt:** 2026-09-01
- **Finding:** Open-source SPICE simulator. Supports analog, digital, mixed-signal. Shared library interface for programmatic access. CLI: `ngspice -b circuit.cir`.
- **Confidence:** high
- **Applicability:** Primary circuit simulation target. Open source, cross-platform.
- **Limitations:** Requires netlist generation (from schematic). Results are text-based.
- **ImplementationConsequence:** ngspice executor takes netlist files, runs simulation, returns results.
- **Status:** verified

### research-pyspice-001
- **Topic:** PySpice Python interface
- **Source:** official documentation
- **SourceUrl:** https://pyspice.fabrice-salvaire.fr/releases/v1.3/overview.html
- **ResearchedAt:** 2026-09-01
- **Finding:** Python module wrapping ngspice and Xyce. Define circuits in Python, run simulations, extract results. Provides a clean API over ngspice's shared library.
- **Confidence:** high
- **Applicability:** Python-native simulation interface for agent-driven circuit analysis.
- **Limitations:** Requires ngspice shared library installed. Complex setup on some platforms.
- **ImplementationConvenience:** Use PySpice as the Python API layer over ngspice.
- **Status:** verified

---

## Visualization Research

### research-threejs-001
- **Topic:** Three.js CAD visualization
- **Source:** community + npm packages
- **SourceUrl:** https://github.com/bernhard-42/three-cad-viewer
- **ResearchedAt:** 2026-09-01
- **Finding:** `three-cad-viewer` is a Three.js component for visualizing CAD models. Supports STL, OBJ, STEP (via conversion). `buerli` integrates CAD into Three.js with STEP/IGES loading.
- **Confidence:** medium
- **Applicability:** Browser-based 3D visualization for the Tauri frontend.
- **Limitations:** STEP requires conversion to mesh before Three.js rendering. Performance with large assemblies may be limited.
- **ImplementationConsequence:** Use Three.js + three-cad-viewer for the 3D viewer panel. Convert STEP to STL/mesh for rendering.
- **Status:** verified

---

## Data / Storage Research

### research-sqlite-graph-001
- **Topic:** SQLite for graph-like data
- **Source:** academic research + industry practice
- **SourceUrl:** https://www.cambridge.org/core/journals/proceedings-of-the-design-society/article/digital-thread-for-system-lifecycle-management-with-a-native-graph-database-in-a-polyglot-architecture/388CEA7F2ECCBE9357E6C9AF60EA2197
- **ResearchedAt:** 2026-09-01
- **Finding:** Graph-like relationships can be modeled in SQLite using adjacency lists or edge tables. For small-to-medium graphs (hundreds of nodes), SQLite is sufficient. In-memory graph traversal via recursive CTEs.
- **Confidence:** high
- **Applicability:** Engineering graph can use SQLite for persistence with in-memory graph index for traversal.
- **Limitations:** Not optimized for deep graph traversal like native graph databases. Acceptable for desktop-scale projects.
- **ImplementationConsequence:** Use SQLite for storage, build in-memory adjacency list for traversal.
- **Status:** verified

### research-content-addressing-001
- **Topic:** Content-addressable storage with SHA-256
- **Source:** standard practice
- **SourceUrl:** N/A
- **ResearchedAt:** 2026-09-01
- **Finding:** SHA-256 provides deterministic content hashing. Content-addressable storage uses hash as identifier, enabling deduplication and integrity verification.
- **Confidence:** high
- **Applicability:** Artifact integrity verification. Provenance chain integrity.
- **Limitations:** SHA-256 collision probability is negligible for practical purposes.
- **ImplementationConsequence:** Compute SHA-256 of artifact file contents. Store hash in artifact metadata.
- **Status:** verified

### research-event-sourcing-001
- **Topic:** Event sourcing for engineering provenance
- **Source:** academic research
- **SourceUrl:** https://pmc.ncbi.nlm.nih.gov/articles/PMC11997226/
- **ResearchedAt:** 2026-09-01
- **Finding:** Event sourcing records every state change as an immutable event. Enables complete audit trail, time-travel, and provenance tracking. Compatible with AURA's existing audit architecture.
- **Confidence:** high
- **Applicability:** Engineering events should be append-only, like AURA's existing audit trail.
- **Limitations:** Event replay can be slow for large histories. Snapshot strategy needed.
- **ImplementationConsequence:** Engineering events use append-only JSONL, similar to AuditStore.
- **Status:** verified
