"""AURA Everything: discovery describes software; the catalogue authorises installs.

The security claim under test is one sentence: nothing a registry returns
can make AURA offer to install anything. Everything else here — identity
folding, tool/library classification, cache separation, the state ladder —
exists to keep that sentence true while still being useful to a person who
found a tool on the internet.

No test here touches the network: sources are exercised through injected
payloads, so the suite is deterministic and says nothing about whether
npm happened to be reachable.
"""

import json

import pytest

from aura.environment.software import cache
from aura.environment.software.classify import classify
from aura.environment.software.identity import (
    Provenance,
    SoftwareKind,
    SoftwareRecord,
    SoftwareState,
    Trust,
    canonical_id,
    highest,
    rank,
)
from aura.environment.software.installability import (
    apply_installability,
    curated_entry,
    install_verdict,
)
from aura.environment.software.sources.npm import NpmSource, _bin_names
from aura.environment.software.sources.pypi import PyPISource, _entry_point_commands


@pytest.fixture(autouse=True)
def _no_machine_scan(monkeypatch):
    """Keep this suite off the real machine.

    `resolve.search` reads the machine inventory, and `get_inventory`
    COLLECTS one on a cache miss — a full scan of the host. In a test
    process that cache is usually cold, so without this every resolver
    test would probe the developer's machine and take minutes. The
    inventory path itself is covered by the inventory suite; what these
    tests are about is resolution, so the machine is stubbed out.
    """
    from aura.environment.software import resolve

    class _Empty:
        items: list = []

    monkeypatch.setattr(resolve, "get_inventory", lambda **kw: _Empty())


# ── 1 & 2: a package can be discovered from each registry ────────────

NPM_SEARCH = {"objects": [{"package": {
    "name": "prettier", "version": "3.9.6",
    "description": "Prettier is an opinionated code formatter",
    "keywords": ["formatter"],
    "links": {"homepage": "https://prettier.io",
              "repository": "https://github.com/prettier/prettier"},
}}]}


def test_npm_package_is_discovered(monkeypatch):
    monkeypatch.setattr("aura.environment.software.sources.npm.fetch_json",
                        lambda url, **kw: NPM_SEARCH if "/-/v1/search" in url
                        else {"bin": {"prettier": "bin/prettier.cjs"}})
    out = NpmSource().search("prettier")
    assert len(out.records) == 1
    rec = out.records[0]
    assert rec.display_name == "prettier"
    assert rec.provenance[0].source == "npm"
    assert rec.provenance[0].trust is Trust.REGISTRY
    # The declared command is captured as classification evidence.
    assert rec.executables == ["prettier"]


PYPI_PROJECT = {"info": {
    "name": "httpie", "version": "3.2.4",
    "summary": "HTTPie: modern, user-friendly command-line HTTP client",
    "classifiers": ["Environment :: Console"],
    "keywords": "http,cli",
    "entry_points": "[console_scripts]\nhttp = httpie.__main__:main\n",
}}


def test_pypi_project_is_discovered(monkeypatch):
    monkeypatch.setattr("aura.environment.software.sources.pypi.fetch_json",
                        lambda url, **kw: PYPI_PROJECT)
    out = PyPISource().search("httpie")
    assert len(out.records) == 1
    assert out.records[0].display_name == "httpie"
    assert "http" in out.records[0].executables


def test_unreachable_source_is_reported_not_treated_as_absent(monkeypatch):
    """Offline must never read as "this software does not exist"."""
    monkeypatch.setattr("aura.environment.software.sources.npm.fetch_json",
                        lambda url, **kw: None)
    out = NpmSource().search("anything")
    assert out.unreachable is True and out.records == []


def test_malformed_registry_payload_is_skipped_not_fatal(monkeypatch):
    monkeypatch.setattr("aura.environment.software.sources.npm.fetch_json",
                        lambda url, **kw: {"objects": [{"package": None},
                                                       {"nope": 1}, "junk"]})
    assert NpmSource().search("x").records == []


