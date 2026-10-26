"""The answer to a git status request, read from git's own output.

`git status --short --branch` prints a header line ("## main",
"## main...origin/main [ahead 1]", "## No commits yet on main",
"## HEAD (no branch)") followed by one line per changed path. Every claim in
the answer comes from those lines; nothing is assumed. When there is no
output there is no claim to make, and the answer says so.
"""

from __future__ import annotations

#: Paths listed before the answer summarises the rest as a count.
MAX_LISTED = 10


def _branch_phrase(header: str) -> str:
    head = header[3:].strip()
    if head.startswith("No commits yet on "):
        return f"on branch {head[len('No commits yet on '):].strip()}, which has no commits yet"
    if head.startswith("HEAD (no branch)"):
        return "on a detached HEAD"
    tracking = ""
    if " [" in head and head.endswith("]"):
        head, tracking = head.split(" [", 1)
        tracking = tracking[:-1]
    branch, _, upstream = head.partition("...")
    phrase = f"on branch {branch.strip()}"
    if upstream:
        phrase += f", tracking {upstream.strip()}"
        if tracking:
            phrase += f" ({tracking})"
    return phrase


def describe_git_status(output: str) -> str | None:
    """A plain answer built from `git status --short --branch` output, or
    None when the output does not look like that command's output."""
    lines = [ln for ln in (output or "").splitlines() if ln.strip()]
    if not lines or not lines[0].startswith("## "):
        return None
    where = _branch_phrase(lines[0])
    changes = lines[1:]
    if not changes:
        return f"The repository is {where}. The working tree is clean."
    shown = "\n".join(f"  {ln}" for ln in changes[:MAX_LISTED])
    more = len(changes) - MAX_LISTED
    tail = f"\n  …and {more} more." if more > 0 else ""
    noun = "path" if len(changes) == 1 else "paths"
    return (f"The repository is {where}. The working tree has "
            f"{len(changes)} changed {noun}:\n{shown}{tail}")


NO_OUTPUT = ("Git status ran, but no status output was recorded, so the branch "
             "and working-tree state cannot be reported.")


__all__ = ["MAX_LISTED", "NO_OUTPUT", "describe_git_status"]
