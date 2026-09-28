"""Context assembly — bounded, provenance-marked, governance-aware.

The agent never dumps a workspace into a model request. A ContextBundle is
assembled from: session history (own store), stored workflows (own store),
capabilities (the Fabric manifest), pending approvals (the ledger), and an
OPTIONAL bounded project scan that itself goes through governed git
invocations when a project path is supplied. Every item carries
provenance; external content stays marked untrusted.

This module is the seam where the future Python Context Fabric (P9) will
plug in; it deliberately owns no persistence of its own.
"""

from __future__ import annotations

from dataclasses import dataclass, field

PROVENANCE_SYSTEM = "system"
PROVENANCE_SESSION = "session"
PROVENANCE_STORE = "store"
PROVENANCE_EXTERNAL = "external"

MAX_ITEMS_PER_SOURCE = 20
MAX_ITEM_CHARS = 600


@dataclass
class ContextItem:
    kind: str          # 'capability' | 'workflow' | 'approval' | 'message' | 'project'
    text: str
    provenance: str    # one of the PROVENANCE_* constants
    untrusted: bool = False


@dataclass
class ContextBundle:
    items: list[ContextItem] = field(default_factory=list)

    def render(self, max_chars: int = 8000) -> str:
        """Bounded plain-text view for prompts. Untrusted items are fenced
        and labelled so no consumer can mistake them for instructions."""
        parts: list[str] = []
        used = 0
        for item in self.items[:MAX_ITEMS_PER_SOURCE * 5]:
            text = item.text[:MAX_ITEM_CHARS]
            if item.untrusted:
                line = f"<untrusted-data provenance=\"{item.provenance}\">{text}</untrusted-data>"
            else:
                line = f"[{item.kind}|{item.provenance}] {text}"
            if used + len(line) > max_chars:
                break
            parts.append(line)
            used += len(line) + 1
        return "\n".join(parts)


#: Bounded project sampling. A planner needs to know what KIND of
#: project this is and roughly where things live; it does not need the
#: repository. Everything here is capped, and every item it produces is
#: marked untrusted external content by the assembler.
MAX_PROJECT_PATHS = 40
PROJECT_SCAN_TIMEOUT_MS = 8_000

#: Cap on one artifact file read. Identity/summary files are small JSON;
#: anything larger is not what this loader is for, and is skipped
#: rather than parsed.
_MAX_ARTIFACT_BYTES = 256 * 1024


def load_project_artifacts(project_id: str, home=None) -> dict | None:
    """Project understanding the TS service already derived, read-only.

    The Ask AURA pipeline persists per-project identity
    (`identity/<id>.json`: purpose, type, language, entry points) and a
    module summary (`summaries/<id>.json`) under the shared AURA home.
    This loads both, bounded, without ever touching the mount: the
    requested id is the key, so a turn can never read another project's
    understanding. Anything unreadable or misshapen yields None, and
    the assembler then says grounding is unavailable rather than
    guessing. Never raises.
    """
    if not project_id or not isinstance(project_id, str):
        return None
    try:
        from ..config import aura_home

        base = home if home is not None else aura_home()
    except Exception:
        return None
    try:
        import json
        import os

        out: dict = {}
        for key, name in (("identity", "identity"),
                          ("summary", "summaries")):
            path = os.path.join(str(base), name, f"{project_id}.json")
            try:
                if os.path.getsize(path) > _MAX_ARTIFACT_BYTES:
                    continue
                with open(path, encoding="utf-8") as fh:
                    data = json.load(fh)
            except (OSError, ValueError):
                continue
            if isinstance(data, dict):
                out[key] = data
        return out or None
    except Exception:
        return None


#: Grounded inspection budgets. A digest is a HANDFUL of small files,
#: never a repository dump: enough to answer "what is this and where is
#: the entry point", small enough that the model reads all of it.
_DIGEST_TREE_ENTRIES = 60
_DIGEST_FILE_CHARS = 1200
_DIGEST_TOTAL_CHARS = 9_000
_DIGEST_KEY_FILES = (
    "README.md", "readme.md", "README",
    "pyproject.toml", "package.json", "Cargo.toml", "go.mod",
    "main.py", "app.py", "manage.py",
    "index.ts", "index.js", "src/index.ts", "src/main.ts",
    "src/main.py", "src/app.py", "src/main.rs", "main.go",
)
_DIGEST_CONFIG_FILES = (
    "pyproject.toml", "package.json", "Cargo.toml", "go.mod", "setup.py",
    "Makefile", "vite.config.ts", "tsconfig.json",
)


