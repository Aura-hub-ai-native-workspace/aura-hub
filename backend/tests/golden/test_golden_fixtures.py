"""Golden fixture harness — schema-validate + model round-trip for all 10 goldens.

Gate rules (mission §11):
  1. every golden validates against its frozen JSON Schema;
  2. every golden deserializes into the corresponding Pydantic contract;
  3. re-serialization is BYTE-stable for the pinned store formats
     (pretty indent-2, no trailing newline; compact+\\n for JSONL);
  4. extras survive round-trips (no silent field drops).
"""

from __future__ import annotations

import json

import pytest
from jsonschema import Draft202012Validator

from aura.contracts import (
    ApprovalRequest,
    AuditRecord,
    AutomationRule,
    AutomationRun,
    PolicyConfig,
    ProvidersStore,
    ScheduleState,
    Workflow,
    WorkflowRun,
    WorkflowVersion,
)
from aura.jsonutil import dumps_compact, dumps_pretty, read_jsonl

from _paths import GOLDEN_DIR, SCHEMA_DIR


def _pairs():
    return [
        ("policy-config.schema.json", GOLDEN_DIR / "fabric-policy.json", PolicyConfig, "object"),
        ("approval-request.schema.json", GOLDEN_DIR / "fabric-approvals.json", ApprovalRequest, "array"),
        ("workflow.schema.json", GOLDEN_DIR / "workflows" / "wf-demo.json", Workflow, "object"),
        ("workflow-version.schema.json", GOLDEN_DIR / "workflow-versions" / "wf-demo" / "wv-demo-0001.json", WorkflowVersion, "object"),
        ("workflow-run.schema.json", GOLDEN_DIR / "workflow-runs" / "wf-demo" / "wr-demo-0001.json", WorkflowRun, "object"),
        ("automation-rule.schema.json", GOLDEN_DIR / "automation" / "rules" / "rule-demo.json", AutomationRule, "object"),
        ("automation-run.schema.json", GOLDEN_DIR / "automation" / "runs" / "ar-demo-0001.json", AutomationRun, "object"),
        ("providers-store.schema.json", GOLDEN_DIR / "providers-store.json", ProvidersStore, "object"),
        ("schedule-state.schema.json", GOLDEN_DIR / "automation" / "schedule-state.json", ScheduleState, "object"),
        ("audit-record.schema.json", GOLDEN_DIR / "fabric-audit.jsonl", AuditRecord, "jsonl"),
    ]


@pytest.mark.parametrize("schema_name,golden,model,kind", _pairs())
def test_golden_schema_and_model(schema_name, golden, model, kind):
    schema = json.loads((SCHEMA_DIR / schema_name).read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema)

    raw = golden.read_text(encoding="utf-8")
    if kind == "jsonl":
        instances = [json.loads(ln) for ln in raw.split("\n") if ln.strip()]
    else:
        data = json.loads(raw)
        instances = data if isinstance(data, list) else [data]

    for inst in instances:
        errs = list(validator.iter_errors(inst))
        assert not errs, f"{golden.name}: {errs[0].message}"
        m = model.model_validate(inst)  # must deserialize cleanly
        assert m is not None


@pytest.mark.parametrize(
    "golden,model",
    [
        (GOLDEN_DIR / "fabric-policy.json", PolicyConfig),
        (GOLDEN_DIR / "workflows" / "wf-demo.json", Workflow),
        (GOLDEN_DIR / "workflow-versions" / "wf-demo" / "wv-demo-0001.json", WorkflowVersion),
        (GOLDEN_DIR / "workflow-runs" / "wf-demo" / "wr-demo-0001.json", WorkflowRun),
        (GOLDEN_DIR / "automation" / "rules" / "rule-demo.json", AutomationRule),
        (GOLDEN_DIR / "automation" / "runs" / "ar-demo-0001.json", AutomationRun),
        (GOLDEN_DIR / "providers-store.json", ProvidersStore),
        (GOLDEN_DIR / "automation" / "schedule-state.json", ScheduleState),
    ],
)
def test_store_byte_stability(golden, model):
    """parse → pretty-dump must reproduce the file EXACTLY (frozen write format)."""
    raw = golden.read_text(encoding="utf-8")
    m = model.model_validate(json.loads(raw))
    assert dumps_pretty(m.wire()) == raw, f"{golden.name}: round-trip not byte-stable"


def test_approvals_array_byte_stability():
    raw = (GOLDEN_DIR / "fabric-approvals.json").read_text(encoding="utf-8")
    items = [ApprovalRequest.model_validate(x) for x in json.loads(raw)]
    dumped = "[\n" + ",\n".join(
        "\n".join("  " + ln for ln in dumps_pretty(m.wire()).split("\n")) for m in items
    ) + "\n]"
    assert dumped == raw


def test_audit_jsonl_byte_stability_and_tolerant_read():
    raw = (GOLDEN_DIR / "fabric-audit.jsonl").read_text(encoding="utf-8")
    lines = [ln for ln in raw.split("\n") if ln.strip()]
    for ln in lines:
        rec = AuditRecord.model_validate_json(ln)
        assert dumps_compact(rec.wire()) == ln
    loaded = read_jsonl(GOLDEN_DIR / "fabric-audit.jsonl")
    assert loaded and loaded[0]["invocationId"] == "invdemo00001"


def test_extras_survive_roundtrip():
    """No silent field drops: unknown keys ride through parse → dump."""
    data = json.loads((GOLDEN_DIR / "fabric-policy.json").read_text(encoding="utf-8"))
    data["someFutureField"] = {"kept": True}
    m = PolicyConfig.model_validate(data)
    assert m.wire()["someFutureField"] == {"kept": True}
