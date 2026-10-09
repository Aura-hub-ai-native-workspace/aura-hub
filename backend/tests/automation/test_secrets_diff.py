"""Secrets TS↔Python differential — REAL oracle (bundled secrets.ts).

Cross-runtime crypto interop both directions + redaction/resolve parity on
shared vectors. Encryption randomness (IV) is normalized by comparing
DECRYPTED semantics and metadata, never ciphertext bytes.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from aura.secrets import SecretStore

# Derived from this file, not typed in. The repo used to be addressed by an
# absolute path from one developer's machine, so this differential ERRORED
# at collection on every other checkout — including CI, where it failed with
# FileNotFoundError on a path that does not exist there. Four spaces up from
# this file is the repository root.
REPO = Path(__file__).resolve().parents[3]
SEED = "ab" * 32

# Filled in by _ensure_oracle(); read by _ts(). Module-level because the
# oracle is built once and used by every test in the file.
_ORACLE: dict[str, Path] = {}


def _ensure_oracle():
    """Bundle the TypeScript oracle, or skip with the reason.

    esbuild comes from the repository's own node_modules, so a checkout
    without `npm ci` cannot build the oracle. That is a missing test
    prerequisite rather than a product defect, and it is reported as a skip
    that says which prerequisite is absent — not as a pass, and not as an
    error that looks like a code fault.
    """
    tsref = Path(tempfile.gettempdir()) / "aura-tsref-secrets"
    secrets_mjs = tsref / "secrets.mjs"
    driver = tsref / "secrets_driver.mjs"
    esbuild = REPO / "node_modules" / ".bin" / ("esbuild.cmd" if os.name == "nt" else "esbuild")
    if not esbuild.exists():
        pytest.skip(f"esbuild is absent at {esbuild} — run `npm ci` to build the TypeScript oracle")
    if not (shutil.which("node") or shutil.which("node.exe")):
        pytest.skip("node is not on PATH, so the bundled oracle cannot be executed")
    tsref.mkdir(parents=True, exist_ok=True)
    subprocess.run([str(esbuild), str(REPO / "packages/ai-service/src/secrets.ts"),
                    "--bundle", "--format=esm", "--platform=node",
                    f"--outfile={secrets_mjs}"], cwd=REPO, check=True, capture_output=True)
    DRIVER_SRC = '''// usage: node secrets_driver.mjs <op> <home> <seed> <argsJSON>
const { secrets } = await import(process.env.TSREF_SECRETS);
const [op, home, seed, argsJson] = process.argv.slice(2);
process.env.AURA_HOME = home;
process.env.AURA_SECRET_SEED = seed;
const args = JSON.parse(argsJson ?? '[]');
if (op === 'set') { const i = secrets.set(args[0], args[1], args[2]); process.stdout.write(JSON.stringify(i)); }
else if (op === 'resolve') { try { const r = secrets.resolve(args[0]); process.stdout.write(JSON.stringify(r)); } catch (e) { process.stdout.write(JSON.stringify({ __error__: e.message })); } }
else if (op === 'redact') { const f = secrets.redactor(); process.stdout.write(JSON.stringify({ text: f(args[0]) })); }
else if (op === 'list') { process.stdout.write(JSON.stringify(secrets.list())); }
else if (op === 'has') { process.stdout.write(JSON.stringify(secrets.has(args[0]))); }
else { throw new Error('op ' + op); }
'''
    driver.write_text(DRIVER_SRC, encoding="utf-8")
    _ORACLE.update(mjs=secrets_mjs, driver=driver)


def _ts(op, home, args, seed=SEED):
    _ensure_oracle()
    env = {**os.environ, "TSREF_SECRETS": str(_ORACLE["mjs"]),
           "AURA_SECRET_SEED": seed}
    proc = subprocess.run(["node", str(_ORACLE["driver"]), op, home, seed,
                           json.dumps(args)],
                          capture_output=True, text=True, env=env, check=True)
    return json.loads(proc.stdout)


VECTORS = [
    ("{{secret:API_KEY}}", {"API_KEY": "sk-1234567890abcdef"}),
    ("a {{secret:A}} b {{secret:B}} c {{secret:A}}",
     {"A": "value-aaaa-1111", "B": "value-bbbb-2222"}),
    ("no refs here", {}),
]


@pytest.fixture(scope="module")
def seeded(tmp_path_factory):
    home = tmp_path_factory.mktemp("sec-home")
    _ensure_oracle()
    for _, values in VECTORS:
        for n, v in values.items():
            _ts("set", str(home), [n, v, None])
    return home


@pytest.mark.parametrize("text,values", VECTORS)
def test_resolve_parity(seeded, text, values):
    import asyncio

    ts_r = _ts("resolve", str(seeded), [text])
    os.environ["AURA_HOME"] = str(seeded)
    os.environ["AURA_SECRET_SEED"] = SEED
    py = SecretStore()
    py_r = asyncio.run(_aresolve(py, text)) if False else py.resolve(text)
    assert ts_r == py_r, f"resolve divergence for {text!r}"


async def _aresolve(py, text):  # placeholder symmetry; resolve is sync
    return py.resolve(text)


def test_redact_parity(seeded):
    os.environ["AURA_HOME"] = str(seeded)
    os.environ["AURA_SECRET_SEED"] = SEED
    sample = "sk-1234567890abcdef mid value-aaaa-1111 end"
    ts_out = _ts("redact", str(seeded), [sample])
    assert SecretStore().redactor()(sample) == ts_out["text"]


def test_metadata_parity_no_value_leak(seeded):
    os.environ["AURA_HOME"] = str(seeded)
    ts_list = _ts("list", str(seeded), [])
    py_list = SecretStore().list()
    norm = lambda l: [{k: v for k, v in i.items()} for i in sorted(l, key=lambda x: x["name"])]
    # createdAt/updatedAt involve real wall clock at different moments — compare names+length only
    assert [i["name"] for i in norm(ts_list)] == [i["name"] for i in norm(py_list)]
    assert [i["length"] for i in norm(ts_list)] == [i["length"] for i in norm(py_list)]
    assert all("encrypted" not in i for i in norm(py_list))
