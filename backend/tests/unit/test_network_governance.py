"""Network governance: a kernel boundary, or an honest refusal.

The tests that matter here are the ones that actually try to get out.
Nothing is mocked at the enforcement layer — a mocked network layer
proves nothing about a kernel namespace, and calling it enforcement
would be exactly the false claim this module exists to avoid.
"""

from __future__ import annotations

import shutil
import subprocess
import sys

import pytest

from aura.governance import network as netgov

LINUX = sys.platform.startswith("linux")
HAS_BWRAP = shutil.which("bwrap") is not None
ENFORCEABLE = (LINUX and HAS_BWRAP
               and netgov.capability()["modes"][netgov.DENY]
               == netgov.SUPPORTED_AND_ENFORCED)
needs_boundary = pytest.mark.skipif(
    not ENFORCEABLE,
    reason="this host cannot create an unprivileged network namespace")


# ── policy is AURA's, and it is read strictly ────────────────────────

class TestPolicy:
    def test_no_policy_is_not_a_policy(self):
        assert netgov.NetworkPolicy.parse(None) is None

    def test_modes_parse(self):
        assert netgov.NetworkPolicy.parse("deny").mode == netgov.DENY
        parsed = netgov.NetworkPolicy.parse(
            {"mode": "allowlist", "domains": ["PyPI.org"]})
        assert parsed.domains == ("pypi.org",)

    @pytest.mark.parametrize("bad", [
        "off", "none", {"mode": "sometimes"}, {"mode": "allowlist"},
        {"mode": "allowlist", "domains": "pypi.org"}, 7,
    ])
    def test_anything_unreadable_is_refused_not_defaulted(self, bad):
        """A policy that cannot be read is not a policy. Defaulting here
        would silently pick a posture the task never asked for."""
        with pytest.raises(ValueError):
            netgov.NetworkPolicy.parse(bad)


class TestCapabilityReporting:
    def test_the_host_reports_per_mode_not_a_boolean(self):
        """§16: "enabled" and "enforced" are different words."""
        caps = netgov.capability()
        assert set(caps["modes"]) == set(netgov.MODES)
        assert caps["detail"]

    def test_selective_egress_is_never_claimed_here(self):
        """An allowlist needs a userspace stack for the namespace. AURA
        does not ship one, so it does not claim one on any platform."""
        assert netgov.capability()["modes"][netgov.ALLOWLIST] == \
            netgov.UNSUPPORTED

    def test_an_unenforceable_mode_refuses_the_launch(self, tmp_path):
        """§19: initialization failure never becomes a launch under the
        claim of governance."""
        result = netgov.establish(
            netgov.NetworkPolicy(mode=netgov.ALLOWLIST,
                                 domains=("pypi.org",)), str(tmp_path))
        assert result.ok is False
        assert result.state == netgov.UNSUPPORTED
        assert result.refusal == "network-allowlist-unsupported"

    def test_a_failed_self_check_refuses_the_launch(self, tmp_path):
        """If the boundary cannot be proven, the worker does not run."""
        result = netgov.establish(
            netgov.NetworkPolicy(mode=netgov.DENY), str(tmp_path),
            verify=lambda home: (False, "the sandbox did not start"))
        assert result.ok is False
        assert result.state == netgov.INITIALIZATION_FAILED
        assert result.verified is False

    def test_an_ungoverned_task_says_so(self, tmp_path):
        result = netgov.establish(None, str(tmp_path))
        assert result.ok is True
        assert result.state == netgov.NOT_CONFIGURED
        assert result.mode == netgov.UNRESTRICTED
        assert result.argv_prefix == []


# ── the boundary, for real ───────────────────────────────────────────

def _inside(tmp_path, code: str, timeout: int = 25):
    return subprocess.run(
        [*netgov.deny_prefix(str(tmp_path)), sys.executable, "-c", code],
        capture_output=True, text=True, timeout=timeout, check=False)


