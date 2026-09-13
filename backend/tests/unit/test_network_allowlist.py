"""Per-domain allowlist: the 26 ways out, and why none of them work.

Every test here runs a real client inside the real boundary. Nothing is
mocked at the enforcement layer — the point of the exercise is that the
kernel and AURA's own gateway decide, so a mock would prove nothing.

The design being tested: the network namespace still has no route. An
allowlist adds exactly one door, reachable only over a unix socket,
which decides on the hostname the client asks for. So the bypass
attempts split into two families, and both fail:

  around the door   there is no route — the same reason a plain denial
                    holds. Raw IPs, IPv6, DNS, alternate ports, forks.
  through the door  the destination is checked by name, so a denied host
                    is refused whether it is reached by curl, git, pip or
                    a redirect.
"""

from __future__ import annotations

import shutil
import sys

import pytest

from aura.environment.procexec import run_argv
from aura.governance import network as netgov
from aura.governance.netgate import host_allowed

ALLOWED_HOST = "example.com"
DENIED_HOST = "github.com"

ENFORCEABLE = (
    sys.platform.startswith("linux") and shutil.which("bwrap") is not None
    and netgov.capability()["modes"][netgov.ALLOWLIST]
    == netgov.SUPPORTED_AND_ENFORCED)
needs_gateway = pytest.mark.skipif(
    not ENFORCEABLE, reason="this host cannot run the AURA egress gateway")

PROXY = f"http://127.0.0.1:{netgov.__dict__.get('SANDBOX_PROXY_PORT', 3128)}"


@pytest.fixture(scope="module")
def boundary(tmp_path_factory):
    """One verified allowlist boundary for the whole battery."""
    home = str(tmp_path_factory.mktemp("allowlist-home"))
    result = netgov.establish(
        netgov.NetworkPolicy(mode=netgov.ALLOWLIST, domains=(ALLOWED_HOST,)),
        home)
    assert result.ok and result.verified, result.detail
    yield result
    result.close()


def inside(boundary, code: str, timeout_ms: int = 90_000):
    return run_argv([*boundary.argv_prefix, sys.executable, "-c", code],
                    timeout_ms=timeout_ms)


def shell(boundary, command: str, timeout_ms: int = 90_000):
    """A shell command inside the boundary, exactly as a worker's would
    be — proxy variables set by AURA's relay, no route around it."""
    return inside(boundary, (
        "import subprocess,sys\n"
        f"r = subprocess.run({command!r}, shell=True, capture_output=True)\n"
        "sys.exit(r.returncode)\n"), timeout_ms)


# ── the decision itself ──────────────────────────────────────────────

class TestMatching:
    """A domain covers its subdomains, on label boundaries only."""

    @pytest.mark.parametrize("host,ok", [
        ("github.com", True), ("api.github.com", True),
        ("a.b.github.com", True), ("GITHUB.COM", True), ("github.com.", True),
        ("evil-github.com", False), ("github.com.evil.net", False),
        ("notgithub.com", False), ("github.co", False), ("", False),
    ])
    def test_label_boundaries(self, host, ok):
        assert host_allowed(host, 443, ("github.com",), (80, 443))[0] is ok

    def test_an_address_literal_needs_naming(self):
        """A worker that resolves an allowed name itself and connects to
        the address has NOT had that address checked."""
        assert host_allowed("140.82.121.4", 443, ("github.com",),
                            (80, 443))[0] is False

    def test_ports_are_part_of_the_grant(self):
        assert host_allowed("github.com", 8080, ("github.com",),
                            (80, 443))[0] is False


# ── 1-7: allowed works, denied and unknown do not ────────────────────

