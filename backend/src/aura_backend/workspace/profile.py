"""Real, derived understanding of a folder.

A port of packages/ai-service/src/profile.ts.

Walks the actual project directory and reports only what is really there:
languages by file extension, package manager, frameworks and dependencies
from real manifests, and whether the project has a frontend, backend,
database, config, git, docker, CI or test surface.

**Nothing here is invented.** A field is absent or empty when the signal
is not present in the folder. The profile is cached and regenerated only
when the folder's fingerprint — the mtimes of the manifests that define
its shape — changes.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from ..core.js_number import js_number
from ..core.json_store import atomic_write_json, read_json
from ..core.node_time import mtime_ms
from ..fabric.types import now_iso

IGNORE_DIRS = frozenset({
    "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage",
    ".turbo", ".cache", "target", "vendor", "__pycache__", ".venv", "venv", ".aura",
    ".aura-index", ".aura-fullstack", ".idea", ".vscode",
})

LANG_BY_EXT: dict[str, str] = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
    ".mjs": "JavaScript", ".cjs": "JavaScript", ".py": "Python", ".rb": "Ruby",
    ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".swift": "Swift",
    ".c": "C", ".h": "C", ".cpp": "C++", ".cc": "C++", ".cs": "C#", ".php": "PHP",
    ".scala": "Scala", ".ex": "Elixir", ".exs": "Elixir", ".dart": "Dart",
    ".vue": "Vue", ".svelte": "Svelte", ".sql": "SQL", ".sh": "Shell",
    ".css": "CSS", ".scss": "CSS", ".html": "HTML", ".md": "Markdown",
}

FRAMEWORK_DEPS: dict[str, str] = {
    "react": "React", "react-dom": "React", "next": "Next.js", "vue": "Vue",
    "nuxt": "Nuxt", "svelte": "Svelte", "@angular/core": "Angular",
    "@sveltejs/kit": "SvelteKit", "express": "Express", "@nestjs/core": "NestJS",
    "@nestjs/common": "NestJS", "@nestjs/platform-express": "NestJS",
    "fastify": "Fastify", "koa": "Koa", "@tauri-apps/api": "Tauri",
    "electron": "Electron", "vite": "Vite", "webpack": "Webpack",
    "tailwindcss": "Tailwind CSS", "typeorm": "TypeORM", "prisma": "Prisma",
    "sequelize": "Sequelize", "mongoose": "Mongoose", "django": "Django",
    "flask": "Flask", "fastapi": "FastAPI", "@aura/core": "AURA",
    "zustand": "Zustand", "framer-motion": "Framer Motion",
}

DB_DEPS = frozenset({
    "pg", "postgres", "mysql", "mysql2", "sqlite3", "better-sqlite3", "mongodb",
    "mongoose", "redis", "ioredis", "typeorm", "prisma", "sequelize", "drizzle-orm",
})

# Bump when the profile shape changes so cached profiles regenerate.
PROFILE_VERSION = 2
# A hard cap so huge repositories still profile quickly.
WALK_BUDGET = 20_000

_TEST_FILE = re.compile(r"\.(test|spec)\.[jt]sx?$")
_TEST_FILE_PY_GO = re.compile(r"_test\.(py|go)$")
_MARKDOWN = re.compile(r"\.mdx?$", re.IGNORECASE)
_EMPHASIS = re.compile(r"[*_`]")
_TABS = re.compile(r"^\t")
_SPACES4 = re.compile(r"^ {4}\S")
_SPACES2 = re.compile(r"^ {2}\S")
_ENDS_SEMI = re.compile(r";\s*$")
_ENDS_CODE = re.compile(r"[)\w\]]\s*$")

FINGERPRINT_MARKERS = (
    "package.json", "requirements.txt", "pyproject.toml", "go.mod",
    "Cargo.toml", "pom.xml", "Gemfile", "composer.json", "Dockerfile",
)


@dataclass
class FolderNode:
    name: str
    files: int
    dirs: int


@dataclass
class ProjectProfile:
    id: str
    path: str
    generated_at: str
    fingerprint: str
    type: str
    primary_language: str
    languages: list[dict[str, Any]] = field(default_factory=list)
    package_manager: str | None = None
    frameworks: list[str] = field(default_factory=list)
    dependencies: list[dict[str, str]] = field(default_factory=list)
    has: dict[str, bool] = field(default_factory=dict)
    structure: list[FolderNode] = field(default_factory=list)
    architecture_docs: list[dict[str, str]] = field(default_factory=list)
    file_count: int = 0
    summary: str = ""
    purpose: str = ""
    entry_points: list[str] = field(default_factory=list)
    build_system: str | None = None
    important_files: list[str] = field(default_factory=list)
    coding_style: dict[str, Any] | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "path": self.path,
            "generatedAt": self.generated_at,
            "fingerprint": self.fingerprint,
            "type": self.type,
            "primaryLanguage": self.primary_language,
            "languages": self.languages,
            "packageManager": self.package_manager,
            "frameworks": self.frameworks,
            "dependencies": self.dependencies,
            "has": self.has,
            "structure": [asdict(s) for s in self.structure],
            "architectureDocs": self.architecture_docs,
            "fileCount": self.file_count,
            "summary": self.summary,
            "purpose": self.purpose,
            "entryPoints": self.entry_points,
            "buildSystem": self.build_system,
            "importantFiles": self.important_files,
            "codingStyle": self.coding_style,
        }

    @staticmethod
    def from_json(raw: dict[str, Any]) -> ProjectProfile:
        return ProjectProfile(
            id=raw["id"],
            path=raw.get("path", ""),
            generated_at=raw.get("generatedAt", ""),
            fingerprint=raw.get("fingerprint", ""),
            type=raw.get("type", "unknown"),
            primary_language=raw.get("primaryLanguage", "unknown"),
            languages=raw.get("languages", []),
            package_manager=raw.get("packageManager"),
            frameworks=raw.get("frameworks", []),
            dependencies=raw.get("dependencies", []),
            has=raw.get("has", {}),
            structure=[FolderNode(**s) for s in raw.get("structure", [])],
            architecture_docs=raw.get("architectureDocs", []),
            file_count=raw.get("fileCount", 0),
            summary=raw.get("summary", ""),
            purpose=raw.get("purpose", ""),
            entry_points=raw.get("entryPoints", []),
            build_system=raw.get("buildSystem"),
            important_files=raw.get("importantFiles", []),
            coding_style=raw.get("codingStyle"),
        )


def _profile_file(home: Path, project_id: str) -> Path:
    return home / "profiles" / f"{project_id}.json"


def _mtime(file: Path) -> float:
    try:
        return mtime_ms(file)
    except OSError:
        return 0


def fingerprint(root: Path) -> str:
    """A cheap fingerprint over the manifests that define the project shape.

    Note what this does NOT cover: an edit to a source file that touches
    no manifest leaves the fingerprint unchanged, so the cached profile
    stands. That is the reference's behaviour and it is deliberate — the
    profile describes shape, not content.
    """
    # `js_number`, not Python's default float formatting: this string is
    # compared for equality against a fingerprint the reference may have
    # written, and `1787501494393.0` never equals `1787501494393`.
    parts = [f"{m}:{js_number(_mtime(root / m))}" for m in FINGERPRINT_MARKERS]
    return f"v{PROFILE_VERSION}|" + "|".join(parts)


def _is_file(root: Path, rel: str) -> bool:
    try:
        return (root / rel).is_file()
    except OSError:
        return False


def _derive_purpose(root: Path, package_description: str | None) -> str:
    readme = root / "README.md"
    if readme.exists():
        try:
            lines = [line.strip() for line in readme.read_text(encoding="utf-8").split("\n")]
            prose = next(
                (
                    line for line in lines
                    if line
                    and not line.startswith(("#", "![", "[!", "<"))
                ),
                None,
            )
            if prose:
                return _EMPHASIS.sub("", prose)[:240]
            heading = next((line for line in lines if line.startswith("# ")), None)
            if heading:
                return heading.lstrip("# ").strip()[:240]
        except (OSError, UnicodeDecodeError):
            pass
    return (package_description or "")[:240]


_ENTRY_CANDIDATES = (
    "src/main.tsx", "src/main.ts", "src/index.tsx", "src/index.ts", "src/App.tsx",
    "index.js", "index.ts", "main.py", "app.py", "src/main.py", "cmd/main.go",
    "main.go", "src/main.rs",
)


def _derive_entry_points(root: Path, package: dict[str, Any] | None) -> list[str]:
    out: list[str] = []
    for candidate in _ENTRY_CANDIDATES:
        if _is_file(root, candidate) and candidate not in out:
            out.append(candidate)
    if package:
        for key in ("main", "module"):
            value = package.get(key)
            if isinstance(value, str) and _is_file(root, value) and value not in out:
                out.append(value)
    return out[:8]


_BUILD_SYSTEMS = (
    (("vite.config.ts", "vite.config.js"), "Vite"),
    (("next.config.js", "next.config.mjs"), "Next.js"),
    (("webpack.config.js",), "Webpack"),
    (("rollup.config.js",), "Rollup"),
    (("tsconfig.json",), "TypeScript (tsc)"),
    (("Makefile",), "Make"),
    (("build.gradle", "build.gradle.kts"), "Gradle"),
    (("pom.xml",), "Maven"),
    (("Cargo.toml",), "Cargo"),
    (("go.mod",), "Go build"),
    (("pyproject.toml", "setup.py"), "Python build"),
)


def _derive_build_system(root: Path) -> str | None:
    for markers, name in _BUILD_SYSTEMS:
        if any(_is_file(root, m) for m in markers):
            return name
    return None


_IMPORTANT = (
    "README.md", "package.json", "tsconfig.json", "ARCHITECTURE.md",
    "docs/ARCHITECTURE.md", "Dockerfile", "docker-compose.yml", ".env.example",
    "requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml",
)


def _derive_important_files(root: Path, entry_points: list[str]) -> list[str]:
    out = list(entry_points)
    for candidate in _IMPORTANT:
        if _is_file(root, candidate) and candidate not in out:
            out.append(candidate)
    return out[:14]


def _derive_coding_style(root: Path, entry_points: list[str]) -> dict[str, Any] | None:
    """Sample a few real source files to infer the dominant style."""
    samples: list[str] = []
    for candidate in [*entry_points, "src/index.ts", "src/main.ts"]:
        if candidate not in samples:
            samples.append(candidate)

    tabs = spaces2 = spaces4 = single = double = with_semi = no_semi = seen = 0
    for rel in samples[:5]:
        if not _is_file(root, rel):
            continue
        try:
            text = (root / rel).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        seen += 1
        for line in text.split("\n"):
            if _TABS.match(line):
                tabs += 1
            elif _SPACES4.match(line):
                spaces4 += 1
            elif _SPACES2.match(line):
                spaces2 += 1
            single += line.count("'")
            double += line.count('"')
            if _ENDS_SEMI.search(line):
                with_semi += 1
            elif _ENDS_CODE.search(line):
                no_semi += 1
    if not seen:
        return None
    if tabs > spaces2 + spaces4:
        indent = "tabs"
    elif spaces4 > spaces2:
        indent = "4 spaces"
    else:
        indent = "2 spaces"
    return {
        "indent": indent,
        "quotes": "single" if single >= double else "double",
        "semicolons": with_semi >= no_semi,
    }


def _read_dir(directory: Path) -> list[Path]:
    """Directory entries in the order Node returns them.

    Node's `readdirSync` comes back SORTED — libuv scans with `alphasort`
    — while Python's `iterdir` yields raw directory order. That is not a
    cosmetic difference: walk order decides which language is recorded
    first, and therefore which one wins a tie for `primaryLanguage`, and
    on a repository large enough to exhaust the walk budget it decides
    which files are counted at all.
    """
    return sorted(directory.iterdir(), key=lambda entry: entry.name)


def _walk(root: Path) -> tuple[dict[str, int], int, bool, bool]:
    langs: dict[str, int] = {}
    files = 0
    has_tests = False
    has_sql = False
    stack: list[Path] = [root]
    budget = WALK_BUDGET

    while stack and budget > 0:
        directory = stack.pop()
        try:
            entries = _read_dir(directory)
        except OSError:
            continue
        for entry in entries:
            # `if (budget-- <= 0) break` in the reference: the OLD value is
            # tested and THEN decremented, so it stops one entry later than
            # a decrement-first loop would. On a repository large enough to
            # exhaust the budget, that one entry changes what gets counted.
            if budget <= 0:
                break
            budget -= 1
            # Dot-DIRECTORIES are skipped; dot-FILES are not (the
            # reference's guard only continues for directories).
            try:
                is_dir = entry.is_dir()
            except OSError:
                continue
            if entry.name.startswith(".") and entry.name != ".env" and is_dir:
                continue
            if is_dir:
                if entry.name not in IGNORE_DIRS:
                    stack.append(entry)
                continue
            ext = entry.suffix.lower()
            lang = LANG_BY_EXT.get(ext)
            if lang:
                langs[lang] = langs.get(lang, 0) + 1
                files += 1
            if _TEST_FILE.search(entry.name) or _TEST_FILE_PY_GO.search(entry.name):
                has_tests = True
            if ext == ".sql":
                has_sql = True
    return langs, files, has_tests, has_sql


def _top_level(root: Path) -> list[FolderNode]:
    out: list[FolderNode] = []
    try:
        entries = _read_dir(root)
    except OSError:
        return out
    for entry in entries:
        try:
            if not entry.is_dir():
                continue
        except OSError:
            continue
        if entry.name in IGNORE_DIRS or entry.name.startswith("."):
            continue
        files = dirs = 0
        try:
            for child in _read_dir(entry):
                if child.is_dir():
                    dirs += 1
                else:
                    files += 1
        except OSError:
            pass
        out.append(FolderNode(name=entry.name, files=files, dirs=dirs))
    out.sort(key=lambda n: n.files + n.dirs, reverse=True)
    return out[:12]


def _find_arch_docs(root: Path) -> list[dict[str, str]]:
    docs: list[dict[str, str]] = []
    for rel in ("README.md", "ARCHITECTURE.md", "CONTRIBUTING.md"):
        if _is_file(root, rel):
            docs.append({"title": Path(rel).name, "relPath": rel})
    docs_dir = root / "docs"
    if docs_dir.is_dir():
        try:
            for name in sorted(p.name for p in docs_dir.iterdir()):
                if _MARKDOWN.search(name):
                    docs.append({"title": name, "relPath": f"docs/{name}"})
        except OSError:
            pass
    return docs[:12]


_PACKAGE_MANAGERS = (
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
    ("bun.lockb", "bun"),
)


def _detect_package_manager(root: Path) -> str | None:
    for marker, name in _PACKAGE_MANAGERS:
        if (root / marker).exists():
            return name
    if (root / "package-lock.json").exists() or (root / "package.json").exists():
        return "npm"
    if (root / "poetry.lock").exists() or (root / "pyproject.toml").exists():
        return "poetry"
    if (root / "requirements.txt").exists():
        return "pip"
    if (root / "go.mod").exists():
        return "go modules"
    if (root / "Cargo.toml").exists():
        return "cargo"
    return None


def _read_package_json(root: Path) -> dict[str, Any] | None:
    file = root / "package.json"
    if not file.exists():
        return None
    try:
        return json.loads(file.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def _classify(has: dict[str, bool], frameworks: set[str], lang_count: int) -> str:
    if "Tauri" in frameworks or "Electron" in frameworks:
        return "Desktop application"
    if has["frontend"] and has["backend"]:
        return "Full-stack application"
    if has["frontend"]:
        return "Frontend application"
    if has["backend"]:
        return "Backend service"
    if lang_count == 0:
        return "Empty or non-code folder"
    return "Library / tooling"


def _describe(
    root: Path, language: str, type_: str, frameworks: list[str],
    has: dict[str, bool], files: int,
) -> str:
    parts = [
        f"{root.name} is a {type_.lower()}"
        + (f" written primarily in {language}" if language != "unknown" else "")
        + "."
    ]
    if frameworks:
        parts.append(f"It uses {', '.join(frameworks[:6])}.")
    surfaces = [k for k, v in has.items() if v]
    if surfaces:
        parts.append(f"Detected surfaces: {', '.join(surfaces)}.")
    parts.append(f"{files} indexable source files found.")
    return " ".join(parts)


def build_profile(project_id: str, root_path: str) -> ProjectProfile:
    """Build a real profile of the folder from scratch."""
    root = Path(root_path)
    langs, files, has_tests, has_sql = _walk(root)
    languages = sorted(
        ({"name": name, "files": n} for name, n in langs.items()),
        key=lambda entry: entry["files"],
        reverse=True,
    )
    primary_language = languages[0]["name"] if languages else "unknown"

    package = _read_package_json(root)
    dependencies: list[dict[str, str]] = []
    frameworks: set[str] = set()
    ordered_frameworks: list[str] = []
    has_db = has_sql

    def note_framework(name: str) -> None:
        mapped = FRAMEWORK_DEPS.get(name)
        if mapped and mapped not in frameworks:
            frameworks.add(mapped)
            ordered_frameworks.append(mapped)

    if package:
        for name, version in (package.get("dependencies") or {}).items():
            dependencies.append({"name": name, "version": str(version), "kind": "runtime"})
            note_framework(name)
            if name in DB_DEPS:
                has_db = True
        for name, version in (package.get("devDependencies") or {}).items():
            dependencies.append({"name": name, "version": str(version), "kind": "dev"})
            note_framework(name)

    structure = _top_level(root)
    dir_names = {s.name.lower() for s in structure}
    has = {
        "frontend": bool(
            frameworks & {"React", "Vue", "Next.js", "Svelte", "Angular"}
            or ("src" in dir_names and ("TypeScript" in langs or "JavaScript" in langs))
            or "components" in dir_names
            or "pages" in dir_names
            or "app" in dir_names
        ),
        "backend": bool(
            frameworks & {"Express", "NestJS", "Fastify", "Django", "Flask", "FastAPI"}
            or dir_names & {"server", "api", "controllers", "routes", "services"}
        ),
        "database": has_db,
        "config": (root / ".env").exists()
        or (root / ".env.example").exists()
        or "config" in dir_names,
        "git": (root / ".git").exists(),
        "docker": (root / "Dockerfile").exists()
        or (root / "docker-compose.yml").exists()
        or (root / "docker-compose.yaml").exists(),
        "ci": (root / ".github" / "workflows").exists()
        or (root / ".gitlab-ci.yml").exists()
        or (root / ".circleci").exists(),
        "tests": has_tests,
    }

    type_ = _classify(has, frameworks, len(languages))
    entry_points = _derive_entry_points(root, package)
    description = package.get("description") if package else None

    return ProjectProfile(
        id=project_id,
        path=str(root),
        generated_at=now_iso(),
        fingerprint=fingerprint(root),
        type=type_,
        primary_language=primary_language,
        languages=languages,
        package_manager=_detect_package_manager(root),
        frameworks=ordered_frameworks,
        dependencies=dependencies,
        has=has,
        structure=structure,
        architecture_docs=_find_arch_docs(root),
        file_count=files,
        summary=_describe(root, primary_language, type_, ordered_frameworks, has, files),
        purpose=_derive_purpose(root, description if isinstance(description, str) else None),
        entry_points=entry_points,
        build_system=_derive_build_system(root),
        important_files=_derive_important_files(root, entry_points),
        coding_style=_derive_coding_style(root, entry_points),
    )


def get_or_build_profile(
    home: Path, project_id: str, root: str, force: bool = False
) -> ProjectProfile:
    """The cached profile if the fingerprint is unchanged, else rebuild."""
    file = _profile_file(home, project_id)
    if not force:
        cached = read_json(file, None)
        if isinstance(cached, dict) and cached.get("fingerprint") == fingerprint(Path(root)):
            return ProjectProfile.from_json(cached)
    profile = build_profile(project_id, root)
    atomic_write_json(file, profile.to_json())
    return profile


def load_profile(home: Path, project_id: str) -> ProjectProfile | None:
    raw = read_json(_profile_file(home, project_id), None)
    return ProjectProfile.from_json(raw) if isinstance(raw, dict) and raw.get("id") else None
