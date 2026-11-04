"""Instance ownership for the local API.

A healthy HTTP answer proves only that something is listening on a port. It
does not prove that the listener belongs to the desktop instance that is
starting it: a stale backend from another AURA home, or any other local
server, can answer the same paths. This module adds the smallest protocol
that does prove it.

The desktop shell creates a fresh random token for each backend it launches
and gives it to that child in the environment (``AURA_INSTANCE_TOKEN``). It
never puts the token on a command line, in a log, or in a file.

* ``GET /instance/proof?challenge=<c>`` returns
  ``HMAC-SHA256(token, "aura-instance-proof:" + c)``. Only a process that was
  started with the token can compute it, and the caller picks a fresh
  challenge each time, so a recorded answer cannot be replayed.
* Every other route except ``/health`` and ``/instance/proof`` requires the
  header ``x-aura-instance-token`` to equal the token. Without it the request
  is refused before any handler runs, so a backend that is not the launched
  instance cannot receive state-changing requests even if a client sends them.

When no token is configured (a developer running the script by hand, or the
test suite) the guard is inert. The desktop shell never accepts such a
backend, because it cannot prove ownership of one it did not launch.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re

TOKEN_ENV = "AURA_INSTANCE_TOKEN"
TOKEN_HEADER = b"x-aura-instance-token"
PROOF_PATH = "/instance/proof"
#: Paths answered without the token: liveness, and the ownership check itself.
OPEN_PATHS = frozenset({"/health", PROOF_PATH})
_CHALLENGE = re.compile(r"^[A-Za-z0-9]{16,128}$")
_PROOF_PREFIX = "aura-instance-proof:"


def configured_token() -> str:
    return os.environ.get(TOKEN_ENV, "").strip()


def proof_for(token: str, challenge: str) -> str:
    """The answer to a challenge. Hex, so it is safe in a URL and a header."""
    return hmac.new(token.encode(), (_PROOF_PREFIX + challenge).encode(),
                    hashlib.sha256).hexdigest()


def token_matches(presented: str | None, token: str) -> bool:
    return bool(token) and presented is not None and hmac.compare_digest(
        presented.encode(), token.encode())


class InstanceGuard:
    """ASGI middleware. Wraps the whole application, so the CORS layer above
    it still answers preflight requests and attaches its headers to refusals."""

    def __init__(self, app, token: str | None = None):
        self.app = app
        self.token = configured_token() if token is None else token

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        if path == PROOF_PATH:
            await self._proof(scope, send)
            return
        if not self.token or path in OPEN_PATHS or scope.get("method") == "OPTIONS":
            await self.app(scope, receive, send)
            return
        presented = None
        for name, value in scope.get("headers", []):
            if name.lower() == TOKEN_HEADER:
                presented = value.decode("latin-1")
                break
        if token_matches(presented, self.token):
            await self.app(scope, receive, send)
            return
        body = json.dumps({"error": "instance-token-required",
                           "message": "This backend did not present the token of the "
                                      "instance it belongs to. The request was refused."}).encode()
        await send({"type": "http.response.start", "status": 401,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})

    async def _proof(self, scope, send) -> None:
        from urllib.parse import parse_qs

        query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
        challenge = (query.get("challenge") or [""])[0]
        if scope.get("method") != "GET" or not _CHALLENGE.match(challenge):
            status, payload = 400, {"error": "a challenge of 16-128 letters and digits is required"}
        elif not self.token:
            status, payload = 200, {"backend": "python", "proof": None}
        else:
            status, payload = 200, {"backend": "python",
                                    "proof": proof_for(self.token, challenge)}
        body = json.dumps(payload).encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"),
                                (b"cache-control", b"no-store"),
                                (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
