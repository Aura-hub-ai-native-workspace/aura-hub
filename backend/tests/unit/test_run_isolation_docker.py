"""Run isolation, proven with real containers.

Nothing here is mocked at the boundary. Each test starts real containers
from the real sandbox image and tries to get out of them: a mocked docker
proves nothing about what Docker enforces, and calling that isolation
would be exactly the false claim the module exists to avoid.

Skipped where Docker cannot run a container (no daemon, no permission, or
not Linux). The CI `docker` job runs them on every change.
"""

from __future__ import annotations

import asyncio
import json
import os
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

from aura.governance import container as sandbox
from aura.governance import network as netgov

LINUX = sys.platform.startswith("linux")
DOCKER = LINUX and sandbox.docker_status(refresh=True).available

pytestmark = [
    pytest.mark.real_isolation,
    pytest.mark.skipif(not DOCKER, reason="Docker cannot run containers on this machine"),
]


@pytest.fixture(scope="module")
def image():
    ok, detail = sandbox.ensure_image(True)
    assert ok, detail
    return sandbox.image_tag()


@pytest.fixture()
def world(tmp_path, image):
    """A fake user: one worker installed and signed in, a private key, a
    second project, and AURA's home — next to the project being worked on."""
    user = tmp_path / "user"
    tool = user / ".opencode" / "bin"
    tool.mkdir(parents=True)
    exe = tool / "opencode"
    exe.write_text("#!/bin/sh\necho fake-opencode \"$@\"\n")
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    (user / ".config" / "opencode").mkdir(parents=True)
    (user / ".config" / "opencode" / "auth.json").write_text("{}")
    (user / ".ssh").mkdir()
    (user / ".ssh" / "id_ed25519").write_text("PRIVATE KEY")
    other = tmp_path / "other-project"
    other.mkdir()
    (other / "secret.txt").write_text("not yours")
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "README.md").write_text("hello")
    home = tmp_path / "aura-home"
    home.mkdir()
    which = lambda name: str(exe) if name == "opencode" else None  # noqa: E731
    run = sandbox.plan_worker("opencode", str(proj), str(home), invocation="test",
                              user_home=str(user), which=which)
    yield {"user": user, "other": other, "proj": proj, "home": str(home), "run": run}
    sandbox.finish(run)


def _inside(prefix, *argv, timeout=120, env=None):
    return subprocess.run([*prefix, *argv], capture_output=True, text=True,
                          timeout=timeout, env={**os.environ, **(env or {})})


def _left() -> list[str]:
    out = subprocess.run(["docker", "ps", "-a", "--filter", f"label={sandbox.LABEL}=run",
                          "--format", "{{.Names}}"], capture_output=True, text=True)
    return [n for n in out.stdout.split() if n.startswith(sandbox.NAME_PREFIX)]


# ── what the worker can see ──────────────────────────────────────────

def test_the_worker_sees_its_project_and_nothing_else(world):
    res = sandbox.establish(None, world["home"], world["run"])
    probe = (
        "import os, json\n"
        "def seen(p):\n"
        "    try:\n"
        "        os.listdir(p) if os.path.isdir(p) else open(p).read(1)\n"
        "        return True\n"
        "    except Exception:\n"
        "        return False\n"
        f"print(json.dumps({{k: seen(p) for k, p in {{"
        f"'project': {str(world['proj'])!r}, "
        f"'signin': {str(world['user'] / '.config/opencode/auth.json')!r}, "
        f"'ssh': {str(world['user'] / '.ssh/id_ed25519')!r}, "
        f"'other': {str(world['other'] / 'secret.txt')!r}}}.items()}}))\n"
    )
    out = _inside(res.argv_prefix, "python3", "-c", probe)
    assert out.returncode == 0, out.stderr
    seen = json.loads(out.stdout.strip().splitlines()[-1])
    assert seen == {"project": True, "signin": True, "ssh": False, "other": False}


def test_files_it_writes_belong_to_the_user_and_the_image_is_read_only(world):
    res = sandbox.establish(None, world["home"], world["run"])
    out = _inside(res.argv_prefix, "sh", "-c",
                  "echo made > made.txt; touch /usr/local/bin/x 2>/dev/null "
                  "&& echo IMAGE-WRITABLE || echo image-read-only; id -u")
    assert out.returncode == 0, out.stderr
    assert "image-read-only" in out.stdout
    assert out.stdout.strip().splitlines()[-1] == str(os.getuid())
    made = world["proj"] / "made.txt"
    assert made.read_text() == "made\n" and made.stat().st_uid == os.getuid()


