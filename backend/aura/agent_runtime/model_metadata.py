"""Authoritative model metadata from an Ollama server, with explicit unknowns.

Ollama's ``POST /api/show`` reports a model's real capability list (for example
``tools``) and its context length (``model_info.<arch>.context_length``). Those
are the only sources treated as authoritative here. A field that is missing,
malformed, or unavailable is reported as unknown (None). It is never guessed
from the model name or filled with a default.

Only call this for endpoints the operator has already approved for the
configured network class.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

SOURCE = "ollama:/api/show"

STATUS_VERIFIED = "verified"        # at least one authoritative field parsed
STATUS_EMPTY = "empty"              # reply was valid but carried neither field
STATUS_MALFORMED = "malformed"      # reply was not the expected JSON object
STATUS_UNAVAILABLE = "unavailable"  # endpoint did not answer in time
STATUS_NOT_QUERIED = "not_queried"  # no metadata source applies
STATUS_HTTP_ERROR = "http_error"    # endpoint answered with an error status (e.g. model not found)


@dataclass(frozen=True)
class ModelMetadata:
    model_id: str
    status: str
    #: Authoritative context window in tokens, or None when unknown.
    context_length: int | None = None
    #: Authoritative capability list (lower-case), or None when the server did not report one.
    capabilities: frozenset | None = None
    source: str = "none"
    detail: str = ""

    @property
    def tool_calling(self) -> bool | None:
        """True/False only when the server reported its capability list; else None."""
        if self.capabilities is None:
            return None
        return "tools" in self.capabilities

    def to_dict(self) -> dict:
        return {
            "modelId": self.model_id,
            "status": self.status,
            "contextLength": self.context_length,
            "toolCalling": self.tool_calling,
            "capabilities": sorted(self.capabilities) if self.capabilities is not None else None,
            "source": self.source,
            "detail": self.detail,
        }


def unknown(model_id: str, status: str, detail: str = "") -> ModelMetadata:
    return ModelMetadata(model_id=model_id, status=status, source="none", detail=detail)


def _context_from_model_info(model_info) -> int | None:
    """The single ``<arch>.context_length`` value, or None when absent or ambiguous."""
    if not isinstance(model_info, dict):
        return None
    values = {
        value for key, value in model_info.items()
        if isinstance(key, str) and key.endswith(".context_length")
        and isinstance(value, int) and not isinstance(value, bool) and value > 0
    }
    return values.pop() if len(values) == 1 else None


def parse_ollama_show(model_id: str, payload) -> ModelMetadata:
    """Parse a ``/api/show`` reply. Never raises; malformed input becomes a status."""
    if not isinstance(payload, dict):
        return unknown(model_id, STATUS_MALFORMED, "reply is not a JSON object")

    caps_raw = payload.get("capabilities")
    capabilities: frozenset | None = None
    if caps_raw is not None:
        if isinstance(caps_raw, list) and all(isinstance(c, str) for c in caps_raw):
            capabilities = frozenset(c.strip().lower() for c in caps_raw if c.strip())
        else:
            return unknown(model_id, STATUS_MALFORMED, "capabilities is not a list of strings")

    context = _context_from_model_info(payload.get("model_info"))

    if capabilities is None and context is None:
        return unknown(model_id, STATUS_EMPTY, "no capability or context field in reply")
    return ModelMetadata(
        model_id=model_id, status=STATUS_VERIFIED, context_length=context,
        capabilities=capabilities, source=SOURCE)


def ollama_server_root(base_url: str) -> str | None:
    """The server root for an OpenAI-compatible base URL, or None if unsafe to call.

    ``http://host:11434/v1`` becomes ``http://host:11434``. Only http and https
    are accepted.
    """
    if not isinstance(base_url, str) or not base_url.strip():
        return None
    parsed = urllib.parse.urlsplit(base_url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    path = parsed.path.rstrip("/")
    if path.endswith("/v1"):
        path = path[: -len("/v1")]
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def fetch_ollama_metadata(base_url: str, model_id: str, timeout_s: float = 3.0,
                          opener=None) -> ModelMetadata:
    """Query ``/api/show`` for one model. Returns an explicit status, never raises."""
    root = ollama_server_root(base_url)
    if root is None:
        return unknown(model_id, STATUS_NOT_QUERIED, "base URL is not an http(s) endpoint")
    body = json.dumps({"model": model_id}).encode("utf-8")
    req = urllib.request.Request(
        root + "/api/show", data=body, method="POST",
        headers={"Content-Type": "application/json"})
    try:
        open_fn = opener or urllib.request.urlopen
        with open_fn(req, timeout=timeout_s) as resp:
            raw = resp.read(2 * 1024 * 1024)
    except urllib.error.HTTPError as exc:
        # The server answered; it simply does not serve this model or request.
        return unknown(model_id, STATUS_HTTP_ERROR, f"HTTP {exc.code}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return unknown(model_id, STATUS_UNAVAILABLE, type(exc).__name__)
    try:
        payload = json.loads(raw)
    except ValueError:
        return unknown(model_id, STATUS_MALFORMED, "reply is not valid JSON")
    return parse_ollama_show(model_id, payload)
