"""Workflow definition — schema/workflow.schema.json (workflow/types.ts:71-100)."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from ._base import ContractModel

WfNodeType = Literal[
    "current-project", "selected-files", "changed-files", "current-conversation",
    "project-memory", "engineering-memory",
    "coding-engine", "fullstack-engine", "research-engine", "intent-classifier",
    "prompt-enhancer", "agent",
    "prompt", "groq", "generate-markdown", "generate-code", "generate-json",
    "condition", "loop", "delay", "variables", "user-input",
    "save-memory", "create-note", "export-file", "shell-command",
    "git-status", "git-diff", "git-commit", "git-branch", "http-request",
    "slack-notify", "output",
]


class WfNode(ContractModel):
    id: str
    type: WfNodeType
    x: float
    y: float
    config: dict


class WfEdge(ContractModel):
    id: str
    from_: str = Field(alias="from")
    fromPort: str  # 'out' | 'true' | 'false' | 'each' | 'done'
    to: str


class Workflow(ContractModel):
    id: str = Field(pattern=r"^wf-")
    name: str
    description: str
    category: str
    favorite: bool
    createdAt: str
    updatedAt: str
    nodes: list[WfNode]
    edges: list[WfEdge]
    # Lazily generated; NEVER included in list/export responses (frozen).
    webhookToken: str | None = None
