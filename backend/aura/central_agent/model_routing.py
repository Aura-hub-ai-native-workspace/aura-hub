"""Model routing — provider-agnostic LLM access for the agent layer.

Design rules (mission §8):
- The Agent depends on ModelPort, never on a provider SDK.
- Provider SELECTION comes from an operator-written JSON file; API KEYS
  come only from the environment at call time and are never persisted,
  logged, or placed into session state.
- Health tracking is per-provider consecutive failures; a failing provider
  falls back down the configured chain until one answers or all fail
  (honest error, no fabricated output).
- Timeouts are hard; retries are capped.

Wire shape assumed: OpenAI-compatible POST {baseUrl}/chat/completions.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from .intent import ModelPort


@dataclass(frozen=True)
class ProviderSpec:
    """Operator-declared endpoint. NEVER carries secrets."""

    id: str
    base_url: str
    model: str
    api_key_env: str          # env var NAME; resolved fresh each call
    timeout_s: float = 30.0
    max_retries: int = 2
    max_context_chars: int = 24_000
    supports_json_mode: bool = True
    enabled: bool = True


@dataclass
class ProviderHealth:
    consecutive_failures: int = 0
    last_error: str | None = None
    calls: int = 0


def load_providers(path: str | None = None) -> list[ProviderSpec]:
    """Read the operator's provider file (~/.aura/agent/providers.json).

    Unknown fields are ignored; entries missing id/baseUrl/model/apiKeyEnv
    are skipped rather than guessed. An absent/empty file means NO model
    routing — the deterministic fallback remains the honest default.
    """
    from ..config import aura_path

    file = Path(path) if path else aura_path("agent", "providers.json")
    try:
        raw = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    entries = raw.get("providers") if isinstance(raw, dict) else raw
    out: list[ProviderSpec] = []
    for e in entries if isinstance(entries, list) else []:
        if not isinstance(e, dict):
            continue
        try:
            spec = ProviderSpec(
                id=str(e["id"]), base_url=str(e["baseUrl"]).rstrip("/"),
                model=str(e["model"]), api_key_env=str(e["apiKeyEnv"]),
                timeout_s=float(e.get("timeoutS", 30)),
                max_context_chars=int(e.get("maxContextChars", 24_000)),
                enabled=e.get("enabled", True) is not False)
        except (KeyError, TypeError, ValueError):
            continue
        out.append(spec)
    return [s for s in out if s.enabled]


class RoutingError(Exception):
    """All configured providers failed or none is configured."""


class RoutedModelPort(ModelPort):
    """ModelPort over a provider chain, tried in order."""

    def __init__(self, providers: list[ProviderSpec],
                 post=None) -> None:
        self.providers = providers
        self.health: dict[str, ProviderHealth] = {
            p.id: ProviderHealth() for p in providers}
        self._post = post or _http_post_json

    def complete_json(self, system: str, user: str) -> dict | None:
        last_error = "no providers configured"
        for spec in self.providers:
            health = self.health[spec.id]
            if health.consecutive_failures >= 5:
                continue  # circuit open; operator heals by fixing the cause
            key = os.environ.get(spec.api_key_env, "")
            if not key:
                health.last_error = f"env {spec.api_key_env} not set"
                continue
            payload = {
                "model": spec.model,
                "messages": [
                    {"role": "system", "content": system[:spec.max_context_chars]},
                    {"role": "user", "content": user[:spec.max_context_chars]},
                ],
                "temperature": 0,
            }
            headers = {"authorization": f"Bearer {key}",
                       "content-type": "application/json"}
            attempt = 0
            while attempt <= spec.max_retries:
                attempt += 1
                health.calls += 1
                try:
                    body = self._post(
                        f"{spec.base_url}/chat/completions",
                        payload, headers, spec.timeout_s)
                    content = (body["choices"][0]["message"]["content"] or "")
                    health.consecutive_failures = 0
                    match = _first_json_object(content)
                    return json.loads(match) if match else None
                except Exception as exc:
                    health.consecutive_failures += 1
                    health.last_error = str(exc)[:200]
                    last_error = f"{spec.id}: {str(exc)[:120]}"
                    if attempt > spec.max_retries:
                        break
                    time.sleep(min(2 ** attempt * 0.25, 2.0))
        raise RoutingError(f"model routing failed ({last_error})")


def _http_post_json(url: str, payload: dict, headers: dict,
                    timeout_s: float) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return json.loads(resp.read(8 * 1024 * 1024))


def _first_json_object(text: str) -> str | None:
    import re

    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fenced:
        return fenced.group(1)
    bare = re.search(r"\{.*\}", text, re.S)
    return bare.group(0) if bare else None

