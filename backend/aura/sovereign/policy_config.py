"""Validated operator configuration for model eligibility, cost and paid grants.

File: ``<AURA_HOME>/agent/model_policy.json`` (only read when present).
Absent file means: no endpoint is cloud-enabled, no endpoint has a declared cost,
no grant exists, and no capability is overridden. That is the default, and it
changes nothing about routing.

Schema (version 1). Unknown keys are errors, so a typo cannot silently
change a policy:

    {
      "schemaVersion": 1,
      "endpoints": {
        "<endpointId>": {
          "networkClass": "local" | "private" | "cloud",
          "cloudEnabled": true,                     // cloud only; default false
          "cost": "free" | "paid" | "unknown",      // default "unknown"
          "pricePer1kTokens": 0.002,                // required when cost is "paid"
          "capabilityOverrides": {"tool-calling": true}   // operator evidence
        }
      },
      "paidGrants": [
        {"endpointId": "<endpointId>", "modelName": "<model>", "spendCap": 5.0}
      ]
    }

Nothing here is inferred or defaulted to a price or a budget. A price the
operator did not write does not exist.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

from aura.sovereign.candidate_policy import EndpointPolicy, PaidGrant

SCHEMA_VERSION = 1
_NETWORK_CLASSES = frozenset({"local", "private", "cloud"})
_COST_VALUES = frozenset({"free", "paid", "unknown"})
_KNOWN_TAGS = frozenset({"text-generation", "code-generation", "json-mode", "vision",
                         "embedding", "tool-calling", "long-context"})
_TOP_KEYS = frozenset({"schemaVersion", "endpoints", "paidGrants"})
_ENDPOINT_KEYS = frozenset({"networkClass", "cloudEnabled", "cost", "pricePer1kTokens",
                            "capabilityOverrides"})
_GRANT_KEYS = frozenset({"endpointId", "modelName", "spendCap"})


class PolicyConfigError(ValueError):
    """The policy file is malformed or contradictory. The message names the location."""


@dataclass(frozen=True)
class ModelPolicy:
    endpoints: Mapping[str, EndpointPolicy] = field(default_factory=dict)
    grants: tuple = ()                                  # tuple[PaidGrant, ...]
    overrides: Mapping[str, Mapping[str, bool]] = field(default_factory=dict)

    @classmethod
    def empty(cls) -> "ModelPolicy":
        return cls()


def _fail(where: str, message: str):
    raise PolicyConfigError(f"{where}: {message}")


def _check_keys(obj: dict, allowed: frozenset, where: str) -> None:
    unknown = sorted(set(obj) - allowed)
    if unknown:
        _fail(where, f"unknown key(s) {unknown}; allowed: {sorted(allowed)}")


def _finite_positive(value, where: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(where, f"must be a number, got {type(value).__name__}")
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        _fail(where, "must be a finite number greater than zero")
    return number


def parse_model_policy(raw) -> ModelPolicy:
    """Validate a parsed JSON value. Raises PolicyConfigError with the failing location."""
    if not isinstance(raw, dict):
        _fail("model_policy", "top level must be a JSON object")
    _check_keys(raw, _TOP_KEYS, "model_policy")
    if raw.get("schemaVersion") != SCHEMA_VERSION:
        _fail("model_policy.schemaVersion", f"must be {SCHEMA_VERSION}")

    endpoints_raw = raw.get("endpoints", {})
    if not isinstance(endpoints_raw, dict):
        _fail("model_policy.endpoints", "must be an object keyed by endpoint id")
    endpoints: dict[str, EndpointPolicy] = {}
    overrides: dict[str, dict[str, bool]] = {}
    for endpoint_id, spec in endpoints_raw.items():
        where = f"model_policy.endpoints[{endpoint_id!r}]"
        if not isinstance(endpoint_id, str) or not endpoint_id.strip():
            _fail(where, "endpoint id must be a non-empty string")
        if not isinstance(spec, dict):
            _fail(where, "must be an object")
        _check_keys(spec, _ENDPOINT_KEYS, where)

        network = spec.get("networkClass")
        if network not in _NETWORK_CLASSES:
            _fail(f"{where}.networkClass", f"must be one of {sorted(_NETWORK_CLASSES)}")

        cloud_enabled = spec.get("cloudEnabled", False)
        if not isinstance(cloud_enabled, bool):
            _fail(f"{where}.cloudEnabled", "must be true or false")
        if cloud_enabled and network != "cloud":
            _fail(f"{where}.cloudEnabled",
                  "is set on a non-cloud endpoint; remove it or change networkClass")

        cost = spec.get("cost", "unknown")
        if cost not in _COST_VALUES:
            _fail(f"{where}.cost", f"must be one of {sorted(_COST_VALUES)}")
        price = spec.get("pricePer1kTokens")
        if cost == "paid":
            if price is None:
                _fail(f"{where}.pricePer1kTokens",
                      "required when cost is 'paid'; AURA never invents a price")
            price = _finite_positive(price, f"{where}.pricePer1kTokens")
        elif price is not None:
            _fail(f"{where}.pricePer1kTokens",
                  f"contradicts cost {cost!r}; a price is only valid for 'paid'")

        tags_raw = spec.get("capabilityOverrides", {})
        if not isinstance(tags_raw, dict):
            _fail(f"{where}.capabilityOverrides", "must be an object of tag -> true/false")
        tags: dict[str, bool] = {}
        for tag, value in tags_raw.items():
            if tag not in _KNOWN_TAGS:
                _fail(f"{where}.capabilityOverrides", f"unknown tag {tag!r}")
            if not isinstance(value, bool):
                _fail(f"{where}.capabilityOverrides[{tag!r}]", "must be true or false")
            tags[tag] = value
        if tags:
            overrides[endpoint_id] = tags

        endpoints[endpoint_id] = EndpointPolicy(
            endpoint_id=endpoint_id,
            network_class=network,
            cloud_enabled=cloud_enabled,
            declared_free=(cost == "free"),
            declared_paid=(cost == "paid"),
            price_per_1k_tokens=price,
        )

    grants_raw = raw.get("paidGrants", [])
    if not isinstance(grants_raw, list):
        _fail("model_policy.paidGrants", "must be a list")
    grants: list[PaidGrant] = []
    seen: set[tuple[str, str]] = set()
    for index, grant in enumerate(grants_raw):
        where = f"model_policy.paidGrants[{index}]"
        if not isinstance(grant, dict):
            _fail(where, "must be an object")
        _check_keys(grant, _GRANT_KEYS, where)
        endpoint_id = grant.get("endpointId")
        model_name = grant.get("modelName")
        if not isinstance(endpoint_id, str) or not endpoint_id.strip():
            _fail(f"{where}.endpointId", "must be a non-empty string")
        if not isinstance(model_name, str) or not model_name.strip():
            _fail(f"{where}.modelName", "must be a non-empty string; grants are exact-model")
        endpoint = endpoints.get(endpoint_id)
        if endpoint is None:
            _fail(where, f"endpoint {endpoint_id!r} is not declared under endpoints")
        if not endpoint.declared_paid:
            _fail(where, f"endpoint {endpoint_id!r} is not cost 'paid'; a grant is meaningless here")
        key = (endpoint_id, model_name)
        if key in seen:
            _fail(where, f"duplicate grant for {endpoint_id!r} / {model_name!r}")
        seen.add(key)
        cap = _finite_positive(grant.get("spendCap"), f"{where}.spendCap")
        grants.append(PaidGrant(endpoint_id=endpoint_id, model_name=model_name, spend_cap=cap,
                                granted_by="operator-config"))

    return ModelPolicy(endpoints=endpoints, grants=tuple(grants), overrides=overrides)


def default_policy_path() -> Path:
    from aura.config import aura_path
    return aura_path("agent", "model_policy.json")


def load_model_policy(path: str | Path | None = None) -> ModelPolicy:
    """Load the policy. A missing file yields the empty default. A malformed file raises.

    This is deliberately fail-closed, unlike the sovereign-mode loader. A broken
    cost or grant file must not silently revert to "no limits".
    """
    target = Path(path) if path is not None else default_policy_path()
    if not target.exists():
        return ModelPolicy.empty()
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise PolicyConfigError(f"{target}: cannot read or parse JSON: {exc}") from exc
    try:
        return parse_model_policy(raw)
    except PolicyConfigError as exc:
        raise PolicyConfigError(f"{target}: {exc}") from None