def test_the_temp_folder_belongs_to_the_user_even_with_a_project_under_tmp(world):
    """pytest puts the project under /tmp, so Docker creates root-owned
    parents there — exactly the case that made Claude Code refuse /tmp."""
    res = sandbox.establish(None, world["home"], world["run"])
    out = _inside(res.argv_prefix, "python3", "-c",
                  "import os, tempfile; d = tempfile.gettempdir(); "
                  "print(d, os.stat(d).st_uid)")
    assert out.returncode == 0, out.stderr
    assert out.stdout.split() == [sandbox.SANDBOX_TMP, str(os.getuid())]


def test_the_worker_runs_by_name_from_its_real_install(world):
    res = sandbox.establish(None, world["home"], world["run"])
    out = _inside(res.argv_prefix, "opencode", "--version")
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "fake-opencode --version"


# ── network, enforced inside the container ───────────────────────────

def test_deny_is_proven_from_inside(world):
    res = sandbox.establish(netgov.NetworkPolicy.parse("deny"), world["home"], world["run"])
    assert res.ok and res.verified, res.detail
    out = _inside(res.argv_prefix, "python3", "-c",
                  "import socket\n"
                  "try:\n socket.create_connection(('1.1.1.1', 443), timeout=4); print('LEAK')\n"
                  "except OSError as e: print('blocked', e.errno)\n")
    assert "blocked" in out.stdout and "LEAK" not in out.stdout


def test_an_allowlist_refuses_what_it_does_not_name(world):
    policy = netgov.NetworkPolicy.parse({"mode": "allowlist", "domains": ["pypi.org"]})
    res = sandbox.establish(policy, world["home"], world["run"])
    try:
        assert res.ok and res.verified, res.detail
        out = _inside(res.argv_prefix, "python3", "-c",
                      "import urllib.request as u\n"
                      "try:\n u.urlopen('https://example.com/', timeout=15); print('LEAK')\n"
                      "except Exception as e: print('refused', e)\n")
        assert "refused" in out.stdout and "LEAK" not in out.stdout
        decisions = {(d["host"], d["decision"]) for d in res.decisions()}
        assert ("example.com", "DENY") in decisions
    finally:
        res.close()


# ── governance still works in there ──────────────────────────────────

def test_the_governance_plugin_denies_inside_the_container(world):
    """The staged OpenCode plugin runs on the container's Node, refuses a
    write outside the scope, and the refusal reaches AURA's log on the host."""
    from aura.governance import staging

    staged = staging.stage_opencode(
        world["home"], invocation_id="inv-1", task_id="t", node_id="opencode",
        attempt="1", cwd=str(world["proj"]), scope_paths=["README.md"])
    # OpenCode loads the staged .ts plugin itself; plain Node needs .mjs.
    # The copy stays in the mounted governance folder, beside the original.
    plugin = Path(staged["pluginPath"]).with_suffix(".mjs")
    plugin.write_text(Path(staged["pluginPath"]).read_text())
    driver = world["proj"] / "driver.mjs"
    # OpenCode 2's real entry: setup(ctx), hooks registered on ctx.tool.hook.
    driver.write_text(
        f"import p from {json.dumps(plugin.as_uri())};\n"
        "let hook; const ctx = {tool: {hook: async (name, fn) => {\n"
        "  hook = fn; return {dispose: async () => {}}; }}};\n"
        "await p.setup(ctx);\n"
        "await hook({tool: 'write', input: {path: 'README.md', content: 'x'}});\n"
        "console.log('ALLOWED-IN-SCOPE');\n"
        "try { await hook({tool: 'write', input: {path: 'outside.txt', content: 'x'}});\n"
        "  console.log('NOT-DENIED'); }\n"
        "catch (e) { console.log(String(e.message).includes('AURA denied') ? 'DENIED' : e.message); }\n")
    res = sandbox.establish(None, world["home"], world["run"], env=staged["env"])
    out = _inside(res.argv_prefix, "node", str(driver), env=staged["env"])
    # An out-of-scope write is refused: the hook throws, or the plugin
    # stops the worker outright (exit 42), as it does on the host.
    assert "ALLOWED-IN-SCOPE" in out.stdout, out.stdout + out.stderr
    assert "NOT-DENIED" not in out.stdout
    assert "DENIED" in out.stdout or out.returncode == 42, out.stdout + out.stderr
    log = [json.loads(line) for line in Path(staged["logPath"]).read_text().splitlines()
           if line.strip()]
    assert any(e.get("decision") == "DENY" and "outside.txt" in str(e.get("target"))
               for e in log), log
    assert any(e.get("decision") == "ALLOW" for e in log), log