@needs_gateway
class TestAllowAndDeny:
    def test_1_4_an_allowed_domain_over_https_works(self, boundary):
        out = inside(boundary, (
            "import urllib.request,sys\n"
            f"op=urllib.request.build_opener(urllib.request.ProxyHandler("
            f"{{'https':'{PROXY}','http':'{PROXY}'}}))\n"
            f"r=op.open('https://{ALLOWED_HOST}',timeout=25)\n"
            "sys.exit(0 if r.status==200 else 1)\n"))
        assert out.exit_code == 0, out.stderr

    def test_6_an_allowed_domain_over_http_works(self, boundary):
        out = inside(boundary, (
            "import urllib.request,sys\n"
            f"op=urllib.request.build_opener(urllib.request.ProxyHandler("
            f"{{'https':'{PROXY}','http':'{PROXY}'}}))\n"
            f"r=op.open('http://{ALLOWED_HOST}',timeout=25)\n"
            "sys.exit(0 if r.status in (200,301,302) else 1)\n"))
        assert out.exit_code == 0, out.stderr

    def test_2_5_7_a_denied_domain_fails(self, boundary):
        out = inside(boundary, (
            "import urllib.request,sys\n"
            f"op=urllib.request.build_opener(urllib.request.ProxyHandler("
            f"{{'https':'{PROXY}','http':'{PROXY}'}}))\n"
            "try:\n"
            f"    op.open('https://{DENIED_HOST}',timeout=25); sys.exit(1)\n"
            "except Exception:\n"
            "    sys.exit(0)\n"))
        assert out.exit_code == 0, out.stderr

    def test_3_an_unknown_domain_fails(self, boundary):
        out = inside(boundary, (
            "import urllib.request,sys\n"
            f"op=urllib.request.build_opener(urllib.request.ProxyHandler("
            f"{{'https':'{PROXY}','http':'{PROXY}'}}))\n"
            "try:\n"
            "    op.open('https://never-named-by-any-policy.example.net',"
            "timeout=25); sys.exit(1)\n"
            "except Exception:\n"
            "    sys.exit(0)\n"))
        assert out.exit_code == 0, out.stderr


# ── 8-13: around the door ────────────────────────────────────────────

@needs_gateway
class TestNoRouteAround:
    """These fail for the same reason a plain denial holds: the
    namespace has nowhere to send them. The door is not involved."""

    def _refused(self, boundary, expr: str):
        out = inside(boundary, (
            "import socket,sys\n"
            "try:\n"
            f"    {expr}\n"
            "    sys.exit(1)\n"
            "except OSError:\n"
            "    sys.exit(0)\n"))
        assert out.exit_code == 0, out.stderr

    def test_8_9_direct_ip_is_not_a_named_destination(self, boundary):
        self._refused(boundary,
                      "socket.create_connection(('93.184.215.14',443),timeout=5)")

    def test_10_ipv4_raw_socket(self, boundary):
        self._refused(boundary,
                      "socket.create_connection(('1.1.1.1',443),timeout=5)")

    def test_11_ipv6_raw_socket(self, boundary):
        self._refused(
            boundary,
            "socket.create_connection(('2606:4700:4700::1111',443),timeout=5)")

    def test_12_dns_is_unavailable(self, boundary):
        """The client never resolves — the gateway does, in AURA's
        namespace. Inside there is no resolver at all."""
        out = inside(boundary, (
            "import socket,sys\n"
            "try:\n"
            "    socket.getaddrinfo('example.com',443); sys.exit(1)\n"
            "except OSError:\n"
            "    sys.exit(0)\n"))
        assert out.exit_code == 0, out.stderr

    def test_12b_udp_dns_packet(self, boundary):
        self._refused(boundary, (
            "s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);"
            "s.settimeout(4);s.sendto(b'x',('1.1.1.1',53));s.recvfrom(64)"))

    def test_13_alternate_port_on_an_allowed_host(self, boundary):
        """Even the allowed host is only allowed where the policy says."""
        out = inside(boundary, (
            "import urllib.request,sys\n"
            f"op=urllib.request.build_opener(urllib.request.ProxyHandler("
            f"{{'http':'{PROXY}'}}))\n"
            "try:\n"
            f"    op.open('http://{ALLOWED_HOST}:8080',timeout=20)\n"
            "    sys.exit(1)\n"
            "except Exception:\n"
            "    sys.exit(0)\n"))
        assert out.exit_code == 0, out.stderr


# ── 14-15: through the door, but not past it ─────────────────────────