@needs_boundary
class TestEnforcement:
    def test_the_boundary_proves_itself_before_it_is_trusted(self, tmp_path):
        ok, why = netgov.verify_denial(str(tmp_path))
        assert ok is True, why
        assert "verified" in why

    def test_establish_returns_a_verified_prefix(self, tmp_path):
        result = netgov.establish(
            netgov.NetworkPolicy(mode=netgov.DENY), str(tmp_path))
        assert result.ok and result.verified
        assert result.state == netgov.SUPPORTED_AND_ENFORCED
        assert "--unshare-net" in result.argv_prefix

    def test_tcp_to_a_literal_ip_is_blocked(self, tmp_path):
        """An IP literal on purpose: a blocked resolver alone would make
        a leaking network look closed."""
        proc = _inside(tmp_path, (
            "import socket,sys\n"
            "try:\n"
            "    socket.create_connection(('1.1.1.1',443),timeout=4)\n"
            "    sys.exit(1)\n"
            "except OSError:\n"
            "    sys.exit(0)\n"))
        assert proc.returncode == 0, proc.stderr

    def test_name_resolution_is_blocked(self, tmp_path):
        """A network namespace does NOT isolate the unix socket glibc
        uses to reach a system resolver. Without closing that, a
        sandboxed worker still resolves names — and a reachable resolver
        is itself a channel out."""
        proc = _inside(tmp_path, (
            "import socket,sys\n"
            "try:\n"
            "    socket.getaddrinfo('example.com',443)\n"
            "    sys.exit(1)\n"
            "except OSError:\n"
            "    sys.exit(0)\n"))
        assert proc.returncode == 0, proc.stderr

    def test_ipv6_is_blocked(self, tmp_path):
        proc = _inside(tmp_path, (
            "import socket,sys\n"
            "try:\n"
            "    socket.create_connection("
            "('2606:4700:4700::1111',443),timeout=4)\n"
            "    sys.exit(1)\n"
            "except OSError:\n"
            "    sys.exit(0)\n"))
        assert proc.returncode == 0, proc.stderr

    def test_udp_is_blocked(self, tmp_path):
        proc = _inside(tmp_path, (
            "import socket,sys\n"
            "s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)\n"
            "s.settimeout(4)\n"
            "try:\n"
            "    s.sendto(b'x',('1.1.1.1',53)); s.recvfrom(64)\n"
            "    sys.exit(1)\n"
            "except OSError:\n"
            "    sys.exit(0)\n"))
        assert proc.returncode == 0, proc.stderr

    def test_a_child_process_cannot_escape(self, tmp_path):
        """The namespace is inherited: a worker cannot shell out of it."""
        proc = _inside(tmp_path, (
            "import subprocess,sys,socket\n"
            "r=subprocess.run([sys.executable,'-c',"
            "\"import socket;socket.create_connection(('1.1.1.1',443),"
            "timeout=4)\"],capture_output=True)\n"
            "sys.exit(0 if r.returncode!=0 else 1)\n"))
        assert proc.returncode == 0, proc.stderr

    def test_a_detached_grandchild_cannot_escape(self, tmp_path):
        """setsid detaches from the process group, not the namespace."""
        proc = _inside(tmp_path, (
            "import subprocess,sys,os\n"
            "r=subprocess.run(['setsid',sys.executable,'-c',"
            "\"import socket;socket.create_connection(('1.1.1.1',443),"
            "timeout=4)\"],capture_output=True)\n"
            "sys.exit(0 if r.returncode!=0 else 1)\n"))
        assert proc.returncode == 0, proc.stderr

    def test_proxy_variables_cannot_open_a_path_out(self, tmp_path):
        """There is no rule to talk past — there is no network."""
        proc = _inside(tmp_path, (
            "import os,subprocess,sys\n"
            "env=dict(os.environ, http_proxy='http://1.1.1.1:3128',\n"
            "         https_proxy='http://1.1.1.1:3128')\n"
            "r=subprocess.run([sys.executable,'-c',"
            "\"import socket;socket.create_connection(('1.1.1.1',3128),"
            "timeout=4)\"],capture_output=True,env=env)\n"
            "sys.exit(0 if r.returncode!=0 else 1)\n"))
        assert proc.returncode == 0, proc.stderr

    def test_the_worker_is_otherwise_unharmed(self, tmp_path):
        """Denial must cost the worker its network and nothing else:
        same filesystem, same identity, same working directory."""
        marker = tmp_path / "written-from-inside.txt"
        proc = _inside(tmp_path, (
            "import os,pathlib,sys\n"
            f"pathlib.Path({str(marker)!r}).write_text(os.getlogin() "
            "if hasattr(os,'getlogin') else 'user')\n"
            "sys.exit(0)\n"))
        assert proc.returncode == 0, proc.stderr
        assert marker.exists()


@needs_boundary
class TestEnforcementThroughTheDispatchPath:
    def test_a_refused_policy_never_launches_the_worker(self, tmp_path,
                                                        monkeypatch):
        """The executor must not run the agent when governance could not
        be established — §19, checked at the real call site."""
        import asyncio

        import aura.executors as ex

        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        launched: list[str] = []
        monkeypatch.setattr(
            ex, "run_agent",
            lambda *a, **k: launched.append(a) or (_ for _ in ()).throw(
                AssertionError("the worker was launched anyway")))
        result = asyncio.run(ex.agent_delegate_run({
            "id": "inv-1",
            "input": {"task": "do it",
                      "network": {"mode": "allowlist",
                                  "domains": ["pypi.org"]}},
            "context": {"cwd": str(tmp_path), "taskId": "t1"},
            "node": {"id": "opencode", "name": "OpenCode",
                     "binary": "opencode"},
        }))
        assert result["ok"] is False
        assert launched == []
        assert "allowlist" in result["detail"]
        assert result["output"]["network"]["state"] == netgov.UNSUPPORTED

    def test_a_malformed_policy_is_refused_before_anything_runs(
            self, tmp_path, monkeypatch):
        import asyncio

        import aura.executors as ex

        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        result = asyncio.run(ex.agent_delegate_run({
            "id": "inv-1",
            "input": {"task": "do it", "network": {"mode": "whatever"}},
            "context": {"cwd": str(tmp_path), "taskId": "t1"},
            "node": {"id": "opencode", "name": "OpenCode",
                     "binary": "opencode"},
        }))
        assert result["ok"] is False
        assert "network policy was refused" in result["detail"]


class TestNoFalseClaims:
    def test_an_unsupported_host_is_reported_not_silently_allowed(self,
                                                                  tmp_path,
                                                                  monkeypatch):
        monkeypatch.setattr(netgov, "capability", lambda: {
            "platform": "windows", "method": "", "modes": {
                netgov.DENY: netgov.UNSUPPORTED,
                netgov.ALLOWLIST: netgov.UNSUPPORTED,
                netgov.UNRESTRICTED: netgov.NOT_CONFIGURED},
            "detail": "no boundary here"})
        result = netgov.establish(
            netgov.NetworkPolicy(mode=netgov.DENY), str(tmp_path))
        assert result.ok is False
        assert result.state == netgov.UNSUPPORTED
        assert result.verified is False

    def test_an_ungoverned_result_never_claims_enforcement(self, tmp_path):
        result = netgov.establish(None, str(tmp_path))
        assert result.verified is False
        assert result.state != netgov.SUPPORTED_AND_ENFORCED
