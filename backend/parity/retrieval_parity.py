"""Differential verification of the retrieval engine.

Indexes the SAME real directory with both implementations, runs the same
queries, and diffs everything observable: tokenization, language
detection, chunk boundaries and byte offsets, index statistics, per-document
metadata, ranked search hits (including scores, matched terms and the
reasons a hit scored), assembled context, and an incremental re-index.

`now` is injected on both sides so the recency boost is deterministic.

Scores are compared to 12 significant figures. Both implementations do the
same IEEE-754 double arithmetic in the same order, so they should agree
far more closely than that; the tolerance exists to keep a formatting
difference from masquerading as a ranking difference, not to hide one.

Usage (from backend/):
    uv run python -m parity.retrieval_parity --repo /mnt/storage/aura-hub
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from aura_backend.retrieval import (
    CodingKnowledgeEngine,
    SearchQuery,
    chunk_document,
    detect_kind,
    detect_language,
    tokenize,
)
from aura_backend.retrieval.types import CodeDocument

FIXED_NOW = 1_800_000_000_000.0

TOKENIZE_CASES = [
    "parseHTTPResponse", "my_var$x", "camelCaseIdentifier", "SCREAMING_SNAKE",
    "XMLHttpRequest", "a", "ab", "x" * 45, "kebab-case-name", "mixed_Case-Thing",
    "const foo = require('bar')", "", "   ", "123 456", "__dunder__",
    "getHTTPSProxy", "IOError", "aB", "snake_case_and_camelCase",
    "export function addNumbers(a: number)", "café naïve", "tab\tsep\nnewline",
]

LANGUAGE_CASES = [
    ["index.ts", ".ts"], ["App.tsx", ".tsx"], ["main.py", ".py"],
    ["README.md", ".md"], ["readme", ""], ["Dockerfile", ""],
    ["dockerfile", ""], ["Makefile", ""], [".gitignore", ""],
    ["LICENSE", ""], ["licence.txt", ".txt"], [".env.example", ".example"],
    ["package.json", ".json"], ["tsconfig.json", ".json"],
    ["docker-compose.yml", ".yml"], ["style.scss", ".scss"],
    ["query.sql", ".sql"], ["script.sh", ".sh"], ["mystery.xyz", ".xyz"],
    ["Cargo.toml", ".toml"], ["go.mod", ".mod"], ["a.min.js", ".js"],
]


def _chunk_cases() -> list[dict]:
    lines_a = "\n".join(f"const value{i} = {i};" for i in range(200))
    lines_b = (
        "export function addNumbers(a: number, b: number) {\n"
        "  return a + b;\n}\n\n"
        "export class Calculator {\n  add(a, b) { return a + b }\n}\n\n"
        + "\n".join(f"// filler line {i}" for i in range(90))
    )
    markdown = "# Title\n\nSome prose.\n\n## Section\n\n" + "\n".join(
        f"- bullet {i}" for i in range(80)
    )
    unicode_doc = "const s = 'héllo wörld — em dash';\n" * 40
    blanky = "\n".join(("code" if i % 7 else "") for i in range(150))
    return [
        {"id": "a.ts", "text": lines_a},
        {"id": "b.ts", "text": lines_b},
        {"id": "c.md", "text": markdown},
        {"id": "d.ts", "text": unicode_doc},
        {"id": "e.ts", "text": blanky},
        {"id": "f.ts", "text": ""},
        {"id": "g.ts", "text": "one line only"},
    ]


QUERIES = [
    {"text": "addNumbers"},
    {"text": "add numbers"},
    {"text": "calculator", "mode": "exact"},
    {"text": "calculatr", "mode": "fuzzy"},
    {"text": "calc", "mode": "prefix"},
    {"text": "function", "mode": "auto", "limit": 5},
    {"text": "readme"},
    {"text": "import", "languages": ["typescript"]},
    {"text": "const", "kinds": ["code"]},
    {"text": "the", "pathIncludes": "src"},
    {"text": "value", "filename": "a"},
    {"text": "zzzzznotpresent"},
    {"text": "export", "extensions": [".ts"]},
    {"text": "a"},
    {"text": ""},
]

CONTEXT_QUERIES = [
    {"text": "addNumbers"},
    {"text": "calculator", "options": {"neighbors": 2, "maxTokens": 2000, "limit": 3}},
    {"text": "const value", "options": {"neighbors": 0, "maxTokens": 50, "limit": 5}},
    {"text": "nothing matches here"},
]


def build_spec() -> dict:
    return {
        "tokenizeCases": TOKENIZE_CASES,
        "languageCases": LANGUAGE_CASES,
        "chunkCases": _chunk_cases(),
        "queries": QUERIES,
        "contextQueries": CONTEXT_QUERIES,
    }


def make_corpus(root: Path) -> None:
    """A small but varied real tree: code, docs, config, nesting, a binary,
    an ignored directory, and a file with unicode."""
    (root / "src" / "deep" / "nested").mkdir(parents=True)
    (root / "docs").mkdir()
    (root / "node_modules" / "pkg").mkdir(parents=True)
    (root / "src" / "calc.ts").write_text(
        "export function addNumbers(a: number, b: number) {\n  return a + b;\n}\n\n"
        "export class Calculator {\n  add(a, b) { return addNumbers(a, b) }\n}\n",
        encoding="utf-8",
    )
    (root / "src" / "sub.ts").write_text(
        "export function subtractNumbers(a: number, b: number) {\n  return a - b;\n}\n",
        encoding="utf-8",
    )
    (root / "src" / "deep" / "nested" / "util.ts").write_text(
        "\n".join(f"export const value{i} = {i};" for i in range(120)) + "\n",
        encoding="utf-8",
    )
    (root / "README.md").write_text(
        "# Calculator\n\nA project that adds numbers.\n\n## Usage\n\nCall addNumbers.\n",
        encoding="utf-8",
    )
    (root / "docs" / "ARCHITECTURE.md").write_text(
        "# Architecture\n\nThe calculator has one module.\n", encoding="utf-8"
    )
    (root / "package.json").write_text(
        json.dumps({"name": "calc", "dependencies": {"react": "^18"}}), encoding="utf-8"
    )
    (root / "unicode.ts").write_text(
        "const greeting = 'héllo wörld — em dash';\n", encoding="utf-8"
    )
    (root / ".gitignore").write_text("node_modules\n", encoding="utf-8")
    # Binary content: must be detected and skipped, not indexed as text.
    (root / "blob.dat").write_bytes(bytes(range(256)) * 8)
    # Inside an ignored directory: must never appear.
    (root / "node_modules" / "pkg" / "index.ts").write_text(
        "export const shouldNotBeIndexed = true;\n", encoding="utf-8"
    )


def run_typescript(repo: Path, project: Path, index_dir: Path, spec_path: Path) -> dict:
    oracle = Path(__file__).parent / "retrieval_oracle.ts"
    proc = subprocess.run(
        ["node", str(repo / "scripts" / "run-ts.mjs"), str(oracle), str(repo),
         str(project), str(index_dir), str(int(FIXED_NOW)), str(spec_path)],
        cwd=repo, capture_output=True, text=True, timeout=1200, check=False,
    )
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        raise SystemExit("the retrieval oracle failed; cannot claim parity")
    return json.loads(proc.stdout)


def run_python(project: Path, index_dir: Path, spec: dict) -> dict:
    out: dict = {}
    out["tokenize"] = [{"input": t, "tokens": tokenize(t)} for t in spec["tokenizeCases"]]
    out["languages"] = []
    for name, ext in spec["languageCases"]:
        language = detect_language(name, ext)
        out["languages"].append(
            {"name": name, "ext": ext, "language": language,
             "kind": detect_kind(name, language)}
        )

    out["chunks"] = []
    for case in spec["chunkCases"]:
        doc = CodeDocument(
            id=case["id"], abs_path="/x/" + case["id"], rel_path=case["id"],
            project_root="/x", name=case["id"], ext=Path(case["id"]).suffix,
            language="typescript", kind="code", size=0, checksum="",
            modified_ms=0, indexed_ms=0, lines=0, truncated=False, binary=False,
        )
        out["chunks"].append({
            "id": case["id"],
            "chunks": [
                {"id": k.id, "ordinal": k.ordinal, "startLine": k.start_line,
                 "endLine": k.end_line, "startByte": k.start_byte,
                 "endByte": k.end_byte, "tokenEstimate": k.token_estimate,
                 "symbols": k.symbols, "textLength": len(k.text)}
                for k in chunk_document(doc, case["text"])
            ],
        })

    engine = CodingKnowledgeEngine(
        str(project), index_dir=str(index_dir), now_ms=lambda: FIXED_NOW
    )
    stats = engine.index()
    out["index"] = {
        "files": stats.files, "chunks": stats.chunks, "bytes": stats.bytes,
        "binaries": stats.binaries, "skipped": stats.skipped,
        "byLanguage": stats.by_language, "errorCount": len(stats.errors),
    }
    # Deliberately unsorted — see the oracle: the engine's order comes from
    # the filesystem walk, so comparing it unsorted tests traversal order.
    out["documents"] = [
        {"relPath": d.rel_path, "name": d.name, "ext": d.ext,
         "language": d.language, "kind": d.kind, "size": d.size,
         "checksum": d.checksum, "lines": d.lines, "truncated": d.truncated,
         "binary": d.binary}
        for d in engine.documents()
    ]

    out["search"] = []
    for q in spec["queries"]:
        query = SearchQuery(
            text=q["text"], limit=q.get("limit"), mode=q.get("mode"),
            fuzzy_max_distance=q.get("fuzzyMaxDistance"),
            languages=q.get("languages"), extensions=q.get("extensions"),
            kinds=q.get("kinds"), path_includes=q.get("pathIncludes"),
            filename=q.get("filename"),
        )
        out["search"].append({
            "query": q,
            "hits": [
                {"relPath": h.document.rel_path, "chunkId": h.chunk.id,
                 "score": h.score, "matched": h.matched_terms, "reasons": h.reasons}
                for h in engine.search(query)
            ],
        })

    out["context"] = []
    for q in spec["contextQueries"]:
        options = q.get("options") or {}
        ctx = engine.get_context(
            SearchQuery(text=q["text"], limit=q.get("limit")),
            neighbors=options.get("neighbors", 1),
            max_tokens=options.get("maxTokens", 6000),
            limit=options.get("limit", 8),
        )
        out["context"].append({
            "query": q["text"], "totalTokens": ctx.total_tokens,
            "truncated": ctx.truncated,
            "entries": [
                {"source": e.source, "tokens": e.tokens, "score": e.score,
                 "chunks": [{"id": r.chunk.id, "role": r.role} for r in e.chunks]}
                for e in ctx.entries
            ],
        })

    delta = engine.update()
    out["incremental"] = {
        "added": delta.added, "modified": delta.modified,
        "deleted": delta.deleted, "unchanged": delta.unchanged,
    }
    return out


def _normalise(value):
    """Round floats so a formatting difference cannot look like a ranking one."""
    if isinstance(value, float):
        return float(f"{value:.12g}")
    if isinstance(value, dict):
        return {k: _normalise(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalise(v) for v in value]
    return value


def compare(ts: dict, py: dict) -> list[str]:
    differences: list[str] = []
    for section in ("tokenize", "languages", "chunks", "index", "documents",
                    "search", "context", "incremental"):
        a, b = _normalise(ts.get(section)), _normalise(py.get(section))
        if a == b:
            continue
        if isinstance(a, list) and isinstance(b, list):
            if len(a) != len(b):
                differences.append(f"{section}: {len(a)} vs {len(b)} entries")
            for i, (x, y) in enumerate(zip(a, b)):
                if x != y:
                    differences.append(
                        f"{section}[{i}]\n"
                        f"    TypeScript: {json.dumps(x, sort_keys=True)[:500]}\n"
                        f"    Python:     {json.dumps(y, sort_keys=True)[:500]}"
                    )
        else:
            differences.append(
                f"{section}\n"
                f"    TypeScript: {json.dumps(a, sort_keys=True)[:500]}\n"
                f"    Python:     {json.dumps(b, sort_keys=True)[:500]}"
            )
    return differences


def run_all(repo: Path) -> tuple[list[str], dict]:
    spec = build_spec()
    with tempfile.TemporaryDirectory(prefix="retrieval-parity-") as tmp:
        work = Path(tmp)
        project = work / "corpus"
        project.mkdir()
        make_corpus(project)
        spec_path = work / "spec.json"
        spec_path.write_text(json.dumps(spec), encoding="utf-8")
        ts = run_typescript(repo, project, work / "idx-ts", spec_path)
        py = run_python(project, work / "idx-py", spec)
    return compare(ts, py), ts


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="/mnt/storage/aura-hub")
    args = ap.parse_args()

    differences, ts = run_all(Path(args.repo))
    counts = {
        "tokenize": len(ts["tokenize"]), "languages": len(ts["languages"]),
        "chunk docs": len(ts["chunks"]),
        "chunks": sum(len(c["chunks"]) for c in ts["chunks"]),
        "documents": len(ts["documents"]),
        "queries": len(ts["search"]),
        "hits": sum(len(s["hits"]) for s in ts["search"]),
        "contexts": len(ts["context"]),
    }
    print("compared: " + ", ".join(f"{v} {k}" for k, v in counts.items()))
    for d in differences:
        print(f"\nDIFF {d}")
    if not differences:
        print("\nEvery retrieval comparison matches the reference.")
    return 1 if differences else 0


if __name__ == "__main__":
    raise SystemExit(main())
