"""Safe version-probe boundary for machine inventory.

Inventory answers "what is installed" by *reading records* wherever possible.
When it must *run* something to learn a version, that execution is confined
here: an explicit allowlist of known CLI tools and their exact arguments.

Why an allowlist, not a denylist
--------------------------------
A denylist of "today's dangerous filenames" fails open the first time
somebody invents a new GUI application, wrapper script, or launcher. The
observed Windows bug was exactly this shape: PATH enumeration found
``git-gui.exe`` and Nsight Compute executables, treated them as generic CLI
tools, and ran ``<exe> --version``. Those programs ignore the flag and open
their GUI instead — Git GUI then reported ``fatal: not a git repository``
(from the scan's home-directory cwd) and Nsight reported
``Unknown option version`` plus a missing ``cupti64_*.dll`` loader dialog.

Rules enforced by this module (used by discovery + inventory verify):

* Inspecting an executable (stat, registry, package DB) is always allowed.
* Running ``<exe> --version`` is allowed ONLY when the executable's basename
  (extension-stripped, case-insensitive) is in :data:`SAFE_VERSION_PROBES`
  and the arguments are exactly the allowlisted ones.
* ``APPLICATION``-kind items are never executed — they are inventoried from
  metadata (registry / package DB / bundle plist) with version unknown when
  no package record names one.
* Known GUI launchers in :data:`NEVER_PROBE` (and NVIDIA GUI substrings) are
  never executed even if a package manager claims them.
* ``.ps1`` is never executed during inventory. ``.cmd``/``.bat`` shims are
  only executed when their basename is allowlisted, and then only through
  ``cmd.exe /d /s /c`` with per-argument quoting (see ``procexec``).

Catalog probes (``catalog.py`` ``ProbeSpec``) are explicit, reviewed
repository data — not machine state — and keep their own arguments. This
module governs *unknown* PATH-found files and inventory verification of
non-catalog items.
"""
from __future__ import annotations

import os

#: Basename (lowercase, Windows extension stripped) -> exact version arguments.
#: Every entry here was reviewed as a headless CLI whose version flag prints
#: and exits without opening a window, prompt, or daemon. Adding an entry is
#: a deliberate safety decision, not a convenience.
SAFE_VERSION_PROBES: dict[str, list[str]] = {
    # VCS / hosting
    "git": ["--version"],
    "gh": ["--version"],
    "glab": ["--version"],
    # Runtimes / package managers (all headless version flags)
    "node": ["--version"],
    "npm": ["--version"],
    "npx": ["--version"],
    "pnpm": ["--version"],
    "bun": ["--version"],
    "deno": ["--version"],
    "python": ["--version"],
    "python3": ["--version"],
    "pip": ["--version"],
    "pip3": ["--version"],
    "pipx": ["--version"],
    "uv": ["--version"],
    "cargo": ["--version"],
    "rustc": ["--version"],
    "go": ["version"],
    "java": ["-version"],
    "flutter": ["--version"],
    "dart": ["--version"],
    # Containers / infra (headless)
    "docker": ["--version"],
    "podman": ["--version"],
    "kubectl": ["version", "--client"],
    "terraform": ["--version"],
    "aws": ["--version"],
    "az": ["version"],
    "gcloud": ["version"],
    "vercel": ["--version"],
    "wrangler": ["--version"],
    "supabase": ["--version"],
    "firebase": ["--version"],
    "flyctl": ["version"],
    "fly": ["version"],
    "railway": ["--version"],
    "doctl": ["version"],
    "heroku": ["--version"],
    "pscale": ["--version"],
    "neonctl": ["--version"],
    "atlas": ["version"],
    "mongosh": ["--version"],
    "psql": ["--version"],
    "sqlite3": ["--version"],
    "redis-cli": ["--version"],
    # Shells / HTTP (headless)
    "bash": ["--version"],
    "zsh": ["--version"],
    "pwsh": ["--version"],
    "powershell": ["--version"],
    "curl": ["--version"],
    "wget": ["--version"],
    "jq": ["--version"],
    "adb": ["--version"],
    # Browsers: `<exe> --version` prints and exits headless (verified).
    "chrome": ["--version"],
    "google-chrome": ["--version"],
    "google-chrome-stable": ["--version"],
    "chromium": ["--version"],
    "chromium-browser": ["--version"],
    "firefox": ["--version"],
    "brave": ["--version"],
    "brave-browser": ["--version"],
    "msedge": ["--version"],
    "microsoft-edge": ["--version"],
    # Editors whose CLI is headless for --version (no window opened).
    "code": ["--version"],
    "cursor": ["--version"],
    # Coding agents (terminal CLIs)
    "claude": ["--version"],
    "codex": ["--version"],
    "gemini": ["--version"],
    "qwen": ["--version"],
    "opencode": ["--version"],
    "kilo": ["--version"],
    # Build / misc headless CLIs
    "cmake": ["--version"],
    "make": ["--version"],
    "gcc": ["--version"],
    "clang": ["--version"],
    "dotnet": ["--version"],
    "playwright": ["--version"],
    # NVIDIA CLI (headless). The GUI tools (ncu-ui/nsys-ui/Nsight) are NOT
    # here — see NEVER_PROBE. `nvidia-smi` without flags prints once and
    # exits; `--version` is not a documented flag, so probe with no args is
    # NOT allowlisted either — inventory uses registry/PATH metadata and
    # reports version unknown rather than guessing flags.
    "nvcc": ["--version"],
}

