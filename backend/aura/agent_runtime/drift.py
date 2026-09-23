"""DriftDetector — compare AURA-expected config vs what is actually on disk."""

from __future__ import annotations

from aura.agent_runtime.model import (
    AgentRecord,
    ConfigurationDrift,
    DriftStatus,
    RuntimeConfig,
)


class DriftDetector:

    def check(self, record: AgentRecord, expected: RuntimeConfig) -> ConfigurationDrift:
        """Compare a freshly-read AgentRecord against the expected RuntimeConfig."""
        if not record.detected:
            return ConfigurationDrift(
                agent_id=record.agent_id,
                status=DriftStatus.UNKNOWN,
                drifted_fields=[],
                expected_base_url=expected.base_url,
                actual_base_url=None,
                expected_model=expected.model_id,
                actual_model=None,
            )

        drifted: list[str] = []
        actual_url = record.current_base_url
        actual_model = record.current_model

        if actual_url != expected.base_url:
            drifted.append("baseUrl")
        # model is optional — some agents (Claude Code) don't store it in config
        if actual_model is not None and actual_model != expected.model_id:
            drifted.append("model")

        return ConfigurationDrift(
            agent_id=record.agent_id,
            status=DriftStatus.DRIFTED if drifted else DriftStatus.IN_SYNC,
            drifted_fields=drifted,
            expected_base_url=expected.base_url,
            actual_base_url=actual_url,
            expected_model=expected.model_id,
            actual_model=actual_model,
        )

    def check_all(
        self,
        records: list[AgentRecord],
        expected: RuntimeConfig,
    ) -> list[ConfigurationDrift]:
        return [self.check(r, expected) for r in records]
