"""What a Let's Chat reply may claim, checked against what actually happened.

Four things are kept apart, and only the last needs evidence:

  available capabilities   names in AURA's catalogue (``mission.start`` …). A name
                           proves nothing: not that the tool exists on this
                           machine, not that anyone called it.
  proposed actions         what the reply suggests could be done.
  executed actions         records of something that ran. A chat executes nothing.
  verified outcomes        a check that observed the result.

A chat reply is generated text. It can say what could be done; it cannot report
that something was done, or that a project is "ready", because nothing ran. This
module finds such sentences deterministically (no second model call) and turns
them into a plain note appended to the reply. It never rewrites what the model
said and never decides anything: it only refuses to let an unsupported claim
stand unqualified.
"""
from __future__ import annotations

import re

#: Phrases that assert a completed or verified outcome. In a chat these have no
#: record behind them.
_OUTCOME_CLAIMS = re.compile(
    r"\b("
    r"ready (?:for|to) (?:deploy(?:ment)?|production|release|launch|ship)"
    r"|production[- ]ready|deployment[- ]ready|ready to go live"
    r"|(?:has|have|was|were|is|are|been|successfully|now) (?:been )?(?:deployed|released|shipped|published|installed|created|written|committed|pushed|merged)"
    r"|deployment (?:is |was )?(?:complete|completed|successful|done)"
    r"|(?:all |the )?tests? (?:pass|passed|passing|are passing|succeed(?:ed)?)"
    r"|build (?:pass(?:es|ed)|succeed(?:s|ed)|is (?:green|successful))"
    r"|(?:verified|validated|confirmed) (?:that|the|working)"
    r"|everything (?:is )?(?:set up|working|done|ready)"
    r")\b", re.IGNORECASE)

#: Words that make a sentence a possibility, an instruction or a condition rather
#: than a report ("could add a test and check whether the build passes").
_HYPOTHETICAL = re.compile(
    r"\b(could|would|should|might|may|can|will|whether|if|once|until|unless|when|after|before|"
    r"need(?:s|ed)? to|want(?:s|ed)? to|how to|to (?:check|see|confirm|make sure|ensure))\b", re.IGNORECASE)

#: Something shaped like a capability id: dotted, lower-case, a known family.
_CAPABILITY_SHAPE = re.compile(
    r"\b((?:mission|project|workflow|knowledge|governance|memory|diagnosis|filesystem|git|agent|"
    r"tool|web|document|fabric|capability|workspace|session|run|shell|exec|deploy|build|test|repo|planner|worker)\.[a-z][a-z0-9_-]{2,}(?:\.[a-z][a-z0-9_-]{2,})?)\b")


def mentioned_capabilities(reply: str, known_ids: set[str] | frozenset[str] | None = None) -> list[str]:
    """Capability-looking names in the reply, known or not, in order, once each.

    A name that is NOT in the catalogue is an invented tool; one that is, is still
    only a name. Both are reported so the note can say which."""
    found: list[str] = []
    for m in _CAPABILITY_SHAPE.finditer(reply or ""):
        name = m.group(1)
        if name not in found:
            found.append(name)
    for known in sorted(known_ids or ()):
        if known in (reply or "") and known not in found:
            found.append(known)
    return found


