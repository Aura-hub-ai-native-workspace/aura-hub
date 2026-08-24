"""Built-in executors — effects this backend can actually perform today.

Scope discipline: each executor is a real, reversible effect on AURA's own
state (the workflow store under AURA_HOME). Process-backed and node-routed
executors arrive with P5; nothing here spawns processes or touches projects.

The Workflow records written here use the frozen workflow schema
(aura.contracts.workflow_def), so anything persisted is loadable by every
existing consumer of that contract.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..canonical import graph_hash
from ..config import aura_home
from ..contracts import Workflow, WfEdge, WfNode
from ..jsonutil import read_json_file, write_json_atomic


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class WorkflowCreateExecutor:
    """workflow.create — persist one workflow definition, then read it back."""

    name = "workflow.create"

    def __init__(self, home: Path | None = None) -> None:
        self._home = home  # None → resolved at call time (tests inject AURA_HOME first)

    def _dir(self) -> Path:
        return (self._home or aura_home()) / "workflows"

    def run(self, input: dict[str, Any], context: dict[str, Any]) -> tuple[Any | None, str]:
        wid = f"wf-{uuid.uuid4().hex[:12]}"
        wf = Workflow(
            id=wid,
            name=str(input["name"]),
            description=str(input.get("description") or ""),
            category="Agent Generated",
            favorite=False,
            createdAt=_now(),
            updatedAt=_now(),
            nodes=[WfNode.model_validate(n) for n in input["nodes"]],
            edges=[WfEdge.model_validate(e) for e in input["edges"]],
        )
        path = self._dir() / f"{wid}.json"
        write_json_atomic(path, wf.wire())
        return (
            {"workflowId": wid, "path": str(path),
             "nodeCount": len(wf.nodes), "edgeCount": len(wf.edges)},
            f'Stored workflow "{wf.name}" with {len(wf.nodes)} nodes.',
        )

    def verify(
        self, input: dict[str, Any], context: dict[str, Any], output: Any | None
    ) -> dict[str, Any] | None:
        if not isinstance(output, dict):
            return {"passed": False, "kind": "read-back",
                    "detail": "No workflow id was returned to verify against."}
        path = Path(output["path"])
        stored = read_json_file(path, None)
        if not isinstance(stored, dict):
            return {"passed": False, "kind": "read-back",
                    "detail": f"The stored definition at {path} could not be read back."}
        stored_hash = graph_hash(stored.get("nodes") or [], stored.get("edges") or [])
        expected_hash = graph_hash(input["nodes"], input["edges"])
        if stored.get("id") != output["workflowId"] or stored_hash != expected_hash:
            return {"passed": False, "kind": "read-back",
                    "detail": "The stored graph does not match what was submitted."}
        return {"passed": True, "kind": "read-back",
                "detail": f"Read back from {path.name}; graph hash matches ({stored_hash})."}


class WorkflowListExecutor:
    """workflow.list — read-only inventory of the store."""

    name = "workflow.list"

    def __init__(self, home: Path | None = None) -> None:
        self._home = home

    def _dir(self) -> Path:
        return (self._home or aura_home()) / "workflows"

    def run(self, input: dict[str, Any], context: dict[str, Any]) -> tuple[Any | None, str]:
        items = []
        for path in sorted(self._dir().glob("*.json")):
            raw = read_json_file(path, None)
            if isinstance(raw, dict) and isinstance(raw.get("id"), str):
                items.append({
                    "id": raw["id"],
                    "name": raw.get("name") or "",
                    "nodeCount": len(raw.get("nodes") or []),
                })
        return {"workflows": items}, f"{len(items)} workflow(s) stored."

    def verify(self, input: dict, context: dict, output: Any | None) -> None:
        return None  # read-only listing has no mechanical check


# ── process/filesystem executors ─────────────────────────────────────────────
#
# Narrow by construction (P5 subset): fixed argument vectors, project-root
# confinement, hard timeouts, bounded output. There is no generic command
# executor here and none is planned; new effects arrive as named capabilities
# with their own review.

MAX_FILE_BYTES = 64 * 1024
PROCESS_TIMEOUT_S = 15.0


def _require_cwd(context: dict[str, Any]) -> Path:
    cwd = context.get("cwd")
    if not cwd:
        raise ValueError("no project directory is resolved for this invocation")
    return Path(cwd).resolve()


def _confine(root: Path, relative: str) -> Path:
    """Resolve `relative` under `root`, refusing every escape (traversal guard)."""
    if not isinstance(relative, str) or not relative.strip():
        raise ValueError("path is required")
    if Path(relative).is_absolute() or relative.startswith("~"):
        raise ValueError("path must be relative to the project root")
    target = (root / relative).resolve()
    if target != root and root not in target.parents:
        raise ValueError("path escapes the project root")
    return target


def _run_argv(argv: list[str], cwd: Path) -> tuple[int, str]:
    import subprocess

    proc = subprocess.run(  # noqa: S603 — fixed argv, no shell
        argv, cwd=str(cwd), capture_output=True, text=True,
        timeout=PROCESS_TIMEOUT_S, check=False,
    )
    out = (proc.stdout or "")[: MAX_FILE_BYTES]
    err = (proc.stderr or "")[:2000]
    return proc.returncode, out + (f"\n{err}" if proc.returncode else "")


class GitStatusExecutor:
    """git.status — read-only repository status with a FIXED argument vector."""

    name = "git.status"

    ARGV = ["git", "status", "--porcelain=v1", "--branch"]

    def run(self, input: dict[str, Any], context: dict[str, Any]) -> tuple[Any | None, str]:
        cwd = _require_cwd(context)
        code, text = _run_argv(list(self.ARGV), cwd)
        if code != 0:
            raise RuntimeError(f"git status failed ({code})")
        detail = input.get("detail") is False and "branch only" or "branch + files"
        return {"text": text, "exitCode": 0}, f"Repository status gathered ({detail})."

    def verify(self, input: dict, context: dict, output: Any | None) -> dict[str, Any] | None:
        ok = isinstance(output, dict) and output.get("exitCode") == 0
        return {"passed": bool(ok), "kind": "exit-code",
                "detail": "git exited 0." if ok else "git did not exit 0."}


class FsWriteFileExecutor:
    """fs.write_file — create/overwrite one file inside the project root."""

    name = "fs.write_file"

    def run(self, input: dict[str, Any], context: dict[str, Any]) -> tuple[Any | None, str]:
        root = _require_cwd(context)
        target = _confine(root, input["path"])
        content = input["content"]
        if not isinstance(content, str):
            raise ValueError("content must be a string")
        data = content.encode("utf-8")
        if len(data) > MAX_FILE_BYTES:
            raise ValueError(f"content exceeds {MAX_FILE_BYTES} bytes")
        existed = target.exists()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return ({"path": str(target.relative_to(root)), "bytes": len(data),
                 "created": not existed},
                f"{'Overwrote' if existed else 'Created'} "
                f"{target.relative_to(root)} ({len(data)} bytes).")

    def verify(self, input: dict, context: dict, output: Any | None) -> dict[str, Any] | None:
        if not isinstance(output, dict):
            return {"passed": False, "kind": "read-back",
                    "detail": "no write result to verify"}
        root = _require_cwd(context)
        try:
            target = _confine(root, output["path"])
            stored = target.read_bytes()
        except Exception as exc:  # noqa: BLE001
            return {"passed": False, "kind": "read-back",
                    "detail": f"read-back failed: {exc}"}
        match = stored == input["content"].encode("utf-8")
        return {"passed": match, "kind": "read-back",
                "detail": (f"Read back {len(stored)} bytes; content matches."
                           if match else "Stored bytes differ from submitted content.")}


class FsReadFileExecutor:
    """fs.read_file — bounded read of one file inside the project root."""

    name = "fs.read_file"

    def run(self, input: dict[str, Any], context: dict[str, Any]) -> tuple[Any | None, str]:
        root = _require_cwd(context)
        target = _confine(root, input["path"])
        if not target.is_file():
            raise FileNotFoundError(f"{input['path']} does not exist in this project")
        data = target.read_bytes()[:MAX_FILE_BYTES]
        truncated = target.stat().st_size > len(data)
        return ({"path": output_rel(root, target), "text": data.decode("utf-8", "replace"),
                 "truncated": truncated},
                f"Read {output_rel(root, target)} ({len(data)} bytes"
                f"{', truncated' if truncated else ''}).")

    def verify(self, input: dict, context: dict, output: Any | None) -> None:
        return None


def output_rel(root: Path, target: Path) -> str:
    try:
        return str(target.relative_to(root))
    except ValueError:
        return str(target)


def builtin_executors(home: Path | None = None) -> dict[str, Any]:
    create = WorkflowCreateExecutor(home)
    listing = WorkflowListExecutor(home)
    registry = {create.name: create, listing.name: listing,
                GitStatusExecutor().name: GitStatusExecutor(),
                FsWriteFileExecutor().name: FsWriteFileExecutor(),
                FsReadFileExecutor().name: FsReadFileExecutor()}
    return registry
