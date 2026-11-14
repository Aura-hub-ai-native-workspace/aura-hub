"""Run isolation: the decision, the container's shape, and the refusals.

These tests need no Docker. They pin down what AURA asks Docker for —
the argv of `docker run` — and how it decides between a container and the
host. Whether Docker really enforces that argv is proven separately, with
real containers, in test_run_isolation_docker.py.
"""

from __future__ import annotations

import asyncio
import os
import stat

import pytest

from aura.governance import container as sandbox
from aura.governance import network as netgov


@pytest.fixture()
def home(tmp_path):
    h = tmp_path / "aura-home"
    h.mkdir()
    return str(h)


@pytest.fixture()
def user_home(tmp_path):
    """A fake $HOME with one worker installed and signed in."""
    u = tmp_path / "user"
    tool = u / ".opencode" / "bin"
    tool.mkdir(parents=True)
    exe = tool / "opencode"
    exe.write_text("#!/bin/sh\necho fake opencode\n")
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    for rel in (".config/opencode", ".local/share/opencode"):
        (u / rel).mkdir(parents=True)
    (u / ".ssh").mkdir()
    (u / ".gitconfig").write_text("[user]\n\tname = t\n")
    return u


def _which(user_home):
    return lambda name: str(user_home / ".opencode" / "bin" / name) \
        if name == "opencode" else None


class _Status:
    def __init__(self, available=True, reason=""):
        self.available, self.reason = available, reason


# ── the setting ──────────────────────────────────────────────────────

class TestSetting:
    def test_the_default_is_automatic(self, home, monkeypatch):
        monkeypatch.delenv("AURA_ISOLATION", raising=False)
        assert sandbox.read_setting(home) == sandbox.AUTO

    def test_a_saved_setting_is_read_back(self, home, monkeypatch):
        monkeypatch.delenv("AURA_ISOLATION", raising=False)
        sandbox.write_setting(home, "container")
        assert sandbox.read_setting(home) == sandbox.CONTAINER

    def test_an_unknown_setting_is_refused(self, home):
        with pytest.raises(ValueError):
            sandbox.write_setting(home, "sometimes")

    def test_a_corrupt_file_reads_as_automatic(self, home, monkeypatch):
        monkeypatch.delenv("AURA_ISOLATION", raising=False)
        path = os.path.join(home, "settings", "isolation.json")
        os.makedirs(os.path.dirname(path))
        with open(path, "w") as fh:
            fh.write("{not json")
        assert sandbox.read_setting(home) == sandbox.AUTO

    def test_the_environment_overrides_the_file(self, home, monkeypatch):
        sandbox.write_setting(home, "container")
        monkeypatch.setenv("AURA_ISOLATION", "host")
        assert sandbox.read_setting(home) == sandbox.HOST
        monkeypatch.setenv("AURA_ISOLATION", "nonsense")
        assert sandbox.read_setting(home) == sandbox.CONTAINER


# ── the decision ─────────────────────────────────────────────────────

