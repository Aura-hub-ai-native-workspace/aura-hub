"""Sovereign Model Registry — structured inventory of privately available models.

Every AI inference event within AURA's sovereign runtime must reference a
model record from this registry.  The registry:

  1. Discovers models from configured private endpoints (Ollama /api/tags, etc.)
  2. Maintains structured metadata per model (capability tags, context window,
     quantization, size, network class)
  3. Tracks health with a TTL-based cache — stale records are re-verified rather
     than blindly trusted
  4. Exposes a query interface used by ModelRouter (S3) to match task
     requirements to a specific model

NO cloud endpoints are registered here.  Cloud provider routing lives in
RoutedModelPort (model_routing.py); this registry only tracks models the
operator controls.

Capability tags (vocabulary shared with ModelRouter):
  "text-generation"  — general completions, planning, summarisation
  "code-generation"  — source code, diffs, shell commands
  "json-mode"        — structured JSON output (function calling / tool use)
  "embedding"        — vector embedding (distance-based retrieval)
  "vision"           — multimodal image+text input
  "long-context"     — context window ≥ 32 k tokens
"""

from __future__ import annotations

import json
import time
import urllib.request
from dataclasses import dataclass, field
from typing import Dict, List, Optional

#: Health cache TTL in seconds.  After this interval a model's health is
#: considered stale and re-verified on next use.
HEALTH_TTL_S: float = 120.0

#: Standard capability tag vocabulary (open-ended — registry never rejects
#: unknown tags, it just doesn't match them in queries)
CAPABILITY_TAGS = frozenset({
    "text-generation",
    "code-generation",
    "json-mode",
    "embedding",
    "vision",
    "long-context",
})


@dataclass
class ModelRecord:
    """A single model known to the sovereign registry.

    Fields are populated from discovery (Ollama /api/tags) and/or from the
    operator's model manifest.  All fields that require a running server are
    populated lazily; the record is valid for router matching even when only
    id + endpoint + capabilities are set.
    """

    id: str                          # unique: "<endpoint_id>/<model_name>"
    model_name: str                  # e.g. "llama3:8b-instruct-q4_K_M"
    endpoint_id: str                 # matches providers.json entry id
    base_url: str                    # normalized endpoint base URL
    network_class: str = "unknown"   # "local" | "private"

    # Capability tags — set during discovery or from manifest
    capabilities: frozenset = field(default_factory=frozenset)

    # Metadata from discovery
    parameter_size: str = ""        # e.g. "8B", "70B"
    quantization: str = ""          # e.g. "Q4_K_M", "F16"
    context_length: int = 0         # 0 = unknown
    size_bytes: int = 0             # model file size on disk

    # Health tracking
    healthy: Optional[bool] = None  # None = unchecked
    last_checked: float = 0.0       # monotonic timestamp
    last_error: str = ""

    def is_stale(self, ttl: float = HEALTH_TTL_S) -> bool:
        return (time.monotonic() - self.last_checked) > ttl

    def matches(self, required_caps: frozenset) -> bool:
        """True if this model has all the required capability tags."""
        return required_caps.issubset(self.capabilities)

    def to_dict(self) -> dict:
        """Secret-free snapshot for telemetry/monitoring UI."""
        return {
            "id": self.id,
            "modelName": self.model_name,
            "endpointId": self.endpoint_id,
            "networkClass": self.network_class,
            "capabilities": sorted(self.capabilities),
            "parameterSize": self.parameter_size,
            "quantization": self.quantization,
            "contextLength": self.context_length,
            "sizeBytes": self.size_bytes,
            "healthy": self.healthy,
            "lastError": self.last_error or None,
            "stale": self.is_stale(),
        }


def _infer_capabilities(model_name: str, context_length: int) -> frozenset:
    """Best-effort capability inference from model name and metadata.

    Registry consumers should treat these as hints; operator manifests take
    precedence.  The inference is intentionally conservative: it only adds
    tags where the model name is a strong signal (e.g. "-embed" → embedding).
    """
    name = model_name.lower()
    caps: set[str] = {"text-generation"}

    # Code-generation signals
    if any(k in name for k in ("code", "coder", "deepseek-coder",
                                "starcoder", "codellama", "qwen-coder")):
        caps.add("code-generation")

    # Embedding signals
    if any(k in name for k in ("embed", "embedding", "nomic-embed",
                                "bge", "e5-")):
        caps.discard("text-generation")  # embeddings are not generation
        caps.add("embedding")

    # Vision signals
    if any(k in name for k in ("llava", "vision", "bakllava", "moondream",
                                "cogvlm", "idefics", "minicpm-v")):
        caps.add("vision")

    # JSON-mode / instruct: conservative; nearly all instruct models work
    if any(k in name for k in ("instruct", "chat", "it", "hermes",
                                "mixtral", "llama3", "phi", "gemma",
                                "qwen", "mistral", "nous")):
        caps.add("json-mode")

    # Long context
    if context_length >= 32_000:
        caps.add("long-context")

    return frozenset(caps)


