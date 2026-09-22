"""Curated machine capabilities — what to look for, and what each may do.

Each entry names environment catalog node ids (the ONE place probe
commands live — this table never duplicates a probe spec) plus the
action table AURA may plan against, graded by machine-action risk.

Rules for extending this table:

- An entry without a measured executable is ``unavailable`` — the
  table asserts candidacy, never presence.
- An action without a fixed ``argv`` template is planning metadata
  only: resolution refuses it rather than composing a command.
- ``requirements`` name services the tool needs beyond its binary
  (``docker-daemon``); the registry checks the ones it knows how to
  check and reports the rest as unevaluated, never as satisfied.
- ``install_hint`` comes from the existing install affordances only;
  None means "no supported installer known", never an invented command.
"""

from __future__ import annotations

from .model import Category


def _ro(name: str, description: str, argv: list[str] | None = None) -> dict:
    return {"name": name, "description": description, "risk": "read-only",
            "argv": list(argv or []), "requires_approval": False}


def _low(name: str, description: str, argv: list[str] | None = None) -> dict:
    return {"name": name, "description": description, "risk": "low-risk",
            "argv": list(argv or []), "requires_approval": False}


def _mod(name: str, description: str, approval: bool = False) -> dict:
    return {"name": name, "description": description, "risk": "modify",
            "argv": [], "requires_approval": approval}


def _des(name: str, description: str) -> dict:
    return {"name": name, "description": description, "risk": "destructive",
            "argv": [], "requires_approval": True}


