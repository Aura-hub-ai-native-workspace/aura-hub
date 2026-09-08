"""The one door out of a denied network — an AURA-owned egress gateway.

A network namespace is all-or-nothing: it gives a worker either every
route or none. That is why an allowlist was previously refused. This
module keeps the namespace exactly as it was — no route, no interface
but loopback, no resolver — and adds a single door that AURA controls.

HOW IT IS ARRANGED

    worker (inside --unshare-net)
      │  http(s)_proxy=127.0.0.1:PORT
      ▼
    relay, also inside the namespace, bound to loopback
      │  AF_UNIX — unix sockets are NOT namespaced by a netns
      ▼
    gateway, in AURA's own process, in the host namespace
      │  allowlist decision, per connection
      ▼
    the destination, or a refusal

The security argument is the absence of alternatives, not the presence
of a rule. There is no second route to talk past: unsetting the proxy
variables does not open a path, it removes the only one. A direct
socket, a raw IP, an IPv6 literal, a DNS query, a forked child and a
double-forked grandchild all fail for the same reason they fail under a
plain denial — the namespace has nowhere to send them.

WHY A CONNECT PROXY RATHER THAN IP FILTERING

An allowlist names DOMAINS. Filtering by IP means resolving those names
and hoping the answer stays true: `github.com` and `pypi.org` sit behind
rotating CDN addresses, so an IP rule is stale the moment it is written,
and a worker that resolves a different address than AURA did slips past.
CONNECT carries the hostname the client actually asked for, so the
decision is made on the same name the policy states. AURA reads that
line and nothing else — the tunnel is opaque, there is no TLS
interception, and no payload is inspected or logged.

WHAT THIS DOES NOT COVER

Only HTTP and HTTPS travel through the door, because only they can be
proxied without inventing a protocol. Everything else — SSH, raw TCP, a
database connection — is denied, which is the fail-closed direction and
is reported rather than papered over.
"""

from __future__ import annotations

import os
import re
import socket
import threading
from dataclasses import dataclass, field

#: Where the relay listens INSIDE the sandbox. The namespace is fresh and
#: empty, so nothing can already hold it.
SANDBOX_PROXY_PORT = 3128

#: Ports an allowlisted destination may be reached on unless the policy
#: says otherwise. An allowlist is about WHERE, but a host reachable on
#: every port is a wider grant than "https://pypi.org" reads as.
DEFAULT_PORTS = (80, 443)

#: Bounds. A proxy request is a request line and headers; anything that
#: large is not one, and reading it unbounded would be a way in.
MAX_REQUEST_BYTES = 16 * 1024
CONNECT_TIMEOUT_S = 15
IDLE_TIMEOUT_S = 300
RELAY_CHUNK = 64 * 1024

_CONNECT_RE = re.compile(rb"^CONNECT[ \t]+([^ \t]+)[ \t]+HTTP/1\.[01]",
                         re.IGNORECASE)
_ABSOLUTE_RE = re.compile(
    rb"^[A-Z]+[ \t]+https?://([^/ \t]+)[^ \t]*[ \t]+HTTP/1\.[01]",
    re.IGNORECASE)


def _split_host_port(raw: str, default_port: int) -> tuple[str, int]:
    """Host and port from an authority, IPv6 literals included."""
    text = raw.strip()
    if text.startswith("["):                       # [::1]:443
        close = text.find("]")
        if close == -1:
            raise ValueError("malformed IPv6 authority")
        host = text[1:close]
        rest = text[close + 1:]
        port = int(rest[1:]) if rest.startswith(":") else default_port
        return host.lower(), port
    if text.count(":") == 1:
        host, _, port = text.partition(":")
        return host.strip().lower(), int(port)
    if ":" in text:                                # bare IPv6, no port
        return text.lower(), default_port
    return text.lower(), default_port


def host_allowed(host: str, port: int, domains: tuple[str, ...],
                 ports: tuple[int, ...]) -> tuple[bool, str]:
    """Does the policy permit this destination?

    A domain covers itself and its subdomains, on label boundaries only,
    so `github.com` never covers `evil-github.com`. A leading `*.` is
    accepted as spelling for the same thing. Nothing is inferred: an
    address literal matches only if the policy names that literal, which
    is what stops a worker from resolving an allowed name itself and
    then connecting to the address as if the name had been checked.
    """
    if port not in ports:
        return False, f"port {port} is not permitted by this task's policy"
    name = host.strip().lower().rstrip(".")
    if not name:
        return False, "no destination was named"
    for entry in domains:
        allowed = entry.lstrip("*.").strip().lower().rstrip(".")
        if not allowed:
            continue
        if name == allowed or name.endswith("." + allowed):
            return True, f"{name} matches the allowed destination {allowed}"
    return False, f"{name} is not an allowed destination for this task"


