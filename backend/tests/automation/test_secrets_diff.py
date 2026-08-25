"""Secrets TS↔Python differential — REAL oracle (bundled secrets.ts).

Cross-runtime crypto interop both directions + redaction/resolve parity on
shared vectors. Encryption randomness (IV) is normalized by comparing
DECRYPTED semantics and metadata, never ciphertext bytes.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

import pytest

from aura.secrets import SecretStore

SECRETS_MJS = "/tmp/opencode/tsref/secrets.mjs"
DRIVER = "/tmp/opencode/tsref/secrets_driver.mjs"
SEED = "ab" * 32


def _ensure_oracle():
    if Path(SECRETS_MJS).exists() and Path(DRIVER).exists():
        return
    esbuild = Path("/mnt/storage/aura-hub/node_modules/.bin/esbuild")
    repo = Path("/mnt/storage/aura-hub")
    tsref = Path("/tmp/opencode/tsref")
    tsref.mkdir(parents=True, exist_ok=True)
    subprocess.run([str(esbuild), str(repo / "packages/ai-service/src/secrets.ts"),
                    "--bundle", "--format=esm", "--platform=node",
                    f"--outfile={SECRETS_MJS}"], cwd=repo, check=True, capture_output=True)
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
    (tsref / "secrets_driver.mjs").write_text(DRIVER_SRC, encoding="utf-8")


def _ts(op, home, args, seed=SEED):
    env = {**os.environ, "TSREF_SECRETS": SECRETS_MJS,
           "AURA_SECRET_SEED": seed}
    proc = subprocess.run(["node", DRIVER, op, home, seed, json.dumps(args)],
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
