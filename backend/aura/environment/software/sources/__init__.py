"""Source adapters — every place AURA can learn about software.

One interface, so a later adapter (Homebrew, winget, crates.io) is a new
file rather than a change to the resolver. Adapters return DESCRIPTIONS
only: none of them may return an install command, and the resolver does
not ask for one. Installation authority lives in the curated catalogue
and nowhere else.
"""

from .base import SoftwareSource, SourceResult
from .npm import NpmSource
from .pypi import PyPISource

__all__ = ["SoftwareSource", "SourceResult", "NpmSource", "PyPISource",
           "external_sources"]


def external_sources() -> list[SoftwareSource]:
    """Network adapters, in the order the resolver should try them."""
    return [NpmSource(), PyPISource()]
