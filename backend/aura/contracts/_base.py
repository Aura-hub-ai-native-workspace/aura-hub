"""Shared contract primitives: the base model and frozen vocabularies."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

# Frozen vocabularies (schemas are the authority; never widen here).
PolicyDecision = Literal["auto-execute", "ask-user", "require-approval", "deny"]
RiskLevel = Literal["low", "medium", "high"]


class ContractModel(BaseModel):
    """Base for every persisted/wire model.

    extra="allow"  — unknown fields survive round-trips (no silent drops).
    Wire naming is the artifact's own naming; fields shadowing Python keywords
    use Field(alias=...) and MUST be dumped via wire() (by_alias).
    """

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    def wire(self) -> dict:
        """Serialize exactly as stored/on the wire.

        exclude_unset drops fields never provided (they were ABSENT in the
        source artifact — absent ≠ null, and collapsing them would corrupt
        byte-stability); explicitly-null fields are kept.
        """
        return self.model_dump(by_alias=True, exclude_unset=True)
