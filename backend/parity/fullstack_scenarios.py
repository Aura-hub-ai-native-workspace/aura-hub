"""Fixture workspaces for the FullStack Knowledge Engine differential.

One workspace that touches every extractor — React pages and hooks, an
Express router, NestJS decorators, Flask routes, TypeORM and Prisma
models, raw SQL migrations, a Dockerfile, a compose file, a CI workflow,
manifests in three ecosystems, and an architecture document — plus the
synthetic inputs that exercise the extraction primitives directly.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

QUERIES: list[Any] = [
    "Where is authentication implemented?",
    "Which frontend page calls /api/orders?",
    "Which database table stores users?",
    "Show everything related to payments.",
    "Find every dependency of OrderService.",
    "OrderService",
    "checkout",
    "",
    {"text": "orders", "limit": 3},
    {"text": "orders", "layers": ["backend"]},
    {"text": "users", "kinds": ["table"]},
    {"text": "OrderService", "intent": "dependencies-of", "depth": 2},
    {"text": "/api/orders/:id", "intent": "callers-of"},
]

IMPORT_TEXTS = [
    "import a from './a';\nimport b from '@/b';\nimport c from '~/c';\n"
    "import d from 'react';\nimport e from '@scope/pkg/sub';\nimport f from 'lodash/get';",
    "",
    "from 'x' from 'x' from './x'",
]

ENV_TEXTS = [
    "process.env.API_KEY and process.env['OTHER_KEY'] and import.meta.env.VITE_X",
    'std::env::var("RUST_VAR") os.environ.get("PY_VAR") os.environ["PY2"]',
    "no env here",
]

LINE_MAP_TEXTS = ["", "a", "a\nb", "\n\n", "a\nbb\nccc\n", "x\r\ny"]


def _source_file(rel_path: str, text: str, language: str, kind: str) -> dict[str, Any]:
    name = rel_path.split("/")[-1]
    dot = name.rfind(".")
    return {
        "relPath": rel_path, "absPath": f"/synthetic/{rel_path}", "name": name,
        "ext": "" if dot <= 0 else name[dot:], "language": language, "kind": kind,
        "text": text, "size": len(text.encode("utf-8")),
        "checksum": "deadbeef", "modifiedMs": 1000,
    }


REGISTRY_FILES = [
    _source_file("src/pages/Checkout.tsx",
                 "import React from 'react';\nimport { useCart } from '../hooks/useCart';\n"
                 "import './checkout.css';\n"
                 "export default function CheckoutPage() {\n"
                 "  const cart = useCart();\n"
                 "  fetch('/api/orders', { method: 'POST' });\n"
                 "  axios.get('/api/orders/42');\n"
                 "  const url = '/api/users/:id';\n"
                 "  return (<div><CartRow /><PayButton /></div>);\n}\n"
                 "export const PayButton = () => <button/>;\n",
                 "tsx", "source"),
    _source_file("src/hooks/useCart.ts",
                 "export function useCart() { return []; }\n", "typescript", "source"),
    _source_file("src/routes.tsx",
                 "export const routes = [\n"
                 "  { path: '/checkout', element: <CheckoutPage /> },\n"
                 "  { path: '/pay', component: PayButton },\n];\n",
                 "tsx", "source"),
    _source_file("server/orders.controller.ts",
                 "@Controller('orders')\nexport class OrdersController {\n"
                 "  @Get(':id')\n  async findOne() {}\n"
                 "  @Post()\n  async create() {}\n}\n"
                 "export class OrderService {}\n"
                 "export class OrderRepository {}\n"
                 "export class JwtGuard {}\n"
                 "// passport jwt authenticate\n"
                 "app.use(loggerMiddleware);\napp.use(cors());\n",
                 "typescript", "source"),
    _source_file("server/app.ts",
                 "import express from 'express';\n"
                 "app.get('/api/orders', listOrders);\n"
                 "app.post('/api/orders/:id', requireAuth, updateOrder);\n"
                 "router.delete('/v1/users/:id', removeUser);\n"
                 "const key = process.env.DATABASE_URL;\n",
                 "typescript", "source"),
    _source_file("server/api.py",
                 "@app.get('/api/py/items')\ndef items(): pass\n"
                 "@app.route('/api/py/legacy', methods=['POST'])\ndef legacy(): pass\n"
                 "import os\nX = os.environ.get('PY_SECRET')\n",
                 "python", "source"),
    _source_file("db/entities.ts",
                 "@Entity('users')\nexport class User {\n"
                 "  @Column() email: string;\n"
                 "  @ManyToOne(() => Order) order: Order;\n}\n"
                 "sequelize.define('sessions', {});\n"
                 "mongoose.model('Audit', schema);\n",
                 "typescript", "source"),
    _source_file("db/schema.prisma",
                 "model Order {\n  id Int @id\n  user User\n  @@map(\"orders\")\n}\n"
                 "model Payment {\n  id Int @id\n}\n",
                 "prisma", "source"),
    _source_file("db/migrations/001_init.sql",
                 'CREATE TABLE IF NOT EXISTS "users" (\n  id SERIAL,\n  email TEXT,\n'
                 "  PRIMARY KEY (id)\n);\n"
                 "CREATE TABLE orders (\n  id SERIAL,\n  user_id INT,\n"
                 "  FOREIGN KEY (user_id) REFERENCES public.users(id)\n);\n"
                 "CREATE UNIQUE INDEX idx_users_email ON users (email);\n",
                 "sql", "source"),
    _source_file("package.json",
                 json.dumps({"name": "shop", "private": True,
                             "scripts": {"build": "tsc", "start": "node ."},
                             "dependencies": {"express": "^4.18.0", "react": "^18.0.0"},
                             "devDependencies": {"vitest": "^1.0.0"}}),
                 "json", "config"),
    _source_file("api/package.json", "{ broken json", "json", "config"),
    _source_file("Cargo.toml",
                 "[package]\nname = \"x\"\n\n[dependencies]\nserde = \"1.0\"\n"
                 "tokio = { version = \"1\", features = [\"full\"] }\n\n[dev-dependencies]\n"
                 "criterion = \"0.5\"\n",
                 "toml", "config"),
    _source_file("go.mod",
                 "module example.com/x\n\ngo 1.22\n\nrequire (\n"
                 "\tgithub.com/gin-gonic/gin v1.9.1\n\tgolang.org/x/net v0.17.0\n)\n",
                 "toml", "config"),
    _source_file("requirements.txt",
                 "# a comment\nflask==3.0.0\nrequests>=2.31\nnumpy\n", "text", "config"),
    _source_file(".env.example",
                 "DATABASE_URL=postgres://x\nAPI_KEY=abc\nlowercase=ignored\n",
                 "text", "config"),
    _source_file("Dockerfile",
                 "FROM node:20-alpine AS build\nENV DATABASE_URL=x\nENV API_KEY=y\n"
                 "EXPOSE 3000\nEXPOSE 9229\nFROM scratch\n",
                 "dockerfile", "config"),
    _source_file("docker-compose.yml",
                 "version: '3'\nservices:\n  web:\n    image: shop:latest\n"
                 "    ports:\n      - \"3000:3000\"\n"
                 "    depends_on:\n      - db\n      - cache\n"
                 "  db:\n    image: postgres:16\n  cache:\n    image: redis:7\n",
                 "yaml", "config"),
    _source_file(".github/workflows/ci.yml",
                 "name: CI Pipeline\non: [push]\njobs:\n  build:\n    runs-on: x\n"
                 "  test:\n    runs-on: y\n  env:\n    runs-on: z\n",
                 "yaml", "config"),
    _source_file("vite.config.ts", "export default {};\n", "typescript", "config"),
    _source_file("docs/ARCHITECTURE.md",
                 "# System Architecture\n\n"
                 "## OrderService\n\n- Responsible for orders\n"
                 "- Must not talk to the UI\n- Uses OrderRepository and PaymentEngine\n\n"
                 "## Payment Module\n\n- Handles payments\n- Depends on PaymentEngine\n\n"
                 "## Notes\n\nNothing module-like here at all.\n",
                 "markdown", "docs"),
    _source_file("README.md", "# Shop\n\nJust a readme.\n", "markdown", "docs"),
]


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def build(work: Path) -> dict[str, Any]:
    """Build the fixture workspace and return the job."""
    root = work / "workspace"
    root.mkdir(parents=True)
    for spec in REGISTRY_FILES:
        _write(root / spec["relPath"], spec["text"])
    # A binary file the reader must skip, and an empty one.
    (root / "assets").mkdir(parents=True, exist_ok=True)
    (root / "assets" / "logo.png").write_bytes(bytes([0x89, 0x50, 0x4E, 0x47, 0, 1, 2, 3]))
    (root / "empty.ts").write_text("")

    return {
        "root": str(root),
        "indexDir": str(work / "index-ts"),
        "pythonIndexDir": str(work / "index-py"),
        "queries": QUERIES,
        "maxTokens": 6000,
        "importTexts": IMPORT_TEXTS,
        "envTexts": ENV_TEXTS,
        "lineMapTexts": LINE_MAP_TEXTS,
        "registryFiles": REGISTRY_FILES,
    }