@needs_gateway
class TestThroughTheDoor:
    def test_14_a_redirect_to_a_denied_host_is_refused(self, tmp_path):
        """A redirect is a NEW request, so the door checks it again.

        Driven by a redirector AURA controls rather than by hoping some
        public URL still 302s: the first hop is genuinely allowed, the
        second genuinely is not, and the client follows automatically —
        which is exactly the case where a naive allowlist leaks.
        """
        import http.server
        import threading

        redirects_served = []

        class Redirector(http.server.BaseHTTPRequestHandler):
            def do_GET(self):                      # noqa: N802
                redirects_served.append(self.path)
                self.send_response(302)
                self.send_header("Location", f"https://{DENIED_HOST}/")
                self.end_headers()

            def log_message(self, *_a):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Redirector)
        port = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            result = netgov.establish(
                netgov.NetworkPolicy(mode=netgov.ALLOWLIST,
                                     domains=("localhost",),
                                     ports=(port,)),
                str(tmp_path))
            assert result.ok, result.detail
            try:
                out = run_argv(
                    [*result.argv_prefix, sys.executable, "-c", (
                        "import urllib.request,sys\n"
                        f"op=urllib.request.build_opener("
                        f"urllib.request.ProxyHandler("
                        f"{{'https':'{PROXY}','http':'{PROXY}'}}))\n"
                        "try:\n"
                        f"    op.open('http://localhost:{port}/start',"
                        "timeout=25)\n"
                        "    sys.exit(1)\n"      # followed it: a leak
                        "except Exception:\n"
                        "    sys.exit(0)\n")],
                    timeout_ms=90_000)
                assert out.exit_code == 0, out.stderr
                decisions = result.decisions()
                # The first hop was allowed and actually served...
                assert redirects_served, "the redirector was never reached"
                assert any(d["decision"] == "ALLOW" and d["host"] == "localhost"
                           for d in decisions), decisions
                # ...and the hop it redirected to was refused by name.
                assert any(d["decision"] == "DENY" and d["host"] == DENIED_HOST
                           for d in decisions), decisions
            finally:
                result.close()
        finally:
            server.shutdown()

    def test_15_proxy_variables_cannot_open_another_path(self, boundary):
        """Pointing elsewhere does not find another way out — it finds
        nothing, because the relay is the only reachable endpoint."""
        out = inside(boundary, (
            "import os,subprocess,sys\n"
            "env=dict(os.environ, http_proxy='http://1.1.1.1:3128',\n"
            "         https_proxy='http://1.1.1.1:3128',\n"
            "         HTTP_PROXY='http://1.1.1.1:3128',\n"
            "         HTTPS_PROXY='http://1.1.1.1:3128')\n"
            "r=subprocess.run([sys.executable,'-c',"
            "\"import urllib.request;urllib.request.urlopen("
            f"'https://{ALLOWED_HOST}',timeout=10)\"],"
            "capture_output=True,env=env)\n"
            "sys.exit(0 if r.returncode!=0 else 1)\n"))
        assert out.exit_code == 0, out.stderr

    def test_15b_unsetting_the_proxy_removes_the_only_path(self, boundary):
        """The variables are a convenience, not the boundary."""
        out = inside(boundary, (
            "import os,subprocess,sys\n"
            "env={k:v for k,v in os.environ.items() "
            "if 'proxy' not in k.lower()}\n"
            "r=subprocess.run([sys.executable,'-c',"
            "\"import urllib.request;urllib.request.urlopen("
            f"'https://{ALLOWED_HOST}',timeout=10)\"],"
            "capture_output=True,env=env)\n"
            "sys.exit(0 if r.returncode!=0 else 1)\n"))
        assert out.exit_code == 0, out.stderr


# ── 16-18: children inherit the boundary ─────────────────────────────

@needs_gateway
class TestChildren:
    def test_16_subprocess_cannot_bypass(self, boundary):
        out = inside(boundary, (
            "import subprocess,sys\n"
            "r=subprocess.run([sys.executable,'-c',"
            "\"import socket;socket.create_connection(('1.1.1.1',443),"
            "timeout=5)\"],capture_output=True)\n"
            "sys.exit(0 if r.returncode!=0 else 1)\n"))
        assert out.exit_code == 0, out.stderr

    def test_17_background_child_cannot_bypass(self, boundary):
        """A child put in the background still has no route. The test
        reports the CHILD's own result, not the shell's."""
        out = inside(boundary, (
            "import subprocess,sys,tempfile,os,time\n"
            "marker=os.path.join(tempfile.mkdtemp(),'r')\n"
            "code=(\"import socket,sys\\n\"\n"
            "      \"try:\\n socket.create_connection(('1.1.1.1',443),\"\n"
            "      \"timeout=5); open(%r,'w').write('LEAK')\\n\"\n"
            "      \"except OSError:\\n open(%r,'w').write('BLOCKED')\\n\"\n"
            "      ) % (marker, marker)\n"
            "p=subprocess.Popen([sys.executable,'-c',code],\n"
            "                   start_new_session=True)\n"
            "p.wait(timeout=30)\n"
            "time.sleep(0.2)\n"
            "sys.exit(0 if open(marker).read()=='BLOCKED' else 1)\n"))
        assert out.exit_code == 0, out.stderr

    def test_18_setsid_double_fork_cannot_bypass(self, boundary):
        out = inside(boundary, (
            "import subprocess,sys\n"
            "r=subprocess.run(['setsid',sys.executable,'-c',"
            "\"import socket;socket.create_connection(('1.1.1.1',443),"
            "timeout=5)\"],capture_output=True)\n"
            "sys.exit(0 if r.returncode!=0 else 1)\n"))
        assert out.exit_code == 0, out.stderr


