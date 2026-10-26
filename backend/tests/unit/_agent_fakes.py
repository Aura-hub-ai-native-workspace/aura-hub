"""Shared fakes for agent runtime configuration tests."""

from __future__ import annotations

from pathlib import Path

from aura.agent_runtime.model import AgentRecord, ConfigStatus, ConfigurationChange


class FakeAdapter:
    """Minimal adapter: writes ``new_bytes`` to its files, then reports as configured."""

    def __init__(self, path: Path, *, companions=(), new_bytes=b"NEW\n",
                 apply_raises=None, partial_then_raise=False,
                 verify_status=ConfigStatus.OK, verify_raises=None,
                 verify_side_effect=None):
        self.path = path
        self.companions = list(companions)
        self.new_bytes = new_bytes
        self.apply_raises = apply_raises
        self.partial_then_raise = partial_then_raise
        self.verify_status = verify_status
        self.verify_raises = verify_raises
        self.verify_side_effect = verify_side_effect
        self.apply_calls = 0

    def mutable_paths(self):
        return [self.path, *self.companions]

    def readCurrentConfig(self) -> AgentRecord:
        return AgentRecord(
            agent_id="fake", display_name="Fake", version=None, binary_path=None,
            config_path=str(self.path), detected=True, adapter_class="fake",
            config_status=ConfigStatus.OK)

    def apply(self, runtime) -> ConfigurationChange:
        self.apply_calls += 1
        self.path.write_bytes(self.new_bytes)
        for companion in self.companions:
            companion.write_bytes(b"COMPANION-NEW\n")
        if self.partial_then_raise:
            raise RuntimeError("disk went away mid-write")
        if self.apply_raises:
            raise self.apply_raises
        return ConfigurationChange(agent_id="fake", operation="apply",
                                   status=ConfigStatus.OK, fields_changed=["x"],
                                   previous_checksum=None, new_checksum=None)

    def verify(self, runtime) -> ConfigurationChange:
        if self.verify_side_effect:
            self.verify_side_effect(self.path)
        if self.verify_raises:
            raise self.verify_raises
        return ConfigurationChange(agent_id="fake", operation="verify",
                                   status=self.verify_status, fields_changed=[],
                                   previous_checksum=None, new_checksum=None,
                                   note="checked")


class FakeRegistry:
    def __init__(self, adapter):
        self._adapter = adapter

    def adapter_for(self, agent_id):
        return self._adapter
