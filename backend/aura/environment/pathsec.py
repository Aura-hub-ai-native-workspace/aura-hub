"""Effective PATH construction, executable resolution, and location trust.

Two questions live here, and they are deliberately separate:

  * *Where would this machine find `git`?* — :func:`resolve_executable`,
    which honours real PATH order and Windows ``PATHEXT``.
  * *Is it safe to run what we found?* — :func:`location_trust`, which is
    about the **location**, not the file's name.

The second question is what defeats PATH hijacking. ``PATH=/tmp/evil:$PATH``
works as an attack because a scanner resolves and runs whatever comes first.
AURA still resolves whatever comes first — lying about resolution would make
the report wrong — but it refuses to *execute* from a directory any user on
the machine can write to, and reports the refusal as evidence.
"""
from __future__ import annotations

import os
import stat
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from .hostplatform import is_macos, is_windows, path_sep

#: Directories AURA appends to the inherited PATH so that tools installed by
#: common per-user installers are still found when the backend was launched
#: from a desktop session with a minimal PATH. They are *appended*, never
#: prepended: the machine's own PATH order stays authoritative (ENV-020).
_EXTRA_POSIX = (
    "~/.local/bin",
    "~/bin",
    "~/.opencode/bin",
    "~/.cargo/bin",
    "~/.bun/bin",
    "~/go/bin",
    "~/.deno/bin",
    "~/.npm-global/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/snap/bin",
)

_EXTRA_MACOS = (
    "/Applications",
    "~/Applications",
)

_EXTRA_WINDOWS_ENV = (
    ("APPDATA", "npm"),
    ("LOCALAPPDATA", "Microsoft/WindowsApps"),
    ("ProgramData", "chocolatey/bin"),
    ("ProgramFiles", ""),
    ("ProgramFiles(x86)", ""),
)

_EXTRA_WINDOWS_HOME = (
    "~/scoop/shims",
    "~/AppData/Roaming/npm",
    "~/AppData/Local/Microsoft/WindowsApps",
    "~/.cargo/bin",
    "~/go/bin",
    "~/.bun/bin",
)


class LocationTrust(str, Enum):
    """Why a resolved executable may or may not be run."""

    TRUSTED = "trusted"
    WORLD_WRITABLE = "world-writable"
    FOREIGN_OWNER = "foreign-owner"
    SETUID = "setuid"
    MISSING = "missing"


@dataclass(frozen=True)
class FileIdentity:
    """Which file, exactly, a trust decision was made about.

    A path is not an identity: between deciding that ``/usr/bin/foo`` is safe
    and running it, the name can be made to point somewhere else. Carrying
    the device and inode lets the execution boundary confirm it is running
    the file that was actually vetted (see `procexec.run_argv(pin=...)`).
    """

    device: int
    inode: int
    mode: int
    size: int
    mtime_ns: int

    @classmethod
    def of(cls, st: os.stat_result) -> FileIdentity:
        return cls(
            device=st.st_dev,
            inode=st.st_ino,
            mode=stat.S_IMODE(st.st_mode) | stat.S_IFMT(st.st_mode),
            size=st.st_size,
            mtime_ns=st.st_mtime_ns,
        )

    def matches(self, other: FileIdentity | None) -> bool:
        return other is not None and (self.device, self.inode) == (other.device, other.inode)


@dataclass(frozen=True)
class TrustVerdict:
    trust: LocationTrust
    reason: str = ""
    #: The exact file this verdict describes, when one could be stat'ed.
    identity: FileIdentity | None = None
    #: The resolved path the verdict was reached about.
    resolved: str | None = None

    @property
    def executable(self) -> bool:
        return self.trust is LocationTrust.TRUSTED


def file_identity(path: str | os.PathLike[str]) -> FileIdentity | None:
    try:
        return FileIdentity.of(os.stat(path))
    except OSError:
        return None


def home_dir() -> Path:
    return Path(os.path.expanduser("~"))


