"""Startup discovery of sovereign model endpoints, driven by the provider file.

Reads ``agent/providers.json`` through the same file reader the planner uses, and
discovers models only from endpoints the operator has explicitly configured for a
sovereign network class. Reading a configuration never authorises anything beyond that:
an endpoint must be enabled, must declare its network class, and must declare a class
the sovereign router may draw from. A network class is never inferred from the address
here, so an undeclared endpoint is not contacted.

Diagnostics carry the endpoint id and a stable reason code only. They never carry a
base URL, a header, a key name, or the text of a provider error.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

#: Classes discovery may draw from. Mirrors the router's sovereign set.
DISCOVERY_CLASSES = frozenset({"local", "private"})
#: Every spelling of network class the provider file may use.
_KNOWN_CLASSES = frozenset({"local", "private", "cloud", "unknown"})


@dataclass(frozen=True)
class EndpointDiscovery:
    endpoint_id: str
    outcome: str        # discovered | skipped | failed | no-models-reported
    reason: str = ""    # a stable code, never an address or message text
    models_found: int = 0


@dataclass
class DiscoveryReport:
    file_status: str                       # ok | missing | malformed | unreadable
    file_detail: str = ""
    endpoints: list[EndpointDiscovery] = field(default_factory=list)

    @property
    def discovered(self) -> list[str]:
        return [e.endpoint_id for e in self.endpoints if e.outcome == "discovered"]

    def to_dict(self) -> dict:
        return {
            "fileStatus": self.file_status,
            "fileDetail": self.file_detail,
            "endpoints": [
                {"endpointId": e.endpoint_id, "outcome": e.outcome, "reason": e.reason,
                 "modelsFound": e.models_found}
                for e in self.endpoints],
        }


def _skip(report: DiscoveryReport, endpoint_id: str, reason: str) -> None:
    report.endpoints.append(EndpointDiscovery(endpoint_id, "skipped", reason))


def discover_configured_endpoints(registry, *, path: str | Path | None = None,
                                  timeout_s: float = 5.0) -> DiscoveryReport:
    """Discover models from every configured, authorised sovereign endpoint.

    A missing, malformed or unreadable file is reported in ``file_status``, and the
    registry is left untouched. Nothing here raises for a bad configuration.
    """
    from ..agent_runtime.model_metadata import ollama_server_root
    from ..central_agent.model_routing import PROVIDER_FILE_OK, read_provider_document

    document = read_provider_document(path)
    report = DiscoveryReport(file_status=document.status, file_detail=document.detail)
    if document.status != PROVIDER_FILE_OK:
        return report

    seen: set[str] = set()
    for entry in document.entries:
        raw_id = entry.get("id")
        endpoint_id = raw_id.strip() if isinstance(raw_id, str) else ""
        if not endpoint_id:
            _skip(report, "<unnamed>", "missing-id")
            continue
        if endpoint_id in seen:
            _skip(report, endpoint_id, "duplicate-id")
            continue
        seen.add(endpoint_id)
        if entry.get("enabled", True) is False:
            _skip(report, endpoint_id, "disabled")
            continue
        base = entry.get("baseUrl")
        if not isinstance(base, str) or not base.strip():
            _skip(report, endpoint_id, "missing-base-url")
            continue
        if ollama_server_root(base) is None:
            _skip(report, endpoint_id, "base-url-unsupported")
            continue
        declared = entry.get("networkClass")
        if declared is None or (isinstance(declared, str) and not declared.strip()):
            _skip(report, endpoint_id, "network-class-not-declared")
            continue
        network = str(declared).strip().lower()
        if network not in _KNOWN_CLASSES:
            _skip(report, endpoint_id, "network-class-invalid")
            continue
        if network not in DISCOVERY_CLASSES:
            _skip(report, endpoint_id, "network-class-not-sovereign")
            continue

        try:
            found = registry.discover_from_ollama(
                endpoint_id=endpoint_id, base_url=base.strip().rstrip("/"),
                network_class=network, timeout_s=timeout_s)
        except Exception as exc:  # noqa: BLE001 — reported by type name only
            report.endpoints.append(EndpointDiscovery(
                endpoint_id, "failed", f"discovery-error:{type(exc).__name__}"))
            continue
        if found:
            report.endpoints.append(EndpointDiscovery(
                endpoint_id, "discovered", "", models_found=len(found)))
        else:
            report.endpoints.append(EndpointDiscovery(
                endpoint_id, "no-models-reported", "endpoint answered no model list, or was unreachable"))
    return report
