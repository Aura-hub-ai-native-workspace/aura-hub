"""What models AURA can think with, measured — and what to suggest.

AURA's reasoning model (Laya, the planning model) is reached through the
provider routing in ``model_routing.py``: the operator's
``agent/providers.json`` is the only thing that enables a provider, and a
network class is never inferred from an address there. This module does
NOT change that. It reports, for the UI and the coordinator:

* ``laya`` — the providers actually configured, and whether any is usable;
* ``local`` — whether a local runtime (Ollama) is present and answering on
  this machine, and which models it already holds;
* ``recommendation`` — when no local model is available, a suggestion to
  install a small one, after checking the runtime, free disk and RAM.

Nothing here downloads, installs, or enables anything. A local model is an
optional enhancement: with none, AURA keeps working through Laya and web
research, and says so.
"""

from __future__ import annotations

import json
import os
import shutil
import urllib.request
from pathlib import Path
from typing import Any, Callable

#: The recommended small coding/classification model, its approximate
#: download size (Q4_K_M, as published), and the headroom we require
#: before calling a machine compatible.
RECOMMENDED_MODEL = "qwen3.5:2b"
RECOMMENDED_DOWNLOAD_MB = 2700
MIN_FREE_DISK_GB = 3.0
MIN_RAM_GB = 4.0

#: The loopback address Ollama listens on by default. Probing it only
#: *detects* a runtime; using it for routing still requires an explicit
#: entry in agent/providers.json.
LOCAL_RUNTIME_URL = "http://127.0.0.1:11434"


