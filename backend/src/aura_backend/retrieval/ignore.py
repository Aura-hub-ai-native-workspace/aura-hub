"""Ignore rules, with the reference's production defaults.

A port of packages/knowledge-coding/src/ignore.ts.
"""

from __future__ import annotations

from dataclasses import dataclass, field

DEFAULT_IGNORE_DIRS = [
    "node_modules", ".git", "dist", "build", "out", "target", "bin", "obj",
    ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache",
    "coverage", ".nyc_output", ".pytest_cache", "__pycache__", ".venv", "venv",
    ".gradle", ".idea", ".vscode", "vendor", ".terraform", ".aura-index",
]

DEFAULT_IGNORE_EXTS = [
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".svgz",
    ".pdf", ".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".bz2",
    ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".flac", ".webm",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".wasm", ".node", ".exe", ".dll", ".so", ".dylib", ".class", ".o", ".a",
    ".lock", ".min.js", ".min.css", ".map",
    ".db", ".sqlite", ".sqlite3",
]

DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024

# Dotfiles that ARE meaningful code knowledge even though hidden.
ALLOWED_DOTFILES = frozenset({
    ".gitignore", ".dockerignore", ".npmignore", ".eslintignore",
    ".prettierignore", ".env.example", ".editorconfig", ".nvmrc", ".node-version",
})


@dataclass
class IgnoreConfig:
    directories: list[str] = field(default_factory=list)
    extensions: list[str] = field(default_factory=list)
    patterns: list[str] = field(default_factory=list)
    max_file_bytes: int | None = None
    include_hidden: bool | None = None
    replace_defaults: bool = False


class IgnoreRules:
    def __init__(self, config: IgnoreConfig | None = None) -> None:
        config = config or IgnoreConfig()
        base_dirs = [] if config.replace_defaults else DEFAULT_IGNORE_DIRS
        base_exts = [] if config.replace_defaults else DEFAULT_IGNORE_EXTS
        self._dirs = {d.lower() for d in [*base_dirs, *config.directories]}
        self._exts = {e.lower() for e in [*base_exts, *config.extensions]}
        self._patterns = [p.lower() for p in config.patterns]
        self.max_file_bytes = (
            config.max_file_bytes if config.max_file_bytes is not None
            else DEFAULT_MAX_FILE_BYTES
        )
        self.include_hidden = bool(config.include_hidden)

    def allow_dir(self, name: str) -> bool:
        if not self.include_hidden and name.startswith("."):
            return False
        return name.lower() not in self._dirs

    def allow_file(self, name: str, rel_path: str) -> bool:
        lower = name.lower()
        if not self.include_hidden and name.startswith(".") and lower not in ALLOWED_DOTFILES:
            return False
        rel_lower = rel_path.lower()
        if any(p in rel_lower for p in self._patterns):
            return False
        return not any(lower.endswith(ext) for ext in self._exts)
