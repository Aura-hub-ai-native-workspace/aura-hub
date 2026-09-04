"""SecretStore — port of ai-service/src/secrets.ts (264 lines).

Named values a workflow may USE but never SEE.
  • definitions hold {{secret:NAME}} references only
  • resolution is one-way, terminal, at the Fabric boundary
  • redaction is proven (visible marker), deterministic, longest-first
  • missing references fail LOUDLY (never the literal reference)
  • wrong seed / tampered file fails the GCM tag -> treated as missing

Crypto parity with the TypeScript oracle: aes-256-gcm, key =
sha256(seed + ':aura-workflow-secrets-v1'), seed from env
AURA_SECRET_SEED or a generated 32-byte hex stored beside the ciphertext.
"""
from __future__ import annotations

import hashlib
import os
import re
from datetime import datetime, timezone
from typing import Any

from ..config import aura_path
from ..jsonutil import read_json_file, write_json_file

ALGORITHM = "aes-256-gcm"
REDACTION = "••••"
REFERENCE = re.compile(r"\{\{\s*secret:([A-Za-z0-9_.-]{1,64})\s*\}\}")
NAME_OK = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
KDF_INFO = ":aura-workflow-secrets-v1"

_MISSING = object()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class SecretStore:
    def __init__(self, home: str | None = None) -> None:
        self._home = home

    # paths -------------------------------------------------------------------

    def _file(self):
        from pathlib import Path

        if self._home:
            return Path(self._home) / "secrets.json"
        return aura_path("secrets.json")

    # file --------------------------------------------------------------------

    def load(self) -> dict:
        raw = read_json_file(self._file(), {"secrets": {}})
        return {
            "seed": raw.get("seed"),
            "secrets": raw.get("secrets") if isinstance(raw.get("secrets"), dict) else {},
        }

    def save(self, file: dict) -> None:
        # TS parity: JSON.stringify DROPS undefined seed; we must too,
        # otherwise an explicit null defeats later seedless derivation.
        payload = {"secrets": file.get("secrets") or {}}
        if file.get("seed"):
            payload = {"seed": file["seed"], **payload}
        write_json_file(self._file(), payload)

    # key ---------------------------------------------------------------------

    def _env_seed(self) -> str | None:
        return os.environ.get("AURA_SECRET_SEED")

    def derive_key(self) -> bytes:
        env = self._env_seed()
        if env:
            return hashlib.sha256(f"{env}{KDF_INFO}".encode()).digest()
        file = self.load()
        seed = file.get("seed")
        if not seed:
            seed = os.urandom(32).hex()
            file["seed"] = seed
            self.save(file)
        return hashlib.sha256(f"{seed}{KDF_INFO}".encode()).digest()

    # CRUD ----------------------------------------------------------------------

    def list(self) -> list[dict]:
        secs = self.load()["secrets"]
        out = [
            {"name": n, "createdAt": s.get("createdAt"), "updatedAt": s.get("updatedAt"),
             "lastUsedAt": s.get("lastUsedAt"), "length": s.get("length"),
             **({"note": s["note"]} if s.get("note") is not None else {})}
            for n, s in secs.items()
        ]

        return sorted(out, key=lambda x: x["name"]) if False else sorted(
            out, key=lambda x: x["name"].lower()) if False else _locale_sorted(out)

    def has(self, name: str) -> bool:
        return bool(self.load()["secrets"].get(name))

    def set(self, name: str, value: str, note: str | None = None) -> dict:
        if not NAME_OK.match(name or ""):
            raise RuntimeError(
                "A secret name may only contain letters, numbers, dot, dash and underscore.")
        if not value:
            raise RuntimeError("A secret needs a value.")
        key = self.derive_key()
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        iv = os.urandom(16)
        sealed = AESGCM(key).encrypt(iv, value.encode("utf-8"), None)
        encrypted, tag = sealed[:-16].hex(), sealed[-16:].hex()
        file = self.load()
        now = _now_iso()
        existing = file["secrets"].get(name)
        file["secrets"][name] = {
            "encrypted": encrypted,
            "iv": iv.hex(),
            "tag": tag,
            "createdAt": (existing or {}).get("createdAt") or now,
            "updatedAt": now,
            "lastUsedAt": (existing or {}).get("lastUsedAt"),
            "length": len(value),
            "note": note if note is not None else (existing or {}).get("note"),
        }
        self.save(file)
        s = file["secrets"][name]
        out = {"name": name, "createdAt": s["createdAt"], "updatedAt": s["updatedAt"],
               "lastUsedAt": s["lastUsedAt"], "length": s["length"]}
        if s.get("note") is not None:
            out["note"] = s["note"]
        return out

    def remove(self, name: str) -> bool:
        file = self.load()
        if not file["secrets"].get(name):
            return False
        del file["secrets"][name]
        self.save(file)
        return True

    # reveal (private by convention) ---------------------------------------------

    def _reveal(self, name: str) -> str | None:
        s = self.load()["secrets"].get(name)
        if not s:
            return None
        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM

            key = self.derive_key()
            sealed = bytes.fromhex(s["encrypted"]) + bytes.fromhex(s["tag"])
            pt = AESGCM(key).decrypt(bytes.fromhex(s["iv"]), sealed, None)
            return pt.decode("utf-8")
        except Exception:  # InvalidTag, ValueError, KeyError — all mean unusable
            return None

    def _touch(self, names: list[str]) -> None:
        if not names:
            return
        file = self.load()
        now = _now_iso()
        changed = False
        for n in names:
            if n in file["secrets"]:
                file["secrets"][n]["lastUsedAt"] = now
                changed = True
        if changed:
            self.save(file)

    # references ---------------------------------------------------------------

    @staticmethod
    def references_in(text: str) -> list[str]:
        seen: dict[str, None] = {}
        for m in REFERENCE.finditer(text or ""):
            seen[m.group(1)] = None
        return list(seen)

    def references_in_configs(self, configs: list[Any]) -> list[str]:
        seen: dict[str, None] = {}
        for config in configs or []:
            for value in (config or {}).values() if isinstance(config, dict) else []:
                if isinstance(value, str):
                    for n in self.references_in(value):
                        seen[n] = None
        return sorted(seen.keys())

    # resolution (terminal) -------------------------------------------------------

    def resolve(self, text: str) -> dict:
        used: list[str] = []
        missing: list[str] = []

        def repl(m: re.Match) -> str:
            name = m.group(1)
            value = self._reveal(name)
            if value is None:
                missing.append(name)
                return ""
            used.append(name)
            return value

        resolved = REFERENCE.sub(repl, text or "")
        if missing:
            noun = "a secret" if len(missing) == 1 else "secrets"
            verb = "is" if len(missing) == 1 else "are"
            pron = "it" if len(missing) == 1 else "them"
            raise RuntimeError(
                f"This node references {noun} that {verb} not stored: {', '.join(missing)}. "
                f"Add {pron} in Settings → Secrets and run again.")
        self._touch(used)
        return {"text": resolved, "used": used}

    # redaction -----------------------------------------------------------------

    def known_values(self) -> list[str]:
        vals = []
        for name in self.load()["secrets"]:
            v = self._reveal(name)
            if v and len(v) >= 4:
                vals.append(v)
        return vals

    def redactor(self, names: list[str] | None = None):
        wanted = names if names is not None else list(self.load()["secrets"].keys())
        values: list[str] = []
        for name in wanted:
            v = self._reveal(name)
            if v and len(v) >= 4:
                values.append(v)
        if not values:
            return lambda text: text
        values.sort(key=len, reverse=True)

        def scrub(text: str) -> str:
            out = text
            for v in values:
                out = out.replace(v, REDACTION)
            return out
        return scrub


def _locale_sorted(items: list[dict]):
    # names are ASCII-restricted by NAME_OK → code-point sort matches
    return sorted(items, key=lambda x: x["name"])
