"""Project Identity Engine.

A port of packages/ai-service/src/intelligence/identity.ts.

Repository Identity is AURA's single source of truth — every field here
becomes an authoritative fact in the prompt. So identity is derived from
REAL, WEIGHTED repository evidence, never from language alone and never
from the first folders encountered.

One deep scan of the tree gathers directory names at every depth, a
bounded sample of source files, build markers and language weights. Each
field is then decided from that combined evidence.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..core import js_regex
from ..core.js_number import js_number
from ..core.js_string import slice_utf16
from ..core.node_path import rel_path as node_rel
from ..core.node_time import mtime_ms
from .constants import DIR_WEIGHT, IGNORE_DIRS, LANG_BY_EXT

CANDIDATE_EXTS = frozenset({
    ".c", ".cc", ".cpp", ".h", ".rs", ".py", ".go", ".ts", ".tsx",
    ".js", ".jsx", ".s", ".asm", ".ld",
})

_ENTRY_DIRS = ("boot", "kernel", "arch", "src", "cmd", "init", "app")
_ENTRY_FILE = js_regex.compile(
    r"^(main|index|kmain|kernel|boot|start|_start|entry|app|linker|link)\b", "i"
)
_ENTRY_EXT = js_regex.compile(r"\.(ld|s|asm)$", "i")

# The scan budget. Post-decrement in the reference (`budget-- <= 0`), so
# it stops one entry LATER than a decrement-first loop would.
SCAN_BUDGET = 40000
CANDIDATE_CAP = 160


@dataclass
class RepoScan:
    """Everything one bounded pass over the tree observed."""

    # Every directory basename at any depth, lowercased.
    dir_names: set[str] = field(default_factory=set)
    # Tokens from directory names split on separators (x86_64 → x86, 64).
    dir_tokens: set[str] = field(default_factory=set)
    # Relative directory paths, lowercased (arch/x86_64 stays intact).
    dir_rel_paths: list[str] = field(default_factory=list)
    # Immediate child directories of the root, original case.
    top_level_dirs: list[str] = field(default_factory=list)
    # Weighted language counts, in insertion order (JavaScript `Map`).
    lang_counts: dict[str, int] = field(default_factory=dict)
    # Source files worth reading for entry-point / signal analysis.
    candidates: list[dict[str, str]] = field(default_factory=list)
    # File-extension presence, lowercased.
    exts: set[str] = field(default_factory=set)


def _read_dir(path: str) -> list[os.DirEntry[str]]:
    """`readdirSync(withFileTypes)`, in Node's order.

    Node returns entries sorted (libuv scans with `alphasort`); Python's
    `scandir` yields raw directory order. Sorting here is what keeps every
    bounded walk in this module — which stops at a budget or a cap —
    visiting the same files as the reference.
    """
    with os.scandir(path) as it:
        return sorted(it, key=lambda e: e.name)


def _ext_of(name: str) -> str:
    """`path.extname(name).toLowerCase()`.

    Node returns '' for a dotfile with no other dot, and for a name that
    ends in a dot it returns '.'.
    """
    base = name
    dot = base.rfind(".")
    if dot <= 0:
        return ""
    return base[dot:].lower()


def _dir_weight(rel_path: str) -> int:
    parts = rel_path.split(os.sep)
    for part in reversed(parts):
        weight = DIR_WEIGHT.get(part)
        if weight is not None:
            return weight
    return 3


def read_head(abs_path: str, num_bytes: int = 8192) -> str:
    """The first N BYTES of a file, decoded as UTF-8.

    Bytes, not characters: the reference allocates a buffer and decodes
    what it read, so a multibyte character straddling the boundary comes
    back as a replacement character in both runtimes.
    """
    try:
        with open(abs_path, "rb") as handle:
            return handle.read(num_bytes).decode("utf-8", errors="replace")
    except OSError:
        return ""


def scan_repository(root: str) -> RepoScan:
    scan = RepoScan()

    try:
        scan.top_level_dirs = [
            e.name for e in _read_dir(root)
            if e.is_dir() and e.name not in IGNORE_DIRS and not e.name.startswith(".")
        ]
    except OSError:
        pass

    budget = SCAN_BUDGET
    stack = [root]
    while stack and budget > 0:
        # `stack.pop()` takes the LAST pushed directory, so the walk is
        # depth-first in reverse readdir order. That decides which files
        # reach the candidate cap.
        directory = stack.pop()
        try:
            entries = _read_dir(directory)
        except OSError:
            continue
        for entry in entries:
            # Post-decrement: the OLD value is tested, so one more entry
            # is processed than a decrement-first loop would allow.
            old, budget = budget, budget - 1
            if old <= 0:
                break
            if entry.is_dir():
                if entry.name in IGNORE_DIRS or entry.name.startswith("."):
                    continue
                full = os.path.join(directory, entry.name)
                lower = entry.name.lower()
                scan.dir_names.add(lower)
                for token in js_regex.compile(r"[-_.]+").split(lower):
                    if token:
                        scan.dir_tokens.add(token)
                scan.dir_rel_paths.append(
                    node_rel(full, root).lower().replace(os.sep, "/")
                )
                stack.append(full)
                continue

            ext = _ext_of(entry.name)
            language = LANG_BY_EXT.get(ext)
            if language:
                rel = node_rel(os.path.join(directory, entry.name), root)
                scan.lang_counts[language] = (
                    scan.lang_counts.get(language, 0) + _dir_weight(rel)
                )
            if ext:
                scan.exts.add(ext)
            if ext in CANDIDATE_EXTS and len(scan.candidates) < CANDIDATE_CAP:
                base = entry.name.lower()
                parent = os.path.basename(directory).lower()
                if (
                    directory == root
                    or parent in _ENTRY_DIRS
                    or _ENTRY_FILE.search(base) is not None
                    or _ENTRY_EXT.search(base) is not None
                    or ext in (".ld", ".s", ".asm")
                ):
                    scan.candidates.append({
                        "rel": node_rel(os.path.join(directory, entry.name), root),
                        "abs": os.path.join(directory, entry.name),
                        "ext": ext,
                    })
    return scan


@dataclass
class RepoSignals:
    has_linker_script: bool
    has_boot_asm: bool
    # -ffreestanding / -nostdlib in the build
    has_freestanding: bool
    # kmain / _start / multiboot in sources
    has_kernel_entry: bool
    has_uefi: bool
    # .y / .l / .g4 → compiler
    has_grammar: bool
    # concatenated build-file heads (lowercased)
    build_text: str
    # x86_64, arm64, riscv … from paths + build
    arch_tokens: set[str]


_BUILD_FILES = ("Makefile", "makefile", "CMakeLists.txt", "Cargo.toml", "Kbuild",
                "meson.build")
_FREESTANDING = js_regex.compile(
    r"-ffreestanding|-nostdlib|-nostdinc|-mno-red-zone|-mcmodel=kernel"
)
_UEFI_BUILD = js_regex.compile(r"efi|uefi|gnu-efi")
_BOOT_ASM = js_regex.compile(r"\b_start\b|multiboot|\.global\s+_start|global\s+_start", "i")
_KERNEL_ENTRY = js_regex.compile(r"\bkmain\s*\(|\b_start\b|multiboot|kernel_main\s*\(", "i")
_UEFI_SRC = js_regex.compile(r"\befi_main\b|\bEfiMain\b|EFI_SYSTEM_TABLE")
_GRAMMAR_EXTS = (".y", ".l", ".g4", ".ebnf")


def collect_signals(root: str, scan: RepoScan) -> RepoSignals:
    build_text = ""
    for name in _BUILD_FILES:
        abs_path = os.path.join(root, name)
        if os.path.exists(abs_path):
            build_text += "\n" + read_head(abs_path, 4096).lower()

    arch_tokens: set[str] = set()
    hay = " ".join(scan.dir_rel_paths) + " " + " ".join(scan.dir_tokens) + " " + build_text
    if js_regex.compile(r"\b(x86[_-]?64|amd64|x64)\b").search(hay):
        arch_tokens.add("x86_64")
    if js_regex.compile(r"\b(i386|ia32|i686)\b").search(hay) or (
        js_regex.compile(r"\bx86\b").search(hay) and "x86_64" not in arch_tokens
    ):
        arch_tokens.add("x86")
    if js_regex.compile(r"\b(aarch64|arm64)\b").search(hay):
        arch_tokens.add("arm64")
    if js_regex.compile(r"\barm(v\d)?\b").search(hay):
        arch_tokens.add("arm")
    if js_regex.compile(r"\b(riscv|risc-v|rv64|rv32)\b").search(hay):
        arch_tokens.add("riscv")

    has_linker_script = False
    has_boot_asm = False
    has_kernel_entry = False
    has_uefi = False
    has_grammar = any(e in _GRAMMAR_EXTS for e in scan.exts)
    has_freestanding = _FREESTANDING.search(build_text) is not None
    if _UEFI_BUILD.search(build_text):
        has_uefi = True

    read = 0
    for candidate in scan.candidates:
        ext = candidate["ext"]
        if ext == ".ld":
            has_linker_script = True
        if ext in (".s", ".asm") and read < 60:
            text = read_head(candidate["abs"], 4096)
            if _BOOT_ASM.search(text):
                has_boot_asm = True
            read += 1
            continue
        if read >= 60:
            continue
        if ext in (".c", ".cc", ".cpp", ".h", ".rs"):
            text = read_head(candidate["abs"], 6144)
            read += 1
            if _KERNEL_ENTRY.search(text):
                has_kernel_entry = True
            if _UEFI_SRC.search(text):
                has_uefi = True
    if any(c["ext"] == ".ld" for c in scan.candidates):
        has_linker_script = True

    return RepoSignals(
        has_linker_script=has_linker_script, has_boot_asm=has_boot_asm,
        has_freestanding=has_freestanding, has_kernel_entry=has_kernel_entry,
        has_uefi=has_uefi, has_grammar=has_grammar, build_text=build_text,
        arch_tokens=arch_tokens,
    )


# Insertion order is load-bearing: ties in `detectRepositoryType` are
# broken by which type was scored FIRST, and JavaScript object literals
# preserve declaration order.
TYPE_DIR_PATTERNS: dict[str, dict[str, Any]] = {
    "operating-system": {"dirs": ["boot", "kernel", "arch", "mm", "drivers", "fs", "init",
                                  "sched", "scheduler", "ipc", "syscall", "interrupt",
                                  "irq", "acpi"], "weight": 4},
    "kernel": {"dirs": ["kernel", "arch", "mm", "drivers", "fs", "sched", "scheduler",
                        "ipc", "irq", "interrupt", "syscall"], "weight": 4},
    "compiler": {"dirs": ["parser", "lexer", "codegen", "ast", "ir", "optimizer", "sema",
                          "frontend", "backend", "typecheck"], "weight": 4},
    "database": {"dirs": ["storage", "query", "planner", "executor", "catalog",
                          "transaction", "wal", "btree", "buffer"], "weight": 4},
    "infrastructure": {"dirs": ["terraform", "helm", "charts", "ansible", "k8s",
                                "kubernetes", "manifests"], "weight": 5},
    "ai-framework": {"dirs": ["training", "inference", "models", "transformer",
                              "attention", "tokenizer", "dataset", "layers", "optim"],
                     "weight": 4},
    "cli": {"dirs": ["commands", "cmd", "cli", "subcommands"], "weight": 3},
    "library": {"dirs": ["lib", "src", "include"], "weight": 1},
    "frontend": {"dirs": ["components", "pages", "hooks", "styles", "assets", "views"],
                 "weight": 3},
    "backend": {"dirs": ["server", "api", "controllers", "routes", "services",
                         "middleware", "handlers"], "weight": 3},
    "fullstack": {"dirs": ["components", "pages", "server", "api", "controllers",
                           "routes"], "weight": 2},
    "mobile": {"dirs": ["android", "ios", "screens", "navigation"], "weight": 4},
    "desktop": {"dirs": ["src-tauri", "src-electron"], "weight": 5},
    "game": {"dirs": ["sprites", "scenes", "entities", "systems", "ecs"], "weight": 4},
    "embedded": {"dirs": ["firmware", "hal", "bsp"], "weight": 4},
}

WEB_FRONTEND = ("React", "Vue", "Next.js", "Nuxt", "SvelteKit", "Svelte", "Angular")
WEB_BACKEND = ("Express", "NestJS", "Fastify", "Koa", "Django", "Flask", "FastAPI")


def detect_repository_type(
    scan: RepoScan, sig: RepoSignals, frameworks: list[str], primary: str
) -> str:
    def present(name: str) -> bool:
        return name in scan.dir_names or name in scan.dir_tokens

    scores: dict[str, int] = {}
    for type_name, pattern in TYPE_DIR_PATTERNS.items():
        hits = sum(1 for d in pattern["dirs"] if present(d))
        if hits:
            scores[type_name] = hits * pattern["weight"]

    def bump(type_name: str, amount: int) -> None:
        scores[type_name] = scores.get(type_name, 0) + amount

    native_lang = primary in ("C", "C++", "Rust", "Assembly")
    if sig.has_linker_script:
        bump("operating-system", 5)
        bump("kernel", 5)
        bump("embedded", 3)
    if sig.has_boot_asm:
        bump("operating-system", 6)
        bump("kernel", 6)
    if sig.has_kernel_entry:
        bump("operating-system", 7)
        bump("kernel", 7)
    if sig.has_freestanding:
        bump("operating-system", 5)
        bump("kernel", 5)
        bump("embedded", 3)
    if sig.has_uefi:
        bump("operating-system", 3)
        bump("kernel", 2)
    if sig.has_grammar:
        bump("compiler", 5)

    kernel_score = max(scores.get("operating-system", 0), scores.get("kernel", 0))
    strong_kernel = (
        sig.has_kernel_entry
        or sig.has_boot_asm
        or (sig.has_linker_script and native_lang)
        or (present("boot") and (present("kernel") or present("arch")))
        or kernel_score >= 12
    )
    if strong_kernel and native_lang:
        return ("operating-system"
                if (present("boot") or present("arch") or present("init"))
                else "kernel")

    has_frontend = any(f in WEB_FRONTEND for f in frameworks)
    has_backend = any(f in WEB_BACKEND for f in frameworks)
    if has_frontend and has_backend:
        return "fullstack"
    if has_frontend:
        return "frontend"
    if has_backend:
        return "backend"
    if any(f in ("Tauri", "Electron") for f in frameworks):
        return "desktop"

    best = "unknown"
    best_score = 0
    for type_name, score in scores.items():
        if score > best_score:
            best_score = score
            best = type_name
    if best_score > 0:
        return best

    if native_lang and (present("kernel") or present("arch") or present("drivers")):
        return "kernel"
    if present("src") or present("lib"):
        return "library"
    return "unknown"


def detect_architecture_style(scan: RepoScan, repo_type: str) -> str:
    def has(name: str) -> bool:
        return name in scan.dir_names or name in scan.dir_tokens

    if repo_type in ("kernel", "operating-system"):
        if has("microkernel") or has("ukernel") or has("servers") or (
            has("ipc") and has("message")
        ):
            return "microkernel"
        return "monolithic"
    if repo_type in ("compiler", "database", "library"):
        return "layered"
    if has("gateway") and (has("services") or has("microservices")):
        return "microservices"
    if has("events") or has("event-bus") or has("pubsub"):
        return "event-driven"
    if has("plugins") or has("extensions") or has("addons"):
        return "plugin-based"
    if repo_type in ("frontend", "fullstack") and (
        has("controllers") and has("views") and has("models")
    ):
        return "mvc"
    if repo_type == "cli":
        return "monolithic"
    return "monolithic"


def detect_platforms(
    scan: RepoScan, sig: RepoSignals, frameworks: list[str],
    has: dict[str, bool], repo_type: str, primary: str,
) -> list[str]:
    # A JavaScript `Set` preserves insertion order, and the result is
    # spread into an array — so this dict is an ordered set.
    platforms: dict[str, None] = {}

    for arch in sig.arch_tokens:
        platforms[arch] = None
    if sig.has_uefi:
        platforms["uefi"] = None

    if has.get("frontend") or any(f in WEB_FRONTEND for f in frameworks):
        platforms["web"] = None
        platforms["browser"] = None
    if has.get("backend") or any(f in WEB_BACKEND for f in frameworks):
        platforms["node"] = None
    if any(f in ("React Native", "Expo") for f in frameworks):
        platforms["ios"] = None
        platforms["android"] = None
    if any(f in ("Tauri", "Electron") for f in frameworks):
        platforms["linux"] = None
        platforms["darwin"] = None
        platforms["windows"] = None
    if any(f == "Wasm" for f in frameworks):
        platforms["wasm"] = None
    if any(d in scan.dir_names for d in ("embedded", "firmware", "hal", "bsp")):
        platforms["embedded"] = None

    is_native_system = (
        repo_type in ("operating-system", "kernel", "embedded")
        or sig.has_freestanding or sig.has_linker_script or sig.has_boot_asm
    )
    if is_native_system and "embedded" not in platforms:
        platforms["bare-metal"] = None

    if not platforms:
        if primary in ("TypeScript", "JavaScript"):
            platforms["node"] = None
        else:
            platforms["native"] = None
    return list(platforms)


_ENTRY_RE_LD = js_regex.compile(r"ENTRY\s*\(\s*([A-Za-z_]\w*)\s*\)")
_ENTRY_RE_ASM = js_regex.compile(r"(\.global|global)\s+_start|^_start\s*:", "im")
_ENTRY_KMAIN = js_regex.compile(r"\bkmain\s*\(")
_ENTRY_KERNEL_MAIN = js_regex.compile(r"\bkernel_main\s*\(")
_ENTRY_EFI = js_regex.compile(r"\befi_main\b|\bEfiMain\b")
_ENTRY_START = js_regex.compile(r"\b_start\b")
_ENTRY_C_MAIN = js_regex.compile(r"^\s*(?:int|void)\s+main\s*\(", "m")
_ENTRY_RS_MAIN = js_regex.compile(r"\bfn\s+main\s*\(")
_ENTRY_RS_NOMAIN = js_regex.compile(r"#!\[no_main\]|#\[no_mangle\][\s\S]{0,80}_start")
_ENTRY_PY_MAIN = js_regex.compile(r"if\s+__name__\s*==\s*['\"]__main__['\"]")
_ENTRY_GO_PKG = js_regex.compile(r"package\s+main")
_ENTRY_GO_MAIN = js_regex.compile(r"func\s+main\s*\(")
_ENTRY_WEB = js_regex.compile(
    r"createRoot\s*\(|ReactDOM\.render\s*\(|\.render\s*\(\s*<|createApp\s*\("
)


def detect_entry_points(root: str, scan: RepoScan) -> list[str]:
    """Entry points from real analysis, not a fixed list.

    **A dangling `else` in the reference is preserved here.** Its source
    reads

        if (pkg.bin && typeof pkg.bin === 'object') for (…) if (…) …;
        else if (typeof pkg.bin === 'string') …

    and the `else` binds to the INNER `if`, inside the loop, inside the
    outer `if`. So a `bin` that is a plain string is never recorded — the
    outer condition is false and the whole statement is skipped. Reading
    it as intended would add an entry point the reference does not have.
    """
    found: dict[str, str] = {}

    pkg_abs = os.path.join(root, "package.json")
    if os.path.exists(pkg_abs):
        try:
            pkg = json.loads(read_head(pkg_abs, 8192))
        except (ValueError, TypeError):
            pkg = None
        if isinstance(pkg, dict):
            main = pkg.get("main")
            if isinstance(main, str):
                found[main] = main
            binary = pkg.get("bin")
            if binary and isinstance(binary, dict):
                for value in binary.values():
                    if isinstance(value, str):
                        found[value] = f"{value} (bin)"
                    # The dangling `else` lands here and tests `pkg.bin`
                    # itself, which is an object — so it never fires.

    read = 0
    for candidate in scan.candidates:
        if read >= 100:
            break
        rel = candidate["rel"].replace(os.sep, "/")
        ext = candidate["ext"]
        if ext == ".ld":
            match = _ENTRY_RE_LD.search(read_head(candidate["abs"], 4096))
            if match:
                found[rel] = f"{rel} (ENTRY {match.group(1)})"
            read += 1
            continue
        text = read_head(candidate["abs"], 6144)
        read += 1
        if ext in (".s", ".asm"):
            if _ENTRY_RE_ASM.search(text):
                found[rel] = f"{rel} (_start)"
            continue
        if ext in (".c", ".cc", ".cpp", ".h"):
            if _ENTRY_KMAIN.search(text):
                found[rel] = f"{rel} (kmain)"
            elif _ENTRY_KERNEL_MAIN.search(text):
                found[rel] = f"{rel} (kernel_main)"
            elif _ENTRY_EFI.search(text):
                found[rel] = f"{rel} (efi_main)"
            elif _ENTRY_START.search(text):
                found[rel] = f"{rel} (_start)"
            elif _ENTRY_C_MAIN.search(text):
                found[rel] = f"{rel} (main)"
        elif ext == ".rs":
            if _ENTRY_RS_MAIN.search(text):
                found[rel] = f"{rel} (main)"
            elif _ENTRY_RS_NOMAIN.search(text):
                found[rel] = f"{rel} (_start)"
        elif ext == ".py":
            if _ENTRY_PY_MAIN.search(text):
                found[rel] = f"{rel} (__main__)"
        elif ext == ".go":
            if _ENTRY_GO_PKG.search(text) and _ENTRY_GO_MAIN.search(text):
                found[rel] = f"{rel} (main)"
        elif ext in (".ts", ".tsx", ".js", ".jsx") and _ENTRY_WEB.search(text):
            found[rel] = f"{rel} (app entry)"
    return list(found.values())[:8]


SUBSYSTEMS: list[tuple[str, str]] = [
    (r"^(boot|bootloader|bootstrap)$", "Boot"),
    (r"^(arch|platform|plat)$", "Arch/Platform"),
    (r"^(mm|memory|vm|paging|heap|alloc)$", "Memory"),
    (r"^(sched|scheduler|task|tasks|proc|process|processes|thread|threads)$",
     "Scheduler/Processes"),
    (r"^(fs|vfs|filesystem)$", "Filesystem"),
    (r"^(drivers?|dev|device)$", "Drivers"),
    (r"^(net|network|networking|tcpip|socket)$", "Networking"),
    (r"^(graphics|gpu|video|fb|framebuffer|display|vga|render)$", "Graphics"),
    (r"^(ipc|message|messaging|mailbox)$", "IPC"),
    (r"^(irq|interrupt|interrupts|idt|isr|trap)$", "Interrupts"),
    (r"^(syscall|syscalls|abi)$", "Syscalls"),
    (r"^(acpi)$", "ACPI"),
    (r"^(pci)$", "PCI"),
    (r"^(usb)$", "USB"),
    (r"^(time|timer|timers|clock|pit|rtc)$", "Timers"),
    (r"^(lib|klib|libk|libc)$", "Kernel Library"),
    (r"^(shell|term|terminal|console|tty|serial)$", "Console/Terminal"),
    (r"^(security|crypto|auth)$", "Security"),
]
_SUBSYSTEM_RES = [(js_regex.compile(p), label) for p, label in SUBSYSTEMS]

_PRETTIFY_SEP = js_regex.compile(r"[-_]")
_PRETTIFY_WORD = js_regex.compile(r"\b\w")


def prettify(name: str) -> str:
    spaced = _PRETTIFY_SEP.sub(" ", name)
    return _PRETTIFY_WORD.sub(lambda m: m.group(0).upper(), spaced)


_SKIP_STRUCTURAL = ("docs", "test", "tests", "examples", "scripts", "assets", "public")


def detect_modules(root: str, scan: RepoScan, repo_type: str) -> list[str]:
    canonical: list[str] = []
    seen: set[str] = set()
    for pattern, label in _SUBSYSTEM_RES:
        for token in scan.dir_tokens:
            if pattern.search(token) and label not in seen:
                seen.add(label)
                canonical.append(label)
                break

    structural: list[str] = []
    src_dir = os.path.join(root, "src")
    if os.path.exists(src_dir):
        try:
            for entry in _read_dir(src_dir):
                if (entry.is_dir() and entry.name not in IGNORE_DIRS
                        and not entry.name.startswith(".")):
                    structural.append(prettify(entry.name))
        except OSError:
            pass
    for name in scan.top_level_dirs:
        if name == "src" or len(name) <= 1:
            continue
        if name.lower() in _SKIP_STRUCTURAL:
            continue
        structural.append(prettify(name))

    # For a system repo with clear subsystems, those subsystems ARE the
    # modules — appending raw folder names would just duplicate them.
    is_system = repo_type in ("operating-system", "kernel", "embedded")
    merged = canonical if (is_system and len(canonical) >= 3) else [*canonical, *structural]
    return list(dict.fromkeys(merged))[:20]


_BUILD_SYSTEMS: list[tuple[str, str]] = [
    ("Makefile", "Make"), ("makefile", "Make"), ("CMakeLists.txt", "CMake"),
    ("Cargo.toml", "Cargo"), ("go.mod", "Go build"), ("build.gradle", "Gradle"),
    ("build.gradle.kts", "Gradle"), ("pom.xml", "Maven"), ("meson.build", "Meson"),
    ("Kbuild", "Kbuild"), ("vite.config.ts", "Vite"), ("vite.config.js", "Vite"),
    ("next.config.js", "Next.js"), ("next.config.mjs", "Next.js"),
    ("webpack.config.js", "Webpack"), ("pyproject.toml", "Python build"),
    ("tsconfig.json", "TypeScript (tsc)"),
]


def detect_build_system(root: str) -> str | None:
    for file_name, label in _BUILD_SYSTEMS:
        if os.path.exists(os.path.join(root, file_name)):
            return label
    return None


_MD_TICK = js_regex.compile(r"`")
_MD_STAR = js_regex.compile(r"\*+")
_MD_EMPHASIS = js_regex.compile(r"(^|[\s(])_([^_]+)_(?=[\s).,]|$)")


def extract_readme_purpose(root: str) -> str:
    readme = os.path.join(root, "README.md")
    if not os.path.exists(readme):
        return ""
    try:
        lines = [line.strip() for line in read_head(readme, 8192).split("\n")]
    except OSError:
        return ""

    def clean(text: str) -> str:
        # Strip markdown emphasis but PRESERVE underscores inside words
        # (x86_64), exactly as the reference does.
        stripped = _MD_EMPHASIS.sub(
            lambda m: m.group(1) + m.group(2), _MD_STAR.sub("", _MD_TICK.sub("", text))
        )
        return slice_utf16(stripped, 0, 300)

    prose = next(
        (line for line in lines
         if line and not line.startswith(("#", "![", "[!", "<", "```"))),
        None,
    )
    if prose:
        return clean(prose)
    heading = next((line for line in lines if line.startswith("# ")), None)
    if heading:
        return clean(js_regex.compile(r"^#\s*").sub("", heading, count=1))
    return ""


TYPE_NOUN: dict[str, str] = {
    "operating-system": "operating-system kernel",
    "kernel": "operating-system kernel",
    "compiler": "compiler / language toolchain",
    "database": "database engine",
    "library": "library",
    "cli": "command-line tool",
    "frontend": "frontend application",
    "backend": "backend service",
    "fullstack": "full-stack application",
    "infrastructure": "infrastructure project",
    "ai-framework": "AI / ML framework",
    "mobile": "mobile application",
    "desktop": "desktop application",
    "game": "game",
    "embedded": "embedded firmware project",
    "unknown": "software project",
}


def synthesize_purpose(
    name: str, repo_type: str, primary: str, platforms: list[str], modules: list[str]
) -> str:
    noun = TYPE_NOUN[repo_type]
    plat = [p for p in platforms if p not in ("native", "node")][:3]
    plat_str = f" for {', '.join(plat)}" if plat else ""
    mods = ", ".join(modules[:4])
    mod_str = f", organized around {mods}" if mods else ""
    lang_str = f" written in {primary}" if primary and primary != "unknown" else ""
    return f"{name} is a {noun}{lang_str}{plat_str}{mod_str}."


_ARCH_PLATFORMS = ("x86_64", "x86", "arm", "arm64", "riscv", "uefi")


def extract_tech_stack(
    root: str, primary: str, secondary: list[str], frameworks: list[str],
    build_system: str | None, platforms: list[str],
) -> list[str]:
    stack: dict[str, None] = {}
    if primary != "unknown":
        stack[primary] = None
    for name in secondary:
        stack[name] = None
    for name in frameworks:
        stack[name] = None
    if build_system:
        stack[build_system] = None
    for platform in platforms:
        if platform in _ARCH_PLATFORMS:
            stack[platform] = None
    if os.path.exists(os.path.join(root, "tsconfig.json")):
        stack["TypeScript"] = None
    if os.path.exists(os.path.join(root, "Dockerfile")):
        stack["Docker"] = None
    if os.path.exists(os.path.join(root, ".github", "workflows")):
        stack["GitHub Actions"] = None
    return list(stack)


IDENTITY_MARKERS = (
    "package.json", "requirements.txt", "pyproject.toml", "go.mod",
    "Cargo.toml", "pom.xml", "Makefile", "CMakeLists.txt",
)


def compute_fingerprint(root: str) -> str:
    """The identity fingerprint, stringified the way JavaScript does.

    Compared for EQUALITY to decide whether the whole repository identity
    is regenerated, so both the arithmetic (`node_time`) and the
    formatting (`js_number`) have to match the reference exactly.
    """
    parts = []
    for marker in IDENTITY_MARKERS:
        try:
            parts.append(f"{marker}:{js_number(mtime_ms(os.path.join(root, marker)))}")
        except OSError:
            parts.append(f"{marker}:0")
    return "|".join(parts)


def generate_identity(
    project_id: str, root: str, profile: dict[str, Any], now: str
) -> dict[str, Any]:
    """Derive a project's identity from one weighted scan of its tree.

    `now` is supplied rather than read: `generatedAt` is the only
    non-deterministic field, and passing it in keeps the rest diffable.
    """
    scan = scan_repository(root)
    sig = collect_signals(root, scan)

    frameworks = list(profile.get("frameworks") or [])
    has = profile.get("has") or {}

    # `Array.prototype.sort` is STABLE, so equal counts keep insertion
    # order — which is the order the walk discovered the languages in.
    sorted_langs = sorted(scan.lang_counts.items(), key=lambda kv: -kv[1])
    primary = sorted_langs[0][0] if sorted_langs else "unknown"
    secondary = [lang for lang, _ in sorted_langs[1:4]]

    repo_type = detect_repository_type(scan, sig, frameworks, primary)
    arch_style = detect_architecture_style(scan, repo_type)
    platforms = detect_platforms(scan, sig, frameworks, has, repo_type, primary)
    build_system = detect_build_system(root)
    modules = detect_modules(root, scan, repo_type)
    entry_points = detect_entry_points(root, scan)
    tech_stack = extract_tech_stack(
        root, primary, secondary, frameworks, build_system, platforms
    )

    name = os.path.basename(root)
    readme_purpose = extract_readme_purpose(root)
    purpose = readme_purpose or synthesize_purpose(
        name, repo_type, primary, platforms, modules
    )

    return {
        "id": project_id,
        "name": name,
        "purpose": purpose,
        "repositoryType": repo_type,
        "primaryLanguage": primary,
        "secondaryLanguages": secondary,
        "buildSystem": build_system,
        "frameworks": frameworks,
        "platforms": platforms,
        "architectureStyle": arch_style,
        "mainModules": modules,
        "entryPoints": entry_points,
        "status": "active",
        "description": purpose or f"{name} — {repo_type} in {primary}",
        "technologyStack": tech_stack,
        "generatedAt": now,
        "fingerprint": compute_fingerprint(root),
    }


def save_identity(home: Path, identity: dict[str, Any]) -> None:
    from ..core.json_store import atomic_write_json

    atomic_write_json(home / "identity" / f"{identity['id']}.json", identity)
