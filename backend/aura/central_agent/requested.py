"""The deliverables a REQUEST names — the request is the authority, not the plan.

A plan states its own acceptance criteria, so a plan can always satisfy
itself: it may declare "the workflow definition is stored and reads back"
and prove exactly that, while the person asked for source code that was
never written. The only thing that can say what was actually requested
is the request itself, so the rule lives here and is used by both the
handoff validator (which refuses a plan that ignores the request) and the
verification engine (which refuses to call an objective met when the
request was never addressed).

The file pattern mirrors the Planner's own (`packages/ai-service/src/mission/planner.ts`),
so the desktop app and the backend agree on what a request names.
"""
from __future__ import annotations

import re

#: A repo-relative path with a known source/document extension, as it
#: appears in a request. Extension list and boundary rules match the
#: Planner's own rule.
FILE_RE = re.compile(
    r"(?:^|[\s\"'`(])"
    r"((?:[\w.-]+/)*[\w-][\w.-]*\."
    r"(?:md|mdx|txt|rst|json|ya?ml|toml|ini|cfg|env|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|"
    r"java|kt|swift|c|h|cpp|hpp|cs|php|css|scss|html|sql|sh|bat|ps1|xml|csv|lock|gitignore))"
    r"(?=$|[\s\"'\]),.;:!?])",
    re.IGNORECASE,
)

#: Words that mean the person asked for a workflow to be defined. A plan
#: that only creates a workflow definition satisfies such a request; it
#: cannot satisfy any other one.
WORKFLOW_WORDS = re.compile(
    r"\b(workflow|workflows|graph|pipeline|definition|automation)\b", re.IGNORECASE)


def named_files(text: str) -> list[str]:
    """The files a request names, in order, de-duplicated."""
    out: list[str] = []
    for match in FILE_RE.finditer(text or ""):
        found = match.group(1).removeprefix("./")
        if found not in out:
            out.append(found)
    return out


#: The request reads git status: "git" and "status" together, with no word
#: that asks for a change. Read-only on purpose: "fix the git status bug and
#: commit" is authoring work and is not a status read.
GIT_STATUS_WORDS = re.compile(r"\bgit\b.*\bstatus\b|\bstatus\b.*\bgit\b", re.IGNORECASE)
GIT_WRITE_WORDS = re.compile(
    r"\b(fix|commit|push|merge|rebase|stage|create|write|implement|change|"
    r"edit|update|add|delete|remove|refactor|revert|reset|stash)\b", re.IGNORECASE)


def asks_for_git_status(text: str) -> bool:
    """True when the request asks to read the repository's git status."""
    text = text or ""
    return bool(GIT_STATUS_WORDS.search(text)) and not GIT_WRITE_WORDS.search(text)


#: Words that mean the request changes something. A request containing one is
#: never answered by a read-only tool alone ("fix the diff", "delete the files
#: in src", "switch to branch main", "read README.md and update it").
READ_ONLY_BLOCKERS = re.compile(
    r"\b(fix|commit|push|merge|rebase|stage|create|write|implement|change|"
    r"edit|update|add|delete|remove|rename|move|refactor|revert|reset|stash|"
    r"switch|checkout|install|run|build|test|make|generate)\b", re.IGNORECASE)
_DIFF_WORDS = re.compile(
    r"\bgit\s+diff\b|\bdiff\b|\bwhat(?:'s|\s+has|\s+have)?\s+changed\b|"
    r"\buncommitted\s+changes\b|\bshow\s+(?:me\s+)?(?:the\s+)?(?:current\s+)?changes\b",
    re.IGNORECASE)
_BRANCH_WORDS = re.compile(
    r"\b(?:what|which)\s+branch\b|\bcurrent\s+branch\b|\bbranch\s+am\s+i\s+on\b",
    re.IGNORECASE)
_LIST_WORDS = re.compile(r"\b(?:list|show)\b(?:\s+\S+){0,4}?\s+files\b", re.IGNORECASE)
_LIST_DIR = re.compile(r"\bfiles\s+(?:in|under|inside)\s+(?:the\s+)?([\w.-]+(?:/[\w.-]+)*)/?\s*[.?!]*$",
                       re.IGNORECASE)
_WHOLE_REPO = frozenset({"repo", "repository", "project", "folder", "directory", "workspace"})
_READ_WORDS = re.compile(r"\b(read|show|open|display|print|cat|view)\b", re.IGNORECASE)


def read_only_request(text: str) -> tuple[str, dict] | None:
    """The read-only capability and its input when the request is plainly one
    of: a git diff, the current branch, a file listing, or reading one named
    file. None for anything else, for a request that also asks for a change,
    and for a request that fits more than one of these (left to the planner).
    Git status has its own rule (`asks_for_git_status`)."""
    text = (text or "").strip()
    if not text or READ_ONLY_BLOCKERS.search(text) or asks_for_git_status(text):
        return None
    found: list[tuple[str, dict]] = []
    if _DIFF_WORDS.search(text):
        found.append(("git.diff", {}))
    if _BRANCH_WORDS.search(text):
        # `git status --short --branch` names the branch. git.branch is the
        # capability that creates or switches branches, never a read.
        found.append(("git.status", {}))
    if _LIST_WORDS.search(text):
        match = _LIST_DIR.search(text)
        where = match.group(1) if match else "."
        if where.lower().split("/")[-1] in _WHOLE_REPO or where.lower() in {"this", "here"}:
            where = "."
        found.append(("filesystem.list", {"path": where}))
    files = named_files(text)
    if len(files) == 1 and _READ_WORDS.search(text) and not _DIFF_WORDS.search(text):
        found.append(("filesystem.read", {"path": files[0]}))
    return found[0] if len(found) == 1 else None


def asks_for_current_branch(text: str) -> bool:
    """True when the request is a plain question about the current branch."""
    return read_only_request(text) == ("git.status", {})


#: The request each read-only capability serves, for the verifier.
READ_ONLY_LABELS = {
    "git.diff": "git diff",
    "git.status": "the current branch",
    "filesystem.list": "a file listing",
    "filesystem.read": "the contents of a file",
}


def asks_for_workflow(text: str) -> bool:
    """True when the request itself asks for a workflow to be defined."""
    return bool(WORKFLOW_WORDS.search(text or ""))


def _covers(targeted: str, wanted: str) -> bool:
    return targeted == wanted or targeted.endswith("/" + wanted)


def addresses(targeted_files: list[str], mentioned: list[str],
              wanted: str) -> bool:
    """Does the plan address this file the request named?

    Addressed means the plan TARGETS it (it writes it) or MENTIONS it
    (a task reads it, reviews it, or writes a test against it). A plan
    that neither targets nor mentions a file the request named simply
    does not do what was asked.

    Mentions are part of the rule on purpose: "write tests for src/app.js"
    is a request that names a file no task will write, and refusing that
    plan would be wrong.
    """
    for path in targeted_files:
        if _covers(path, wanted):
            return True
    for text in mentioned:
        if wanted in text:
            return True
    return False


def unaddressed_files(request: str, targeted_files: list[str],
                       mentioned: list[str]) -> list[str]:
    """The files the request named that the plan never addresses."""
    return [f for f in named_files(request)
            if not addresses(targeted_files, mentioned, f)]


__all__ = [
    "FILE_RE",
    "READ_ONLY_BLOCKERS",
    "READ_ONLY_LABELS",
    "WORKFLOW_WORDS",
    "addresses",
    "asks_for_current_branch",
    "asks_for_git_status",
    "asks_for_workflow",
    "named_files",
    "read_only_request",
    "unaddressed_files",
]