#: capability id → spec. ``nodes`` are python-catalog node ids probed
#: in order; the first that verifies wins.
TOOL_SPECS: dict[str, dict] = {
    "git": {
        "name": "Git", "category": "version-control",
        "description": "Distributed version control.",
        "nodes": ["git"],
        "fabric_capabilities": ["git.status"],
        "actions": [
            _ro("status", "Working tree status.", ["{exe}", "status", "--porcelain=v1", "-b"]),
            _ro("diff", "Uncommitted changes.", ["{exe}", "diff", "--no-color"]),
            _ro("log", "Recent history.", ["{exe}", "log", "--oneline", "-20"]),
            _ro("branch-list", "Local branches.", ["{exe}", "branch", "--list"]),
            _low("branch-create", "Create a branch (name supplied by the governed caller)."),
            _mod("stage", "Stage paths (supplied by the governed caller)."),
            _mod("commit", "Record a commit (message supplied by the governed caller).", approval=False),
            _mod("push", "Publish commits elsewhere; leaves this machine.", approval=True),
            _des("reset-hard", "Discard uncommitted work and move the branch tip."),
        ],
    },
    "node": {
        "name": "Node.js", "category": "development",
        "description": "JavaScript runtime.",
        "nodes": ["node"],
        "actions": [
            _ro("version", "Runtime version.", ["{exe}", "--version"]),
            _low("run", "Run a script file (path supplied by the governed caller)."),
            _low("test", "Run the project's test command (resolved from project files, never invented)."),
            _low("build", "Run the project's build command (resolved from project files, never invented)."),
        ],
    },
    "npm": {
        "name": "npm", "category": "development",
        "description": "Node package manager.",
        "nodes": ["npm"],
        "actions": [
            _ro("version", "Manager version.", ["{exe}", "--version"]),
            _low("install", "Install locked dependencies into the project."),
            _low("test", "Run the package test script."),
            _mod("install-package", "Add a new dependency (name supplied by the governed caller)."),
        ],
    },
    "python": {
        "name": "Python", "category": "development",
        "description": "Python interpreter.",
        "nodes": ["python"],
        "actions": [
            _ro("version", "Interpreter version.", ["{exe}", "--version"]),
            _low("execute", "Run a script file (path supplied by the governed caller)."),
            _low("test", "Run pytest in the project (only when the project declares it)."),
            _mod("install-package", "Install a package (name supplied by the governed caller)."),
        ],
    },
    "cargo": {
        "name": "Cargo", "category": "development",
        "description": "Rust build system and package manager.",
        "nodes": ["rust"],
        "actions": [
            _ro("version", "Toolchain version.", ["{exe}", "--version"]),
            _low("build", "Build the workspace's default targets."),
            _low("test", "Run the workspace test suite."),
        ],
    },
    "go": {
        "name": "Go", "category": "development",
        "description": "Go toolchain.",
        "nodes": ["go"],
        "actions": [
            _ro("version", "Toolchain version.", ["{exe}", "version"]),
            _low("build", "Build the module's packages."),
            _low("test", "Run the module test suite."),
        ],
    },
    "java": {
        "name": "Java", "category": "development",
        "description": "Java runtime toolchain.",
        "nodes": ["java"],
        "actions": [
            _ro("version", "Runtime version.", ["{exe}", "-version"]),
            _low("build", "Build with the project's declared build tool."),
        ],
    },
    "docker": {
        "name": "Docker", "category": "containers",
        "description": "Container runtime.",
        "nodes": ["docker"],
        "requirements": ["docker-daemon"],
        "actions": [
            _ro("version", "Client version.", ["{exe}", "--version"]),
            _ro("list", "Running containers.", ["{exe}", "ps", "--format", "{{.Names}}"]),
            _mod("build", "Build an image from the project's Dockerfile.", approval=False),
            _mod("run", "Run a container (image and flags supplied by the governed caller).", approval=True),
        ],
    },
    "curl": {
        "name": "curl", "category": "network",
        "description": "HTTP transfer tool.",
        "nodes": ["curl"],
        "actions": [
            _ro("version", "Tool version.", ["{exe}", "--version"]),
            _low("fetch", "Retrieve a URL (supplied by the governed caller; response treated as untrusted data)."),
        ],
    },
    "chromium": {
        "name": "Chromium", "category": "browsers",
        "description": "Browser binary for automation.",
        "nodes": ["chromium", "chrome", "firefox"],
        "actions": [
            _ro("version", "Browser version.", ["{exe}", "--version"]),
            _low("launch", "Launch headless for automation (flags supplied by the governed caller)."),
        ],
    },
    "playwright": {
        "name": "Playwright", "category": "browsers",
        "description": "Browser automation and E2E testing.",
        "nodes": ["playwright"],
        "requirements": ["browser"],
        "actions": [
            _low("test", "Run the project's Playwright suite (only when the project declares it)."),
            _low("screenshot", "Capture a page (URL supplied by the governed caller)."),
        ],
    },
    "sqlite": {
        "name": "SQLite", "category": "database",
        "description": "Embedded database CLI.",
        "nodes": ["sqlite"],
        "actions": [
            _ro("version", "Tool version.", ["{exe}", "--version"]),
            _ro("query", "Run a read-only query (SQL supplied by the governed caller)."),
            _mod("execute", "Run a write statement (SQL supplied by the governed caller).", approval=True),
        ],
    },
    "ollama": {
        "name": "Ollama", "category": "ai",
        "description": "Local model server (this machine or another).",
        "nodes": ["ollama"],
        "requirements": ["ollama-endpoint"],
        "actions": [
            _low("chat", "Generate with a served model (model and prompt supplied by the governed caller)."),
            _ro("list-models", "Models the server offers."),
        ],
    },
    "shell": {
        "name": "Shell", "category": "system",
        "description": "Command execution boundary (POSIX sh).",
        "nodes": ["bash"],
        "actions": [
            _mod("execute", "Run a vetted argv (composed by the governed executor, never by the model).", approval=False),
        ],
    },
}

#: Worker role → machine capabilities the role wants available. Used
#: for REPORTING (what is missing for this role), never for authority:
#: dispatch still matches connected worker nodes, and a missing tool
#: fails the message, never the plan, until the executor needs it.
ROLE_TOOL_NEEDS: dict[str, list[str]] = {
    "code": ["git"],
    "review": ["git"],
    "execute": ["shell"],
    "research": [],
    "planning": [],
    "testing": [],
    "documentation": [],
}

#: Governed capability → machine capabilities it needs beneath it.
#: Only entries with a real machine dependency are listed: everything
#: else is decided by manifest + authority exactly as before.
CAPABILITY_MACHINE_NEEDS: dict[str, list[str]] = {
    "git.status": ["git"],
}


def tool_spec(capability_id: str) -> dict | None:
    """The curated spec, or None for an id this table does not know.
    Unknown ids are the caller's mistake to handle fail-closed — the
    table never invents a spec."""
    return TOOL_SPECS.get(capability_id)


def categories() -> list[Category]:
    seen: list[Category] = []
    for spec in TOOL_SPECS.values():
        cat = spec["category"]
        if cat not in seen:
            seen.append(cat)
    return seen
