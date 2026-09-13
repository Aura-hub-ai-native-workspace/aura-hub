"""Can AURA safely install this? Asked of the curated catalogue alone.

This is the narrow gate between "AURA has heard of some software" and
"AURA will offer to install it", and it is the whole reason discovery is
safe to expose. Everything a registry says — that a package exists, has
a repository, a README, a download link, even a declared executable — is
evidence about IDENTITY. None of it is authority to run an installer.

So the question is answered by looking the resolved identity up in the
curated in-repo catalogue and asking the EXISTING planner whether it can
produce a real, privilege-appropriate command on this machine. If the
catalogue does not know the software, or knows it but has no InstallSpec,
or the plan needs a privilege AURA does not have, the answer is no and
the record carries no install affordance at all.

Nothing here constructs a command. `plan_install` does that, from
`CatalogEntry.install`, exactly as it did before this module existed.
"""

from __future__ import annotations

from ..catalog import ALL, CatalogEntry
from ..install import InstallPlan, plan_install
from .identity import SoftwareRecord, SoftwareState, canonical_id

#: canonical id -> curated entry. Built once; the catalogue is static data.
_INDEX: dict[str, CatalogEntry] | None = None


def _index() -> dict[str, CatalogEntry]:
    global _INDEX
    if _INDEX is None:
        idx: dict[str, CatalogEntry] = {}
        for entry in ALL:
            for key in {canonical_id(entry.id), canonical_id(entry.name)}:
                idx.setdefault(key, entry)
        _INDEX = idx
    return _INDEX


def curated_entry(record_or_id: SoftwareRecord | str) -> CatalogEntry | None:
    """The curated entry for an identity, or None if AURA does not know it."""
    if isinstance(record_or_id, str):
        return _index().get(canonical_id(record_or_id))
    keys = [record_or_id.canonical_id]
    keys += [canonical_id(a) for a in record_or_id.aliases]
    keys += [canonical_id(e) for e in record_or_id.executables]
    for key in keys:
        found = _index().get(key)
        if found is not None:
            return found
    return None


def install_verdict(entry: CatalogEntry | None) -> tuple[bool, str]:
    """Whether the EXISTING planner can install this here, and why not.

    The reason string is the user-facing explanation for the missing
    button. "AURA will not guess" is a better answer than a dead control.
    """
    if entry is None:
        return False, (
            "AURA has no curated installation record for this software, so it "
            "will not offer to install it.")
    if entry.install is None:
        return False, (
            f"AURA knows {entry.name} but has no verified way to install it. "
            f"See {entry.homepage} for the project's own instructions.")
    plan = plan_install(entry)
    if isinstance(plan, InstallPlan) and plan.executable:
        return True, ""
    reason = getattr(plan, "reason", "") or (
        "This machine cannot run that installation without a privilege AURA "
        "does not have.")
    return False, reason


def apply_installability(record: SoftwareRecord) -> SoftwareRecord:
    """Attach curated identity and decide INSTALLABLE vs UNTRUSTED.

    Called AFTER machine state has been read, and deliberately does not
    lower a state the machine already proved: software that is installed
    is installed whether or not AURA could have installed it.
    """
    entry = curated_entry(record)
    if entry is not None:
        record.catalog_id = entry.id
        if not record.summary:
            record.summary = entry.summary
        if not record.homepage:
            record.homepage = entry.homepage
        if not record.category:
            record.category = entry.category
        record.add_alias(entry.name)

    # Machine truth outranks everything below it and is never overwritten.
    if record.state in (SoftwareState.INSTALLED, SoftwareState.VERIFIED,
                        SoftwareState.CONNECTED, SoftwareState.AURA_READY):
        return record

    ok, why = install_verdict(entry)
    if ok:
        record.state = SoftwareState.INSTALLABLE
        record.reason = ""
        return record

    # Known to the catalogue but not installable here vs merely described
    # by a registry: different words, because they are different facts.
    record.state = (SoftwareState.UNSUPPORTED if entry is not None
                    else SoftwareState.UNTRUSTED)
    record.reason = why
    return record