class ModelRegistry:
    """Live inventory of models available on private endpoints.

    Usage:
        registry = ModelRegistry()
        registry.discover_from_ollama("ollama-local", "http://localhost:11434",
                                      network_class="local")
        models = registry.query(frozenset({"text-generation", "json-mode"}))
    """

    def __init__(self) -> None:
        self._records: Dict[str, ModelRecord] = {}

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------

    def discover_from_ollama(
            self, endpoint_id: str, base_url: str,
            network_class: str = "local",
            timeout_s: float = 5.0) -> list[ModelRecord]:
        """Pull the model list from an Ollama server's /api/tags endpoint.

        Returns the list of newly registered/updated records.
        Does NOT raise: a dead server simply returns an empty list and the
        caller gets an honest empty result — never a fabricated one.
        """
        url = base_url.rstrip("/") + "/api/tags"
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                data = json.loads(resp.read(2 * 1024 * 1024))
        except Exception as exc:
            return []

        models_raw = data.get("models") if isinstance(data, dict) else []
        if not isinstance(models_raw, list):
            return []

        added: list[ModelRecord] = []
        for m in models_raw:
            if not isinstance(m, dict):
                continue
            model_name = str(m.get("name") or m.get("model") or "").strip()
            if not model_name:
                continue

            details = m.get("details") or {}
            param_size = str(details.get("parameter_size") or "").strip()
            quantization = str(details.get("quantization_level") or "").strip()
            size_bytes = int(m.get("size") or 0)

            # context_length: Ollama /api/tags doesn't expose it directly.
            # A separate /api/show call would give it, but that's one HTTP
            # round-trip per model — too expensive for bulk discovery.
            # Default 0; ModelRouter treats 0 as "unknown, not long-context".
            context_length = 0

            capabilities = _infer_capabilities(model_name, context_length)

            record_id = f"{endpoint_id}/{model_name}"
            record = ModelRecord(
                id=record_id,
                model_name=model_name,
                endpoint_id=endpoint_id,
                base_url=base_url.rstrip("/"),
                network_class=network_class,
                capabilities=capabilities,
                parameter_size=param_size,
                quantization=quantization,
                context_length=context_length,
                size_bytes=size_bytes,
                healthy=True,
                last_checked=time.monotonic(),
            )
            self._records[record_id] = record
            added.append(record)

        return added

    def register_manual(self, record: ModelRecord) -> None:
        """Register a model record from an operator manifest."""
        self._records[record.id] = record

    # ------------------------------------------------------------------
    # Health
    # ------------------------------------------------------------------

    def verify_health(self, record: ModelRecord,
                      timeout_s: float = 5.0) -> bool:
        """Probe the endpoint and update the record's health flag.

        Uses a minimal /api/tags call (Ollama) for local/private endpoints.
        Returns the health result.  Updates the record in-place.
        """
        url = record.base_url + "/api/tags"
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=timeout_s):
                pass
            record.healthy = True
            record.last_error = ""
            record.last_checked = time.monotonic()
            return True
        except Exception as exc:
            record.healthy = False
            record.last_error = str(exc)[:200]
            record.last_checked = time.monotonic()
            return False

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def query(self, required_caps: frozenset,
              network_classes: frozenset | None = None,
              healthy_only: bool = True) -> list[ModelRecord]:
        """Return records matching capability requirements.

        Args:
            required_caps: every tag must be present on returned records.
            network_classes: if given, restrict to these network classes.
            healthy_only: skip records known to be unhealthy.

        Results are ordered: healthy first, then by parameter size descending
        (larger models first as a proxy for capability when all else is equal).
        """
        results: list[ModelRecord] = []
        for rec in self._records.values():
            if healthy_only and rec.healthy is False:
                continue
            if network_classes is not None and rec.network_class not in network_classes:
                continue
            if not rec.matches(required_caps):
                continue
            results.append(rec)

        def _sort_key(r: ModelRecord):
            # Healthy confirmed > unchecked > unhealthy
            health_rank = 0 if r.healthy is True else (1 if r.healthy is None else 2)
            # Larger models first: parse "8B", "70B" etc.
            size_val = 0
            try:
                size_val = int("".join(c for c in r.parameter_size if c.isdigit()) or "0")
            except ValueError:
                pass
            return (health_rank, -size_val)

        results.sort(key=_sort_key)
        return results

    def get(self, record_id: str) -> ModelRecord | None:
        return self._records.get(record_id)

    def all_records(self) -> list[ModelRecord]:
        return list(self._records.values())

    def snapshot(self) -> dict:
        """Secret-free inventory snapshot for monitoring UI."""
        records = [r.to_dict() for r in self._records.values()]
        healthy = sum(1 for r in self._records.values() if r.healthy is True)
        return {
            "total": len(records),
            "healthy": healthy,
            "records": records,
        }