class TestDecide:
    def _decide(self, home, monkeypatch, setting, available=True,
                image=(True, "")):
        monkeypatch.setenv("AURA_ISOLATION", setting)
        calls = []

        def ensure(block):
            calls.append(block)
            return image
        d = sandbox.decide(home, status=_Status(available, "Docker is not installed."),
                           ensure=ensure)
        return d, calls

    def test_host_never_asks_docker(self, home, monkeypatch):
        monkeypatch.setenv("AURA_ISOLATION", "host")
        d = sandbox.decide(home, status=object(), ensure=lambda b: 1 / 0)
        assert not d.use_container and not d.refusal

    def test_auto_uses_a_container_when_one_is_ready(self, home, monkeypatch):
        d, calls = self._decide(home, monkeypatch, "auto")
        assert d.use_container and calls == [False]

    def test_auto_without_docker_runs_on_the_host_and_says_why(self, home, monkeypatch):
        d, _ = self._decide(home, monkeypatch, "auto", available=False)
        assert not d.use_container and not d.refusal
        assert "Docker is not installed" in d.reason

    def test_auto_never_waits_for_the_image(self, home, monkeypatch):
        d, calls = self._decide(home, monkeypatch, "auto",
                                image=(False, "the sandbox image is being built"))
        assert calls == [False]                 # non-blocking
        assert not d.use_container and not d.refusal
        assert "being built" in d.reason

    def test_container_without_docker_refuses(self, home, monkeypatch):
        d, _ = self._decide(home, monkeypatch, "container", available=False)
        assert d.refusal == "isolation-unavailable" and not d.use_container
        assert "set to Container" in d.reason

    def test_container_waits_for_the_image(self, home, monkeypatch):
        d, calls = self._decide(home, monkeypatch, "container")
        assert calls == [True] and d.use_container

    def test_container_with_a_failed_image_refuses(self, home, monkeypatch):
        d, _ = self._decide(home, monkeypatch, "container",
                            image=(False, "the sandbox image could not be built: x"))
        assert d.refusal and "could not be built" in d.reason

    def test_other_platforms_report_the_blocker(self, monkeypatch):
        monkeypatch.setattr(sandbox.sys, "platform", "darwin")
        st = sandbox.docker_status(refresh=True)
        assert not st.available and not st.platform_supported
        assert "Linux only" in st.reason


class TestDockerProbe:
    class _Out:
        def __init__(self, code, out="", err=""):
            self.exit_code, self.stdout, self.stderr, self.error = code, out, err, ""
            self.status = "x"

    def test_a_running_daemon_is_available(self, monkeypatch):
        monkeypatch.setattr(sandbox.sys, "platform", "linux")
        st = sandbox.docker_status(query=lambda argv: self._Out(0, "29.9.3\n"))
        assert st.available and st.version == "29.9.3"

    def test_a_stopped_daemon_is_explained(self, monkeypatch):
        monkeypatch.setattr(sandbox.sys, "platform", "linux")
        st = sandbox.docker_status(query=lambda argv: self._Out(
            1, "", "permission denied while trying to connect to the docker API"))
        assert not st.available and st.platform_supported
        assert "permission denied" in st.reason


# ── what one run sees ────────────────────────────────────────────────

class TestPlan:
    def test_install_root_finds_the_package(self, tmp_path):
        pkg = tmp_path / "lib" / "node_modules" / "@x" / "cli"
        (pkg / "bin").mkdir(parents=True)
        (pkg / "package.json").write_text("{}")
        assert sandbox.install_root(str(pkg / "bin" / "x.js"), str(tmp_path)) == str(pkg)

    def test_install_root_of_a_standalone_binary_is_beside_bin(self, tmp_path):
        rel = tmp_path / "releases" / "1.0" / "bin"
        rel.mkdir(parents=True)
        assert sandbox.install_root(str(rel / "codex"), str(tmp_path / "home")) \
            == str(rel.parent)

    def test_install_root_is_never_the_home_directory(self, tmp_path):
        (tmp_path / "bin").mkdir()
        (tmp_path / "package.json").write_text("{}")
        root = sandbox.install_root(str(tmp_path / "bin" / "tool"), str(tmp_path))
        assert root == str(tmp_path / "bin")

    def test_the_worker_sees_its_project_install_and_sign_in_only(
            self, tmp_path, home, user_home):
        proj = tmp_path / "proj"
        proj.mkdir()
        run = sandbox.plan_worker("opencode", str(proj), home,
                                  invocation="t1", user_home=str(user_home),
                                  which=_which(user_home))
        try:
            by_target = {m.target: m for m in run.mounts}
            assert str(proj) in by_target and not by_target[str(proj)].readonly
            assert by_target[str(user_home / ".opencode")].readonly
            assert not by_target[str(user_home / ".config/opencode")].readonly
            assert by_target[str(user_home / ".gitconfig")].readonly
            assert os.path.join(home, "gov") in by_target
            # Not mounted: other workers' state, private keys, the home itself.
            assert str(user_home / ".ssh") not in by_target
            assert str(user_home) not in by_target
            # AURA's own source is only for the hook that needs it.
            assert not any(t.endswith("/backend") for t in by_target)
            # The worker resolves by name through a one-entry bin directory.
            link = os.path.join(run.scratch, "bin", "opencode")
            assert os.path.realpath(link) == str(user_home / ".opencode/bin/opencode")
        finally:
            sandbox.finish(run)
        assert not os.path.exists(run.scratch)

    def test_a_missing_worker_is_an_error_not_an_empty_container(self, home, tmp_path):
        with pytest.raises(FileNotFoundError):
            sandbox.plan_worker("opencode", str(tmp_path), home, which=lambda n: None)