# ── stopping, and leaving nothing behind ─────────────────────────────

def test_stop_reaches_the_container_and_nothing_is_left(world):
    from aura.exec_ import run_file

    res = sandbox.establish(None, world["home"], world["run"])

    async def go():
        cancel = asyncio.Event()

        async def press_stop():
            for _ in range(100):
                if world["run"].name in _left():
                    break
                await asyncio.sleep(0.2)
            cancel.set()

        stopper = asyncio.ensure_future(press_stop())
        started = time.monotonic()
        out = await run_file([*res.argv_prefix, "sleep", "300"], str(world["proj"]),
                             120_000, cancel=cancel)
        await stopper
        return out, time.monotonic() - started

    out, took = asyncio.run(go())
    sandbox.finish(world["run"])
    assert out.signal == "SIGTERM" and took < 60
    assert world["run"].name not in _left()


def _dead_pid() -> int:
    import sys as _sys

    p = subprocess.Popen([_sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


def test_a_container_left_by_a_previous_aura_is_swept(image, tmp_path, monkeypatch):
    """A legacy container (no instance label) whose owner process is
    confirmed dead is removed (issue #112 keeps this for old containers)."""
    monkeypatch.setenv("AURA_HOME", str(tmp_path / "home"))
    name = sandbox.new_name("orphan")
    subprocess.run(["docker", "run", "-d", "--name", name, "--label", f"{sandbox.LABEL}=run",
                    "--label", f"{sandbox.LABEL}.owner={_dead_pid()}", image, "sleep", "300"],
                   check=True, capture_output=True)
    try:
        assert name in _left()
        assert sandbox.sweep(force=True) >= 1
        assert name not in _left()
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


def test_a_legacy_container_whose_owner_pid_is_alive_is_never_swept(image, tmp_path, monkeypatch):
    """Issue #112, A6: the old rule removed every container not owned by this
    pid — including another live AURA's worker. An owner pid that is alive
    (possibly reused) is never proof of death, so the container stays."""
    monkeypatch.setenv("AURA_HOME", str(tmp_path / "home"))
    name = sandbox.new_name("liveowner")
    subprocess.run(["docker", "run", "-d", "--name", name, "--label", f"{sandbox.LABEL}=run",
                    "--label", f"{sandbox.LABEL}.owner=1", image, "sleep", "300"],
                   check=True, capture_output=True)
    try:
        sandbox.sweep(force=True)
        assert name in _left(), "a container whose owner pid is alive was removed"
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


# ── sandbox.execute ──────────────────────────────────────────────────

def test_sandbox_execute_runs_in_a_container(tmp_path, monkeypatch, image):
    from aura.audit import AuditStore
    from aura.fabric import CapabilityFabric, FabricConfig, FabricHost, builtin_executors, invoke_fabric

    class Host(FabricHost):
        def permissions_for(self, _cap, _ctx):
            return {"read": True, "write": True, "execute": True, "autonomous": True,
                    "network": True}

        def node_available(self, _cap):
            return True

    home = tmp_path / "home"
    monkeypatch.setenv("AURA_HOME", str(home))
    monkeypatch.setenv("AURA_ISOLATION", "auto")
    proj = tmp_path / "proj"
    (proj / "sub").mkdir(parents=True)
    (proj / "sub" / "inner.txt").write_text("inner")
    audit = AuditStore(home / "audit" / "trail.jsonl")
    fab = CapabilityFabric(Host())
    fab.attach_audit_store(audit.load, audit.append)
    execs = builtin_executors(home)
    for exe in execs.values():
        try:
            fab.register(exe)
        except Exception:
            pass
    cfg = FabricConfig(fabric=fab, policy_config={}, permissions={"read": True, "write": True},
                       executors=execs, audit_store=audit)
    ctx = {"cwd": str(proj), "actor": {"kind": "agent", "id": "t"}}
    result = invoke_fabric("sandbox.execute", {"command": "pwd", "cwd": "sub"}, ctx, cfg)
    assert result["outcome"] == "succeeded", result
    assert result["output"]["stdout"].strip() == str((proj / "sub").resolve())
    iso = result["output"]["isolation"]
    assert iso["mode"] == "container" and iso["container"].startswith(sandbox.NAME_PREFIX)
    assert iso["container"] not in _left()