@dataclass
class GatewayDecision:
    at: str
    host: str
    port: int
    decision: str          # ALLOW | DENY
    reason: str
    method: str = ""

    def to_dict(self) -> dict:
        return {"at": self.at, "host": self.host, "port": self.port,
                "decision": self.decision, "reason": self.reason,
                "actionType": "NETWORK", "tool": self.method or "proxy"}


def _now() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z")


class EgressGateway:
    """AURA's side of the door. Lives exactly as long as one invocation.

    Deliberately a thread inside the process that is already supervising
    the worker, not a service: there is nothing to start, nothing to
    leave running, and nothing that outlives the run it belongs to.
    """

    def __init__(self, socket_path: str, domains: tuple[str, ...],
                 ports: tuple[int, ...] = DEFAULT_PORTS,
                 max_events: int = 500) -> None:
        self.socket_path = socket_path
        self.domains = tuple(d.lower() for d in domains)
        self.ports = tuple(ports or DEFAULT_PORTS)
        self._server: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._max_events = max_events
        self.decisions: list[GatewayDecision] = []

    # ── lifecycle ────────────────────────────────────────────────────
    def start(self) -> None:
        os.makedirs(os.path.dirname(self.socket_path), exist_ok=True)
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(self.socket_path)
        # The door is the worker's only egress, so it must not be anyone
        # else's: the socket is readable by this user alone.
        os.chmod(self.socket_path, 0o600)
        server.listen(64)
        server.settimeout(0.5)
        self._server = server
        self._thread = threading.Thread(target=self._serve, daemon=True,
                                        name="aura-egress-gateway")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._server is not None:
            try:
                self._server.close()
            except OSError:
                pass
        if self._thread is not None:
            self._thread.join(timeout=5)
        try:
            os.unlink(self.socket_path)
        except OSError:
            pass

    def __enter__(self) -> "EgressGateway":
        self.start()
        return self

    def __exit__(self, *_exc) -> None:
        self.stop()

    # ── serving ──────────────────────────────────────────────────────
    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self._server.accept()  # type: ignore[union-attr]
            except TimeoutError:
                continue
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,),
                             daemon=True).start()

    def _record(self, decision: GatewayDecision) -> None:
        with self._lock:
            if len(self.decisions) < self._max_events:
                self.decisions.append(decision)

    def _handle(self, conn: socket.socket) -> None:
        upstream: socket.socket | None = None
        try:
            conn.settimeout(CONNECT_TIMEOUT_S)
            head = b""
            while b"\r\n" not in head and len(head) < MAX_REQUEST_BYTES:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                head += chunk
            method = head.split(b" ", 1)[0].decode("latin-1", "replace")[:16]
            tunnel = bool(_CONNECT_RE.match(head))
            match = _CONNECT_RE.match(head) or _ABSOLUTE_RE.match(head)
            if match is None:
                # Not a proxy request. A client speaking something else
                # to this port is not asking for a destination AURA can
                # check, so there is nothing to allow.
                self._record(GatewayDecision(
                    _now(), "", 0, "DENY",
                    "only HTTP and HTTPS can travel through this door",
                    method))
                conn.sendall(b"HTTP/1.1 501 Not Implemented\r\n"
                             b"Connection: close\r\n\r\n"
                             b"AURA: this task's network policy allows only "
                             b"HTTP and HTTPS.\n")
                return
            try:
                host, port = _split_host_port(
                    match.group(1).decode("latin-1"), 443 if tunnel else 80)
            except (ValueError, UnicodeDecodeError):
                self._record(GatewayDecision(
                    _now(), "", 0, "DENY", "malformed destination", method))
                conn.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
                return

            ok, why = host_allowed(host, port, self.domains, self.ports)
            self._record(GatewayDecision(
                _now(), host, port, "ALLOW" if ok else "DENY", why, method))
            if not ok:
                conn.sendall(
                    b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"
                    + f"AURA denied {host}:{port}: {why}\n".encode())
                return

            upstream = socket.create_connection((host, port),
                                                timeout=CONNECT_TIMEOUT_S)
            if tunnel:
                conn.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            else:
                # A plain proxied request: the head already read belongs
                # to the origin server, so it is forwarded verbatim.
                upstream.sendall(head)
            self._pump(conn, upstream)
        except OSError:
            pass
        finally:
            for sock in (conn, upstream):
                if sock is not None:
                    try:
                        sock.close()
                    except OSError:
                        pass

    @staticmethod
    def _pump(a: socket.socket, b: socket.socket) -> None:
        """Move bytes both ways until either side is done.

        The tunnel is opaque on purpose. AURA decided WHERE this
        connection goes; it does not read what travels inside it, and a
        gateway that inspected payloads would be a far larger promise
        than the one being made.
        """
        done = threading.Event()

        def copy(src: socket.socket, dst: socket.socket) -> None:
            try:
                src.settimeout(IDLE_TIMEOUT_S)
                while not done.is_set():
                    data = src.recv(RELAY_CHUNK)
                    if not data:
                        break
                    dst.sendall(data)
            except OSError:
                pass
            finally:
                done.set()
                for sock in (src, dst):
                    try:
                        sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

        t = threading.Thread(target=copy, args=(a, b), daemon=True)
        t.start()
        copy(b, a)
        t.join(timeout=5)


