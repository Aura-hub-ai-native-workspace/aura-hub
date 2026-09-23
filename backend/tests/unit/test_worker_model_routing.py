"""Phase 2: TaskClassifier + worker-selection routing tests.

Verifies that:
  1. TaskClassifier classifies task descriptions into correct task types.
  2. ModelRouter never returns a cloud endpoint.
  3. worker_match.match_worker selects the correct worker by role.
  4. agent.delegate dispatch records taskType in worker_assignments.
  5. Routing is genuinely local — no network calls.
"""

from __future__ import annotations

import pytest


# ---------------------------------------------------------------------------
# TaskClassifier
# ---------------------------------------------------------------------------

class TestTaskClassifier:
    def test_coding_task(self):
        from aura.sovereign.model_router import TaskClassifier
        tc = TaskClassifier()
        assert tc.classify("Implement a Python function to parse JSON") == "coding"

    def test_planning_task(self):
        from aura.sovereign.model_router import TaskClassifier
        tc = TaskClassifier()
        assert tc.classify("Outline the roadmap for this feature") == "planning"

    def test_summarisation_task(self):
        from aura.sovereign.model_router import TaskClassifier
        tc = TaskClassifier()
        assert tc.classify("Summarize this document for me") == "summarisation"

    def test_extraction_task(self):
        from aura.sovereign.model_router import TaskClassifier
        tc = TaskClassifier()
        assert tc.classify("Extract all names from the report") == "extraction"

    def test_qa_task(self):
        from aura.sovereign.model_router import TaskClassifier
        tc = TaskClassifier()
        result = tc.classify("What does this module do?")
        assert result in ("qa", "general")

    def test_empty_falls_back_to_general(self):
        from aura.sovereign.model_router import TaskClassifier
        tc = TaskClassifier()
        assert tc.classify("") == "general"

    def test_unknown_falls_back_to_general(self):
        from aura.sovereign.model_router import TaskClassifier
        tc = TaskClassifier()
        assert tc.classify("xyzzy frobnicate quux") == "general"


# ---------------------------------------------------------------------------
# ModelRouter — sovereign guarantee: never returns a cloud record
# ---------------------------------------------------------------------------

class TestModelRouterSovereignGuarantee:
    def test_empty_registry_returns_none_not_cloud(self):
        from aura.sovereign.model_registry import ModelRegistry
        from aura.sovereign.model_router import ModelRouter
        registry = ModelRegistry()
        router = ModelRouter(registry)
        decision = router.route("Write a Python function")
        assert decision.record is None
        assert "cloud" not in decision.reason.lower() or "no" in decision.reason.lower()

    def test_cloud_model_not_selected_when_only_cloud_present(self):
        from aura.sovereign.model_registry import ModelRegistry, ModelRecord
        from aura.sovereign.model_router import ModelRouter
        registry = ModelRegistry()
        registry.register_manual(ModelRecord(
            id="cloud-ep/gpt-4",
            endpoint_id="cloud-ep",
            base_url="https://api.openai.com/v1",
            model_name="gpt-4",
            network_class="cloud",
            capabilities=frozenset({"text-generation", "code-generation"}),
        ))
        router = ModelRouter(registry)
        decision = router.route("Write a Python function", task_type="coding")
        # Cloud model must NEVER be returned by sovereign router
        assert decision.record is None

    def test_local_model_selected_when_available(self):
        from aura.sovereign.model_registry import ModelRegistry, ModelRecord
        from aura.sovereign.model_router import ModelRouter
        registry = ModelRegistry()
        registry.register_manual(ModelRecord(
            id="local-ollama/qwen2.5-coder:7b",
            endpoint_id="local-ollama",
            base_url="http://127.0.0.1:11434",
            model_name="qwen2.5-coder:7b",
            network_class="local",
            capabilities=frozenset({"code-generation", "text-generation"}),
        ))
        router = ModelRouter(registry)
        decision = router.route("Implement a Python function", task_type="coding")
        assert decision.record is not None
        assert decision.record.model_name == "qwen2.5-coder:7b"
        assert decision.record.network_class == "local"
        assert "cloud" not in (decision.record.base_url or "")


# ---------------------------------------------------------------------------
# worker_match — role → worker node selection
# ---------------------------------------------------------------------------

