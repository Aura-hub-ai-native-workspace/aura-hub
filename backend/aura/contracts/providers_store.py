"""ProvidersStore — schema/providers-store.schema.json (credentialStore.ts:5-37).

Crypto envelope frozen: aes-256-gcm, key = sha256(seed + ':aura-provider-v2'),
seed from env AURA_PROVIDER_SECRET or store.secret (random 32B hex, once).
Python MUST read existing stores byte-compatibly at Phase 9 — this model only
freezes the envelope shape; values stay opaque hex here.
"""

from __future__ import annotations

from pydantic import Field

from ._base import ContractModel


class ProviderCredential(ContractModel):
    encryptedKey: str  # hex ciphertext
    iv: str            # hex, 16 random bytes
    tag: str           # hex GCM auth tag
    fingerprint: str   # display fingerprint only


class ProvidersStore(ContractModel):
    credentials: dict[str, ProviderCredential]
    models: dict
    health: dict
    active: str | None = None
    activeModel: str = ""
    secret: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
