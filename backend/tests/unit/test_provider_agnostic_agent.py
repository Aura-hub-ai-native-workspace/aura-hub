"""The Central Agent is provider-agnostic (correction brief TEST 14).

The agent asks the shared AI runtime for inference through the
ModelPort abstraction, configured by an operator-written provider
file. It must never name a commercial provider — no preferred model,
no vendor endpoint, no vendor key variable, no per-task provider
branch. "OpenAI-compatible" is a wire shape, not a provider, and is
allowed; everything below names a vendor and is not.

Run with `python3 -m pytest backend/tests/unit/test_provider_agnostic_agent.py`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

AGENT_DIR = Path(__file__).resolve().parents[2] / "aura" / "central_agent"

#: Vendor markers that must never appear in agent sources. Each names a
#: company endpoint, a company key variable, or a company model — the
#: three ways provider-specific logic smuggles itself in.
FORBIDDEN = (
    "api.x.ai",
    "api.openai.com",
    "api.anthropic.com",
    "api.groq.com",
    "api.mistral.ai",
    "xai_api_key",
    "anthropic_api_key",
    "openai_api_key",
    "groq_api_key",
    "grok-4",
    "grok-3",
    "grok-2",
    "claude-3",
    "gpt-4",
    "gpt-3.5",
    "gemini-1",
    "gemini-2",
)


def _agent_sources() -> list[Path]:
    return sorted(AGENT_DIR.glob("*.py"))


class TestNoVendorInAgent:
    def test_agent_package_exists(self) -> None:
        assert AGENT_DIR.is_dir()
        assert _agent_sources(), "no agent sources found to scan"

    @pytest.mark.parametrize("marker", FORBIDDEN)
    def test_no_vendor_marker_in_agent_sources(self, marker: str) -> None:
        offenders = [
            f"{p.name}:{i}"
            for p in _agent_sources()
            for i, line in enumerate(
                p.read_text(encoding="utf-8").splitlines(), start=1)
            if marker.lower() in line.lower()
        ]
        assert offenders == [], f"vendor marker {marker!r} in agent: {offenders}"

    def test_routing_stays_abstraction_shaped(self) -> None:
        """The routing module exposes the operator file + port seam and
        nothing vendor-shaped: ProviderSpec carries an env var NAME
        (never a secret) and a base URL the operator wrote."""
        from aura.central_agent.model_routing import ProviderSpec, load_providers

        fields = set(ProviderSpec.__dataclass_fields__)
        assert {"id", "base_url", "model", "api_key_env"} <= fields
        assert load_providers("/nonexistent/providers.json") == []
