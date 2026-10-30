"""Destination policy for http.request.

Autonomous agents may read from loopback and private-network services (a local
model server is a supported setup) but may not change them: only GET and HEAD
reach those destinations. GET and HEAD are not claimed to be side-effect free;
they are the narrowest methods that keep read access working.

The check runs where the connection is made, on the address actually
connected to, so a hostname that resolves to a private address, a rebinding
answer, or a redirect to an internal host cannot slip past a check done on the
URL text. Every redirect hop opens a new connection and is checked again.

Explicitly user-initiated requests (actor kind "human") are not limited here.
A missing or unknown actor is treated as autonomous.
"""

from __future__ import annotations

import http.client
import ipaddress
import socket
import urllib.error
import urllib.parse
import urllib.request

#: Methods an autonomous request may send to a non-public destination.
SAFE_METHODS = frozenset({"GET", "HEAD"})

#: Cloud instance-metadata addresses. Refused for every actor.
METADATA_ADDRESSES = frozenset({
    ipaddress.ip_address("169.254.169.254"),
    ipaddress.ip_address("100.100.100.200"),
    ipaddress.ip_address("fd00:ec2::254"),
})


class DestinationRefused(OSError):
    """The destination policy refused this connection."""


def is_autonomous(actor: object) -> bool:
    return not (isinstance(actor, dict) and actor.get("kind") == "human")


def _normalise(addr: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    ip = ipaddress.ip_address(addr.split("%", 1)[0])
    mapped = getattr(ip, "ipv4_mapped", None)
    return mapped if mapped is not None else ip


def is_metadata(addr: str) -> bool:
    return _normalise(addr) in METADATA_ADDRESSES


def is_non_public(addr: str) -> bool:
    """Loopback, private, link-local, CGNAT, unspecified, reserved, multicast."""
    ip = _normalise(addr)
    return ip.is_loopback or not ip.is_global


def check_address(addr: str, method: str, autonomous: bool) -> None:
    """Raise DestinationRefused when this actor may not send `method` to `addr`."""
    if is_metadata(addr):
        raise DestinationRefused("That address serves cloud instance metadata, so it is refused.")
    if autonomous and is_non_public(addr) and method.upper() not in SAFE_METHODS:
        raise DestinationRefused(
            f"An autonomous request may only use GET or HEAD against a local or private "
            f"address; {method.upper()} to {addr} was refused.")


def _connect(conn: http.client.HTTPConnection, autonomous: bool) -> socket.socket:
    method = getattr(conn, "_method", None) or "GET"
    infos = socket.getaddrinfo(conn.host, conn.port, type=socket.SOCK_STREAM)
    if not infos:
        raise OSError(f"{conn.host} did not resolve")
    # Judge every answer before connecting to any, so a mixed answer cannot
    # be used to reach the private one.
    for info in infos:
        check_address(info[4][0], method, autonomous)
    last: OSError | None = None
    for family, socktype, proto, _canon, sockaddr in infos:
        sock = socket.socket(family, socktype, proto)
        try:
            sock.settimeout(conn.timeout if conn.timeout is not socket._GLOBAL_DEFAULT_TIMEOUT else None)
            sock.connect(sockaddr)
            return sock
        except OSError as exc:
            sock.close()
            last = exc
    raise last or OSError("connection failed")


def _make_connections(autonomous: bool):
    class Http(http.client.HTTPConnection):
        def connect(self):
            self.sock = _connect(self, autonomous)

    class Https(http.client.HTTPSConnection):
        def connect(self):
            sock = _connect(self, autonomous)
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)

    return Http, Https


class _Redirects(urllib.request.HTTPRedirectHandler):
    max_redirections = 5

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.lower().startswith(("http://", "https://")):
            raise urllib.error.HTTPError(req.full_url, code, "redirect to a non-http(s) address refused", headers, fp)
        # Also catches a literal metadata address when a proxy hides the
        # destination from the connection-time check.
        host = urllib.parse.urlsplit(newurl).hostname or ""
        try:
            literal = is_metadata(host)
        except ValueError:
            literal = False
        if literal:
            raise DestinationRefused("That address serves cloud instance metadata, so it is refused.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def build_opener(autonomous: bool, proxies: bool | None = None) -> urllib.request.OpenerDirector:
    """An opener whose every connection, redirects included, is checked.

    `proxies` defaults to off for an autonomous request, because a proxy would
    be the connection's destination and hide the real one from the check. A
    caller that must work behind a proxy and only ever sends GET (web research)
    passes True; the literal-metadata check on redirects still applies."""
    Http, Https = _make_connections(autonomous)

    class HttpHandler(urllib.request.HTTPHandler):
        def http_open(self, req):
            return self.do_open(Http, req)

    class HttpsHandler(urllib.request.HTTPSHandler):
        def https_open(self, req):
            return self.do_open(Https, req, context=self._context)

    handlers = [HttpHandler, HttpsHandler, _Redirects]
    if (not proxies) if proxies is not None else autonomous:
        handlers.append(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers)
