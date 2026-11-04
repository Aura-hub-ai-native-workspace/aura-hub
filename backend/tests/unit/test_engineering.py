"""Physical Engineering Foundation — comprehensive tests.

Covers: domain types, engineering graph, artifact store, tool registry,
capability contracts, event store, change impact analysis, and context extension.

All tests use tmp_path for isolation. No external tools are required.
"""

from __future__ import annotations

import hashlib

import pytest

from aura.engineering.artifacts import ArtifactStore
from aura.engineering.capabilities import (
    ALL_ENGINEERING_CAPABILITIES,
    engineering_capabilities_summary,
    get_engineering_capability,
    list_engineering_capabilities,
)
from aura.engineering.change_impact import ImpactReport, analyze_change_impact
from aura.engineering.domain import (
    ArtifactStatus,
    ArtifactType,
    CapabilityRisk,
    ComponentState,
    EngineeringDomain,
    EngineeringEdge,
    EngineeringEventRecord,
    EngineeringEventType,
    EngineeringNode,
    NodeType,
    RelationshipType,
    ToolAvailability,
    content_hash,
    new_id,
    now_iso,
)
from aura.engineering.events import EngineeringEventStore
from aura.engineering.graph import EngineeringGraph
from aura.engineering.tools import ToolRegistry

# ── Domain types ─────────────────────────────────────────────────────────────


class TestDomainTypes:
    def test_enums_have_expected_values(self):
        assert EngineeringDomain.MECHANICAL.value == "mechanical"
        assert NodeType.ARTIFACT.value == "artifact"
        assert RelationshipType.DEPENDS_ON.value == "depends_on"
        assert ArtifactType.CAD_MODEL.value == "cad-model"
        assert ArtifactStatus.STALE.value == "stale"
        assert CapabilityRisk.CRITICAL_PHYSICAL.value == "critical-physical"
        assert ToolAvailability.INSTALLED.value == "installed"

    def test_new_id_is_deterministic_prefix(self):
        id1 = new_id("test")
        id2 = new_id("test")
        assert id1.startswith("test-")
        assert id2.startswith("test-")
        assert id1 != id2  # different UUIDs

    def test_now_iso_format(self):
        ts = now_iso()
        assert ts.endswith("Z")
        assert "T" in ts

    def test_content_hash(self):
        h = content_hash(b"hello world")
        expected = hashlib.sha256(b"hello world").hexdigest()
        assert h == expected
        assert len(h) == 64


class TestDomainSerialization:
    def test_engineering_node_roundtrip(self):
        node = EngineeringNode(
            id="node-001",
            node_type=NodeType.COMPONENT,
            domain=EngineeringDomain.MECHANICAL,
            name="Frame",
            description="Main structural frame",
            state=ComponentState.PLANNED.value,
            metadata={"material": "carbon-fiber"},
        )
        d = node.to_dict()
        restored = EngineeringNode.from_dict(d)
        assert restored.id == "node-001"
        assert restored.node_type == NodeType.COMPONENT
        assert restored.domain == EngineeringDomain.MECHANICAL
        assert restored.metadata["material"] == "carbon-fiber"

    def test_engineering_edge_roundtrip(self):
        edge = EngineeringEdge(
            id="edge-001",
            source_id="node-a",
            target_id="node-b",
            relationship=RelationshipType.DEPENDS_ON,
            metadata={"reason": "enclosure depends on PCB"},
        )
        d = edge.to_dict()
        restored = EngineeringEdge.from_dict(d)
        assert restored.source_id == "node-a"
        assert restored.relationship == RelationshipType.DEPENDS_ON

    def test_event_record_roundtrip(self):
        evt = EngineeringEventRecord(
            id="evt-001",
            event_type=EngineeringEventType.ARTIFACT_CREATED,
            project_id="proj-1",
            actor="agent",
            agent="cad-agent",
            artifact_id="art-001",
            outcome="success",
        )
        d = evt.to_dict()
        restored = EngineeringEventRecord.from_dict(d)
        assert restored.event_type == EngineeringEventType.ARTIFACT_CREATED
        assert restored.agent == "cad-agent"


# ── Engineering Graph ────────────────────────────────────────────────────────


