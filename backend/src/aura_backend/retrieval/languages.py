"""Language and file-kind detection.

A port of packages/knowledge-coding/src/languages.ts.

Real detection by extension and by well-known filenames. Deterministic,
with no guessing beyond the declared rules.
"""

from __future__ import annotations

EXT_LANG: dict[str, str] = {
    ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".tsx": "tsx", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".jsx": "jsx",
    ".json": "json", ".jsonc": "jsonc", ".json5": "jsonc",
    ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".ini": "ini",
    ".cfg": "ini", ".conf": "ini",
    ".xml": "xml", ".sql": "sql",
    ".md": "markdown", ".markdown": "markdown", ".mdx": "markdown",
    ".txt": "text", ".text": "text",
    ".rs": "rust", ".py": "python", ".pyi": "python", ".go": "go", ".java": "java",
    ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp",
    ".cs": "csharp", ".rb": "ruby", ".php": "php", ".swift": "swift",
    ".kt": "kotlin", ".kts": "kotlin",
    ".css": "css", ".scss": "scss", ".sass": "scss", ".less": "scss",
    ".html": "html", ".htm": "html",
    ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".fish": "shell",
    ".env": "env",
}

NAME_LANG: dict[str, str] = {
    "dockerfile": "dockerfile", "containerfile": "dockerfile",
    "makefile": "makefile", "gnumakefile": "makefile",
    ".gitignore": "gitignore", ".dockerignore": "gitignore",
    ".npmignore": "gitignore", ".eslintignore": "gitignore",
    ".prettierignore": "gitignore",
    ".env": "env", ".env.local": "env", ".env.example": "env",
    "license": "license", "license.md": "license", "license.txt": "license",
    "licence": "license", "copying": "license",
}

MANIFEST_NAMES = frozenset({
    "package.json", "tsconfig.json", "tsconfig.base.json", "pnpm-workspace.yaml",
    "cargo.toml", "go.mod", "go.sum", "pyproject.toml", "requirements.txt",
    "pipfile", "gemfile", "composer.json", "pom.xml", "build.gradle",
    "vite.config.ts", "vite.config.js", "tailwind.config.ts", "postcss.config.js",
    "rollup.config.js", "webpack.config.js", "dockerfile", "docker-compose.yml",
    "docker-compose.yaml", "makefile",
})

DOC_LANGS = frozenset({"markdown", "text"})
CONFIG_LANGS = frozenset({"yaml", "toml", "ini", "xml", "json", "jsonc", "env"})
CODE_LANGS = frozenset({
    "typescript", "javascript", "tsx", "jsx", "rust", "python", "go", "java",
    "c", "cpp", "csharp", "ruby", "php", "swift", "kotlin", "css", "scss",
    "html", "shell", "sql", "dockerfile", "makefile",
})


def detect_language(name: str, ext: str) -> str:
    lower = name.lower()
    if lower in NAME_LANG:
        return NAME_LANG[lower]
    if lower.startswith(".env"):
        return "env"
    if lower.startswith(("license", "licence")):
        return "license"
    if lower.startswith("readme"):
        return "markdown"
    return EXT_LANG.get(ext.lower(), "unknown")


def detect_kind(name: str, language: str) -> str:
    lower = name.lower()
    if language == "license":
        return "license"
    if language == "gitignore":
        return "ignore"
    if lower in MANIFEST_NAMES:
        return "manifest"
    if language in CODE_LANGS:
        return "code"
    if language in DOC_LANGS:
        return "doc"
    if language in CONFIG_LANGS:
        return "config"
    if language == "sql":
        return "data"
    if language == "unknown":
        return "unknown"
    return "text"


def is_indexable_language(language: str) -> bool:
    return language not in ("binary", "unknown")