# ── 19-26: the tools a worker actually reaches for ───────────────────

@needs_gateway
class TestRealClients:
    def test_19_curl_denied(self, boundary):
        out = shell(boundary, f"curl -sS --max-time 20 https://{DENIED_HOST}")
        assert out.exit_code != 0

    def test_19b_curl_allowed(self, boundary):
        out = shell(boundary, f"curl -sS --max-time 25 https://{ALLOWED_HOST}")
        assert out.exit_code == 0, out.stderr

    def test_20_wget_denied(self, boundary):
        out = shell(boundary,
                    f"wget -q -T 20 -O /dev/null https://{DENIED_HOST}")
        assert out.exit_code != 0

    def test_21_python_socket_denied(self, boundary):
        out = inside(boundary, (
            "import socket,sys\n"
            "try:\n"
            "    socket.create_connection(('140.82.121.4',443),timeout=5)\n"
            "    sys.exit(1)\n"
            "except OSError:\n"
            "    sys.exit(0)\n"))
        assert out.exit_code == 0

    def test_22_python_urllib_denied_allowed_pair(self, boundary):
        out = inside(boundary, (
            "import urllib.request,sys\n"
            f"op=urllib.request.build_opener(urllib.request.ProxyHandler("
            f"{{'https':'{PROXY}'}}))\n"
            f"ok = op.open('https://{ALLOWED_HOST}',timeout=25).status==200\n"
            "try:\n"
            f"    op.open('https://{DENIED_HOST}',timeout=25); bad=True\n"
            "except Exception:\n"
            "    bad=False\n"
            "sys.exit(0 if (ok and not bad) else 1)\n"))
        assert out.exit_code == 0, out.stderr

    def test_23_node_denied(self, boundary):
        out = shell(boundary,
                    "node -e \"const n=require('net');"
                    "const s=n.connect(443,'140.82.121.4');"
                    "s.on('connect',()=>process.exit(1));"
                    "s.on('error',()=>process.exit(0));"
                    "setTimeout(()=>process.exit(0),8000)\"")
        assert out.exit_code == 0

    def test_24_git_denied(self, boundary):
        out = shell(boundary,
                    f"git ls-remote https://{DENIED_HOST}/git/git",
                    timeout_ms=120_000)
        assert out.exit_code != 0

    def test_25_npm_denied(self, boundary):
        out = shell(boundary, "npm ping", timeout_ms=120_000)
        assert out.exit_code != 0

    def test_26_pip_denied_with_cache_disabled(self, boundary):
        """--no-cache-dir on purpose. pip's local HTTP cache can satisfy
        a download with no network at all, which looks like a leak and
        is not one: the earlier deny-mode battery reported pip as
        ALLOWED for exactly that reason. Cache access is not network
        access, and the test has to be able to tell them apart."""
        out = shell(
            boundary,
            "python3 -m pip download --no-cache-dir --no-deps "
            "-d /tmp/aura-pip-probe requests", timeout_ms=150_000)
        assert out.exit_code != 0


# ── the record AURA keeps ────────────────────────────────────────────

@needs_gateway
class TestEvidence:
    def test_every_destination_is_recorded_with_its_decision(self, boundary):
        decisions = boundary.decisions()
        assert decisions, "the gateway recorded nothing"
        assert any(d["decision"] == "ALLOW" for d in decisions)
        assert any(d["decision"] == "DENY" for d in decisions)
        for d in decisions:
            assert d["actionType"] == "NETWORK"
            assert d["reason"]

    def test_no_payload_is_recorded(self, boundary):
        """AURA decides WHERE a connection goes. It does not read what
        travels inside it, and the evidence must not imply otherwise."""
        for d in boundary.decisions():
            assert set(d) == {"at", "host", "port", "decision", "reason",
                              "actionType", "tool"}


