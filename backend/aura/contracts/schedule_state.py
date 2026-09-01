"""ScheduleState — schema/schedule-state.schema.json.

Empty object when no schedule rules are enabled (observed live). Kept
schema-open so the Phase 7 field-level freeze can extend it without breaking
readers.
"""

from __future__ import annotations

from ._base import ContractModel


class ScheduleState(ContractModel):
    pass  # open model: everything is extra, preserved on round-trip
