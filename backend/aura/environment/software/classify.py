"""Is this a tool a person can use, or a library another package imports?

A registry is overwhelmingly libraries. If AURA Everything answered
"docker" with forty transitive dependencies that merely mention Docker,
the feature would be useless — so classification is what makes search
worth having, not a nicety.

The decision is made from structured metadata only, strongest evidence
first:

    an executable it declares      (npm `bin`, PyPI console_scripts)
    the curated catalogue's own category
    package classifiers / keywords
    naming conventions, last and weakest

A declared executable is the single most reliable signal available: a
package that installs a command is, by construction, something a person
runs. Nothing here executes anything, downloads anything, or asks a
model — it reads fields the registry already published.
"""

from __future__ import annotations

from .identity import SoftwareKind

#: Words that mark a package as an AI runtime AURA could delegate to.
_WORKER_HINTS = (
    "coding agent", "ai agent", "code assistant", "autonomous agent",
    "ai coding", "pair programmer", "agentic",
)
_RUNTIME_HINTS = ("runtime", "interpreter", "language runtime", "virtual machine")
_SERVICE_HINTS = ("server", "daemon", "database", "broker", "container runtime")
_FRAMEWORK_HINTS = ("framework", "toolkit", "scaffold")
_SDK_HINTS = ("sdk", "client library", "api client", "bindings")

#: Classifiers/keywords that positively mark a LIBRARY, whatever else it says.
_LIBRARY_HINTS = (
    "library", "utility functions", "helper", "polyfill", "type definitions",
    "typescript definitions", "plugin for", "middleware", "parser for",
)

#: PyPI trove classifiers that settle the question outright.
_PY_LIBRARY_CLASSIFIERS = ("Topic :: Software Development :: Libraries",)
_PY_APP_CLASSIFIERS = ("Environment :: Console", "Topic :: Utilities")


def _has(text: str, hints: tuple[str, ...]) -> bool:
    low = text.lower()
    return any(h in low for h in hints)


def classify(
    *,
    name: str,
    summary: str = "",
    keywords: list[str] | None = None,
    classifiers: list[str] | None = None,
    executables: list[str] | None = None,
    category: str = "",
) -> SoftwareKind:
    """Best-evidence kind for one package.

    `executables` must be names the SOURCE declared (npm `bin` keys,
    PyPI entry points). It is never derived from prose, and never used
    to build a command — only to answer "does this install something a
    person can run".
    """
    words = " ".join([name, summary, " ".join(keywords or [])])
    classifiers = classifiers or []
    execs = [e for e in (executables or []) if e]

    # The curated catalogue already decided; trust it over any heuristic.
    if category:
        cat = category.lower()
        if cat == "ai":
            return SoftwareKind.WORKER
        if cat in ("development", "browser"):
            return SoftwareKind.CLI_TOOL if execs else SoftwareKind.APPLICATION
        if cat == "cloud":
            return SoftwareKind.SERVICE

    # An explicit library classifier outranks a bin entry: plenty of
    # libraries ship a small helper command without being a tool.
    if any(c.startswith(_PY_LIBRARY_CLASSIFIERS[0]) for c in classifiers) and not execs:
        return SoftwareKind.LIBRARY

    if _has(words, _WORKER_HINTS):
        return SoftwareKind.WORKER

    if execs:
        # It installs a command. Narrow the kind from prose, but it is a
        # tool of some sort either way.
        if _has(words, _RUNTIME_HINTS):
            return SoftwareKind.RUNTIME
        if _has(words, _SERVICE_HINTS):
            return SoftwareKind.SERVICE
        return SoftwareKind.CLI_TOOL

    # No executable declared. Now the burden is on prose, and the default
    # is LIBRARY — the honest answer for the vast majority of registries.
    if _has(words, _LIBRARY_HINTS):
        return SoftwareKind.LIBRARY
    if any(c in classifiers for c in _PY_APP_CLASSIFIERS):
        return SoftwareKind.CLI_TOOL
    if _has(words, _RUNTIME_HINTS):
        return SoftwareKind.RUNTIME
    if _has(words, _SERVICE_HINTS):
        return SoftwareKind.SERVICE
    if _has(words, _FRAMEWORK_HINTS):
        return SoftwareKind.FRAMEWORK
    if _has(words, _SDK_HINTS):
        return SoftwareKind.SDK
    return SoftwareKind.LIBRARY


def is_usable_tool(kind: SoftwareKind) -> bool:
    from .identity import USABLE_KINDS
    return kind in USABLE_KINDS