def test_registry_name_is_validated_before_use(monkeypatch):
    """A hostile name never reaches a URL or a record."""
    monkeypatch.setattr("aura.environment.software.sources.npm.fetch_json",
                        lambda url, **kw: {"objects": [{"package": {
                            "name": "../../etc/passwd", "version": "1"}}]})
    assert NpmSource().search("x").records == []


def test_plaintext_transport_is_refused():
    from aura.environment.software.sources.base import fetch_json
    assert fetch_json("http://registry.npmjs.org/x") is None


# ── 3: tool vs library classification ────────────────────────────────

@pytest.mark.parametrize("name,summary,classifiers,execs,expected", [
    ("prettier", "opinionated code formatter", [], ["prettier"], SoftwareKind.CLI_TOOL),
    ("lodash", "Lodash modular utilities", [], [], SoftwareKind.LIBRARY),
    ("@types/node", "TypeScript definitions for Node.js", [], [], SoftwareKind.LIBRARY),
    ("requests", "Python HTTP for humans",
     ["Topic :: Software Development :: Libraries :: Python Modules"], [], SoftwareKind.LIBRARY),
    ("opencode", "AI coding agent for the terminal", [], ["opencode"], SoftwareKind.WORKER),
    ("postgres", "database server", [], ["postgres"], SoftwareKind.SERVICE),
])
def test_classification(name, summary, classifiers, execs, expected):
    assert classify(name=name, summary=summary,
                    classifiers=classifiers, executables=execs) is expected


def test_library_shipping_a_helper_command_is_still_a_library():
    """A bin entry is strong evidence, but an explicit library classifier
    outranks it — otherwise half of PyPI becomes a "tool"."""
    assert classify(
        name="somelib", summary="helper library",
        classifiers=["Topic :: Software Development :: Libraries"],
        executables=[]) is SoftwareKind.LIBRARY


# ── 4: duplicate identities resolve to one canonical record ──────────

@pytest.mark.parametrize("name", [
    "OpenCode", "opencode", "opencode-cli", "@scope/opencode",
])
def test_aliases_fold_to_one_identity(name):
    assert canonical_id(name) == "opencode"


def test_distinct_software_does_not_fold_together():
    assert canonical_id("git") != canonical_id("github-cli")
    # Folding is conservative on purpose: separate words stay separate,
    # because collapsing them could merge two unrelated projects.
    assert canonical_id("open code") == "open-code" != canonical_id("opencode")


def test_merge_produces_one_record_listing_every_source():
    from aura.environment.software.resolve import _merge
    a = SoftwareRecord(canonical_id="prettier", display_name="prettier",
                       provenance=[Provenance("npm", Trust.REGISTRY, "prettier")])
    b = SoftwareRecord(canonical_id="prettier", display_name="Prettier",
                       provenance=[Provenance("pypi", Trust.REGISTRY, "prettier")])
    records = [a]
    _merge(records, [b])
    assert len(records) == 1
    assert records[0].sources() == ["npm", "pypi"]


# ── 5 & 6: the cache is not the catalogue, and cannot create authority ─

