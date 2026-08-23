"""Error taxonomy shared by every subsystem.

HTTP mapping happens once, in the API layer; inner layers raise these and
never construct HTTP responses themselves.
"""

from __future__ import annotations


class AuraError(Exception):
    """Base class. `code` is a stable machine-readable identifier."""

    code = "internal-error"
    http_status = 500

    def __init__(self, message: str, *, code: str | None = None):
        super().__init__(message)
        if code is not None:
            self.code = code

    def payload(self) -> dict:
        return {"error": self.code, "message": str(self)}


class ValidationFailure(AuraError):
    code = "invalid-request"
    http_status = 400


class NotFoundError(AuraError):
    code = "not-found"
    http_status = 404


class DeniedError(AuraError):
    """A governance denial — policy, approval, resolution or floor.

    Denials are outcomes, not crashes: they are auditable results of the
    fabric pipeline, and must never be conflated with internal errors.
    """

    code = "denied"
    http_status = 403
