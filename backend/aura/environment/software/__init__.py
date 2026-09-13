"""Software discovery — what AURA knows about software, and how sure it is.

Three layers, kept apart on purpose:

    identity/classify   what a piece of software IS
    sources/ + cache    what the world says about it
    installability      whether AURA will act on it

Only the last consults the curated catalogue, and only the curated
catalogue can authorise an install. Nothing in this package builds,
stores or returns a command — see `test_software_discovery` for the test
that keeps it that way.
"""

from .identity import (
    SoftwareKind,
    SoftwareRecord,
    SoftwareState,
    Trust,
    canonical_id,
)

__all__ = ["SoftwareKind", "SoftwareRecord", "SoftwareState", "Trust",
           "canonical_id"]