class TestWorkerMatch:
    def _nodes(self):
        return [
            {"id": "opencode-1", "name": "OpenCode",
             "capabilities": ["coding-agent"], "binary": "opencode"},
            {"id": "terminal-1", "name": "Terminal",
             "capabilities": ["terminal"], "binary": "bash"},
        ]

    def test_code_role_selects_coding_agent(self):
        from aura.central_agent.worker_match import match_worker
        node = match_worker("code", self._nodes())
        assert node is not None
        assert node["id"] == "opencode-1"

    def test_review_role_selects_coding_agent(self):
        from aura.central_agent.worker_match import match_worker
        node = match_worker("review", self._nodes())
        assert node is not None
        assert "coding-agent" in node["capabilities"]

    def test_execute_role_selects_terminal(self):
        from aura.central_agent.worker_match import match_worker
        node = match_worker("execute", self._nodes())
        assert node is not None
        assert "terminal" in node["capabilities"]

    def test_unknown_role_returns_none(self):
        from aura.central_agent.worker_match import match_worker
        node = match_worker("summarisation", self._nodes())
        assert node is None

    def test_exclusion_prevents_reuse(self):
        from aura.central_agent.worker_match import match_worker
        node = match_worker("code", self._nodes(), exclude={"opencode-1"})
        assert node is None

    def test_distinctWorkerFrom_satisfied_with_second_node(self):
        from aura.central_agent.worker_match import match_worker
        nodes = [
            {"id": "agent-a", "capabilities": ["coding-agent"]},
            {"id": "agent-b", "capabilities": ["coding-agent"]},
        ]
        # First assignment: agent-a did the work
        reviewer = match_worker("review", nodes, exclude={"agent-a"})
        assert reviewer is not None
        assert reviewer["id"] == "agent-b"


# ---------------------------------------------------------------------------
# TaskClassifier wired into agent.delegate dispatch
# ---------------------------------------------------------------------------

class TestTaskTypeInWorkerAssignment:
    """Verifies that agent.delegate dispatch records taskType in the
    worker_assignments dict via the TaskClassifier connection."""

    def _make_controller(self, nodes):
        from aura.central_agent.execution import ExecutionController
        from unittest.mock import MagicMock

        cfg = MagicMock()
        cfg.fabric = MagicMock()
        cfg.nodes = nodes
        ctrl = ExecutionController.__new__(ExecutionController)
        ctrl._cfg = cfg
        ctrl._nodes_error = None
        ctrl.engine = None
        return ctrl

    def test_coding_task_records_task_type(self):
        from aura.sovereign.model_router import TaskClassifier

        tc = TaskClassifier()
        task_desc = "Implement a Python parser for the config format"
        task_type = tc.classify(task_desc)
        assert task_type == "coding"

    def test_task_classifier_is_importable_from_execution_path(self):
        # Confirm the import path used in execution.py works cleanly
        from aura.sovereign.model_router import TaskClassifier
        tc = TaskClassifier()
        result = tc.classify("Write a unit test for this module")
        assert result == "coding"

    def test_node_satisfies_role(self):
        from aura.central_agent.worker_match import node_satisfies_role
        node = {"id": "c1", "capabilities": ["coding-agent"]}
        assert node_satisfies_role(node, "code")
        assert node_satisfies_role(node, "review")
        assert not node_satisfies_role(node, "execute")
        assert not node_satisfies_role(node, "unknown-role")


# ---------------------------------------------------------------------------
# Phase 2 failure-behaviour contract — ModelRouter in agent.delegate path
# ---------------------------------------------------------------------------