# ── fail closed ──────────────────────────────────────────────────────

class TestFailClosed:
    def test_a_gateway_that_will_not_start_refuses_the_launch(self, tmp_path):
        def boom(policy, home):
            raise OSError("no socket for you")

        result = netgov.establish(
            netgov.NetworkPolicy(mode=netgov.ALLOWLIST, domains=("x.test",)),
            str(tmp_path), stage=boom)
        assert result.ok is False
        assert result.state == netgov.INITIALIZATION_FAILED
        assert result.argv_prefix == []

    def test_a_boundary_that_fails_its_check_refuses_the_launch(self,
                                                                tmp_path):
        closed = []

        class _Staged:
            launcher_path = "/nonexistent"
            socket_path = "/nonexistent.sock"
            port = 3128

            def close(self):
                closed.append(True)

        result = netgov.establish(
            netgov.NetworkPolicy(mode=netgov.ALLOWLIST, domains=("x.test",)),
            str(tmp_path), stage=lambda p, h: _Staged(),
            verify_allow=lambda home, staged: (False, "traffic escaped"))
        assert result.ok is False
        assert result.state == netgov.INITIALIZATION_FAILED
        assert closed, "a refused boundary must not leave its door open"

    def test_it_never_silently_becomes_unrestricted(self, tmp_path):
        result = netgov.establish(
            netgov.NetworkPolicy(mode=netgov.ALLOWLIST, domains=("x.test",)),
            str(tmp_path), stage=lambda p, h: (_ for _ in ()).throw(
                OSError("nope")))
        assert result.mode == netgov.ALLOWLIST
        assert result.state != netgov.NOT_CONFIGURED
        assert result.verified is False


# ── allowlist + cancellation ─────────────────────────────────────────

@needs_gateway
class TestCancellationWithNetwork:
    """Stopping a run that is mid-request must stop it, and must take
    the door with it. A gateway that outlived its worker would be a
    standing hole in the next task's boundary."""

    def test_the_door_closes_with_the_invocation(self, tmp_path):
        import os
        import socket

        result = netgov.establish(
            netgov.NetworkPolicy(mode=netgov.ALLOWLIST,
                                 domains=(ALLOWED_HOST,)), str(tmp_path))
        assert result.ok
        sock = result.staged.socket_path
        assert os.path.exists(sock)
        result.close()
        assert not os.path.exists(sock), "the gateway socket outlived the run"
        with pytest.raises(OSError):
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            probe.settimeout(2)
            probe.connect(sock)

    def test_a_worker_stopped_mid_request_leaves_nothing_behind(
            self, tmp_path):
        """The worker is a child of the relay, which is the sandbox's
        only command — so a group signal reaches the whole tree, exactly
        as it does without a network policy."""
        import os
        import signal
        import subprocess
        import time

        result = netgov.establish(
            netgov.NetworkPolicy(mode=netgov.ALLOWLIST,
                                 domains=(ALLOWED_HOST,)), str(tmp_path))
        assert result.ok
        try:
            busy = (
                "import urllib.request, time, sys\n"
                f"op=urllib.request.build_opener(urllib.request.ProxyHandler("
                f"{{'https':'{PROXY}','http':'{PROXY}'}}))\n"
                "for _ in range(200):\n"
                "    try:\n"
                f"        op.open('https://{ALLOWED_HOST}',timeout=10)\n"
                "    except Exception:\n"
                "        pass\n"
                "    time.sleep(0.2)\n")
            proc = subprocess.Popen(
                [*result.argv_prefix, sys.executable, "-c", busy],
                start_new_session=True,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(4)
            assert result.decisions(), "the worker never used the door"
            group = os.getpgid(proc.pid)

            os.killpg(group, signal.SIGTERM)
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(group, signal.SIGKILL)
                proc.wait(timeout=15)

            # Nothing of the tree survives the group signal.
            deadline = time.time() + 15
            while time.time() < deadline:
                try:
                    os.killpg(group, 0)
                except (ProcessLookupError, PermissionError):
                    break
                time.sleep(0.5)
            else:
                pytest.fail("the worker's process group survived")
            socket_path = result.staged.socket_path
        finally:
            result.close()
        assert not os.path.exists(socket_path), \
            "the gateway socket outlived the cancelled worker"
