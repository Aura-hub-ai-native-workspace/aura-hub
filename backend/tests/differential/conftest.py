"""Differential harness fixtures — build REAL TypeScript reference bundles.

Uses the repo's own esbuild (node_modules/.bin/esbuild) to bundle the genuine
implementations:
  - packages/capability-fabric/src/fabric.ts      → fingerprintInvocation
  - packages/ai-service/src/workflow/versions.ts  → hashGraph

Bundles land in /tmp/opencode/tsref (pre-approved scratch). If esbuild or the
sources are missing, the differential tests SKIP with an explicit reason —
they never silently pass.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
# Worktree checkouts have no node_modules; borrow the main checkout's
# TypeScript toolchain so the differential gate never silently skips.
if not (REPO / "node_modules" / ".bin" / "esbuild").exists():
    _main = Path("/mnt/storage/aura-hub")
    if (_main / "node_modules" / ".bin" / "esbuild").exists():
        REPO = _main
TSREF = Path("/tmp/opencode/tsref")
ESBUILD = REPO / "node_modules" / ".bin" / "esbuild"
DRIVER = Path(__file__).parent / "ts_driver.mjs"


WF_STUBS = {
    "stub-secrets.mjs": "export const secrets = { redactor: () => (t) => t, resolve: (v) => ({ text: v }), known_values: () => [] };\nexport default { secrets };",
    "stub-agentrunner.mjs": "export function createAgentRunner() { throw new Error('agent runtime not exercised'); }\nexport default { createAgentRunner };",
}


def _wf_stubs() -> None:
    TSREF.mkdir(parents=True, exist_ok=True)
    for name, content in WF_STUBS.items():
        (TSREF / name).write_text(content, encoding="utf-8")


STUB_ENV = """export async function probeNode() { throw new Error('probe unavailable in differential harness'); }
export default { probeNode };
"""

BUILD_WIRING_JS = """
import { build } from '<ESBUILD_LIB>';
import { writeFileSync } from 'node:fs';
const envStub = { name:'env-stub', setup(b){ b.onResolve({filter:/src\/environment$/}, () => ({path:'<TSREF>/stub-env.mjs'})); } };
await build({entryPoints:['<REPO>/packages/ai-service/src/fabric/index.ts'],bundle:true,platform:'node',format:'esm',
  plugins:[envStub], alias:{'@aura/connected-environment':'<TSREF>/connidx.mjs'}, external:['typescript'],
  outfile:'<TSREF>/fabricwiring.mjs', logLevel:'silent'});
"""


def _write_stub_env() -> None:
    TSREF.mkdir(parents=True, exist_ok=True)
    (TSREF / "stub-env.mjs").write_text(STUB_ENV, encoding="utf-8")
    # connected-environment index bundle (once)
    if not (TSREF / "connidx.mjs").exists():
        subprocess.run([
            str(ESBUILD),
            str(REPO / "packages/connected-environment/src/index.ts"),
            "--bundle", "--format=esm", "--platform=node", "--external:typescript",
            f"--outfile={TSREF / 'connidx.mjs'}",
        ], cwd=REPO, check=True, capture_output=True)


def _build_fabric_wiring(repo: Path, esbuild: Path, tsref: Path) -> None:
    js = (BUILD_WIRING_JS
          .replace("<ESBUILD_LIB>", str(repo / "node_modules" / "esbuild" / "lib" / "main.js"))
          .replace("<TSREF>", str(tsref))
          .replace("<REPO>", str(repo)))
    script = tsref / "build-wiring.mjs"
    script.write_text(js, encoding="utf-8")
    subprocess.run(["node", str(script)], cwd=repo, check=True, capture_output=True)


def _build_bundle(entry: Path, out: Path, extra: list[str]) -> None:
    TSREF.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(ESBUILD), str(entry),
        "--bundle", "--format=esm", "--platform=node",
        *extra,
        f"--outfile={out}",
    ]
    subprocess.run(cmd, cwd=REPO, check=True, capture_output=True, text=True)


@pytest.fixture(scope="session")
def tsref() -> dict[str, Path]:
    if not ESBUILD.exists():
        pytest.skip("repo esbuild not installed (node_modules/.bin/esbuild missing)")
    fabric_out = TSREF / "fabric.mjs"
    index_out = TSREF / "fabric-index.mjs"
    versions_out = TSREF / "versions.mjs"
    try:
        _build_bundle(
            REPO / "packages/capability-fabric/src/fabric.ts",
            fabric_out,
            ["--alias:@aura/connected-environment=./packages/connected-environment/src/index.ts"],
        )
        _build_bundle(
            REPO / "packages/capability-fabric/src/index.ts",
            index_out,
            ["--alias:@aura/connected-environment=./packages/connected-environment/src/index.ts"],
        )
        _build_bundle(
            REPO / "packages/ai-service/src/workflow/versions.ts",
            versions_out,
            ["--external:typescript"],
        )
        _build_bundle(
            REPO / "packages/ai-service/src/workflow/store.ts",
            TSREF / "wfstore.mjs", [],
        )
        _build_bundle(
            REPO / "packages/ai-service/src/workflow/run/store.ts",
            TSREF / "runstore.mjs", [],
        )
        _build_bundle(
            REPO / "packages/automation/src/store.ts",
            TSREF / "autostore.mjs", [],
        )
        _build_bundle(
            REPO / "packages/ai-service/src/workflow/run/types.ts",
            TSREF / "runtypes.mjs", [],
        )
        _write_stub_env()
        _build_fabric_wiring(REPO, ESBUILD, TSREF)
        _wf_stubs()
        subprocess.run([str(ESBUILD),
            str(REPO / "packages/ai-service/src/workflow/engine.ts"),
            "--bundle", "--format=esm", "--platform=node", "--external:typescript",
            f"--outfile={TSREF / 'wfengine.mjs'}"], cwd=REPO, check=True, capture_output=True)
    except subprocess.CalledProcessError as e:
        pytest.skip(f"failed to build TS reference bundles: {e.stderr[-400:]}")
    return {
        "fabric": fabric_out, "index": index_out, "versions": versions_out,
        "wfstore": TSREF / "wfstore.mjs", "runstore": TSREF / "runstore.mjs",
        "autostore": TSREF / "autostore.mjs", "fabricwiring": TSREF / "fabricwiring.mjs", "runtypes": TSREF / "runtypes.mjs", "wfengine": TSREF / "wfengine.mjs",
    }


def run_ts_batch(tsref_paths: dict[str, Path], func: str, cases: list[dict]) -> list[str]:
    """One node process per batch; cases in, digests out, order preserved."""
    env_driver = {
        "TSREF_FABRIC": str(tsref_paths["fabric"]),
        "TSREF_VERSIONS": str(tsref_paths["versions"]),
        "PATH": "/usr/bin:/bin:/usr/local/bin",
    }
    import json
    proc = subprocess.run(
        ["node", str(DRIVER)],
        input=json.dumps({"func": func, "cases": cases}),
        capture_output=True, text=True, env=env_driver, check=True,
    )
    return json.loads(proc.stdout)["digests"]