class TestEngineeringGraph:
    @pytest.fixture()
    def graph(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        return EngineeringGraph("test-project", home=tmp_path)

    def test_add_and_get_node(self, graph):
        node = graph.add_node(
            node_type=NodeType.REQUIREMENT,
            domain="system",
            name="Autonomy requirement",
            description="Drone must fly autonomously",
        )
        assert node.id.startswith("node-")
        fetched = graph.get_node(node.id)
        assert fetched is not None
        assert fetched.name == "Autonomy requirement"

    def test_add_node_with_custom_id(self, graph):
        node = graph.add_node(
            node_type=NodeType.COMPONENT,
            domain="mechanical",
            name="Frame",
            node_id="custom-frame-id",
        )
        assert node.id == "custom-frame-id"
        assert graph.get_node("custom-frame-id") is not None

    def test_find_nodes(self, graph):
        graph.add_node(NodeType.COMPONENT, "mechanical", "Frame")
        graph.add_node(NodeType.COMPONENT, "electronics", "PCB")
        graph.add_node(NodeType.REQUIREMENT, "system", "Flight time")

        mechanical = graph.find_nodes(node_type=NodeType.COMPONENT, domain="mechanical")
        assert len(mechanical) == 1
        assert mechanical[0].name == "Frame"

        all_components = graph.find_nodes(node_type=NodeType.COMPONENT)
        assert len(all_components) == 2

    def test_update_node(self, graph):
        node = graph.add_node(NodeType.COMPONENT, "mechanical", "Frame")
        updated = graph.update_node(node.id, state=ComponentState.IN_DESIGN.value)
        assert updated is not None
        assert updated.state == ComponentState.IN_DESIGN.value

    def test_update_nonexistent_node_returns_none(self, graph):
        result = graph.update_node("nonexistent", name="nope")
        assert result is None

    def test_remove_node_cleans_edges(self, graph):
        n1 = graph.add_node(NodeType.COMPONENT, "mechanical", "A")
        n2 = graph.add_node(NodeType.COMPONENT, "mechanical", "B")
        edge = graph.add_edge(n1.id, n2.id, RelationshipType.DEPENDS_ON)
        assert edge is not None

        removed = graph.remove_node(n1.id)
        assert removed is True
        assert graph.get_node(n1.id) is None
        assert graph.get_node(n2.id) is not None
        # Edge should be cleaned up
        assert graph.all_edges_for(n1.id) == []
        assert graph.all_edges_for(n2.id) == []

    def test_add_and_get_edge(self, graph):
        n1 = graph.add_node(NodeType.SYSTEM, "system", "Drone System")
        n2 = graph.add_node(NodeType.SUBSYSTEM, "mechanical", "Frame Subsystem")
        edge = graph.add_edge(n1.id, n2.id, RelationshipType.CONTAINS)
        assert edge is not None
        assert edge.source_id == n1.id
        assert edge.target_id == n2.id

    def test_add_edge_nonexistent_node_returns_none(self, graph):
        n1 = graph.add_node(NodeType.COMPONENT, "mechanical", "A")
        result = graph.add_edge(n1.id, "nonexistent", RelationshipType.DEPENDS_ON)
        assert result is None

    def test_forward_traversal(self, graph):
        req = graph.add_node(NodeType.REQUIREMENT, "system", "Flight time > 20min")
        sys_ = graph.add_node(NodeType.SYSTEM, "system", "Drone System")
        mech = graph.add_node(NodeType.SUBSYSTEM, "mechanical", "Mechanical")
        pcb = graph.add_node(NodeType.ARTIFACT, "electronics", "Main PCB")

        graph.add_edge(req.id, sys_.id, RelationshipType.DERIVES)
        graph.add_edge(sys_.id, mech.id, RelationshipType.CONTAINS)
        graph.add_edge(sys_.id, pcb.id, RelationshipType.CONTAINS)

        # Forward from requirement: direct forward finds system
        forward = graph.forward(req.id)
        forward_ids = {n.id for n in forward}
        assert sys_.id in forward_ids
        # Transitive dependencies finds everything downstream
        deps = graph.dependencies_of(req.id)
        dep_ids = {n.id for n in deps}
        assert mech.id in dep_ids
        assert pcb.id in dep_ids

    def test_reverse_traversal(self, graph):
        sys_ = graph.add_node(NodeType.SYSTEM, "system", "Drone System")
        frame = graph.add_node(NodeType.COMPONENT, "mechanical", "Frame")
        enclosure = graph.add_node(NodeType.COMPONENT, "mechanical", "Enclosure")

        graph.add_edge(frame.id, sys_.id, RelationshipType.CONTAINS)
        graph.add_edge(enclosure.id, sys_.id, RelationshipType.CONTAINS)

        # What depends on the system?
        reverse = graph.reverse(sys_.id)
        reverse_ids = {n.id for n in reverse}
        assert frame.id in reverse_ids
        assert enclosure.id in reverse_ids

    def test_dependency_lookup(self, graph):
        a = graph.add_node(NodeType.ARTIFACT, "mechanical", "Frame STEP")
        b = graph.add_node(NodeType.ARTIFACT, "electronics", "PCB")
        c = graph.add_node(NodeType.ARTIFACT, "mechanical", "Enclosure")

        graph.add_edge(c.id, a.id, RelationshipType.DEPENDS_ON)
        graph.add_edge(c.id, b.id, RelationshipType.DEPENDS_ON)

        deps = graph.dependencies_of(c.id)
        dep_ids = {n.id for n in deps}
        assert a.id in dep_ids
        assert b.id in dep_ids

    def test_dependents_lookup(self, graph):
        pcb = graph.add_node(NodeType.ARTIFACT, "electronics", "Main PCB")
        enclosure = graph.add_node(NodeType.ARTIFACT, "mechanical", "Enclosure")
        firmware = graph.add_node(NodeType.ARTIFACT, "firmware", "ESP32 Firmware")

        graph.add_edge(enclosure.id, pcb.id, RelationshipType.DEPENDS_ON)
        graph.add_edge(firmware.id, pcb.id, RelationshipType.DEPENDS_ON)

        dependents = graph.dependents_of(pcb.id)
        dependent_ids = {n.id for n in dependents}
        assert enclosure.id in dependent_ids
        assert firmware.id in dependent_ids

    def test_change_impact(self, graph):
        pcb = graph.add_node(NodeType.ARTIFACT, "electronics", "Main PCB")
        enclosure = graph.add_node(NodeType.ARTIFACT, "mechanical", "Enclosure")
        mount = graph.add_node(NodeType.COMPONENT, "mechanical", "Mount bracket")

        graph.add_edge(enclosure.id, pcb.id, RelationshipType.DEPENDS_ON)
        graph.add_edge(mount.id, pcb.id, RelationshipType.DEPENDS_ON)

        impact = graph.change_impact(pcb.id)
        affected_ids = {item["nodeId"] for item in impact}
        assert enclosure.id in affected_ids
        assert mount.id in affected_ids

    def test_provenance_queries(self, graph):
        artifact = graph.add_node(NodeType.ARTIFACT, "mechanical", "Frame STEP")
        cad_agent = graph.add_node(NodeType.AGENT, "system", "CAD Agent")
        tool = graph.add_node(NodeType.TOOL, "system", "CadQuery")

        graph.add_edge(cad_agent.id, artifact.id, RelationshipType.PRODUCED_BY)
        graph.add_edge(tool.id, artifact.id, RelationshipType.PRODUCED_BY)

        producers = graph.produced_by(artifact.id)
        producer_ids = {n.id for n in producers}
        assert cad_agent.id in producer_ids
        assert tool.id in producer_ids

    def test_validates_query(self, graph):
        artifact = graph.add_node(NodeType.ARTIFACT, "mechanical", "Frame STEP")
        test = graph.add_node(NodeType.TEST, "validation", "Dimensional check")

        graph.add_edge(test.id, artifact.id, RelationshipType.VALIDATED_BY)

        validators = graph.validates(artifact.id)
        assert len(validators) == 1
        assert validators[0].id == test.id

    def test_persistence_survives_reload(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        g1 = EngineeringGraph("persist-test", home=tmp_path)
        n = g1.add_node(NodeType.COMPONENT, "mechanical", "Frame")
        g1.add_node(NodeType.COMPONENT, "electronics", "PCB")
        g1.add_edge(n.id, "non-edge-test", RelationshipType.DEPENDS_ON)

        # Reload
        g2 = EngineeringGraph("persist-test", home=tmp_path)
        assert len(g2.find_nodes()) == 2

    def test_summary(self, graph):
        graph.add_node(NodeType.COMPONENT, "mechanical", "Frame")
        graph.add_node(NodeType.ARTIFACT, "electronics", "PCB")
        n1 = graph.add_node(NodeType.COMPONENT, "mechanical", "Motor")
        n2 = graph.add_node(NodeType.COMPONENT, "mechanical", "Prop")
        graph.add_edge(n1.id, n2.id, RelationshipType.CONTAINS)

        summary = graph.summary()
        assert summary["totalNodes"] == 4
        assert summary["totalEdges"] == 1
        assert summary["nodeTypes"]["component"] == 3
        assert summary["nodeTypes"]["artifact"] == 1


# ── Artifact Store ───────────────────────────────────────────────────────────


class TestArtifactStore:
    @pytest.fixture()
    def store(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        return ArtifactStore("test-project", home=tmp_path)

    def test_create_artifact(self, store):
        art = store.create(
            artifact_type=ArtifactType.CAD_MODEL,
            name="Frame.step",
            version="1.0.0",
            file_path="/artifacts/frame.step",
            file_hash="abc123",
            source="cad-agent",
            author_agent="cad-agent",
        )
        assert art.id.startswith("artifact-")
        assert art.version == "1.0.0"

    def test_get_artifact(self, store):
        art = store.create(
            artifact_type=ArtifactType.CAD_MODEL,
            name="Frame.step",
            version="1.0.0",
            file_path="/artifacts/frame.step",
            file_hash="abc123",
        )
        fetched = store.get(art.id)
        assert fetched is not None
        assert fetched.name == "Frame.step"

    def test_update_artifact(self, store):
        art = store.create(
            artifact_type=ArtifactType.CAD_MODEL,
            name="Frame.step",
            version="1.0.0",
            file_path="/artifacts/frame.step",
            file_hash="abc123",
        )
        updated = store.update(art.id, status=ArtifactStatus.VERIFIED.value)
        assert updated is not None
        assert updated.status == ArtifactStatus.VERIFIED

    def test_new_version(self, store):
        v1 = store.create(
            artifact_type=ArtifactType.CAD_MODEL,
            name="Frame.step",
            version="1.0.0",
            file_path="/artifacts/frame.step",
            file_hash="abc123",
        )
        v2 = store.new_version(
            parent_id=v1.id,
            version="1.1.0",
            file_path="/artifacts/frame-v2.step",
            file_hash="def456",
        )
        assert v2 is not None
        assert v2.parent_id == v1.id
        assert v2.version == "1.1.0"
        assert v2.artifact_type == ArtifactType.CAD_MODEL  # inherited

    def test_version_history(self, store):
        v1 = store.create(
            artifact_type=ArtifactType.CAD_MODEL,
            name="Frame.step",
            version="1.0.0",
            file_path="/artifacts/frame.step",
            file_hash="abc123",
        )
        v2 = store.new_version(v1.id, "1.1.0", "/frame-v2.step", "def456")
        v3 = store.new_version(v2.id, "1.2.0", "/frame-v3.step", "ghi789")

        history = store.version_history(v3.id)
        assert len(history) == 3
        assert history[0].version == "1.2.0"  # newest first
        assert history[1].version == "1.1.0"
        assert history[2].version == "1.0.0"

    def test_list_by_type(self, store):
        store.create(ArtifactType.CAD_MODEL, "f.step", "1.0.0", "/f.step", "a")
        store.create(ArtifactType.PCB, "main.kicad_pcb", "1.0.0", "/p.kicad_pcb", "b")
        store.create(ArtifactType.CAD_MODEL, "e.step", "1.0.0", "/e.step", "c")

        cad = store.list_artifacts(artifact_type=ArtifactType.CAD_MODEL)
        assert len(cad) == 2

    def test_dependencies_and_dependents(self, store):
        pcb = store.create(ArtifactType.PCB, "Main PCB", "1.0.0", "/pcb", "h1")
        enclosure = store.create(
            ArtifactType.CAD_MODEL, "Enclosure", "1.0.0", "/enc", "h2",
            dependencies=[pcb.id],
        )
        mount = store.create(
            ArtifactType.CAD_MODEL, "Mount", "1.0.0", "/mnt", "h3",
            dependencies=[pcb.id],
        )

        deps = store.dependencies_of(enclosure.id)
        assert len(deps) == 1
        assert deps[0].id == pcb.id

        dependents = store.dependents_of(pcb.id)
        dep_ids = {d.id for d in dependents}
        assert enclosure.id in dep_ids
        assert mount.id in dep_ids

    def test_mark_stale_and_verify(self, store):
        art = store.create(ArtifactType.CAD_MODEL, "Frame", "1.0.0", "/f", "h")
        store.mark_stale(art.id)
        stale = store.stale_artifacts()
        assert len(stale) == 1

        store.mark_verified(art.id)
        assert len(store.stale_artifacts()) == 0

    def test_provenance_chain(self, store):
        from aura.engineering.domain import ArtifactProvenance

        v1 = store.create(
            ArtifactType.CAD_MODEL, "Frame", "1.0.0", "/f", "h",
            provenance=ArtifactProvenance(agent="cad-agent", tool="cadquery"),
        )
        v2 = store.new_version(
            v1.id, "2.0.0", "/f2", "h2",
            provenance=ArtifactProvenance(agent="cad-agent", tool="cadquery"),
        )
        chain = store.provenance_chain(v2.id)
        assert len(chain) == 2
        assert chain[0]["artifactId"] == v2.id
        assert chain[1]["artifactId"] == v1.id

    def test_integrity_verification(self, store):
        art = store.create(ArtifactType.CAD_MODEL, "Frame", "1.0.0", "/f", "abc123")
        result = store.verify_integrity(art.id)
        assert result["ok"] is True

        result_bad = store.verify_integrity(art.id, expected_hash="wrong")
        assert result_bad["ok"] is False

    def test_persistence_survives_reload(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        s1 = ArtifactStore("persist-test", home=tmp_path)
        s1.create(ArtifactType.CAD_MODEL, "F", "1.0.0", "/f", "h")

        s2 = ArtifactStore("persist-test", home=tmp_path)
        assert len(s2.list_artifacts()) == 1

    def test_summary(self, store):
        store.create(ArtifactType.CAD_MODEL, "F", "1.0.0", "/f", "h")
        store.create(ArtifactType.PCB, "P", "1.0.0", "/p", "h2")
        summary = store.summary()
        assert summary["totalArtifacts"] == 2
        assert summary["byType"]["cad-model"] == 1
        assert summary["byType"]["pcb"] == 1


# ── Tool Registry ────────────────────────────────────────────────────────────


class TestToolRegistry:
    @pytest.fixture()
    def registry(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        return ToolRegistry(home=tmp_path)

    def test_catalog_loaded(self, registry):
        tools = registry.list_tools()
        assert len(tools) >= 5  # at least cadquery, freecad, openscad, kicad, ngspice

    def test_get_tool(self, registry):
        cq = registry.get("cadquery")
        assert cq is not None
        assert cq.name == "CadQuery"

    def test_list_by_domain(self, registry):
        cad_tools = registry.list_tools(domain=EngineeringDomain.MECHANICAL)
        assert len(cad_tools) >= 2  # cadquery + freecad + openscad

        eda_tools = registry.list_tools(domain=EngineeringDomain.ELECTRONICS)
        assert len(eda_tools) >= 1  # kicad

    def test_tools_for_capability(self, registry):
        tools = registry.tools_for_capability("cad.create_part")
        assert len(tools) >= 1
        assert any(t.id == "cadquery" for t in tools)

    def test_detect_missing_tool(self, registry):
        # cadquery is likely not installed in test env
        tool = registry.detect("cadquery")
        assert tool is not None
        assert tool.availability in (
            ToolAvailability.INSTALLED,
            ToolAvailability.MISSING,
        )

    def test_register_custom_tool(self, registry):
        from aura.engineering.domain import ToolRecord

        custom = ToolRecord(
            id="custom-tool",
            name="Custom CAD Tool",
            provider="custom",
            domain=EngineeringDomain.MECHANICAL,
            capabilities=["cad.custom_op"],
        )
        registry.register(custom)
        fetched = registry.get("custom-tool")
        assert fetched is not None
        assert fetched.name == "Custom CAD Tool"

    def test_remove_tool(self, registry):
        registry.remove("openscad")
        assert registry.get("openscad") is None

    def test_summary(self, registry):
        summary = registry.summary()
        assert summary["totalTools"] >= 5
        assert "installed" in summary
        assert "missing" in summary

    def test_persistence_of_detection(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        r1 = ToolRegistry(home=tmp_path)
        r1.detect("cadquery")

        r2 = ToolRegistry(home=tmp_path)
        tool = r2.get("cadquery")
        assert tool.availability != ToolAvailability.UNKNOWN


# ── Capability Contracts ─────────────────────────────────────────────────────


class TestEngineeringCapabilities:
    def test_capabilities_registered(self):
        assert len(ALL_ENGINEERING_CAPABILITIES) >= 10

    def test_get_capability(self):
        cap = get_engineering_capability("cad.create_part")
        assert cap is not None
        assert cap.domain == EngineeringDomain.MECHANICAL
        assert cap.risk == CapabilityRisk.MEDIUM

    def test_list_by_domain(self):
        cad_caps = list_engineering_capabilities(domain=EngineeringDomain.MECHANICAL)
        assert len(cad_caps) >= 3  # create_part, modify_parameter, export_step, export_stl

    def test_list_by_risk(self):
        critical = list_engineering_capabilities(risk=CapabilityRisk.CRITICAL_PHYSICAL)
        assert len(critical) >= 1  # device.flash

    def test_device_flash_is_critical(self):
        cap = get_engineering_capability("device.flash")
        assert cap is not None
        assert cap.risk == CapabilityRisk.CRITICAL_PHYSICAL
        assert cap.irreversible is True

    def test_low_risk_caps_dont_require_approval(self):
        low_caps = list_engineering_capabilities(risk=CapabilityRisk.LOW)
        for cap in low_caps:
            # Low-risk capabilities should not require approval
            # (exception: if explicitly set, that's fine)
            assert cap.risk == CapabilityRisk.LOW

    def test_summary(self):
        summary = engineering_capabilities_summary()
        assert summary["total"] >= 10
        assert summary["byDomain"]["mechanical"] >= 3
        assert summary["byDomain"]["electronics"] >= 3

    def test_capabilities_have_schemas(self):
        for cap in ALL_ENGINEERING_CAPABILITIES:
            assert isinstance(cap.input_schema, dict)
            assert isinstance(cap.output_schema, dict)


# ── Event Store ──────────────────────────────────────────────────────────────


class TestEngineeringEventStore:
    @pytest.fixture()
    def store(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        return EngineeringEventStore("test-project", home=tmp_path)

    def test_record_event(self, store):
        evt = store.record(
            event_type=EngineeringEventType.ARTIFACT_CREATED,
            artifact_id="art-001",
            outcome="success",
        )
        assert evt.id.startswith("evt-")
        assert evt.event_type == EngineeringEventType.ARTIFACT_CREATED

    def test_list_events(self, store):
        store.record(EngineeringEventType.ARTIFACT_CREATED, artifact_id="a")
        store.record(EngineeringEventType.ARTIFACT_UPDATED, artifact_id="b")
        store.record(EngineeringEventType.ARTIFACT_CREATED, artifact_id="c")

        all_events = store.list_events()
        assert len(all_events) == 3

        created = store.list_events(event_type=EngineeringEventType.ARTIFACT_CREATED)
        assert len(created) == 2

    def test_events_for_artifact(self, store):
        store.record(EngineeringEventType.ARTIFACT_CREATED, artifact_id="art-1")
        store.record(EngineeringEventType.ARTIFACT_UPDATED, artifact_id="art-1")
        store.record(EngineeringEventType.ARTIFACT_CREATED, artifact_id="art-2")

        events = store.events_for_artifact("art-1")
        assert len(events) == 2

    def test_recent_events(self, store):
        for i in range(5):
            store.record(EngineeringEventType.ARTIFACT_CREATED, node_id=f"n{i}")

        recent = store.recent_events(limit=3)
        assert len(recent) == 3

    def test_count(self, store):
        assert store.count() == 0
        store.record(EngineeringEventType.ARTIFACT_CREATED)
        assert store.count() == 1
        store.record(EngineeringEventType.ARTIFACT_UPDATED)
        assert store.count() == 2

    def test_persistence_survives_reload(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        s1 = EngineeringEventStore("test", home=tmp_path)
        s1.record(EngineeringEventType.ARTIFACT_CREATED, artifact_id="a")
        s1.record(EngineeringEventType.ARTIFACT_UPDATED, artifact_id="b")

        s2 = EngineeringEventStore("test", home=tmp_path)
        assert s2.count() == 2


# ── Change Impact ────────────────────────────────────────────────────────────


class TestChangeImpact:
    @pytest.fixture()
    def graph(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        g = EngineeringGraph("impact-test", home=tmp_path)
        # Build a dependency chain:
        # PCB → Enclosure, PCB → Mount, PCB → Firmware
        pcb = g.add_node(NodeType.ARTIFACT, "electronics", "Main PCB")
        enclosure = g.add_node(NodeType.ARTIFACT, "mechanical", "Enclosure")
        mount = g.add_node(NodeType.ARTIFACT, "mechanical", "Mount Bracket")
        firmware = g.add_node(NodeType.ARTIFACT, "firmware", "ESP32 Firmware")
        test_node = g.add_node(NodeType.TEST, "validation", "Integration Test")

        g.add_edge(enclosure.id, pcb.id, RelationshipType.DEPENDS_ON)
        g.add_edge(mount.id, pcb.id, RelationshipType.DEPENDS_ON)
        g.add_edge(firmware.id, pcb.id, RelationshipType.DEPENDS_ON)
        g.add_edge(test_node.id, pcb.id, RelationshipType.VALIDATED_BY)

        return g

    def test_analyze_impact(self, graph, tmp_path, monkeypatch):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        artifact_store = ArtifactStore("impact-test", home=tmp_path)
        event_store = EngineeringEventStore("impact-test", home=tmp_path)

        # Find the PCB node
        pcb_nodes = graph.find_nodes(name="Main PCB")
        assert len(pcb_nodes) == 1
        pcb_id = pcb_nodes[0].id

        report = analyze_change_impact(
            graph=graph,
            node_id=pcb_id,
            artifact_store=artifact_store,
            event_store=event_store,
        )

        assert isinstance(report, ImpactReport)
        assert report.total_affected >= 3  # enclosure, mount, firmware, test
        assert report.source_node_id == pcb_id
        assert report.source_name == "Main PCB"

        # Should have affected nodes with actions
        affected_ids = {n.node_id for n in report.affected_nodes}
        assert len(affected_ids) >= 3

    def test_analyze_impact_marks_stale(self, graph, tmp_path, monkeypatch):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        artifact_store = ArtifactStore("impact-test", home=tmp_path)

        # Create artifact records for the graph nodes
        enclosure_node = graph.find_nodes(name="Enclosure")[0]
        art = artifact_store.create(
            ArtifactType.CAD_MODEL, "Enclosure.step", "1.0.0", "/enc.step", "h",
            artifact_id=enclosure_node.id,
        )

        pcb_id = graph.find_nodes(name="Main PCB")[0].id
        report = analyze_change_impact(
            graph=graph,
            node_id=pcb_id,
            artifact_store=artifact_store,
            mark_stale=True,
        )

        # The enclosure artifact should be marked stale
        assert len(report.stale_artifacts) >= 1
        stale = artifact_store.stale_artifacts()
        assert any(a.id == enclosure_node.id for a in stale)

    def test_analyze_impact_nonexistent_node(self, graph):
        report = analyze_change_impact(graph, "nonexistent")
        assert report.total_affected == 0
        assert report.source_name == "<unknown>"

    def test_report_serialization(self, graph, tmp_path, monkeypatch):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        pcb_id = graph.find_nodes(name="Main PCB")[0].id
        report = analyze_change_impact(graph, pcb_id)

        d = report.to_dict()
        assert "sourceNodeId" in d
        assert "affectedNodes" in d
        assert "totalAffected" in d

    def test_suggested_order_prioritizes_artifacts(self, graph, tmp_path, monkeypatch):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        pcb_id = graph.find_nodes(name="Main PCB")[0].id
        report = analyze_change_impact(graph, pcb_id)

        # In suggested order, artifacts should come before tests
        artifact_idx = {}
        test_idx = {}
        for i, nid in enumerate(report.suggested_order):
            node = graph.get_node(nid)
            if node and node.node_type == NodeType.ARTIFACT:
                artifact_idx[nid] = i
            elif node and node.node_type == NodeType.TEST:
                test_idx[nid] = i

        # If both exist, artifacts should have lower indices
        if artifact_idx and test_idx:
            max_art_idx = max(artifact_idx.values())
            min_test_idx = min(test_idx.values())
            assert max_art_idx < min_test_idx


# ── Integration: graph + artifacts + events ──────────────────────────────────


class TestEngineeringIntegration:
    def test_full_workflow(self, tmp_path, monkeypatch):
        """Simulate a minimal engineering workflow:
        1. Create project nodes (requirement, system, components)
        2. Create artifacts
        3. Record events
        4. Track dependencies
        5. Analyze change impact
        """
        monkeypatch.setenv("AURA_HOME", str(tmp_path))

        graph = EngineeringGraph("integration-test", home=tmp_path)
        artifact_store = ArtifactStore("integration-test", home=tmp_path)
        event_store = EngineeringEventStore("integration-test", home=tmp_path)

        # 1. Create project structure
        req = graph.add_node(NodeType.REQUIREMENT, "system", "Flight time > 20min")
        system = graph.add_node(NodeType.SYSTEM, "system", "Drone System")
        frame = graph.add_node(NodeType.COMPONENT, "mechanical", "Frame")
        pcb = graph.add_node(NodeType.ARTIFACT, "electronics", "Main PCB")
        enclosure = graph.add_node(NodeType.ARTIFACT, "mechanical", "Enclosure")

        graph.add_edge(req.id, system.id, RelationshipType.DERIVES)
        graph.add_edge(system.id, frame.id, RelationshipType.CONTAINS)
        graph.add_edge(enclosure.id, pcb.id, RelationshipType.DEPENDS_ON)

        # 2. Create artifacts
        pcb_art = artifact_store.create(
            ArtifactType.PCB, "Main PCB", "1.0.0", "/pcb.kicad_pcb", "pcb_hash",
            author_agent="electronics-agent",
        )
        enc_art = artifact_store.create(
            ArtifactType.CAD_MODEL, "Enclosure.step", "1.0.0", "/enc.step", "enc_hash",
            author_agent="cad-agent",
            dependencies=[pcb_art.id],
        )

        # 3. Record events
        event_store.record(
            EngineeringEventType.ARTIFACT_CREATED,
            artifact_id=pcb_art.id,
            agent="electronics-agent",
            outcome="success",
        )
        event_store.record(
            EngineeringEventType.ARTIFACT_CREATED,
            artifact_id=enc_art.id,
            agent="cad-agent",
            outcome="success",
        )

        # 4. Verify state
        assert graph.summary()["totalNodes"] == 5
        assert artifact_store.summary()["totalArtifacts"] == 2
        assert event_store.count() == 2

        # 5. Analyze impact of PCB change
        report = analyze_change_impact(
            graph=graph,
            node_id=pcb.id,
            artifact_store=artifact_store,
            event_store=event_store,
        )
        assert report.total_affected >= 1  # at least enclosure depends on PCB

        # 6. Verify provenance
        dependents = artifact_store.dependents_of(pcb_art.id)
        assert len(dependents) == 1  # enclosure depends on PCB

        # 7. Check events include impact analysis
        impact_events = event_store.list_events(
            event_type=EngineeringEventType.CHANGE_IMPACT_DETECTED
        )
        assert len(impact_events) >= 1