def project_digest(path: str) -> dict | None:
    """A bounded, read-only digest of a project's ACTUAL files.

    Returns ``{"root", "tree", "files": [{path, chars, content}],
    "tests"}`` or None when the root is missing/unreadable. Contents are
    UNTRUSTED DATA — consumers must fence them; the digest exists so a
    project question can be answered from the real code instead of a
    guess, with every claim citable to a listed path.

    Selection is structural, never clever: top-of-tree layout, the
    project's declared manifests, conventional entry points, and the
    test directory listing. Anything unreadable is skipped; a file that
    vanished between listing and reading changes nothing.
    """
    import os

    root = os.path.realpath(path or "")
    if not root or not os.path.isdir(root):
        return None

    tree: list[str] = []
    try:
        entries = sorted(os.scandir(root), key=lambda e: (not e.is_dir(), e.name))
        for entry in entries[:_DIGEST_TREE_ENTRIES]:
            suffix = "/" if entry.is_dir() else ""
            tree.append(entry.name + suffix)
    except OSError:
        return None

    tests = sorted(
        e.name for e in os.scandir(root)
        if e.is_dir() and e.name.lower() in ("tests", "test", "spec", "__tests__")
    ) if os.path.isdir(root) else []
    tests_listing: list[str] = []
    for tdir in tests[:2]:
        troot = os.path.join(root, tdir)
        try:
            names = [f"{tdir}/{e.name}" for e in sorted(os.scandir(troot), key=lambda e: e.name)
                     if e.is_file()][:40]
            tests_listing.extend(names)
        except OSError:
            continue

    files: list[dict] = []
    used = 0
    seen: set[str] = set()
    candidates: list[str] = []
    for name in _DIGEST_KEY_FILES:
        if name in seen:
            continue
        seen.add(name)
        candidates.append(name)
    for name in tree:
        base = name.rstrip("/")
        if base.endswith(".py") or base.endswith(".ts") or base.endswith(".js"):
            if base not in seen and len(candidates) < 14:
                seen.add(base)
                candidates.append(base)
    for rel in candidates:
        if used >= _DIGEST_TOTAL_CHARS or len(files) >= 12:
            break
        full = os.path.join(root, rel)
        if not os.path.isfile(full):
            continue
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as fh:
                content = fh.read(_DIGEST_FILE_CHARS)
        except OSError:
            continue
        if not content.strip():
            continue
        files.append({"path": rel, "chars": len(content),
                      "content": content})
        used += len(content)

    return {"root": root, "tree": tree, "files": files,
            "tests": tests_listing}


def git_worktree_digest(path: str) -> dict | None:
    """Read-only git facts about a project, through the ONE exec boundary.

    Returns ``{"status", "diff", "log", "is_repo"}`` — all bounded — or
    None when the path is not a readable directory. Every command is
    read-only; a git that fails or is absent yields empty strings with
    ``is_repo=False``, never an error, because this digest exists to
    ground post-execution questions in what ACTUALLY changed, and "no
    git here" is an honest answer too.
    """
    import os

    from ..environment.procexec import run_argv

    root = os.path.realpath(path or "")
    if not root or not os.path.isdir(root):
        return None

    def _run(argv: list[str], timeout_ms: int = 6_000) -> str:
        try:
            r = run_argv(argv, timeout_ms=timeout_ms, cwd=root)
        except Exception:  # noqa: BLE001 — grounding is best-effort
            return ""
        if r.exit_code != 0:
            return ""
        return (r.stdout or "")[:2_000]

    status = _run(["git", "status", "--porcelain=v1", "-b"])
    return {
        "is_repo": bool(status),
        "status": status,
        "diff": _run(["git", "diff", "--no-color", "--stat"])
        + "\n" + _run(["git", "diff", "--no-color"]),
        "log": _run(["git", "log", "--oneline", "-8"]),
    }


