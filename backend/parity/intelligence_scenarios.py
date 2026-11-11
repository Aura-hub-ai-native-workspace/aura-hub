"""Fixture projects for the intelligence differential.

Each fixture is a real directory tree on disk, built once and read by
BOTH implementations. They are small but deliberately awkward: the
generators are almost entirely heuristics over file contents, so the
fixtures exist to reach the branches those heuristics have — a kernel
that looks like a kernel, a web app that looks like both a frontend and a
backend, a repository with nothing in it at all, and a tree full of the
edge cases that separate the two runtimes (astral characters, a `bin`
that is a bare string, a directory whose name is a regex metacharacter).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

INTENT_TYPES = [
    "project_overview", "architecture", "module_explanation", "function_explanation",
    "bug_fix", "debugging", "refactoring", "code_search", "api_reference",
    "dependency", "build_system", "documentation", "design", "security",
    "performance", "testing", "unknown",
]

QUERIES = [
    "What is this project?",
    "Explain the architecture of this system",
    "How does the scheduler module work?",
    "What does parseConfig do?",
    "There is a bug: the server crashes on startup",
    "Why does the build keep failing?",
    "Refactor the payment service to remove duplication",
    "Where is validateToken implemented?",
    "Document the REST API endpoints and their parameters for the client",
    "Which npm packages does this depend on?",
    "How to build and run this with Docker",
    "Where is the README and the CONTRIBUTING documentation",
    "What is the best practice approach for interface design here?",
    "Is there a SQL injection vulnerability in the auth code?",
    "The endpoint is slow — where is the bottleneck?",
    "Write a unit test for the OrderService with Vitest",
    "hello",
    "",
    "接口 and 参数 in the API",
    'Find "UserRepository" in src/services/order.ts',
]


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _kernel(root: Path) -> None:
    """A native systems project: linker script, boot asm, kernel entry."""
    _write(root / "Makefile",
           "CFLAGS = -ffreestanding -nostdlib -mno-red-zone -mcmodel=kernel\n"
           "ARCH ?= x86_64\nall:\n\t$(CC) $(CFLAGS) -o kernel.elf\n")
    _write(root / "linker.ld", "ENTRY(_start)\nSECTIONS { . = 1M; }\n")
    _write(root / "boot" / "boot.s",
           ".global _start\n_start:\n    cli\n    hlt\n")
    _write(root / "kernel" / "kmain.c",
           "#include <stdint.h>\n/* multiboot */\nvoid kmain(void) { for(;;); }\n")
    _write(root / "arch" / "x86_64" / "idt.c", "void idt_init(void) {}\n")
    _write(root / "mm" / "paging.c", "void map_page(void) {}\n")
    _write(root / "drivers" / "vga.c", "void vga_put(char c) { (void)c; }\n")
    _write(root / "fs" / "vfs.c", "int vfs_open(const char *p) { (void)p; return 0; }\n")
    _write(root / "ipc" / "msg.c", "void send_message(void) {}\n")
    _write(root / "README.md",
           "# aura-kernel\n\nA tiny _x86_64_ kernel with a `microkernel` flavour.\n")


def _webapp(root: Path) -> None:
    """A full-stack TypeScript app: React pages, an Express API, Prisma."""
    _write(root / "package.json", json.dumps({
        "name": "shop", "version": "1.0.0", "main": "src/index.ts",
        # A bare-string `bin`. The reference's dangling `else` means this
        # is never recorded as an entry point — see identity.py.
        "bin": "src/cli.ts",
        "scripts": {"start": "node dist/index.js", "test": "vitest"},
        "dependencies": {"react": "^18.0.0", "express": "^4.18.0",
                         "@prisma/client": "^5.0.0"},
        "devDependencies": {"vitest": "^1.0.0", "typescript": "^5.0.0"},
    }, indent=2))
    _write(root / "package-lock.json", "{}\n")
    _write(root / "tsconfig.json", '{"compilerOptions":{"strict":true}}\n')
    _write(root / "Dockerfile",
           "FROM node:20-alpine\nENV API_KEY_NAME=x\nEXPOSE 3000\nCMD [\"node\"]\n")
    _write(root / "docker-compose.yml",
           "services:\n  web:\n    image: shop:latest\n    ports:\n      - \"3000:3000\"\n"
           "    depends_on:\n      - db\n  db:\n    image: postgres:16\n")
    _write(root / ".github" / "workflows" / "ci.yml",
           "name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n"
           "  test:\n    runs-on: ubuntu-latest\n")
    _write(root / ".env.example", "DATABASE_URL=postgres://x\nAPI_KEY=abc\n")
    _write(root / "README.md",
           "# Shop\n\nA comprehensive full-stack storefront. Therefore the "
           "implementation uses a layered architecture and an abstraction over "
           "the protocol interface.\n\n" + "\n".join(f"Line {i}" for i in range(120)))
    _write(root / "ARCHITECTURE.md",
           "# Architecture\n\n## OrderService\n\n- Responsible for orders\n"
           "- Must not talk to the UI\n- Depends on OrderRepository and PaymentEngine\n\n"
           "## Payment Module\n\n- Handles payments\n")
    _write(root / "docs" / "api-reference.md",
           "# API Reference\n\nA detailed, in-depth specification.\n")
    _write(root / "docs" / "adr" / "0001-use-prisma.md", "# Use Prisma\n\nDecision.\n")
    _write(root / "docs" / "guide.md", "# Getting Started\n\nStep by step tutorial.\n")
    _write(root / "examples" / "basic.ts", "export const x = 1;\n")

    _write(root / "src" / "index.ts",
           "import express from 'express';\nimport { OrderService } from './services/order';\n"
           "const app = express();\n"
           "app.get('/api/orders', (req, res) => res.json([]));\n"
           "app.post('/api/orders/:id', authGuard, createOrder);\n"
           "app.use(loggerMiddleware);\n"
           "export function start() { app.listen(process.env.PORT); }\n")
    _write(root / "src" / "cli.ts", "#!/usr/bin/env node\nconsole.log('cli');\n")
    _write(root / "src" / "components" / "OrderList.tsx",
           "import React from 'react';\nimport { useOrders } from '../hooks/useOrders';\n"
           "import './styles.css';\n"
           "export function OrderList() {\n  const o = useOrders();\n"
           "  return (<div><OrderRow /></div>);\n}\n"
           "export const OrderRow = () => <span>row</span>;\n")
    _write(root / "src" / "pages" / "CheckoutPage.tsx",
           "import React from 'react';\n"
           "export default function CheckoutPage() {\n"
           "  fetch('/api/orders', { method: 'POST' });\n"
           "  return <div><OrderList /></div>;\n}\n")
    _write(root / "src" / "hooks" / "useOrders.ts",
           "export function useOrders() { return []; }\n")
    _write(root / "src" / "routes" / "routes.tsx",
           "export const routes = [{ path: '/checkout', element: <CheckoutPage /> }];\n")
    _write(root / "src" / "services" / "order.ts",
           "import { OrderRepository } from '../repositories/order';\n"
           "export class OrderService {\n"
           "  constructor(private repo: OrderRepository) {}\n"
           "  async list() { return this.repo.all(); }\n}\n")
    _write(root / "src" / "repositories" / "order.ts",
           "export class OrderRepository {\n  all() { return []; }\n}\n")
    _write(root / "src" / "middleware" / "auth.ts",
           "export class AuthGuard { canActivate() { return true; } }\n"
           "// passport jwt authenticate\n")
    _write(root / "src" / "controllers" / "order.controller.ts",
           "@Controller('orders')\nexport class OrderController {\n"
           "  @Get(':id')\n  async findOne() { return null; }\n"
           "  @Post()\n  async create() { return null; }\n}\n")
    _write(root / "src" / "utils" / "fmt.ts", "export const fmt = (s: string) => s;\n")
    _write(root / "src" / "index.test.ts", "import { start } from './index';\n")
    _write(root / "src" / "order.spec.ts", "describe('order', () => {});\n")
    _write(root / "prisma" / "schema.prisma",
           "model User {\n  id Int @id\n  email String\n  orders Order[]\n  @@map(\"users\")\n}\n"
           "model Order {\n  id Int @id\n  userId Int\n}\n")
    _write(root / "migrations" / "001_init.sql",
           'CREATE TABLE IF NOT EXISTS "users" (\n  id SERIAL,\n  email TEXT\n);\n'
           "CREATE TABLE orders (\n  id SERIAL,\n  user_id INT,\n"
           "  FOREIGN KEY (user_id) REFERENCES users(id)\n);\n"
           "CREATE INDEX idx_orders_user ON orders (user_id);\n")


def _minimal(root: Path) -> None:
    """A directory with nothing a generator can latch onto."""
    (root / "empty-dir").mkdir(parents=True)


def _awkward(root: Path) -> None:
    """The cases where the two runtimes disagree if nothing is done.

    An astral character inside the first 300 README characters (UTF-16
    slicing), a directory whose name is a regex metacharacter (the
    glossary interpolates term names into a `RegExp` unescaped), a file
    whose head splits a multibyte character at the read boundary, and a
    manifest that is not valid JSON.
    """
    _write(root / "README.md",
           "# Awkward 🚀 project\n\nA project with an astral 🚀 character well "
           "inside the first three hundred characters, "
           + "padding " * 40 + "🚀 tail.\n")
    _write(root / "package.json", "{ not valid json at all\n")
    (root / "c++").mkdir(parents=True, exist_ok=True)
    _write(root / "c++" / "thing.cpp", "class Widget {};\n")
    (root / "a.b").mkdir(parents=True, exist_ok=True)
    _write(root / "a.b" / "mod.rs", "pub fn main() {}\n")
    _write(root / "src" / "Ünicode.ts",
           "// " + "ü" * 4100 + "\nexport class Ünicode {}\n")
    _write(root / "src" / "MAX_RETRIES.ts",
           "export const MAX_RETRIES = 3;\nexport const HTTP_TIMEOUT_MS = 1;\n"
           "// VFS IRQ ACPI JSON API\ninterface WidgetFactory {}\n")
    _write(root / "utils" / "helper.ts", "import x from '../app';\n")
    _write(root / "app" / "main.ts", "export const app = 1;\n")
    _write(root / "src" / "circular-a.ts", "import './circular-b';\n")
    _write(root / "src" / "circular-b.ts", "import './circular-a';\n")


FIXTURES = {
    "kernel": _kernel,
    "webapp": _webapp,
    "minimal": _minimal,
    "awkward": _awkward,
}

PROFILES: dict[str, dict[str, Any]] = {
    "kernel": {"frameworks": [], "has": {"frontend": False, "backend": False,
                                         "database": False, "tests": False,
                                         "docker": False, "ci": False}},
    "webapp": {"frameworks": ["React", "Express", "Prisma"],
               "has": {"frontend": True, "backend": True, "database": True,
                       "tests": True, "docker": True, "ci": True}},
    "minimal": {"frameworks": [], "has": {"frontend": False, "backend": False,
                                          "database": False, "tests": False,
                                          "docker": False, "ci": False}},
    "awkward": {"frameworks": ["Tauri"], "has": {"frontend": False, "backend": False,
                                                 "database": False, "tests": False,
                                                 "docker": False, "ci": False}},
}

CHANGE_LOG = {
    "entries": [
        {"file": "/w/src/hot.ts", "timestamp": "2026-08-20T10:00:00.000Z", "type": "modify"},
        {"file": "/w/src/hot.ts", "timestamp": "2026-08-20T10:20:00.000Z", "type": "modify"},
        {"file": "/w/src/hot.ts", "timestamp": "2026-08-20T10:40:00.000Z", "type": "modify"},
        {"file": "/w/src/warm.ts", "timestamp": "2026-08-19T09:00:00.000Z", "type": "create"},
        {"file": "/w/src/warm.ts", "timestamp": "2026-08-19T09:30:00.000Z", "type": "modify"},
        {"file": "/w/src/cold.ts", "timestamp": "2020-01-01T00:00:00.000Z", "type": "modify"},
    ],
    "patterns": [],
    "generatedAt": "2026-08-20T11:00:00.000Z",
}

CLAIMS = [
    "The OrderService handles orders",
    "This is a fullstack project",
    "See src/services/order.ts for details",
    "Something entirely unrelated to anything",
]

HASH_INPUTS = ["", "a", "hello world", "🚀 astral", "x" * 1000, '{"a":1,"b":[2,3]}']


def build(work: Path) -> list[dict[str, Any]]:
    """Build every fixture and return one job per fixture."""
    jobs: list[dict[str, Any]] = []
    for name, populate in FIXTURES.items():
        # ONE tree, TWO homes. Several generators read what an earlier
        # generator wrote (versions, the workspace graph, the index
        # state), so a shared home would let each implementation see the
        # other's writes and quietly agree.
        home = work / name / "home-ts"
        py_home = work / name / "home-py"
        root = work / name / "project"
        home.mkdir(parents=True)
        py_home.mkdir(parents=True)
        root.mkdir(parents=True)
        populate(root)
        # A sibling that shares the root's path prefix — the agent APIs
        # guard traversal with a bare `startsWith`, and this is what that
        # weakness looks like from outside.
        sibling = Path(str(root) + "-sibling")
        sibling.mkdir(parents=True, exist_ok=True)
        (sibling / "secret.txt").write_text("do not read me")
        (work / name / "escape.txt").write_text("outside the root")

        jobs.append({
            "name": name,
            "auraHome": str(home),
            "pythonHome": str(py_home),
            "root": str(root),
            "projectId": name,
            "profile": PROFILES[name],
            "queries": QUERIES,
            "intentTypes": INTENT_TYPES,
            "importantFiles": ["README.md", "src/index.ts", "not/present.md"],
            "assembleQueries": QUERIES[:8],
            "codingContext": "// excerpt from src/index.ts\nexport function start() {}",
            "graphContext": "index.ts -> services/order.ts",
            "memoryContext": "The team decided to use Prisma.",
            "retrievedFiles": ["src/index.ts", "README.md", "src/services/order.ts"],
            "graphEntities": ["OrderRepository", "AuthGuard"],
            "claims": CLAIMS,
            "hashInputs": HASH_INPUTS,
            "symbol": "export",
            "searchPattern": "export",
            "readPath": "README.md",
            "changeLog": CHANGE_LOG,
            "workspaceRepos": [
                {"id": "alpha", "root": str(work / name / "alpha"), "identity": None},
                {"id": "alpha-web", "root": str(work / name / "alpha" / "web"),
                 "identity": {"name": "alpha-web", "repositoryType": "frontend",
                              "primaryLanguage": "TypeScript",
                              "frameworks": ["React", "Vite"]}},
                {"id": "beta", "root": str(work / name / "beta"),
                 "identity": {"name": "beta", "repositoryType": "backend",
                              "primaryLanguage": "TypeScript",
                              "frameworks": ["Express", "Vite"]}},
            ],
            "repoCriteria": {"primaryLanguage": "TypeScript"},
            "pathPair": ["alpha", "beta"],
            "removeRepo": "beta",
        })
    return jobs