def audit_chat_reply(reply: str, known_ids: set[str] | frozenset[str] | None = None) -> dict:
    """{"capabilities": [...], "invented": [...], "outcomes": [...]} for a chat reply.

    ``outcomes`` are sentences asserting a result; in chat all of them are
    unsupported, since no run, record or verification exists.
    """
    known = set(known_ids or ())
    names = mentioned_capabilities(reply, known)
    outcomes: list[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", reply or ""):
        hit = _OUTCOME_CLAIMS.search(sentence)
        if hit and not _HYPOTHETICAL.search(sentence[:hit.start()]):
            clipped = sentence.strip()[:160]
            if clipped and clipped not in outcomes:
                outcomes.append(clipped)
    return {"capabilities": names,
            "invented": [n for n in names if known and n not in known],
            "outcomes": outcomes[:4]}


def claims_note(reply: str, known_ids: set[str] | frozenset[str] | None = None) -> str | None:
    """A plain correction to append, or None when the reply makes no such claim."""
    audit = audit_chat_reply(reply, known_ids)
    parts: list[str] = []
    if audit["capabilities"]:
        shown = ", ".join(f"`{n}`" for n in audit["capabilities"][:5])
        invented = audit["invented"]
        parts.append(
            f"{shown} {'is a name' if len(audit['capabilities']) == 1 else 'are names'} from AURA's internal catalogue, not "
            "something that was run here" + (
                f"; {', '.join('`' + n + '`' for n in invented[:3])} "
                f"{'is' if len(invented) == 1 else 'are'} not in the catalogue at all" if invented else "") +
            ". A name does not show that a tool exists on this machine or that it did anything.")
    if audit["outcomes"]:
        parts.append(
            "Statements such as “" + audit["outcomes"][0].rstrip(".!?") + "” are not established: "
            "no build, test, deployment or other check was run in this chat, so there is no record or "
            "verification behind them.")
    if not parts:
        return None
    return "Note: " + " ".join(parts)


# ── rewriting the answer itself ──────────────────────────────────────────
#
# Appending a warning after a reply that presents `project.exit` as something to
# run leaves the reader with an executable-looking command and a footnote. The
# answer is rewritten instead: a name shown AS A COMMAND (the command word of a
# shell line, or a whole inline code span) that is not a real, runnable thing is
# labelled in place. Ordinary programming examples are left alone: anything in a
# python/javascript/json/... fence, and any dotted name used as a call or an
# attribute chain (`session.get(url)`, `os.path.join`), is not a command.

#: Name families that are AURA's own vocabulary. A name in one of these is flagged
#: wherever it is shown as a command, known to the catalogue or not.
_AURA_FAMILIES = frozenset({
    "mission", "project", "workflow", "knowledge", "governance", "memory", "diagnosis",
    "filesystem", "fabric", "capability", "workspace", "tool", "agent", "planner", "worker"})

_FENCE = re.compile(r"```([A-Za-z0-9_+-]*)[ \t]*\n(.*?)\n?```", re.DOTALL)
_INLINE = re.compile(r"(?<!`)`([^`\n]+)`(?!`)")
#: Fence languages whose lines are shell commands (an unlabelled fence is treated as shell).
_SHELL_LANGS = frozenset({"", "sh", "bash", "shell", "zsh", "console", "text", "plaintext", "terminal"})

PSEUDOCODE_HEADER = "# Illustrative only: AURA has no command with these names, so they cannot be run."
LABEL_INLINE = " (an illustrative name, not a real command)"
LABEL_LINE = "# (not a real command) "


#: `project.json`, `workspace.yaml`, `agent.py`: a file name is not a command.
_FILE_EXTS = frozenset({
    "json", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "md", "txt", "csv", "log", "lock", "xml", "html",
    "css", "scss", "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "pyc", "rs", "go", "java", "rb", "php", "sql",
    "db", "sqlite", "sh", "bat", "ps1", "exe", "dll", "so", "zip", "tar", "gz", "png", "jpg", "svg", "wav", "mp3",
    # top-level domains: `tool.dev`, `project.io` are sites, not commands
    "com", "org", "net", "dev", "io", "app", "ai", "co", "edu", "gov"})


def _shape(word: str) -> str | None:
    m = _CAPABILITY_SHAPE.fullmatch(word)
    if not m or m.group(1).rsplit(".", 1)[-1] in _FILE_EXTS:
        return None
    return m.group(1)


def _flaggable(name: str, known: set[str]) -> bool:
    if name.rsplit(".", 1)[-1] in _FILE_EXTS:
        return False
    return name in known or name.split(".", 1)[0] in _AURA_FAMILIES


def _command_name(line: str) -> str | None:
    """The capability-shaped command word of a shell line, else None."""
    words = line.strip().lstrip("$>").strip().split()
    if not words:
        return None
    return _shape(words[0])


def rewrite_unsupported_commands(reply: str, known_ids: set[str] | frozenset[str] | None = None) -> tuple[str, list[str]]:
    """The reply with every invented or non-runnable command labelled where it appears.

    Returns ``(text, names)``: the rewritten reply and the names it labelled.
    A reply with nothing to label is returned unchanged.
    """
    known = set(known_ids or ())
    flagged: list[str] = []

    def note(name: str) -> None:
        if name not in flagged:
            flagged.append(name)

    def fence(m: re.Match) -> str:
        lang, body = m.group(1).lower(), m.group(2)
        if lang not in _SHELL_LANGS:
            return m.group(0)                      # a python/js/json/... example: not a command
        out: list[str] = []
        hit = False
        for line in body.split("\n"):
            name = _command_name(line)
            if name and (_flaggable(name, known) or _shape(name)):
                note(name)
                hit = True
                out.append(LABEL_LINE + line.strip())
            else:
                out.append(line)
        if not hit:
            return m.group(0)
        return f"```{m.group(1)}\n{PSEUDOCODE_HEADER}\n" + "\n".join(out) + "\n```"

    def inline(m: re.Match) -> str:
        content = m.group(1).strip()
        if "(" in content or "=" in content or content.count(" ") > 3:
            return m.group(0)                      # a call, an assignment or a longer snippet
        name = _shape(content.split()[0]) if content else None
        if not name or not _flaggable(name, known):
            return m.group(0)                      # `os.path.join`, `session.get` … ordinary code
        if m.string[m.end():m.end() + len(LABEL_INLINE)] == LABEL_INLINE:
            return m.group(0)
        note(name)
        return m.group(0) + LABEL_INLINE

    def gap(segment: str) -> str:
        """Plain prose between code spans: a bare `mission.start` is labelled too."""
        def bare(m: re.Match) -> str:
            name = m.group(1)
            before = segment[m.start() - 1] if m.start() else " "
            if before in "./@:-_" or before.isalnum():
                return m.group(0)                  # part of a URL, a domain or a longer word
            if not _flaggable(name, known) or segment[m.end():m.end() + len(LABEL_INLINE)] == LABEL_INLINE:
                return m.group(0)
            note(name)
            return m.group(0) + LABEL_INLINE
        return _CAPABILITY_SHAPE.sub(bare, segment)

    def prose(segment: str) -> str:
        out: list[str] = []
        pos = 0
        for m in _INLINE.finditer(segment):
            out.append(gap(segment[pos:m.start()]))
            out.append(inline(m))
            pos = m.end()
        out.append(gap(segment[pos:]))
        return "".join(out)

    # Fences first, so inline spans inside them are not touched twice.
    parts: list[str] = []
    last = 0
    text = reply or ""
    for fm in _FENCE.finditer(text):
        parts.append(prose(text[last:fm.start()]))
        parts.append(fence(fm))
        last = fm.end()
    parts.append(prose(text[last:]))
    return "".join(parts), flagged


def outcomes_note(reply: str) -> str | None:
    """The note for unsupported completion/readiness claims only (command names are rewritten in place)."""
    audit = audit_chat_reply(reply, None)
    if not audit["outcomes"]:
        return None
    return ("Note: statements such as “" + audit["outcomes"][0].rstrip(".!?") + "” are not established: "
            "no build, test, deployment or other check was run in this chat, so there is no record or "
            "verification behind them.")