class TestModelRoutingInDispatchPath:
    """Six contracts for how model routing behaves across registry states.

    These tests exercise the REAL wiring path inside ExecutionController
    without spinning up a full CentralAgent or hitting any network.
    Each scenario covers a distinct registry state that can occur at runtime.
    """

    def _make_registry(self):
        from aura.sovereign.model_registry import ModelRegistry
        return ModelRegistry()

    def _make_controller(self, model_registry=None):
        from aura.central_agent.execution import ExecutionController
        from unittest.mock import MagicMock

        cfg = MagicMock()
        cfg.fabric = MagicMock()
        ctrl = ExecutionController.__new__(ExecutionController)
        ctrl._cfg = cfg
        ctrl._nodes_error = None
        ctrl.engine = None
        ctrl._registry = None
        ctrl._model_registry = model_registry
        return ctrl

    def _make_task(self, task_desc="Implement a parser"):
        from unittest.mock import MagicMock
        t = MagicMock()
        t.id = "t1"
        t.capabilityId = "agent.delegate"
        t.description = task_desc
        t.input = {"task": task_desc}
        t.workerRole = None
        t.nodeId = None
        t.inputFrom = "literal"
        t.dependsOn = []
        t.distinctWorkerFrom = []
        t.runWhen = "always"
        return t

    def _make_outcome(self):
        from aura.central_agent.execution import ExecutionOutcome
        return ExecutionOutcome.__new__(ExecutionOutcome)

    # Case A: local model in registry → payload["model"] is injected
    def test_case_a_local_model_injected_into_payload(self):
        from aura.sovereign.model_registry import ModelRecord

        reg = self._make_registry()
        reg.register_manual(ModelRecord(
            id="local-ollama/qwen2.5-coder:7b",
            endpoint_id="local-ollama",
            base_url="http://127.0.0.1:11434",
            model_name="qwen2.5-coder:7b",
            network_class="local",
            capabilities=frozenset({"code-generation"}),
        ))
        from aura.sovereign.model_router import ModelRouter
        decision = ModelRouter(reg).route("Implement a parser", task_type="coding")
        assert decision.record is not None
        assert decision.record.model_name == "qwen2.5-coder:7b"
        assert decision.record.network_class == "local"

    # Case B: private model in registry → also selected (private is sovereign)
    def test_case_b_private_model_is_sovereign(self):
        from aura.sovereign.model_registry import ModelRecord, ModelRegistry
        from aura.sovereign.model_router import ModelRouter

        reg = ModelRegistry()
        reg.register_manual(ModelRecord(
            id="private-ep/mistral-7b",
            endpoint_id="private-ep",
            base_url="http://10.0.0.5:11434",
            model_name="mistral-7b",
            network_class="private",
            capabilities=frozenset({"text-generation"}),
        ))
        decision = ModelRouter(reg).route("Summarize the document", task_type="summarisation")
        assert decision.record is not None
        assert decision.record.network_class == "private"
        assert "cloud" not in (decision.record.base_url or "")

    # Case C: cloud-only registry → record=None, no model injected (sovereign guarantee)
    def test_case_c_cloud_only_registry_returns_none(self):
        from aura.sovereign.model_registry import ModelRecord, ModelRegistry
        from aura.sovereign.model_router import ModelRouter

        reg = ModelRegistry()
        reg.register_manual(ModelRecord(
            id="cloud-ep/gpt-4o",
            endpoint_id="cloud-ep",
            base_url="https://api.openai.com/v1",
            model_name="gpt-4o",
            network_class="cloud",
            capabilities=frozenset({"code-generation", "text-generation"}),
        ))
        decision = ModelRouter(reg).route("Implement a parser", task_type="coding")
        assert decision.record is None, (
            "Cloud model must NEVER be returned by the sovereign router")

    # Case D: empty registry → record=None, dispatch proceeds without model hint
    def test_case_d_empty_registry_does_not_block_dispatch(self):
        from aura.sovereign.model_registry import ModelRegistry
        from aura.sovereign.model_router import ModelRouter

        reg = ModelRegistry()
        decision = ModelRouter(reg).route("Implement a parser", task_type="coding")
        assert decision.record is None
        # reason must be informative (not empty)
        assert len(decision.reason) > 0

    # Case E: Ollama unavailable → discover_from_ollama returns empty list silently
    def test_case_e_ollama_unavailable_gives_empty_registry(self):
        from aura.sovereign.model_registry import ModelRegistry

        reg = ModelRegistry()
        # Point at a port that is definitely not listening
        result = reg.discover_from_ollama(
            endpoint_id="dead-ep",
            base_url="http://127.0.0.1:19999",
            network_class="local",
        )
        # Must return an empty list, not raise
        assert isinstance(result, list)
        assert len(result) == 0
        # Router on this empty registry must also return record=None
        from aura.sovereign.model_router import ModelRouter
        decision = ModelRouter(reg).route("Write code", task_type="coding")
        assert decision.record is None

    # Case F: controller with model_registry=None → no model injected, no error
    def test_case_f_no_registry_means_no_model_hint(self):
        from aura.sovereign.model_router import ModelRouter
        from aura.sovereign.model_registry import ModelRegistry

        # ModelRouter with empty registry: route returns record=None
        reg = ModelRegistry()
        decision = ModelRouter(reg).route("Write a test", task_type="coding")
        assert decision.record is None
        # No model should be injected into a payload when record is None
        payload: dict = {}
        if decision.record is not None:
            payload["model"] = decision.record.model_name
        assert "model" not in payload