def test_discovery_cache_never_confers_curated_trust(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    forged = SoftwareRecord(
        canonical_id="evil", display_name="evil",
        provenance=[Provenance("npm", Trust.CURATED, "evil")])
    cache.store("evil", [forged])
    restored = cache.load("evil").records[0]
    # A file on disk must not be able to impersonate AURA's own catalogue.
    assert restored.provenance[0].trust is Trust.REGISTRY
    assert restored.trust_level() is not Trust.CURATED


def test_cache_does_not_persist_machine_truth(tmp_path, monkeypatch):
    """Installed/verified/connected are re-read live every search, so a
    stale cache can never claim software is present on this machine."""
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    rec = SoftwareRecord(canonical_id="x", display_name="x",
                         installed=True, verified=True, connected=True)
    cache.store("x", [rec])
    raw = json.loads((tmp_path / "software" / "discovery-cache.json").read_text())
    stored = raw["x"]["records"][0]
    for field in ("installed", "verified", "connected"):
        assert field not in stored
    assert cache.load("x").records[0].installed is False


def test_discovery_cannot_create_an_install_spec(tmp_path, monkeypatch):
    """The decisive security test: nothing discovered becomes installable."""
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    discovered = SoftwareRecord(
        canonical_id="newtoolxyz", display_name="NewToolXYZ",
        kind=SoftwareKind.CLI_TOOL, executables=["newtoolxyz"],
        homepage="https://example.invalid",
        provenance=[Provenance("npm", Trust.REGISTRY, "newtoolxyz")],
        state=SoftwareState.DISCOVERED)
    apply_installability(discovered)
    assert discovered.catalog_id is None
    assert discovered.state is SoftwareState.UNTRUSTED
    assert discovered.to_dict()["installable"] is False
    assert discovered.reason                     # the user is told why


def test_registry_signals_do_not_grant_installability(tmp_path, monkeypatch):
    """Bin fields, repos, homepages and versions are identity, not authority."""
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    rich = SoftwareRecord(
        canonical_id="fancy", display_name="fancy", kind=SoftwareKind.CLI_TOOL,
        executables=["fancy"], repository="https://github.com/x/fancy",
        homepage="https://fancy.example", latest_version="9.9.9",
        provenance=[Provenance("npm", Trust.REGISTRY, "fancy",
                               url="https://npmjs.com/package/fancy")])
    apply_installability(rich)
    assert rich.to_dict()["installable"] is False


# ── 7 & 8: curated entries are the only installable ones ─────────────

def test_curated_entry_with_userspace_spec_is_installable():
    entry = curated_entry("opencode")
    assert entry is not None and entry.install is not None
    ok, _ = install_verdict(entry)
    assert ok is True
    rec = SoftwareRecord(canonical_id="opencode", display_name="OpenCode")
    apply_installability(rec)
    assert rec.state is SoftwareState.INSTALLABLE
    assert rec.catalog_id == "opencode"


def test_curated_entry_without_install_spec_is_not_installable():
    entry = curated_entry("git")
    assert entry is not None and entry.install is None
    ok, why = install_verdict(entry)
    assert ok is False and "no verified way to install" in why


def test_unknown_software_has_no_install_affordance():
    ok, why = install_verdict(None)
    assert ok is False and "no curated installation record" in why


# ── 9-11: machine state comes from the existing systems ──────────────

def test_machine_state_outranks_installability():
    """Installed software stays installed even if AURA could not have
    installed it — the machine is authoritative for local truth."""
    rec = SoftwareRecord(canonical_id="git", display_name="Git",
                         installed=True, verified=True,
                         state=SoftwareState.VERIFIED)
    apply_installability(rec)
    assert rec.state is SoftwareState.VERIFIED
    assert rec.catalog_id == "git"


def test_state_ladder_never_claims_more_than_proven():
    assert rank(SoftwareState.DISCOVERED) < rank(SoftwareState.INSTALLABLE)
    assert rank(SoftwareState.INSTALLABLE) < rank(SoftwareState.INSTALLED)
    assert rank(SoftwareState.INSTALLED) < rank(SoftwareState.VERIFIED)
    assert rank(SoftwareState.VERIFIED) < rank(SoftwareState.CONNECTED)
    assert rank(SoftwareState.CONNECTED) < rank(SoftwareState.AURA_READY)
    assert highest(SoftwareState.INSTALLED, SoftwareState.DISCOVERED) \
        is SoftwareState.INSTALLED


def test_installed_is_not_verified_and_verified_is_not_connected():
    rec = SoftwareRecord(canonical_id="x", display_name="x", installed=True,
                         state=SoftwareState.INSTALLED)
    d = rec.to_dict()
    assert d["installed"] is True and d["verified"] is False
    assert d["connected"] is False and d["state"] == "INSTALLED"


# ── security: no command ever comes from discovery ───────────────────

def test_no_discovery_module_can_emit_a_command():
    """Grep the discovery layer for execution primitives. The install
    planner is the only place a command is built, and it lives outside
    this package by design."""
    import pathlib
    import aura.environment.software as pkg

    root = pathlib.Path(pkg.__file__).parent
    banned = ("subprocess", "os.system", "shell=True", "Popen", "run_argv",
              "procexec", "eval(", "exec(")
    for path in root.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        for token in banned:
            assert token not in text, f"{path.name} must not reference {token}"


def test_bin_names_keeps_command_names_not_paths():
    """Package-relative paths are discarded: only the command name is kept,
    so nothing path-shaped can travel with a record."""
    assert _bin_names({"bin": {"prettier": "bin/prettier.cjs"}}) == ["prettier"]
    assert _bin_names({"bin": "./cli/run.js"}) == ["run"]
    assert _bin_names({"bin": {"../evil": "x"}}) == []


def test_entry_points_parse_only_console_scripts():
    raw = "[console_scripts]\nhttp = httpie:main\n[gui_scripts]\nwin = x:y\n"
    assert _entry_point_commands({"entry_points": raw}) == ["http"]


# ── 12-13: the entry points do not scan; the route describes only ────

def test_search_route_never_installs_or_scans():
    """AURA Everything's backend surface is read-only by construction:
    the handler resolves and returns, and the only install route in the
    API is the pre-existing governed one."""
    import inspect

    from aura.api import server

    src = inspect.getsource(server.environment_search)
    for token in ("plan_install", "install(", "subprocess", "run_argv", "scan("):
        assert token not in src, f"search handler must not reference {token}"
    assert "search(" in src


def test_search_handler_is_registered_once():
    from aura.api.server import create_app

    app = create_app()
    paths = [getattr(r, "path", "") for r in app.routes]
    assert paths.count("/environment/search") == 1
    # The governed install route is untouched and still the only one.
    assert paths.count("/environment/install") == 1


def test_offline_search_never_reaches_a_registry(monkeypatch):
    """`external: false` must keep the resolver entirely local — this is
    what makes the offline story true rather than aspirational."""
    from aura.environment.software import resolve

    def explode(*a, **k):                    # any network use fails the test
        raise AssertionError("external source consulted during offline search")

    monkeypatch.setattr(resolve, "external_sources", explode)
    outcome = resolve.search("git", allow_external=False)
    assert "npm" not in outcome.consulted and "pypi" not in outcome.consulted
    assert "inventory" in outcome.consulted and "catalog" in outcome.consulted


def test_curated_answer_short_circuits_external_discovery(monkeypatch):
    """A tool AURA already curates must not cost a network round trip."""
    from aura.environment.software import resolve

    called: list[str] = []

    class Loud:
        id = "npm"

        def search(self, q, *, limit=10):
            called.append(q)
            from aura.environment.software.sources.base import SourceResult
            return SourceResult()

    monkeypatch.setattr(resolve, "external_sources", lambda: [Loud()])
    resolve.search("opencode")
    assert called == [], "a curated hit must not consult a registry"


def test_search_result_shape_is_stable_for_the_ui():
    from aura.environment.software.resolve import search

    out = search("git", allow_external=False).to_dict()
    assert set(out) == {"query", "results", "consulted", "offline", "stale", "detail"}
    if out["results"]:
        row = out["results"][0]
        for key in ("canonicalId", "displayName", "state", "installable",
                    "installed", "verified", "connected", "sources", "reason"):
            assert key in row


def test_absent_is_not_offline(monkeypatch):
    """A 404 is a definite "no such project", not a network failure. The
    UI must not tell a user their tool was unreachable when the registry
    plainly answered that it does not exist."""
    from aura.environment.software.sources import base, pypi

    monkeypatch.setattr(pypi, "fetch_json", lambda url, **kw: base.ABSENT)
    out = pypi.PyPISource().search("definitely-not-a-real-project")
    assert out.unreachable is False
    assert out.records == []


def test_transport_failure_is_offline(monkeypatch):
    from aura.environment.software.sources import pypi

    monkeypatch.setattr(pypi, "fetch_json", lambda url, **kw: None)
    assert pypi.PyPISource().search("anything").unreachable is True
