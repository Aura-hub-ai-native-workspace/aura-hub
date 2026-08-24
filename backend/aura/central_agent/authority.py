"""Authority checking — the agent READS the policy engine's answer.

Every planned capability is prefetched through aura.fabric.describe_authority
(the same evaluation invoke() will perform). The checker decides nothing:
it mirrors decisions into AuthorityRequirement and marks a plan blocked on
deny. ask-user / require-approval become approval expectations, never
obstacles to route around.
"""

from __future__ import annotations

from ..contracts import AuthorityRequirement, TaskPlan
from ..fabric import FabricConfig, describe_authority


class AuthorityChecker:
    def __init__(self, fabric_cfg: FabricConfig) -> None:
        self._cfg = fabric_cfg

    def check_plan(self, plan: TaskPlan, project_id: str | None,
                   project_path: str | None = None) -> list[AuthorityRequirement]:
        out: list[AuthorityRequirement] = []
        for task in plan.tasks:
            if not task.capabilityId:
                continue
            requested_scope = task.input.get("path") \
                if isinstance(task.input, dict) else None
            raw = describe_authority(
                task.capabilityId,
                {"actor": {"kind": "agent", "id": "central-agent"},
                 "projectId": project_id, "taskId": task.id},
                self._cfg,
            )
            # EFFECTIVE scope is policy's confinement of the request: for
            # project-confined capabilities that IS the project root. The
            # agent cannot widen it; it can only report it.
            effective_scope = requested_scope
            if requested_scope and project_path:
                effective_scope = f"{project_path.rstrip('/')}/{requested_scope.lstrip('/')}"
            if raw is None:
                out.append(AuthorityRequirement(
                    capabilityId=task.capabilityId,
                    decision="deny", rule="unknown-capability",
                    reason="The Fabric does not know this capability.",
                    risk=task.risk, available=False, approvalRequired=False,
                ))
                continue
            out.append(AuthorityRequirement(
                capabilityId=task.capabilityId,
                decision=raw["decision"],
                rule=raw["rule"],
                reason=raw["reason"],
                risk=raw["risk"],
                available=True,
                approvalRequired=raw["decision"] in ("ask-user", "require-approval"),
                requestedScope=requested_scope,
                effectiveScope=effective_scope,
            ))
        return out

    @staticmethod
    def blocked(requirements: list[AuthorityRequirement]) -> list[str]:
        return [
            f"{r.capabilityId}: {r.reason}"
            for r in requirements if r.decision == "deny"
        ]

    @staticmethod
    def expected_approvals(requirements: list[AuthorityRequirement]) -> int:
        return sum(1 for r in requirements if r.approvalRequired)
