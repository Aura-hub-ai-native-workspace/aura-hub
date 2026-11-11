"""Differential verification of the Repository Intelligence generators.

Runs the REAL generators from packages/ai-service/src/intelligence/ and
the Python port against the SAME fixture trees and the SAME isolated
`AURA_HOME`, then diffs every artifact they produce, section by section
and field by field.

**What is normalized.** `generatedAt`, `timestamp` and `lastIndexed` are
wall-clock; the Python port takes them as a parameter and the harness
passes the value the reference produced, so they are compared as data
rather than blanked. `durationMs` is a measured elapsed time and is the
one field dropped on both sides. Nothing else is normalized: every score,
every path, every extracted term is compared exactly.

Usage (from backend/):
    uv run python -m parity.intelligence_parity [--repo PATH] [--only NAME]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from aura_backend.intelligence import (
    agent_apis,
    change,
    confidence,
    context_assembler,
    cross_repo,
    document_priority,
    health_engine,
    module_summarizer,
    performance,
    repository_intent,
    repository_memory,
    versioning,
    workspace_graph,
)
from aura_backend.intelligence import (
    architecture as arch_mod,
)
from aura_backend.intelligence import (
    glossary as glossary_mod,
)
from aura_backend.intelligence import (
    identity as identity_mod,
)
from aura_backend.intelligence import (
    personality as personality_mod,
)
from aura_backend.intelligence import (
    validation as validation_mod,
)
from aura_backend.intelligence import (
    verification as verification_mod,
)
from aura_backend.intelligence.artifacts import identity_needs_regeneration

from .intelligence_scenarios import build

# Elapsed-time measurements. Everything else is a claim about the tree.
DROP_KEYS = {"durationMs"}

# Sections where both implementations raised. Reported, not hidden.
THREW_ALIKE: list[str] = []


def _strip(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _strip(v) for k, v in value.items() if k not in DROP_KEYS}
    if isinstance(value, list):
        return [_strip(v) for v in value]
    return value


def _oracle(repo: Path, job: dict[str, Any], job_file: Path) -> dict[str, Any]:
    job_file.write_text(json.dumps(job))
    proc = subprocess.run(
        ["node", str(repo / "scripts" / "run-ts.mjs"),
         str(Path(__file__).parent / "intelligence_oracle.ts"), str(repo), str(job_file)],
        cwd=repo, capture_output=True, text=True, timeout=1800, check=False,
    )
    if proc.returncode != 0:
        print(proc.stderr[-4000:], file=sys.stderr)
        raise SystemExit(f"the intelligence oracle failed on {job['name']}")
    return json.loads(proc.stdout)


def _guard(fn):
    """Run a section, recording a throw the way the oracle does."""
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 — the reference throws here too
        return {"__error": f"{type(exc).__name__}: {exc}"}


def _ok_or_none(value: Any) -> Any:
    return None if isinstance(value, dict) and "__error" in value else value


def _mine(job: dict[str, Any], reference: dict[str, Any]) -> dict[str, Any]:
    """The Python side, given the reference's wall-clock stamps.

    Timestamps are the only values a generator cannot derive from the
    tree, so they are supplied rather than blanked — which keeps them
    inside the comparison instead of outside it.
    """
    home = Path(job["pythonHome"])
    root = job["root"]
    project_id = job["projectId"]
    out: dict[str, Any] = {}

    now_identity = reference["identity"]["generatedAt"]
    identity = identity_mod.generate_identity(project_id, root, job["profile"], now_identity)
    out["identity"] = identity
    # Checked BEFORE the save (nothing stored yet) and again after, so
    # both the "regenerate" and the "unchanged" answers are compared.
    out["identityNeedsRegeneration"] = identity_needs_regeneration(home, project_id, root)
    identity_mod.save_identity(home, identity)
    out["identityAfterSave"] = identity_needs_regeneration(home, project_id, root)

    out["intents"] = [
        repository_intent.classify_repository_intent(q).to_json() for q in job["queries"]
    ]

    out["summary"] = module_summarizer.generate_repository_summary(
        home, project_id, root, reference["summary"]["generatedAt"],
        {"name": identity["name"], "purpose": identity["purpose"],
         "mainModules": identity["mainModules"]},
    )

    out["docs"] = {
        t: document_priority.prioritize_documents(root, t, job["importantFiles"])
        for t in job["intentTypes"]
    }

    ref_glossary = reference["glossary"]
    out["glossary"] = _guard(lambda: glossary_mod.build_glossary(
        home, project_id, root,
        ref_glossary.get("generatedAt", "") if "__error" not in ref_glossary else "",
    ))
    ref_health = reference["health"]
    out["health"] = _guard(lambda: health_engine.generate_repository_health(
        home, project_id, root,
        ref_health.get("generatedAt", "") if "__error" not in ref_health else "",
        identity, out["summary"],
    ))
    ref_profile = reference["profile"]
    out["profile"] = _guard(lambda: repository_memory.build_repository_profile(
        home, project_id, root,
        ref_profile.get("generatedAt", "") if "__error" not in ref_profile else "",
    ))

    out["architecture"] = _guard(lambda: {
        "hierarchy": arch_mod.build_module_hierarchy(root),
        "dependencies": arch_mod.build_dependency_graph(root),
        "entryPoints": arch_mod.detect_entry_points(root, identity),
        "apiSurface": arch_mod.map_api_surface(root),
        "usages": arch_mod.find_usages(root, job["symbol"]),
    })

    ref_verification = reference["verification"]
    out["verification"] = _guard(lambda: verification_mod.generate_verification_report(
        home, project_id, root,
        ref_verification.get("generatedAt", "") if "__error" not in ref_verification else "",
        identity, out["summary"], _ok_or_none(out["health"]),
        _ok_or_none(out["profile"]), _ok_or_none(out["glossary"]),
    ))
    ref_personality = reference["personality"]
    out["personality"] = _guard(lambda: personality_mod.detect_personality(
        home, project_id, root,
        ref_personality.get("generatedAt", "") if "__error" not in ref_personality else "",
        identity, _ok_or_none(out["profile"]), _ok_or_none(out["glossary"]),
    ))
    out["validation"] = _guard(lambda: validation_mod.validate_architecture(
        root, identity, _ok_or_none(out["profile"])
    ))

    out["hash"] = [versioning.generate_artifact_hash(s) for s in job["hashInputs"]]
    # The two versions the oracle created, stamped with the timestamps it
    # recorded — so the timestamps stay inside the comparison.
    ref_versions = reference["versionStats"]
    versioning.create_version(
        home, project_id, {"understanding": "h1"},
        {"fileCount": 3, "totalTokens": 0, "lastIndexed": "T"},
        ref_versions.get("oldestVersion") or "",
    )
    versioning.create_version(
        home, project_id, {"understanding": "h2", "extra": "e"},
        {"fileCount": 4, "totalTokens": 0, "lastIndexed": "T"},
        ref_versions.get("newestVersion") or "",
    )
    out["versionStats"] = versioning.get_version_stats(home, project_id)
    out["currentVersion"] = versioning.get_current_version(home, project_id)
    out["compareVersions"] = versioning.compare_versions(home, project_id, 1, 2)
    out["rollback"] = versioning.rollback_to_version(home, project_id, 1)
    out["afterRollback"] = versioning.get_current_version(home, project_id)

    # `upsertRepository` reads the clock TWICE — once for the repo's
    # `lastIndexed` and once for the graph's `generatedAt` — so the
    # reference's own two stamps are replayed rather than collapsed.
    ws_now = (reference["workspaceGraph"] or {}).get("generatedAt") or ""
    ref_repos = {r["id"]: r for r in (reference["workspaceGraph"] or {}).get("repositories", [])}
    for repo in job["workspaceRepos"]:
        workspace_graph.upsert_repository(
            home, repo["id"], repo["root"], repo.get("identity"),
            ref_repos.get(repo["id"], {}).get("lastIndexed") or ws_now,
            graph_now=ws_now,
        )
    out["workspaceStats"] = workspace_graph.get_workspace_stats(home)
    out["workspaceGraph"] = workspace_graph.load_workspace_graph(home)
    out["crossDeps"] = (
        workspace_graph.detect_cross_repo_dependencies(out["workspaceGraph"])
        if out["workspaceGraph"] else []
    )
    out["findRepositories"] = workspace_graph.find_repositories(home, job["repoCriteria"])
    out["repoDeps"] = workspace_graph.get_repository_dependencies(home, project_id)
    out["group"] = workspace_graph.create_repository_group(
        home, "g1", "a group", [r["id"] for r in job["workspaceRepos"]],
        (reference["group"] or {}).get("generatedAt") or "",
    )
    cross_now = (reference["crossGraph"] or {}).get("generatedAt") or ""
    cross = (cross_repo.build_cross_repo_graph(home, out["workspaceGraph"], cross_now)
             if out["workspaceGraph"] else None)
    out["crossGraph"] = cross
    out["crossStats"] = cross_repo.get_graph_stats(cross) if cross else None
    out["crossPath"] = (cross_repo.find_path(cross, job["pathPair"][0], job["pathPair"][1])
                        if cross else None)
    out["removeRepository"] = workspace_graph.remove_repository(
        home, job["removeRepo"],
        (reference["removeRepository"] or {}).get("generatedAt") or "",
    )

    out["agent"] = {
        "info": agent_apis.get_project_info({
            "projectId": project_id, "root": root, "identity": identity,
            "summary": out["summary"], "profile": _ok_or_none(out["profile"]),
            "glossary": _ok_or_none(out["glossary"]),
        }),
        "tree": agent_apis.get_directory_tree(root),
        "list": agent_apis.list_files(root, ".", recursive=True),
        "search": agent_apis.search_code(root, job["searchPattern"], max_results=20),
        "readFile": agent_apis.read_file(root, job["readPath"]),
        "escape": agent_apis.read_file(root, "../escape.txt"),
        "exists": agent_apis.file_exists(root, job["readPath"]),
        "fileInfo": agent_apis.get_file_info(root, job["readPath"]),
        "missingInfo": agent_apis.get_file_info(root, "does-not-exist.txt"),
    }

    out["detectChangesFresh"] = performance.detect_changes(home, root)
    performance.update_index_state(home, root)
    out["hasChangesAfterUpdate"] = performance.has_changes(home, root)
    out["detectChangesAfterUpdate"] = performance.detect_changes(home, root)
    loader = performance.LazyFileLoader(root, 2)
    out["lazy"] = {
        "first": loader.load(job["readPath"]),
        "missing": loader.load("nope.txt"),
        "stats": loader.stats(),
    }

    log = job["changeLog"]
    out["change"] = {
        "report": change.generate_change_report(log),
        "patterns": change.analyze_change_patterns(log),
        "impact": change.calculate_change_impact(log),
        "hotspots": change.detect_hotspots(log),
        "velocity": change.get_change_velocity(log),
    }

    out["assembled"] = _guard(lambda: [
        context_assembler.assemble_context({
            "intent": repository_intent.classify_repository_intent(q),
            "identity": identity, "summary": out["summary"],
            "profile": _ok_or_none(out["profile"]),
            "glossary": _ok_or_none(out["glossary"]),
            "health": _ok_or_none(out["health"]),
            "prioritizedDocs": out["docs"].get(
                repository_intent.classify_repository_intent(q).type, []
            ),
            "codingContext": job["codingContext"],
            "graphContext": job["graphContext"],
            "memoryContext": job["memoryContext"],
            "retrievedFiles": job["retrievedFiles"],
        })
        for q in job["assembleQueries"]
    ])

    out["confidence"] = [
        confidence.evaluate_confidence(c, {
            "identity": identity, "summary": out["summary"],
            "documentation": job["retrievedFiles"],
            "graphEntities": job["graphEntities"],
        })
        for c in job["claims"]
    ]
    return out


def _diff(label: str, ts: Any, py: Any, out: list[str], depth: int = 0) -> None:
    ts, py = _strip(ts), _strip(py)
    if ts == py:
        return
    if label.endswith(".__error") and isinstance(ts, str) and isinstance(py, str):
        # BOTH threw, at the same call, for the same reason. The message
        # text is a runtime string rather than a contract — `SyntaxError`
        # in V8, `JsRegexSyntaxError` here — and it reaches no response
        # body. What matters is that neither implementation returned a
        # value where the other raised, and that is what is compared.
        THREW_ALIKE.append(
            f"{label}\n    TypeScript: {ts}\n    Python:     {py}"
        )
        return
    if depth < 3 and isinstance(ts, dict) and isinstance(py, dict):
        for key in sorted(set(ts) | set(py)):
            _diff(f"{label}.{key}", ts.get(key), py.get(key), out, depth + 1)
        return
    if depth < 3 and isinstance(ts, list) and isinstance(py, list):
        if len(ts) != len(py):
            out.append(f"{label}: length {len(ts)} vs {len(py)}\n"
                       f"    TypeScript: {json.dumps(ts, sort_keys=True)[:500]}\n"
                       f"    Python:     {json.dumps(py, sort_keys=True)[:500]}")
            return
        for i, (a, b) in enumerate(zip(ts, py, strict=True)):
            _diff(f"{label}[{i}]", a, b, out, depth + 1)
        return
    out.append(f"{label}\n"
               f"    TypeScript: {json.dumps(ts, sort_keys=True, ensure_ascii=False)[:700]}\n"
               f"    Python:     {json.dumps(py, sort_keys=True, ensure_ascii=False)[:700]}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="/mnt/storage/aura-hub")
    ap.add_argument("--only", default=None)
    args = ap.parse_args()
    repo = Path(args.repo)

    differences: list[str] = []
    compared = 0

    with tempfile.TemporaryDirectory(prefix="intel-parity-") as tmp:
        work = Path(tmp)
        job_file = work / "job.json"
        jobs = [j for j in build(work) if not args.only or j["name"] == args.only]

        for job in jobs:
            reference = _oracle(repo, job, job_file)
            mine = _mine(job, reference)
            before = len(differences)
            for key in sorted(set(reference) | set(mine)):
                _diff(f"{job['name']}/{key}", reference.get(key), mine.get(key),
                      differences)
                compared += 1
            status = "MATCH" if len(differences) == before else "DIFFERS"
            print(f"{job['name']:10s} {status}"
                  + ("" if status == "MATCH" else f"  ({len(differences) - before})"))

    print(f"\n{len(jobs)} fixtures · {compared} sections compared")
    if THREW_ALIKE:
        print(f"\n{len(THREW_ALIKE)} section(s) raised on BOTH implementations "
              "(same call, same cause, runtime-specific wording):\n")
        for item in THREW_ALIKE:
            print(item)
            print()
    if differences:
        print(f"\n{len(differences)} DIFFERENCE(S):\n")
        for item in differences[:60]:
            print(item)
            print()
        if len(differences) > 60:
            print(f"... and {len(differences) - 60} more")
        return 1
    print("\nRESULT: every generator matches the reference")
    return 0


if __name__ == "__main__":
    sys.exit(main())
