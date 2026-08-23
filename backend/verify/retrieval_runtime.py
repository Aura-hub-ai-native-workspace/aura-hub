"""Runtime verification of the retrieval engine against a real repository.

Not a fixture: this indexes an actual source tree on this machine,
queries it, persists the index, reloads it from disk in a fresh process
object, makes a real edit and re-indexes incrementally.

The retrieval engine is a library in this phase — the HTTP surface that
exposes it (`/index`, `/reindex`, `/retrieve`) belongs to the pipeline in
Phase 5 — so runtime verification here means real files, not real routes,
and says so rather than inventing a contract.

Usage:  uv run python -m verify.retrieval_runtime [--repo PATH]
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
import time
from pathlib import Path

from aura_backend.retrieval import CodingKnowledgeEngine, SearchQuery

failed = False


def check(name: str, ok: bool, extra: str = "") -> None:
    global failed
    print(f"{'PASS' if ok else 'FAIL'}  {name}{f' — {extra}' if extra else ''}")
    if not ok:
        failed = True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="/mnt/storage/aura-hub")
    args = ap.parse_args()
    source = Path(args.repo) / "packages" / "capability-fabric"
    if not source.is_dir():
        print(f"{source} is not present; cannot run")
        return 1

    with tempfile.TemporaryDirectory(prefix="retrieval-runtime-") as tmp:
        work = Path(tmp)
        project = work / "capability-fabric"
        # A real copy, so the incremental edit later touches a real file
        # without modifying the reference tree.
        shutil.copytree(source, project)
        index_dir = work / "idx"

        # The recency boost reads the clock, so both engines are pinned to
        # the same instant: this phase is verifying persistence and
        # retrieval, not the passage of time between two searches.
        fixed_now = 1_800_000_000_000.0
        engine = CodingKnowledgeEngine(
            str(project), index_dir=str(index_dir), now_ms=lambda: fixed_now
        )

        started = time.monotonic()
        stats = engine.index()
        elapsed = time.monotonic() - started

        check("1. a real source tree indexes", stats.files > 5,
              f"{stats.files} files, {stats.chunks} chunks in {elapsed:.2f}s")
        check("1b. it found real TypeScript", stats.by_language.get("typescript", 0) > 0,
              str(stats.by_language))
        check("1c. nothing errored", stats.errors == [], f"{len(stats.errors)} errors")

        # ── real queries against real code ──────────────────────────
        hits = engine.search(SearchQuery(text="evaluatePolicy"))
        check("2. a real symbol is found", bool(hits),
              hits[0].document.rel_path if hits else "no hits")
        check("2b. the best hit is the file that defines it",
              bool(hits) and "policy" in hits[0].document.rel_path,
              hits[0].document.rel_path if hits else "")
        check("2c. the hit explains itself", bool(hits) and "bm25" in hits[0].reasons,
              ",".join(hits[0].reasons) if hits else "")

        irreversible = engine.search(SearchQuery(text="irreversible floor"))
        check("3. a multi-word query works", bool(irreversible),
              f"{len(irreversible)} hits")

        nonsense = engine.search(SearchQuery(text="photosynthesis chlorophyll mitochondria"))
        check("3b. an unrelated query returns NOTHING, not the nearest thing",
              nonsense == [], f"{len(nonsense)} hits")

        # ── context assembly ────────────────────────────────────────
        ctx = engine.get_context(SearchQuery(text="approval single use"), max_tokens=6000)
        check("4. context is assembled within budget",
              ctx.total_tokens <= 6000 and bool(ctx.entries),
              f"{ctx.total_tokens} tokens across {len(ctx.entries)} files")
        check("4b. every entry cites a real file and line range",
              all(":" in e.source and (project / e.source.rsplit(":", 1)[0]).exists()
                  for e in ctx.entries),
              ", ".join(e.source for e in ctx.entries[:2]))
        # A budget smaller than the first whole entry admits NOTHING and
        # says so. The reference adds whole entries or none, and an empty
        # context flagged `truncated` is the honest answer — better than a
        # half-file that reads as if it were the whole match.
        tight = engine.get_context(SearchQuery(text="approval single use"), max_tokens=500)
        check("4c. too small a budget yields an empty, flagged context",
              tight.entries == [] and tight.truncated is True and tight.total_tokens == 0,
              f"{tight.total_tokens} tokens, truncated={tight.truncated}")

        # ── persistence ─────────────────────────────────────────────
        on_disk = sorted(p.name for p in index_dir.iterdir())
        check("5. the index is on disk",
              on_disk == ["chunks.json", "documents.json", "index.json",
                          "manifest.json", "meta.json"],
              ", ".join(on_disk))

        reloaded = CodingKnowledgeEngine(
            str(project), index_dir=str(index_dir), now_ms=lambda: fixed_now
        )
        check("5b. it reloads from disk", reloaded.load() is True)
        check("5c. and answers identically",
              [(h.chunk.id, h.score) for h in reloaded.search(SearchQuery(text="evaluatePolicy"))]
              == [(h.chunk.id, h.score) for h in hits],
              "same ids and scores")

        # ── incremental over a real edit ────────────────────────────
        unchanged = reloaded.update()
        check("6. an unchanged tree reindexes nothing",
              (unchanged.added, unchanged.modified, unchanged.deleted) == (0, 0, 0),
              f"{unchanged.unchanged} unchanged")

        target = project / "src" / "policy.ts"
        target.write_text(
            target.read_text(encoding="utf-8") + "\nexport const addedByVerification = 1;\n",
            encoding="utf-8",
        )
        (project / "src" / "brand-new.ts").write_text(
            "export const brandNewSymbol = 'verification';\n", encoding="utf-8"
        )
        removed = project / "src" / "missionCapabilities.ts"
        existed = removed.exists()
        if existed:
            removed.unlink()

        delta = reloaded.update()
        check("6b. a real edit is picked up", delta.modified >= 1, f"modified={delta.modified}")
        check("6c. a new file is added", delta.added == 1, f"added={delta.added}")
        check("6d. a deleted file is dropped", delta.deleted == (1 if existed else 0),
              f"deleted={delta.deleted}")
        check("6e. the new symbol is searchable",
              bool(reloaded.search(SearchQuery(text="brandNewSymbol"))))
        check("6f. the deleted file is no longer cited",
              not any(h.document.rel_path.endswith("missionCapabilities.ts")
                      for h in reloaded.search(SearchQuery(text="capability"))))

        # ── the reference tree is untouched ─────────────────────────
        check("7. the real repository was never written to",
              (source / "src" / "missionCapabilities.ts").exists()
              and "addedByVerification" not in (source / "src" / "policy.ts").read_text(
                  encoding="utf-8"),
              "reference tree intact")

    print("\nRESULT: FAILED" if failed else "\nRESULT: ALL CHECKS PASSED")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