class TestPrefix:
    def _prefix(self, tmp_path, home, user_home, network="none", env=None):
        proj = tmp_path / "proj"
        proj.mkdir(exist_ok=True)
        run = sandbox.plan_worker("opencode", str(proj), home,
                                  user_home=str(user_home), which=_which(user_home))
        try:
            return sandbox.run_prefix(run, network=network, env=env), run
        finally:
            sandbox.finish(run)

    def test_the_container_is_locked_down(self, tmp_path, home, user_home):
        argv, run = self._prefix(tmp_path, home, user_home)
        joined = " ".join(argv)
        assert argv[:4] == ["docker", "run", "--rm", "--init"]
        assert f"--user {os.getuid()}:{os.getgid()}" in joined
        assert "--read-only" in argv
        assert "--cap-drop ALL" in joined
        assert "--security-opt no-new-privileges" in joined
        assert "--network none" in joined
        assert f"--workdir {run.workdir}" in joined
        assert f"--tmpfs {user_home}:" in joined          # an empty home
        # Its own temp folder, owned by the user: /tmp can hold root-owned
        # parents of mounts, which Claude Code refuses to use.
        assert f"--tmpfs {sandbox.SANDBOX_TMP}:" in joined
        assert f"TMPDIR={sandbox.SANDBOX_TMP}" in argv
        assert argv[-1] == sandbox.image_tag()
        assert f"--label {sandbox.LABEL}=run" in joined

    def test_secrets_travel_by_name_never_by_value(self, tmp_path, home, user_home,
                                                   monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-very-secret")
        monkeypatch.setenv("UNRELATED_THING", "x")
        argv, _ = self._prefix(tmp_path, home, user_home,
                               env={"OPENCODE_CONFIG": "/gov/c.json"})
        assert "sk-very-secret" not in " ".join(argv)
        names = [argv[i + 1] for i, a in enumerate(argv) if a == "-e"]
        assert "ANTHROPIC_API_KEY" in names and "OPENCODE_CONFIG" in names
        assert "UNRELATED_THING" not in names

    def test_a_host_proxy_never_becomes_a_route_out(self, monkeypatch):
        monkeypatch.setenv("HTTPS_PROXY", "http://corp:3128")
        names = sandbox.env_names({"HTTP_PROXY": "x"})
        assert "HTTPS_PROXY" not in names and "HTTP_PROXY" not in names

    def test_the_image_tag_follows_the_dockerfile(self, monkeypatch):
        before = sandbox.image_tag()
        monkeypatch.setattr(sandbox, "SANDBOX_DOCKERFILE",
                            sandbox.SANDBOX_DOCKERFILE + "# change\n")
        assert sandbox.image_tag() != before


# ── network policy, through the container ────────────────────────────

class TestEstablish:
    def _run(self, tmp_path, home, user_home):
        proj = tmp_path / "proj"
        proj.mkdir(exist_ok=True)
        return sandbox.plan_worker("opencode", str(proj), home,
                                   user_home=str(user_home), which=_which(user_home))

    def test_no_policy_is_reported_as_ungoverned_network(self, tmp_path, home, user_home):
        run = self._run(tmp_path, home, user_home)
        try:
            res = sandbox.establish(None, home, run)
        finally:
            sandbox.finish(run)
        assert res.ok and res.mode == netgov.UNRESTRICTED
        assert "--network bridge" in " ".join(res.argv_prefix)
        assert "ungoverned" in res.detail

    def test_deny_is_proven_before_it_is_trusted(self, tmp_path, home, user_home):
        run = self._run(tmp_path, home, user_home)
        try:
            ok = sandbox.establish(netgov.NetworkPolicy.parse("deny"), home, run,
                                   verify=lambda r, e: (True, "verified: x"))
            bad = sandbox.establish(netgov.NetworkPolicy.parse("deny"), home, run,
                                    verify=lambda r, e: (False, "traffic escaped"))
        finally:
            sandbox.finish(run)
        assert ok.ok and ok.verified and ok.state == netgov.SUPPORTED_AND_ENFORCED
        assert "--network none" in " ".join(ok.argv_prefix)
        assert not bad.ok and bad.refusal == "network-initialization-failed"
        assert bad.argv_prefix == []

    def test_an_allowlist_runs_the_relay_and_closes_on_failure(self, tmp_path, home,
                                                               user_home):
        closed = []

        class Staged:
            launcher_path = str(tmp_path / "relay.py")
            socket_path = str(tmp_path / "s" / "e.sock")
            port = 3128

            def close(self):
                closed.append(True)

        (tmp_path / "relay.py").write_text("")
        (tmp_path / "s").mkdir()
        policy = netgov.NetworkPolicy.parse({"mode": "allowlist", "domains": ["pypi.org"]})
        run = self._run(tmp_path, home, user_home)
        try:
            ok = sandbox.establish(policy, home, run, stage=lambda p, h: Staged(),
                                   verify_allow=lambda r, s, e: (True, "verified"))
            bad = sandbox.establish(policy, home, run, stage=lambda p, h: Staged(),
                                    verify_allow=lambda r, s, e: (False, "no door"))
        finally:
            sandbox.finish(run)
        assert ok.ok and ok.argv_prefix[-4:] == [
            "python3", Staged.launcher_path, Staged.socket_path, "3128"]
        assert any(m.target == str(tmp_path / "s") for m in run.mounts)
        assert not bad.ok and closed == [True]


# ── the executors ────────────────────────────────────────────────────

class TestDelegateRefusal:
    @pytest.mark.real_isolation
    def test_container_only_without_docker_refuses_before_anything_runs(
            self, tmp_path, monkeypatch):
        from aura.executors import agent_delegate_run

        monkeypatch.setenv("AURA_ISOLATION", "container")
        monkeypatch.setattr(sandbox, "docker_status",
                            lambda *a, **k: sandbox.DockerStatus(
                                False, True, reason="Docker is not installed."))
        spawned = []
        monkeypatch.setattr("aura.executors.run_agent",
                            lambda *a, **k: spawned.append(a))
        node = {"id": "opencode", "name": "OpenCode", "binary": "opencode"}
        res = asyncio.run(agent_delegate_run({
            "input": {"task": "do it", "role": "code"},
            "context": {"cwd": str(tmp_path), "taskId": "t"}, "node": node}))
        assert res["ok"] is False and res.get("refused") is True
        assert res["output"]["blocked"] == "isolation-unavailable"
        assert "Docker is not installed" in res["detail"]
        assert spawned == []


class TestApi:
    def test_status_save_and_refuse(self, monkeypatch, tmp_path):
        from starlette.testclient import TestClient

        from aura.api.server import create_app

        monkeypatch.delenv("AURA_ISOLATION", raising=False)
        monkeypatch.setattr(sandbox, "docker_status",
                            lambda *a, **k: sandbox.DockerStatus(
                                False, True, reason="Docker is not installed."))
        client = TestClient(create_app())
        body = client.get("/governance/isolation").json()
        assert body["setting"] == "auto" and body["active"] == "host"
        assert body["docker"]["available"] is False
        assert "Docker is not installed" in body["reason"]
        assert client.put("/governance/isolation", json={"mode": "bogus"}).status_code == 400
        saved = client.put("/governance/isolation", json={"mode": "container"}).json()
        assert saved["setting"] == "container" and saved["active"] == "refused"
        prep = client.post("/governance/isolation/prepare")
        assert prep.status_code == 409
