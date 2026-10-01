"""Sovereign infrastructure package.

Provides:
  policy       — SovereignPolicy: load/enforce ~/.aura/sovereign.json
  model_registry — ModelRegistry: discover and track private model inventory
  model_router   — ModelRouter: task-aware routing to private models

These modules together ensure AURA can run entirely on privately controlled
infrastructure with no runtime dependency on cloud LLM APIs.
"""

from .policy import SovereignPolicy, load_sovereign_policy, write_sovereign_config
from .model_registry import ModelRegistry, ModelRecord
from .model_router import ModelRouter, TaskClassifier, RoutingDecision

__all__ = [
    "SovereignPolicy",
    "load_sovereign_policy",
    "write_sovereign_config",
    "ModelRegistry",
    "ModelRecord",
    "ModelRouter",
    "TaskClassifier",
    "RoutingDecision",
]