def self_runtime_dirs() -> set[str]:
    """Directories belonging to the Python runtime AURA itself is using.

    A backend launched from its own virtualenv has that venv's ``bin`` first
    on PATH, so ``python3`` resolves to AURA's interpreter and the scan
    reports AURA's own version as the machine's Python. The scan measures the
    machine, not the scanner, so these are excluded from both resolution and
    enumeration.
    """
    dirs: set[str] = set()

    def add(raw: str | None) -> None:
        if raw:
            dirs.add(os.path.normcase(os.path.normpath(raw)))

    add(os.path.dirname(sys.executable))
    venv = os.environ.get("VIRTUAL_ENV")
    if venv:
        add(os.path.join(venv, "Scripts" if is_windows() else "bin"))
    return dirs


def _expand(entry: str) -> str:
    """``~`` and environment variables, so catalog fallbacks can name
    ``%ProgramFiles%/...`` or ``$HOME/...`` without platform branching."""
    return os.path.expandvars(os.path.expanduser(entry))


def effective_path(*, include_extras: bool = True) -> str:
    """The PATH probes run under.

    The inherited PATH comes first and in order, so what AURA measures is
    what the user's shell would run. Known installer directories are appended
    afterwards and only when they exist, which recovers tools for a backend
    launched from a GUI session without changing precedence for one launched
    from a shell.
    """
    parts: list[str] = []
    seen: set[str] = set()

    def add(raw: str, *, must_exist: bool) -> None:
        if not raw:
            return
        value = _expand(raw)
        key = os.path.normcase(os.path.normpath(value))
        if key in seen:
            return
        if must_exist and not os.path.isdir(value):
            return
        seen.add(key)
        parts.append(value)

    mine = self_runtime_dirs()
    for entry in os.environ.get("PATH", "").split(path_sep()):
        if entry and os.path.normcase(os.path.normpath(_expand(entry))) in mine:
            continue
        # Inherited entries are kept even if absent: the user put them there,
        # and a directory can appear between scans.
        add(entry, must_exist=False)

    if include_extras:
        if is_windows():
            for var, suffix in _EXTRA_WINDOWS_ENV:
                base = os.environ.get(var)
                if base:
                    add(os.path.join(base, suffix) if suffix else base, must_exist=True)
            for entry in _EXTRA_WINDOWS_HOME:
                add(entry, must_exist=True)
        else:
            for entry in _EXTRA_POSIX:
                add(entry, must_exist=True)
            if is_macos():
                for entry in _EXTRA_MACOS:
                    add(entry, must_exist=True)

    return path_sep().join(parts)


def _pathext() -> list[str]:
    raw = os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD;.PS1")
    return [e for e in (part.strip() for part in raw.split(";")) if e]


def resolve_executable(command: str, path: str | None = None) -> str | None:
    """Absolute path of ``command`` as this machine would resolve it.

    Honours real PATH order. On Windows every ``PATHEXT`` suffix is tried for
    each directory before moving on, which is what the OS itself does — the
    common bug is to try every directory for ``.exe`` first and so pick a far
    ``foo.exe`` over a near ``foo.cmd``.
    """
    if not command:
        return None

    search = path if path is not None else effective_path()

    # An explicit path is used as given, not searched for.
    if os.path.dirname(command):
        candidate = os.path.abspath(_expand(command))
        return candidate if _is_runnable_file(candidate) else None

    exts = [""] + _pathext() if is_windows() else [""]
    for directory in search.split(path_sep()):
        if not directory:
            continue
        for ext in exts:
            candidate = os.path.join(_expand(directory), command + ext)
            if _is_runnable_file(candidate):
                return os.path.abspath(candidate)
            if is_windows() and ext:
                # PATHEXT is conventionally upper case; the file may not be.
                lower = os.path.join(_expand(directory), command + ext.lower())
                if _is_runnable_file(lower):
                    return os.path.abspath(lower)
    return None


def _is_runnable_file(candidate: str) -> bool:
    """A real file the OS would agree to execute.

    ``os.path.isfile`` follows symlinks, so a broken link is correctly false.
    """
    try:
        if not os.path.isfile(candidate):
            return False
    except OSError:
        return False
    if is_windows():
        return True
    return os.access(candidate, os.X_OK)