def scan_project(path: str) -> list[str]:
    """A cheap, read-only look at a project, through the ONE exec boundary.

    Returns bounded strings: the top-level layout and a sample of tracked
    paths. Never the file CONTENTS — a planner that needs to read code
    delegates that to a worker under a task contract, which is the whole
    point of the architecture. A directory that is not a git worktree, or
    a git that does not answer, yields nothing rather than an error: the
    absence of context is a smaller problem than a broken submit.
    """
    import os

    from ..environment.procexec import run_argv

    if not path or not os.path.isdir(path):
        return []
    out: list[str] = []
    try:
        listing = sorted(
            entry.name + ("/" if entry.is_dir() else "")
            for entry in list(os.scandir(path))[:200]
            if not entry.name.startswith("."))[:MAX_PROJECT_PATHS]
    except OSError:
        listing = []
    if listing:
        out.append("top level: " + ", ".join(listing))
    try:
        result = run_argv(["git", "ls-files"], timeout_ms=PROJECT_SCAN_TIMEOUT_MS,
                          cwd=path)
    except Exception:  # noqa: BLE001 — context is optional, never fatal
        return out
    if result.exit_code != 0:
        return out
    files = [line for line in (result.stdout or "").splitlines() if line]
    if files:
        out.append(f"tracked files: {len(files)}")
        out.append("sample: " + ", ".join(files[:MAX_PROJECT_PATHS]))
    return out


def _artifact_texts(project_id: str, artifacts: dict | None) -> list[str]:
    """Bounded identity/summary lines for the bundle. Misshapen values
    are skipped field by field — one bad field never costs the rest."""
    if not isinstance(artifacts, dict):
        return []
    out: list[str] = []
    ident = artifacts.get("identity")
    if isinstance(ident, dict):
        bits = [f"project identity for '{project_id}'"]
        purpose = ident.get("purpose")
        if isinstance(purpose, str) and purpose.strip():
            bits.append("purpose: " + purpose.strip()[:200])
        meta = [str(ident.get(k)) for k in ("repositoryType", "primaryLanguage")
                if ident.get(k)]
        if meta:
            bits.append("type/language: " + ", ".join(meta)[:120])
        entries = ident.get("entryPoints")
        if isinstance(entries, list):
            named = [str(e) for e in entries[:3] if e]
            if named:
                bits.append("entry points: " + ", ".join(named)[:160])
        if len(bits) > 1:
            out.append("; ".join(bits))
    summary = artifacts.get("summary")
    if isinstance(summary, dict):
        bits = [f"project summary for '{project_id}'"]
        purpose = summary.get("purpose")
        if isinstance(purpose, str) and purpose.strip():
            bits.append(str(purpose.strip()[:200]))
        modules = summary.get("modules")
        if isinstance(modules, list):
            named = [str(m.get("name")) for m in modules[:8]
                     if isinstance(m, dict) and m.get("name")]
            if named:
                bits.append("modules: " + ", ".join(named)[:200])
        total = summary.get("totalFiles")
        if isinstance(total, int):
            bits.append(f"files: {total}")
        if len(bits) > 1:
            out.append("; ".join(bits))
    return out