#: The launcher AURA stages INSIDE the sandbox. It is the sandbox half of
#: the door: it binds loopback (which a network namespace does allow),
#: forwards each connection to the gateway's unix socket, points the
#: worker's proxy variables at itself, and exits with the worker's own
#: status. It is started by bwrap as the sandbox's only command, so the
#: worker remains a child of it and of AURA's process group — which is
#: what keeps cancellation and process-tree termination working exactly
#: as they do without a network policy.
LAUNCHER_SOURCE = r'''#!/usr/bin/env python3
"""AURA sandbox egress relay — generated per invocation, do not edit."""
import os
import socket
import subprocess
import sys
import threading

GATEWAY = sys.argv[1]
PORT = int(sys.argv[2])
ARGV = sys.argv[3:]
CHUNK = 64 * 1024


def pump(src, dst):
    try:
        while True:
            data = src.recv(CHUNK)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def handle(client):
    try:
        gate = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        gate.connect(GATEWAY)
    except OSError:
        try:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
        except OSError:
            pass
        client.close()
        return
    t = threading.Thread(target=pump, args=(client, gate), daemon=True)
    t.start()
    pump(gate, client)
    t.join(timeout=5)
    for s in (client, gate):
        try:
            s.close()
        except OSError:
            pass


def serve(server):
    while True:
        try:
            client, _ = server.accept()
        except OSError:
            return
        threading.Thread(target=handle, args=(client,), daemon=True).start()


def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", PORT))
    server.listen(64)
    threading.Thread(target=serve, args=(server,), daemon=True).start()

    proxy = "http://127.0.0.1:%d" % PORT
    env = dict(os.environ)
    # Both spellings, because clients disagree about which they read.
    for name in ("http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY",
                 "all_proxy", "ALL_PROXY"):
        env[name] = proxy
    env["no_proxy"] = env["NO_PROXY"] = ""
    # git and npm do not always read the environment.
    env["GIT_CONFIG_COUNT"] = "2"
    env["GIT_CONFIG_KEY_0"] = "http.proxy"
    env["GIT_CONFIG_VALUE_0"] = proxy
    env["GIT_CONFIG_KEY_1"] = "https.proxy"
    env["GIT_CONFIG_VALUE_1"] = proxy
    env["npm_config_proxy"] = env["npm_config_https_proxy"] = proxy

    try:
        completed = subprocess.run(ARGV, env=env)
    except FileNotFoundError as exc:
        sys.stderr.write("AURA relay could not start the worker: %s\n" % exc)
        return 127
    return completed.returncode


if __name__ == "__main__":
    sys.exit(main())
'''


@dataclass
class StagedGateway:
    """Everything one governed invocation needs, and its cleanup."""

    gateway: EgressGateway
    launcher_path: str
    socket_path: str
    port: int = SANDBOX_PROXY_PORT
    #: The short-path directory holding the socket. Removed on close so
    #: a run leaves nothing behind in the runtime directory.
    socket_dir: str = ""

    def close(self) -> None:
        self.gateway.stop()
        if self.socket_dir:
            import shutil

            shutil.rmtree(self.socket_dir, ignore_errors=True)


__all__ = ["DEFAULT_PORTS", "LAUNCHER_SOURCE", "SANDBOX_PROXY_PORT",
           "EgressGateway", "GatewayDecision", "StagedGateway",
           "host_allowed"]