def _dir_is_open_to_all(st: os.stat_result) -> bool:
    """World-writable *and* not sticky.

    The sticky bit is what makes ``/tmp`` survivable: anyone may create files
    there, but only the owner may replace or remove their own. A directory
    that is world-writable without it lets any local user swap the binary
    underneath us, which is the classic PATH-hijack primitive.
    """
    return bool(st.st_mode & stat.S_IWOTH) and not bool(st.st_mode & stat.S_ISVTX)


def _system_owner_uids() -> set[int]:
    """UIDs that identify the platform's trusted system owner.

    POSIX normally reports the filesystem root as UID 0.  Rootless
    containers and id-mapped mounts can instead expose that same immutable
    host-owned tree as an overflow UID (commonly 65534).  Treating every
    file below such a root as foreign makes ordinary system executables
    permanently unprobeable, even though the calling user cannot alter the
    tree.  The owner of ``/`` is therefore the system-owner identity too.

    This does *not* trust arbitrary foreign users: a file or directory owned
    by any UID other than the process user, UID 0, or the root-filesystem
    owner remains blocked.
    """
    owners = {0}
    try:
        owners.add(os.stat(os.path.sep).st_uid)
    except OSError:
        pass
    return owners


def location_trust(executable: str | os.PathLike[str]) -> TrustVerdict:
    """Decide whether it is safe to execute what is at ``executable``.

    The file and every ancestor directory are checked, because a safe file
    inside a directory another user can write to can simply be replaced.

    This is a check on *who else can tamper with it*, not on whether the
    operator meant to install it. Deliberate-installation is a separate
    question answered by :mod:`aura.environment.provenance`; unknown binaries
    must satisfy both before AURA will run them.
    """
    target = Path(executable)
    try:
        resolved = target.resolve()
    except (OSError, RuntimeError) as exc:
        return TrustVerdict(LocationTrust.MISSING, f"path could not be resolved: {exc}")

    try:
        st = resolved.stat()
    except OSError:
        return TrustVerdict(LocationTrust.MISSING, "file does not exist", resolved=str(resolved))

    identity = FileIdentity.of(st)
    here = str(resolved)

    def verdict(trust: LocationTrust, reason: str = "") -> TrustVerdict:
        return TrustVerdict(trust, reason, identity=identity, resolved=here)

    if not stat.S_ISREG(st.st_mode):
        return verdict(LocationTrust.MISSING, "not a regular file")

    if is_windows():
        # POSIX mode bits do not describe Windows ACLs, so they are not
        # applied there rather than being applied wrongly. Windows relies on
        # identity pinning at the execution boundary instead.
        return verdict(LocationTrust.TRUSTED)

    if st.st_mode & (stat.S_ISUID | stat.S_ISGID):
        return verdict(
            LocationTrust.SETUID,
            "the file is setuid or setgid, so running it would change privileges",
        )
    if st.st_mode & stat.S_IWOTH:
        return verdict(
            LocationTrust.WORLD_WRITABLE,
            f"{resolved} can be rewritten by any user on this machine",
        )

    uid = os.getuid()
    trusted_owners = _system_owner_uids() | {uid}
    if st.st_uid not in trusted_owners:
        return verdict(
            LocationTrust.FOREIGN_OWNER,
            f"{resolved} belongs to another user (uid {st.st_uid})",
        )

    for ancestor in resolved.parents:
        try:
            ast = ancestor.stat()
        except OSError:
            break
        if _dir_is_open_to_all(ast):
            return verdict(
                LocationTrust.WORLD_WRITABLE,
                f"{ancestor} is writable by any user on this machine",
            )
        if ast.st_uid not in trusted_owners:
            return verdict(
                LocationTrust.FOREIGN_OWNER,
                f"{ancestor} belongs to another user (uid {ast.st_uid})",
            )

    return verdict(LocationTrust.TRUSTED)


def real_target(executable: str | os.PathLike[str]) -> str:
    """Symlinks followed to the file that actually runs.

    This is the identity used for deduplication: ``wrangler`` and
    ``wrangler2`` are two names for one program, and only the target says so.
    """
    try:
        return str(Path(executable).resolve())
    except (OSError, RuntimeError):
        return str(executable)