class ContextAssembler:
    def __init__(self, workflow_lister=None, capability_lister=None,
                 approval_lister=None, session_loader=None,
                 project_scanner=None, project_artifacts=None,
                 capability_summary=None, project_inspect=None,
                 document_lister=None) -> None:
        self._workflows = workflow_lister or (lambda: [])
        self._capabilities = capability_lister or (lambda: [])
        self._approvals = approval_lister or (lambda: [])
        self._sessions = session_loader or (lambda sid: None)
        self._project_scan = project_scanner or (lambda path: [])
        self._artifacts = (project_artifacts
                           or (lambda pid: load_project_artifacts(pid)))
        # Machine capabilities, measured — bounded lines for planning
        # prompts, never an inventory dump. Project inspection reads
        # the working project's own markers (unexecuted data).
        self._capability_summary = capability_summary
        self._project_inspect = project_inspect
        # Knowledge-base document inventory (Phase 16). The intent
        # compiler cannot pick knowledge.search for "what does my PDF
        # say" if it has no evidence a document was ingested — so the
        # model asks a clarifying question the user just answered by
        # uploading a file. Surface a bounded list here so the model
        # can decide without re-asking. NEVER carries document text —
        # only filenames + counts — because content is untrusted data
        # and belongs in verified_outputs, not planning context.
        self._documents = document_lister or (lambda: [])

    def assemble(self, session_id: str | None = None,
                 project_path: str | None = None,
                 editor_block: str | None = None,
                 project_id: str | None = None) -> ContextBundle:
        bundle = ContextBundle()
        # The fabric capability manifest is the model's action space —
        # truncating it silently blinds the intent compiler to real,
        # registered capabilities (bug found in Phase 15: knowledge.search
        # and document.ingest were being cut off, causing the model to
        # claim they were unavailable). The manifest is bounded to ~40
        # items by design; render() still caps output by char budget.
        caps = self._capabilities()
        for c in caps:
            bundle.items.append(ContextItem(
                kind="capability",
                text=f"{c.id}: {c.description} (risk {c.risk})",
                provenance=PROVENANCE_SYSTEM))
        # Ingested documents: filenames only, bounded. Lets the intent
        # compiler pick knowledge.search for "what does my PDF say"
        # without asking a clarifying question the user just answered
        # by uploading. NEVER includes chunk text — content is untrusted
        # data and reaches the model through verified_outputs after a
        # governed retrieval, not through planning context.
        try:
            docs = list(self._documents() or [])[:MAX_ITEMS_PER_SOURCE]
        except Exception:  # noqa: BLE001 — must not break intent
            docs = []
        for d in docs:
            path = str(d.get("path") or d.get("filename") or "").strip()
            if not path:
                continue
            filename = path.rsplit("/", 1)[-1][:200]
            chunks = d.get("chunk_count") or d.get("chunkCount") or 0
            mime = d.get("mime_type") or d.get("mimeType") or ""
            bundle.items.append(ContextItem(
                kind="document",
                text=(f"{filename}"
                      + (f" ({chunks} chunk(s))" if chunks else "")
                      + (f" [{mime}]" if mime else "")),
                provenance=PROVENANCE_STORE))
        wfs = self._workflows()[:MAX_ITEMS_PER_SOURCE]
        for w in wfs:
            bundle.items.append(ContextItem(
                kind="workflow",
                text=f"{w.get('id')}: {w.get('name')} "
                     f"({w.get('nodeCount', '?')} nodes)",
                provenance=PROVENANCE_STORE))
        approvals = self._approvals()[:MAX_ITEMS_PER_SOURCE]
        for a in approvals:
            summary = a.get("summary") or ""
            bundle.items.append(ContextItem(
                kind="approval",
                text=f"{a.get('id')} pending: {summary[:200]}",
                provenance=PROVENANCE_SYSTEM))
        if session_id:
            session = self._sessions(session_id)
            if session is not None:
                for m in session.messages[-6:]:
                    bundle.items.append(ContextItem(
                        kind="message", text=f"{m.role}: {m.content[:300]}",
                        provenance=PROVENANCE_SESSION))
        grounded = False
        if project_path:
            for entry in self._project_scan(project_path)[:MAX_ITEMS_PER_SOURCE]:
                bundle.items.append(ContextItem(
                    kind="project", text=str(entry)[:300],
                    provenance=PROVENANCE_EXTERNAL, untrusted=True))
                grounded = True
        if project_id:
            try:
                artifacts = self._artifacts(project_id)
            except Exception:
                artifacts = None
            for text in _artifact_texts(project_id, artifacts):
                bundle.items.append(ContextItem(
                    kind="project", text=text[:300],
                    provenance=PROVENANCE_EXTERNAL, untrusted=True))
                grounded = True
        if (project_id or project_path) and not grounded:
            # The turn names a project AURA knows nothing about. The
            # model must hear that explicitly, or it will fill the gap
            # with invented project facts.
            bundle.items.append(ContextItem(
                kind="message",
                text=(f"Project grounding is unavailable for "
                      f"'{project_id or project_path}'. Answer from "
                      f"session context only; do not invent project "
                      f"facts."),
                provenance=PROVENANCE_SYSTEM))
        if project_path and self._project_inspect is not None:
            # What THIS project needs (its own markers, read not run).
            # Kept separate from global machine capabilities on purpose:
            # the planner joins "project needs X" with "machine has X".
            try:
                from ..capabilities.project import project_summary

                report = self._project_inspect(project_path)
                line = project_summary(report) if report is not None else None
            except Exception:
                line = None
            if line:
                bundle.items.append(ContextItem(
                    kind="project", text=line[:300],
                    provenance=PROVENANCE_EXTERNAL, untrusted=True))
        if self._capability_summary is not None:
            # What THIS machine can do (measured, bounded). Global
            # capabilities only — project needs ride above, separately.
            try:
                lines = self._capability_summary() or []
            except Exception:
                lines = []
            for entry in list(lines)[:6]:
                bundle.items.append(ContextItem(
                    kind="capability", text=str(entry)[:200],
                    provenance=PROVENANCE_SYSTEM))
        if editor_block:
            # Ephemeral editor snapshot (Ctrl+I and siblings): fenced
            # untrusted content, chunked to the item bound, capped so one
            # editor request can never flood the model context.
            chunk = MAX_ITEM_CHARS
            for part in [editor_block[i:i + chunk]
                         for i in range(0, len(editor_block), chunk)][:8]:
                bundle.items.append(ContextItem(
                    kind="editor", text=part,
                    provenance=PROVENANCE_EXTERNAL, untrusted=True))
        return bundle
