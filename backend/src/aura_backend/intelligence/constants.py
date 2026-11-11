"""Shared constants for the Repository Intelligence Engine.

A port of packages/ai-service/src/intelligence/constants.ts.

Single source of truth for the intelligence layer — every generator
imports from here. Note that `profile.ts` keeps its OWN copy of
`IGNORE_DIRS`; that duplication exists in the reference and is mirrored
rather than consolidated, because the two lists are free to drift and
consolidating them would silently couple the profiler to the intelligence
engine.
"""

from __future__ import annotations

import math
from typing import Final

IGNORE_DIRS: Final[frozenset[str]] = frozenset({
    "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage",
    ".turbo", ".cache", "target", "vendor", "__pycache__", ".venv", "venv", ".aura",
    ".aura-index", ".aura-fullstack", ".idea", ".vscode",
})

LANG_BY_EXT: Final[dict[str, str]] = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
    ".mjs": "JavaScript", ".cjs": "JavaScript", ".py": "Python", ".rb": "Ruby",
    ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".swift": "Swift",
    ".c": "C", ".h": "C", ".cpp": "C++", ".cc": "C++", ".cs": "C#", ".php": "PHP",
    ".scala": "Scala", ".ex": "Elixir", ".exs": "Elixir", ".dart": "Dart",
    ".vue": "Vue", ".svelte": "Svelte", ".sql": "SQL", ".sh": "Shell",
    ".css": "CSS", ".scss": "CSS", ".html": "HTML", ".md": "Markdown",
    ".asm": "Assembly", ".s": "Assembly",
}

FRAMEWORK_DEPS: Final[dict[str, str]] = {
    "react": "React", "react-dom": "React", "next": "Next.js", "vue": "Vue", "nuxt": "Nuxt",
    "svelte": "Svelte", "@angular/core": "Angular", "@sveltejs/kit": "SvelteKit",
    "express": "Express", "@nestjs/core": "NestJS", "@nestjs/common": "NestJS",
    "@nestjs/platform-express": "NestJS", "fastify": "Fastify", "koa": "Koa",
    "@tauri-apps/api": "Tauri", "electron": "Electron", "vite": "Vite", "webpack": "Webpack",
    "tailwindcss": "Tailwind CSS", "typeorm": "TypeORM", "prisma": "Prisma",
    "sequelize": "Sequelize", "mongoose": "Mongoose", "django": "Django", "flask": "Flask",
    "fastapi": "FastAPI", "@aura/core": "AURA", "zustand": "Zustand",
    "framer-motion": "Framer Motion",
}

DB_DEPS: Final[frozenset[str]] = frozenset({
    "pg", "postgres", "mysql", "mysql2", "sqlite3", "better-sqlite3", "mongodb",
    "mongoose", "redis", "ioredis", "typeorm", "prisma", "sequelize", "drizzle-orm",
})

# Directory weight map for weighted language detection.
DIR_WEIGHT: Final[dict[str, int]] = {
    "kernel": 10, "arch": 10, "drivers": 10, "mm": 10, "fs": 10, "net": 10, "ipc": 10,
    "boot": 10, "init": 10, "include": 8, "lib": 8,
    "src": 5, "app": 5, "packages": 5,
    "scripts": 1, "tools": 1, "utils": 1,
    "docs": 0, "documentation": 0, "examples": 0, "test": 0, "tests": 0, "__tests__": 0,
}


def est_tokens(text: str) -> int:
    """`Math.ceil(s.length / 4)` — over UTF-16 code units, as in JavaScript."""
    return math.ceil(utf16_length(text) / 4)


def utf16_length(text: str) -> int:
    """JavaScript's `String.length`: UTF-16 code units, not code points.

    An emoji is 1 character to Python and 2 to JavaScript, and this number
    feeds every token estimate and every `slice` bound in the reference.
    """
    return sum(2 if ord(c) > 0xFFFF else 1 for c in text)
