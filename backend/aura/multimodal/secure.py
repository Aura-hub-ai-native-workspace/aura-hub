"""Security primitives for document conversion.

Confinement semantics mirror ``aura.fabric.executors._confine``
(resolve, then require the result to be the root or a child of it,
fail-closed on every escape) without importing the fabric stack, so the
document subsystem stays dependency-light.

Rules enforced here:
- symlink escapes are refused (resolve-then-check, plus a recheck after open
  so a swapped symlink between check and read cannot smuggle content in);
- absolute source paths are accepted but recorded; traversal is meaningless
  for absolute inputs because resolution already fixed them;
- ZIP/TAR/archive extraction is never performed (callers reject archives
  before reaching conversion);
- temporary files live under one managed directory and are removed in a
  ``finally`` even when conversion raises or times out.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional


class PathSecurityError(ValueError):
    """Raised when a path fails confinement. Never carries file content."""


def resolve_secure(path: str | Path,
                   root: Optional[str | Path] = None) -> Path:
    """Resolve ``path`` and, when ``root`` is given, require containment.

    Args:
        path: source file path (absolute or relative to cwd).
        root: optional confinement root. When ``None``, the path is only
            resolved and must exist as a regular file (no directories,
            no sockets, no devices).

    Raises:
        PathSecurityError: on missing files, non-regular files, or escapes.
    """
    p = Path(path).expanduser()
    if not p.is_absolute():
        p = Path.cwd() / p
    try:
        # strict resolve follows every symlink to its final target, so a
        # symlink pointing outside `root` is caught by containment below.
        resolved = p.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise PathSecurityError(f"unresolvable path: {exc}") from exc

    if not resolved.is_file():
        raise PathSecurityError("not a regular file")

    if root is not None:
        root_resolved = Path(root).expanduser().resolve()
        norm = os.path.normcase
        same = norm(str(resolved)) == norm(str(root_resolved))
        inside = any(norm(str(parent)) == norm(str(root_resolved))
                     for parent in resolved.parents)
        if not (same or inside):
            raise PathSecurityError("path escapes the confinement root")
    return resolved


def file_size(path: Path) -> int:
    """Best-effort size in bytes; -1 when it cannot be determined."""
    try:
        return path.stat().st_size
    except OSError:
        return -1


def file_identity(path: Path) -> tuple[int, int]:
    """(device, inode) identity for re-verification after open."""
    st = path.stat()
    return (st.st_dev, st.st_ino)


def verify_same_file(path: Path, identity: tuple[int, int]) -> bool:
    """True when ``path`` still refers to the file vetted earlier.

    Call after opening/reading: defeats symlink or rename swaps between
    the confinement check and the read (TOCTOU).
    """
    try:
        return file_identity(path) == identity
    except OSError:
        return False


@contextmanager
def managed_temp_dir(prefix: str = "aura-doc-",
                      base: Optional[str | Path] = None) -> Iterator[Path]:
    """Yield a temp directory that is always removed on exit.

    Args:
        prefix: directory name prefix.
        base: parent directory; defaults to the system temp dir. Pass
            AURA's home documents directory to keep temp files on one
            filesystem with a known owner.
    """
    tmpdir = Path(tempfile.mkdtemp(prefix=prefix,
                                   dir=str(base) if base else None))
    try:
        yield tmpdir
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


@contextmanager
def managed_temp_file(suffix: str = "",
                      prefix: str = "aura-doc-",
                      base: Optional[str | Path] = None) -> Iterator[Path]:
    """Yield a temp file path; the file is always unlinked on exit."""
    fd, name = tempfile.mkstemp(suffix=suffix, prefix=prefix,
                                dir=str(base) if base else None)
    os.close(fd)
    try:
        yield Path(name)
    finally:
        try:
            os.unlink(name)
        except OSError:
            pass
