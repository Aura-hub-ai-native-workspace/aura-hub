"""Error taxonomy — every wire error body is exactly {"error": string}.

Frozen by docs/migration/wire-contracts.md §1. No stack traces, no extra
fields, no nesting on the wire. Internal exceptions carry context; the wire
projection never does.
"""

from __future__ import annotations

from typing import Any


class AuraError(Exception):
    """Base for backend errors that map to a wire error body."""

    def __init__(self, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status

    def to_wire(self) -> dict[str, Any]:
        return {"error": self.message}


class NotFound(AuraError):
    def __init__(self, message: str = "not found") -> None:
        super().__init__(message, status=404)


class Forbidden(AuraError):
    def __init__(self, message: str) -> None:
        super().__init__(message, status=403)