#: Exact basenames (normalised) that must never be executed during inventory,
#: even if a package manager claims them. GUI launchers, IDE starters, and
#: NVIDIA graphical profilers live here.
NEVER_PROBE: frozenset[str] = frozenset(
    {
        # Git GUI family (Tcl/Tk launchers that ignore --version and open a window)
        "git-gui",
        "gitk",
        "git-citool",
        "git-gui-wish",
        "wish",
        # NVIDIA graphical profilers (do not accept --version; open GUI + DLL dialogs)
        "ncu",
        "ncu-ui",
        "nsys",
        "nsys-ui",
        "nsight",
        "nsight-compute",
        "nsight-systems",
        "nv-nsight-cu-cli",
        # Generic GUI shells that must never be version-probed
        "explorer",
        "cmd",
        "conhost",
        "powershell_ise",
    }
)

#: Substrings (lowercase) that mark an NVIDIA GUI/profiler executable that
#: must never be launched during inventory, whatever its exact filename is.
NEVER_PROBE_SUBSTRINGS: tuple[str, ...] = (
    "nsight",
    "ncu-ui",
    "nsys-ui",
    "cupti",
)

#: Windows executable extensions that may carry a runnable program during
#: inventory. `.ps1` is deliberately absent — PowerShell scripts are never
#: executed to learn a version.
WINDOWS_PROBEABLE_EXTS: tuple[str, ...] = (".exe", ".cmd", ".bat", ".com")

#: File suffixes that are never programs (libraries, data, build leftovers).
#: Mirrors discovery._NON_PROGRAM_SUFFIXES so inventory PATH enumeration and
#: discovery agree on what "a program" means on Windows.
NON_PROGRAM_SUFFIXES: frozenset[str] = frozenset(
    {
        ".so", ".dylib", ".dll", ".a", ".o", ".lib", ".pdb", ".h", ".c", ".cc",
        ".cpp", ".hpp", ".rs", ".java", ".class", ".jar", ".log", ".tmp", ".txt",
        ".md", ".json", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".lock", ".map",
        ".zip", ".gz", ".xz", ".bz2", ".tar", ".png", ".svg", ".ico",
    }
)

_WINDOWS_STRIP_EXTS: tuple[str, ...] = (".exe", ".cmd", ".bat", ".com", ".ps1")


def normalize_basename(path_or_name: str) -> str:
    """Basename with directories and Windows executable extension removed.

    ``C:\\Program Files\\Git\\cmd\\git-gui.exe`` -> ``git-gui``.
    Comparison is always case-insensitive (Windows + POSIX alike).
    """
    base = os.path.basename((path_or_name or "").strip())
    stem, ext = os.path.splitext(base)
    if ext.lower() in _WINDOWS_STRIP_EXTS:
        base = stem
    return base.lower()


def is_never_probe(path_or_name: str) -> bool:
    """True when this executable must never be launched during inventory."""
    name = normalize_basename(path_or_name)
    if not name:
        return True
    if name in NEVER_PROBE:
        return True
    return any(sub in name for sub in NEVER_PROBE_SUBSTRINGS)


def safe_probe_args(path_or_name: str) -> list[str] | None:
    """Exact allowlisted version arguments, or ``None`` when not probeable."""
    if is_never_probe(path_or_name):
        return None
    return SAFE_VERSION_PROBES.get(normalize_basename(path_or_name))


def allowed_to_probe(path_or_name: str, *, kind: str | None = None) -> tuple[bool, str]:
    """Whether inventory may execute this file to learn its version.

    Returns ``(allowed, reason)``. ``reason`` is empty when allowed and names
    the refusal otherwise, so callers can report it as evidence.
    """
    name = normalize_basename(path_or_name)
    if not name:
        return False, "no executable name to probe"
    if is_never_probe(path_or_name):
        return False, (
            f"{name} is a known GUI application; AURA inventories it from "
            "installation metadata without launching it"
        )
    if kind is not None and kind.lower() == "application":
        return False, (
            f"{name} is an application; AURA inventories applications from "
            "installation metadata without launching them"
        )
    args = SAFE_VERSION_PROBES.get(name)
    if args is None:
        return False, (
            f"{name} has no allowlisted version probe; AURA lists it from "
            "package metadata without running it"
        )
    return True, ""


def is_windows_probeable_file(filename: str) -> bool:
    """Whether a PATH directory entry may be a runnable program on Windows.

    Only real executable extensions count. ``.dll``/``.ps1``/data files are
    not programs, even though they sit beside programs in directories like
    CUDA ``bin/`` (home of the observed ``cupti64_*.dll``).
    """
    if not filename or filename.startswith("."):
        return False
    _, ext = os.path.splitext(filename)
    lowered = ext.lower()
    if lowered in NON_PROGRAM_SUFFIXES:
        return False
    if lowered == ".ps1":
        return False
    return lowered in WINDOWS_PROBEABLE_EXTS
