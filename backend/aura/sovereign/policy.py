"""Sovereign policy — application-level enforcement of private-only AI inference.

IMPORTANT DISTINCTION (requirement §3):
  APPLICATION ENFORCED SOVEREIGN MODE  ← this module implements this
  PHYSICALLY AIR-GAPPED DEPLOYMENT      ← this is an infrastructure concern

This module implements the former: software policy that actively blocks
outbound calls to cloud LLM APIs at the RoutedModelPort layer. It does NOT
claim to physically prevent network access. Operators who need a physical
air-gap must enforce it at the network/OS level independently.

Config file: ~/.aura/sovereign.json
Schema:
  {
    "sovereignMode": true,           // block cloud providers
    "allowedNetworkClasses": ["local", "private"],  // optional override
    "enforcedAt": "2026-09-23T00:00:00Z"  // audit timestamp
  }

When sovereign_mode is True:
  - "local" and "private" network classes are allowed
  - "cloud" and "unknown" are blocked
  - RoutedModelPort raises RoutingError with PROVIDER_NOT_CONFIGURED
    rather than silently routing to the internet

Precedence: environment variable AURA_SOVEREIGN_MODE=1 overrides the file.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import FrozenSet


_DEFAULT_ALLOWED: FrozenSet[str] = frozenset({"local", "private"})
_ALL_CLASSES: FrozenSet[str] = frozenset({"local", "private", "cloud", "unknown"})


@dataclass(frozen=True)
class SovereignPolicy:
    """Immutable policy snapshot.

    sovereign_mode=True  → only network classes in allowed_classes pass.
    sovereign_mode=False → all network classes pass (no restriction).

    Never mutate at runtime: load once at startup, replace the whole
    object when the operator updates the config file.
    """

    sovereign_mode: bool = False
    allowed_classes: FrozenSet[str] = field(
        default_factory=lambda: frozenset(_DEFAULT_ALLOWED))
    source: str = "default"   # "file", "env", or "default" — for telemetry

    def allows(self, network_class: str) -> bool:
        """True if this network class is permitted under the current policy.

        When sovereign_mode is False every class is permitted.
        When sovereign_mode is True only classes in allowed_classes pass.
        """
        if not self.sovereign_mode:
            return True
        return network_class in self.allowed_classes

    def describe(self) -> dict:
        """Secret-free policy snapshot for telemetry/UI."""
        return {
            "sovereignMode": self.sovereign_mode,
            "allowedNetworkClasses": sorted(self.allowed_classes),
            "source": self.source,
            "note": (
                "APPLICATION ENFORCED SOVEREIGN MODE — software policy only."
                " Physical air-gap requires separate infrastructure controls."
            ) if self.sovereign_mode else "unrestricted",
        }


def load_sovereign_policy(path: str | None = None) -> SovereignPolicy:
    """Load policy from ~/.aura/sovereign.json (or the supplied path).

    Precedence (highest first):
      1. AURA_SOVEREIGN_MODE env var ("1"/"true" enables sovereign mode)
      2. Config file sovereignMode field
      3. Default: sovereign_mode=False (unrestricted)

    Missing file → unrestricted (policy defaults to False, not an error).
    Malformed file → unrestricted + warning to stderr (fail-open for policy
    load failures, fail-closed for sovereign blocking during inference).
    """
    # Env var overrides everything.
    env_val = os.environ.get("AURA_SOVEREIGN_MODE", "").strip().lower()
    env_override: bool | None = None
    if env_val in ("1", "true", "yes", "on"):
        env_override = True
    elif env_val in ("0", "false", "no", "off"):
        env_override = False

    if path is None:
        from ..config import aura_path
        config_file = aura_path("sovereign.json")
    else:
        config_file = Path(path)

    raw: dict = {}
    source = "default"
    try:
        if config_file.exists():
            raw = json.loads(config_file.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raw = {}
                import sys
                print(
                    f"[aura.sovereign] WARNING: {config_file} is not a JSON"
                    " object — using defaults",
                    file=sys.stderr)
            else:
                source = "file"
    except (OSError, json.JSONDecodeError) as exc:
        import sys
        print(
            f"[aura.sovereign] WARNING: could not read {config_file}: {exc}"
            " — using defaults",
            file=sys.stderr)

    file_sovereign = bool(raw.get("sovereignMode", False))
    sovereign_mode = (
        env_override if env_override is not None else file_sovereign)
    if env_override is not None:
        source = "env"

    # allowed_classes: explicit list or default (local + private).
    raw_classes = raw.get("allowedNetworkClasses")
    if isinstance(raw_classes, list):
        allowed = frozenset(
            c for c in (str(x).lower() for x in raw_classes)
            if c in _ALL_CLASSES)
        if not allowed:
            # Guard: empty allowed set with sovereign mode ON means nothing
            # works. Fall back to default rather than hard-locking.
            allowed = _DEFAULT_ALLOWED
    else:
        allowed = _DEFAULT_ALLOWED

    return SovereignPolicy(
        sovereign_mode=sovereign_mode,
        allowed_classes=allowed,
        source=source,
    )


def write_sovereign_config(
        sovereign_mode: bool,
        allowed_classes: list[str] | None = None,
        path: str | None = None) -> Path:
    """Persist a sovereign config file.

    Used by the Settings UI when the operator toggles Sovereign Mode.
    Writes atomically (temp file + rename) to avoid partial writes.
    Returns the path written.
    """
    from ..config import aura_path
    target = Path(path) if path else aura_path("sovereign.json")
    target.parent.mkdir(parents=True, exist_ok=True)

    if allowed_classes is None:
        allowed_classes = sorted(_DEFAULT_ALLOWED)
    allowed_classes = [
        c for c in (str(x).lower() for x in allowed_classes)
        if c in _ALL_CLASSES] or sorted(_DEFAULT_ALLOWED)

    payload = {
        "sovereignMode": sovereign_mode,
        "allowedNetworkClasses": allowed_classes,
        "enforcedAt": datetime.now(timezone.utc).isoformat(),
        "_note": (
            "APPLICATION ENFORCED SOVEREIGN MODE. "
            "This file controls software-level policy only. "
            "Physical air-gap isolation requires separate "
            "infrastructure controls independent of AURA."
        ),
    }
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(target)
    return target