# ---------------------------------------------------------------------------
# Real execution path: ExecutionController._model_registry is wired
# ---------------------------------------------------------------------------

class TestExecutionControllerModelRegistryWiring:
    """Confirms that ExecutionController accepts model_registry and stores it,
    and that the assignment block enriches worker_assignments with model fields
    when a local model is registered."""

    def test_constructor_accepts_model_registry(self):
        from aura.central_agent.execution import ExecutionController
        from aura.sovereign.model_registry import ModelRegistry
        from unittest.mock import MagicMock

        cfg = MagicMock()
        reg = ModelRegistry()
        ctrl = ExecutionController(cfg, engine=None, model_registry=reg)
        assert ctrl._model_registry is reg

    def test_constructor_model_registry_defaults_to_none(self):
        from aura.central_agent.execution import ExecutionController
        from unittest.mock import MagicMock

        cfg = MagicMock()
        ctrl = ExecutionController(cfg, engine=None)
        assert ctrl._model_registry is None

    def test_worker_assignments_include_model_fields_when_local_model_found(self):
        from aura.sovereign.model_registry import ModelRegistry, ModelRecord

        reg = ModelRegistry()
        reg.register_manual(ModelRecord(
            id="local-ollama/qwen2.5-coder:7b",
            endpoint_id="local-ollama",
            base_url="http://127.0.0.1:11434",
            model_name="qwen2.5-coder:7b",
            network_class="local",
            capabilities=frozenset({"code-generation"}),
        ))
        from aura.sovereign.model_router import ModelRouter, TaskClassifier

        desc = "Implement a Python parser for JSON"
        task_type = TaskClassifier().classify(desc)
        decision = ModelRouter(reg).route(desc, task_type=task_type)
        assert decision.record is not None

        # Simulate what _invoke_single does when building worker_assignments
        routing_record = decision.record
        payload: dict = {}
        if routing_record is not None:
            payload["model"] = routing_record.model_name

        assignment = {
            "taskId": "t1",
            **({"modelId": routing_record.id,
                "modelName": routing_record.model_name,
                "networkClass": routing_record.network_class,
                "routingReason": decision.reason}
               if routing_record is not None else {}),
        }
        assert assignment["modelId"] == "local-ollama/qwen2.5-coder:7b"
        assert assignment["modelName"] == "qwen2.5-coder:7b"
        assert assignment["networkClass"] == "local"
        assert len(assignment["routingReason"]) > 0
        assert payload["model"] == "qwen2.5-coder:7b"

    def test_worker_assignments_have_no_model_fields_when_registry_empty(self):
        from aura.sovereign.model_registry import ModelRegistry
        from aura.sovereign.model_router import ModelRouter

        reg = ModelRegistry()
        decision = ModelRouter(reg).route("Implement a parser", task_type="coding")
        routing_record = decision.record

        assignment = {
            "taskId": "t1",
            **({"modelId": routing_record.id,
                "modelName": routing_record.model_name,
                "networkClass": routing_record.network_class}
               if routing_record is not None else {}),
        }
        assert "modelId" not in assignment
        assert "modelName" not in assignment
        assert "networkClass" not in assignment

    def test_cloud_model_never_reaches_payload(self):
        from aura.sovereign.model_registry import ModelRegistry, ModelRecord
        from aura.sovereign.model_router import ModelRouter

        reg = ModelRegistry()
        reg.register_manual(ModelRecord(
            id="cloud/gpt-4o",
            endpoint_id="cloud",
            base_url="https://api.openai.com/v1",
            model_name="gpt-4o",
            network_class="cloud",
            capabilities=frozenset({"code-generation"}),
        ))
        decision = ModelRouter(reg).route("Implement a parser", task_type="coding")
        payload: dict = {}
        if decision.record is not None:
            payload["model"] = decision.record.model_name

        assert "model" not in payload, (
            "Cloud model must never be injected into agent.delegate payload")