def _http_json(url: str, timeout: float) -> dict | None:
    try:
        req = urllib.request.Request(url, headers={"accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 — loopback only
            data = json.loads(res.read(512 * 1024).decode("utf-8", "replace"))
        return data if isinstance(data, dict) else None
    except Exception:  # noqa: BLE001 — "not answering" is the finding
        return None


def _ram_gb() -> float | None:
    try:
        with open("/proc/meminfo", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("MemTotal:"):
                    return round(int(line.split()[1]) / 1024 / 1024, 1)
    except OSError:
        pass
    try:
        return round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3, 1)
    except (ValueError, OSError, AttributeError):
        return None


def _free_disk_gb(path: str) -> float | None:
    try:
        return round(shutil.disk_usage(path).free / 1024**3, 1)
    except OSError:
        return None


def detect_local_runtime(*, probe: Callable[[str, float], dict | None] = _http_json,
                         which: Callable[[str], str | None] = shutil.which,
                         timeout: float = 1.5) -> dict:
    """Is a local model runtime here, running, and holding models?"""
    tags = probe(f"{LOCAL_RUNTIME_URL}/api/tags", timeout)
    installed = bool(which("ollama"))
    if tags is None:
        return {"runtime": "ollama", "installed": installed, "running": False,
                "models": [], "state": "installed-not-running" if installed else "not-installed"}
    models = []
    for m in (tags.get("models") or []):
        if not isinstance(m, dict) or not m.get("name"):
            continue
        models.append({"name": str(m["name"]),
                       "sizeMB": round(int(m.get("size") or 0) / 1024 / 1024),
                       "parameters": str((m.get("details") or {}).get("parameter_size") or ""),
                       "embeddingOnly": "embed" in str(m["name"]).lower()})
    return {"runtime": "ollama", "installed": True, "running": True,
            "models": models, "state": "ready" if models else "running-no-models"}


def recommend_local_model(local: dict, *, models_dir: str | None = None,
                          ram_gb: float | None = None,
                          free_gb: float | None = None) -> dict | None:
    """A suggestion to install a small local model, or None when one is
    already there. It states what was checked and never starts a download."""
    usable = [m for m in local.get("models", []) if not m.get("embeddingOnly")]
    if usable:
        return None
    ram = ram_gb if ram_gb is not None else _ram_gb()
    disk = free_gb if free_gb is not None else _free_disk_gb(models_dir or str(Path.home()))
    problems: list[str] = []
    if not local.get("installed"):
        problems.append("No local runtime (Ollama) was found on this machine.")
    if ram is not None and ram < MIN_RAM_GB:
        problems.append(f"This machine has {ram} GB of RAM; a small model wants at least {MIN_RAM_GB:g} GB.")
    if disk is not None and disk < MIN_FREE_DISK_GB:
        problems.append(f"Only {disk} GB of disk is free; about {MIN_FREE_DISK_GB:g} GB is needed.")
    compatible = not problems
    rec: dict[str, Any] = {
        "model": RECOMMENDED_MODEL,
        "approxDownloadMB": RECOMMENDED_DOWNLOAD_MB,
        "ramGB": ram, "freeDiskGB": disk,
        "compatible": compatible,
        "required": False,
        "benefit": ("A small model on this machine can handle lightweight coding help, intent "
                    "classification and compressing context quickly, offline, and without "
                    "sending your text anywhere."),
        "limitations": ("It is small: it can be slow on a CPU-only machine, and it is weaker at "
                        "complex reasoning than Laya. It does not search the web (research is a "
                        "separate step) and is not a source of current facts."),
        "note": "Optional. AURA works fully without it, using Laya and web research.",
        "problems": problems,
    }
    if compatible:
        rec["command"] = f"ollama pull {RECOMMENDED_MODEL}"
        rec["thenConfigure"] = ("Then add it to ~/.aura/agent/providers.json as a local provider "
                                "so AURA may route to it.")
    return rec


PROBE_TIMEOUT_S = 2.0


def safe_base_url(url: str) -> str:
    """The address without credentials, query or fragment — safe to show and log."""
    from urllib.parse import urlsplit

    try:
        u = urlsplit(url)
        host = u.hostname or ""
        port = f":{u.port}" if u.port else ""
        return f"{u.scheme}://{host}{port}{u.path}".rstrip("/")
    except ValueError:
        return ""


def probe_provider(provider: dict, *, timeout_s: float = PROBE_TIMEOUT_S, fetch=None) -> dict:
    """Can this provider really be called right now? Bounded, read-only, no inference.

    Only keyless providers are probed (a request to a keyed cloud service would
    spend a key and leak a hostname for a status page); those are ``unchecked``.
    Asks the OpenAI-compatible ``/models`` list and checks the configured model
    is in it, so "configured" cannot mean "a file says so".
    """
    import json as _json
    import urllib.request

    base = str(provider.get("baseUrl") or "")
    if not base or not provider.get("keyless", False):
        return {"state": "unchecked", "reachable": None, "modelAvailable": None, "detail": "not probed"}
    try:
        if fetch is not None:
            body = fetch(f"{base}/models", timeout_s)
        else:
            with urllib.request.urlopen(f"{base}/models", timeout=timeout_s) as resp:
                body = _json.loads(resp.read(2 * 1024 * 1024))
    except Exception as exc:  # noqa: BLE001 — any failure is "unreachable", with its type
        return {"state": "unreachable", "reachable": False, "modelAvailable": None,
                "detail": f"{type(exc).__name__}"}
    ids = {str(m.get("id")) for m in (body.get("data") or []) if isinstance(m, dict)} if isinstance(body, dict) else set()
    wanted = str(provider.get("model") or "")
    if wanted and ids and wanted not in ids:
        return {"state": "model-missing", "reachable": True, "modelAvailable": False,
                "detail": f"the server does not list {wanted}"}
    return {"state": "ready", "reachable": True, "modelAvailable": True if ids else None, "detail": ""}


def model_status(providers: list[dict], *, local: dict | None = None,
                 recommendation: Callable[[dict], dict | None] = recommend_local_model,
                 probe: Callable[[dict], dict] = probe_provider,
                 settings: dict | None = None) -> dict:
    """The combined picture. ``providers`` come from the live model port.

    ``configured`` means a provider is set up; ``usable`` means one of them
    answered a bounded, read-only probe (or is a keyed service that is not
    probed) and its circuit is not open. A provider that is set up but cannot be
    reached is configured and NOT usable, and says why.
    """
    local = local if local is not None else detect_local_runtime()
    probed = []
    for p in providers:
        info = probe(p) if p.get("enabled", True) else {"state": "disabled", "reachable": None, "modelAvailable": None, "detail": ""}
        last = p.get("lastRequest")
        # Five separate facts, so none is mistaken for another: a model is only
        # "answering" once a real request succeeded, whatever the config says.
        stages = {
            "configured": True,
            "credentials": p.get("credentials", "unknown"),
            "reachable": info.get("reachable"),
            "modelAvailable": info.get("modelAvailable"),
            "lastRequest": (None if not last else ("succeeded" if last.get("ok") else "failed")),
        }
        probed.append({**p, "check": info, "stages": stages})
    configured_local = [p for p in probed if p.get("networkClass") == "local" and p.get("enabled", True)]
    healthy = [p for p in probed if p.get("enabled", True) and p.get("circuit", "closed") != "open"
               and p["check"]["state"] in ("ready", "unchecked")]
    rec = recommendation(local)
    usable_models = [m for m in local.get("models", []) if not m.get("embeddingOnly")]
    if rec is None and usable_models and not configured_local:
        rec = {"model": usable_models[0]["name"], "needsConfiguration": True, "required": False,
               "note": ("A local model is already installed but AURA is not set up to use it. Select it "
                        "in Settings (or list it in ~/.aura/agent/providers.json) to let AURA route to it.")}
    settings = settings or {}
    if probed:
        bad = [p for p in probed if p["check"]["state"] in ("unreachable", "model-missing")]
        note = ""
        if not healthy and bad:
            note = ("A model is configured but AURA cannot use it right now: "
                    + "; ".join(f"{p['id']} — {p['check']['state'].replace('-', ' ')}"
                                + (f" ({p['check']['detail']})" if p["check"].get("detail") else "")
                                for p in bad) + ".")
    elif settings.get("configured") and not settings.get("callable"):
        note = ("A provider is selected in Settings, but the Central Agent cannot call it: "
                + str(settings.get("reason") or "unknown reason")
                + ". Self-hosted providers (Ollama) are shared automatically; a provider that needs an "
                  "API key must be listed by you in ~/.aura/agent/providers.json with apiKeyEnv.")
    else:
        note = "No reasoning model is configured; chat answers are limited to what AURA can say without one."
    return {
        "laya": {"configured": bool(probed), "usable": bool(healthy),
                 "providers": probed, "note": note, "settings": settings},
        "local": {**local, "configured": bool(configured_local)},
        "recommendation": rec,
    }


__all__ = ["RECOMMENDED_MODEL", "detect_local_runtime", "model_status", "probe_provider", "recommend_local_model", "safe_base_url"]
