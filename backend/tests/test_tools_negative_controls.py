"""Negative controls for tools, the catalogue and the scanner.

The security argument of this layer is narrow and specific: a probe
command and an install package come from the CATALOGUE, looked up by id,
and never from a request. Combined with argv spawning, that is what makes
it acceptable for this service to bind a local port at all.

These tests assert that property and the confinement rules around it.
"""

from __future__ import annotations

import pytest

from aura_backend.environment import (
    CAPABILITIES,
    CATALOG,
    EnvironmentScanner,
    NodeProjection,
    entries_providing,
    extract_version,
    is_connectable,
)
from aura_backend.execution import AGENT_BINARIES, INSTALLER_BINARIES
from aura_backend.fabric.types import (
    ExecutorResult,
    Invocation,
    InvocationActor,
    InvocationContext,
    NodeRef,
)
from aura_backend.tools.executors import (
    AGENT_INVOCATIONS,
    MAX_CONTEXT_CHARS,
    AgentDelegate,
    FilesystemList,
    FilesystemRead,
    FilesystemWrite,
    HttpRequest,
    SystemInstall,
    TerminalExecute,
    cwd_of,
    inside,
    machine_executors,
    with_context,
)


def inv(capability_id: str, input_: dict, cwd: str | None = None, node=None) -> Invocation:
    return Invocation(
        id="inv1",
        capability_id=capability_id,
        input=input_,
        context=InvocationContext(
            actor=InvocationActor(kind="agent", id="t"), project_id="p", cwd=cwd
        ),
        requested_at="2026-01-01T00:00:00.000Z",
        node=node,
    )


# --------------------------------------------------------------------------
# The catalogue is the only source of what may be probed or installed.
# --------------------------------------------------------------------------


def test_every_probe_command_comes_from_the_catalogue():
    """There is no field on a catalogue entry that a request could set."""
    for entry in CATALOG:
        if entry.probe is None:
            continue
        assert isinstance(entry.probe.command, str) and entry.probe.command
        assert all(isinstance(a, str) for a in entry.probe.args)
        # A probe command is a bare binary name, never a path or a shell
        # fragment — the resolver, not the catalogue, finds it on PATH.
        assert "/" not in entry.probe.command
        assert "\\" not in entry.probe.command
        assert not any(ch in entry.probe.command for ch in ";&|<>`$")


def test_every_install_spec_names_only_an_allow_listed_installer():
    """A catalogue install can never reach a privileged binary."""
    from aura_backend.execution.install import InstallSpec, userspace_command

    for entry in CATALOG:
        if entry.install is None:
            continue
        spec = InstallSpec(
            method=entry.install.method,
            package=entry.install.package,
            privilege=entry.install.privilege,
            distro=entry.install.distro,
        )
        base = userspace_command(spec, spec.package)
        if base is None:
            assert spec.method == "system-package"
            continue
        assert base[0] in INSTALLER_BINARIES, entry.id


def test_no_catalogue_entry_declares_an_unknown_capability():
    known = set(CAPABILITIES)
    for entry in CATALOG:
        unknown = set(entry.capabilities) - known
        assert not unknown, f"{entry.id} declares {unknown}"


def test_catalogue_ids_are_unique_and_order_is_stable():
    ids = [e.id for e in CATALOG]
    assert len(ids) == len(set(ids))
    # Order is the routing tie-break, so it is asserted, not assumed.
    assert entries_providing("coding-agent")[0].id == ids[
        min(i for i, e in enumerate(CATALOG) if "coding-agent" in e.capabilities)
    ]


def test_an_oauth_node_is_never_connectable():
    for entry in CATALOG:
        if entry.transport == "oauth":
            assert is_connectable(entry) is False


async def test_probing_an_uncatalogued_id_runs_nothing():
    scanner = EnvironmentScanner()
    result = await scanner.probe_node("../../bin/sh")
    assert result.present is False
    assert result.detail == "That node is not in the catalog."
    result = await scanner.probe_node("git; rm -rf /")
    assert result.present is False


# --------------------------------------------------------------------------
# Version extraction — the bug the reference documents.
# --------------------------------------------------------------------------


def test_a_leading_v_does_not_swallow_the_major_version():
    """In `v24.7.0` there is no word boundary between `v` and `2`, so a
    leading \\b would report `7.0`."""
    assert extract_version("v24.7.0") == "24.7.0"
    assert extract_version("git version 2.43.0") == "2.43.0"
    assert extract_version("Python 3.12.3") == "3.12.3"
    assert extract_version("Docker version 27.0.3, build abc") == "27.0.3"


def test_unrecognisable_output_is_truncated_not_invented():
    assert extract_version("some tool with no number") == "some tool with no number"[:40]
    assert extract_version("") is None
    assert extract_version("\n\n  \n") is None


# --------------------------------------------------------------------------
# Path confinement.
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "escape",
    ["../outside.txt", "../../etc/passwd", "a/../../outside", "/etc/passwd", "sub/../../x"],
)
def test_a_path_cannot_leave_the_project(tmp_path, escape):
    (tmp_path / "sub").mkdir()
    with pytest.raises(ValueError, match="leaves the project directory"):
        inside(str(tmp_path), escape)


def test_a_symlink_cannot_walk_out_of_the_project(tmp_path):
    """Resolving both sides is what stops a link taking a route the string
    form does not show."""
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "project"
    root.mkdir()
    (root / "escape").symlink_to(outside)
    with pytest.raises(ValueError, match="leaves the project directory"):
        inside(str(root), "escape/secret.txt")


def test_the_project_root_itself_is_allowed(tmp_path):
    assert inside(str(tmp_path), ".") == tmp_path.resolve()


def test_an_invocation_with_no_project_directory_refuses(tmp_path):
    with pytest.raises(ValueError, match="No project directory"):
        cwd_of(inv("filesystem.read", {"path": "a"}, cwd=None))


async def test_filesystem_executors_refuse_to_escape(tmp_path):
    (tmp_path / "inside.txt").write_text("ok", encoding="utf-8")
    outside = tmp_path.parent / "secret.txt"
    outside.write_text("SECRET", encoding="utf-8")
    for executor, payload in (
        (FilesystemRead(), {"path": "../secret.txt"}),
        (FilesystemList(), {"path": ".."}),
        (FilesystemWrite(), {"path": "../pwned.txt", "content": "x"}),
    ):
        with pytest.raises(ValueError, match="leaves the project directory"):
            await executor.run(inv(executor.capability_id, payload, cwd=str(tmp_path)))
    assert not (tmp_path.parent / "pwned.txt").exists()


async def test_a_large_file_is_refused_rather_than_truncated(tmp_path):
    big = tmp_path / "big.bin"
    big.write_bytes(b"x" * (600 * 1024))
    result = await FilesystemRead().run(inv("filesystem.read", {"path": "big.bin"}, str(tmp_path)))
    assert result.ok is False
    assert "read limit" in result.detail


async def test_a_written_file_is_verified_by_reading_it_back(tmp_path):
    executor = FilesystemWrite()
    invocation = inv("filesystem.write", {"path": "a/b.txt", "content": "hello"}, str(tmp_path))
    result = await executor.run(invocation)
    assert result.ok
    assert (tmp_path / "a" / "b.txt").read_text() == "hello"
    assert (await executor.verify(invocation, result)).passed is True

    # Tamper with it: the read-back must notice.
    (tmp_path / "a" / "b.txt").write_text("something else", encoding="utf-8")
    assert (await executor.verify(invocation, result)).passed is False


# --------------------------------------------------------------------------
# terminal.execute cannot become an installer or an agent launcher.
# --------------------------------------------------------------------------


async def test_terminal_execute_refuses_before_spawning(tmp_path):
    for command in ("rm -rf /", "npm install -g evil", "opencode run x", "git status; id"):
        result = await TerminalExecute().run(
            inv("terminal.execute", {"command": command}, str(tmp_path))
        )
        assert result.ok is False
        assert list(tmp_path.iterdir()) == []


# --------------------------------------------------------------------------
# agent.delegate: named, verified, confined.
# --------------------------------------------------------------------------


def test_only_agents_with_a_verified_invocation_are_drivable():
    executor = AgentDelegate()
    for binary in AGENT_BINARIES:
        node = NodeRef(id=binary, name=binary, capabilities=("coding-agent",), binary=binary)
        assert executor.supports_node(node) is (binary in AGENT_INVOCATIONS)
    # And an off-list binary is never drivable, whatever it claims.
    assert executor.supports_node(
        NodeRef(id="x", name="x", capabilities=("coding-agent",), binary="sh")
    ) is False


async def test_a_resolved_node_with_no_verified_invocation_fails_rather_than_substituting(tmp_path):
    node = NodeRef(id="claude-code", name="Claude Code", capabilities=("coding-agent",),
                   binary="claude")
    result = await AgentDelegate().run(
        inv("agent.delegate", {"task": "do it"}, str(tmp_path), node=node)
    )
    assert result.ok is False
    assert "no verified non-interactive invocation" in result.detail


async def test_agent_delegate_refuses_without_a_resolved_node(tmp_path):
    result = await AgentDelegate().run(inv("agent.delegate", {"task": "x"}, str(tmp_path)))
    assert result.ok is False
    assert "No coding-agent node was resolved" in result.detail


def test_context_truncation_is_announced_not_silent():
    brief = with_context("do the thing", "c" * (MAX_CONTEXT_CHARS + 500))
    assert "[context truncated by AURA at" in brief
    assert "<TASK>\ndo the thing\n</TASK>" in brief


def test_an_empty_context_leaves_the_task_untouched():
    assert with_context("just this", "   ") == "just this"


def test_the_task_is_always_the_last_argv_element():
    """It must reach the spawner as one opaque argument, never concatenated."""
    args = AGENT_INVOCATIONS["opencode"]["args"]("the task; rm -rf /", "/tmp/proj", None)
    assert args[-1] == "the task; rm -rf /"
    assert "--dir" in args and args[args.index("--dir") + 1] == "/tmp/proj"


# --------------------------------------------------------------------------
# system.install: catalogue-only, and exit 0 is a claim.
# --------------------------------------------------------------------------


async def test_installing_an_uncatalogued_node_is_refused(tmp_path):
    executor = SystemInstall(EnvironmentScanner())
    for node_id in ("definitely-not-a-node", "../../bin/sh", "", "   "):
        result = await executor.run(inv("system.install", {"nodeId": node_id}))
        assert result.ok is False
        assert "catalogue" in result.detail or "nothing to install" in result.detail


async def test_a_root_tier_install_executes_nothing_and_hands_over_a_command():
    executor = SystemInstall(EnvironmentScanner())
    root_entry = next(
        (e for e in CATALOG if e.install and e.install.privilege == "root"), None
    )
    assert root_entry is not None, "no root-tier entry to exercise"
    result = await executor.run(inv("system.install", {"nodeId": root_entry.id}))
    assert result.ok is False
    assert result.output["installOutcome"] == "guided"
    assert result.output["requiresUserAction"] is True
    # AURA hands over the command; it never runs it.
    verification = await executor.verify(None, result)
    assert verification.passed is False


async def test_verification_passes_only_for_installed():
    executor = SystemInstall(EnvironmentScanner())
    for outcome, expected in (
        ("installed", True),
        ("guided", False),
        ("unverified", False),
        ("failed", False),
    ):
        report = await executor.verify(
            None,
            ExecutorResult(True, "d", {"installOutcome": outcome, "nodeId": "x", "probe": {}}),
        )
        assert report.passed is expected, outcome


# --------------------------------------------------------------------------
# http.request
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url", ["file:///etc/passwd", "ftp://x/y", "javascript:alert(1)", "", "/etc/passwd"]
)
async def test_only_http_urls_are_allowed(url):
    result = await HttpRequest().run(inv("http.request", {"url": url}))
    assert result.ok is False
    assert result.detail == "Only http(s) URLs are allowed."


# --------------------------------------------------------------------------
# The node projection — including the reference bug this port fixes.
# --------------------------------------------------------------------------


async def test_a_targeted_scan_merges_rather_than_erasing_everything_else():
    """The reference ASSIGNS here, so a targeted scan makes every unscanned
    node vanish and a genuinely installed node becomes unroutable. This
    port merges — a deliberate, recorded difference."""
    scanner = EnvironmentScanner()
    projection = NodeProjection()

    full = await scanner.scan(None, True)
    projection.apply(full, targeted=False)
    before = {n.id for n in projection.present_nodes()}
    assert len(before) > 1, "need more than one present node for this to mean anything"

    one = next(iter(before))
    targeted = await scanner.scan([one], True)
    projection.apply(targeted, targeted=True)
    after = {n.id for n in projection.present_nodes()}

    assert after == before, "a targeted scan erased nodes it never looked at"


async def test_a_targeted_scan_still_reports_a_node_that_went_away():
    scanner = EnvironmentScanner()
    projection = NodeProjection()
    projection.apply(await scanner.scan(None, True), targeted=False)
    present = {n.id for n in projection.present_nodes()}
    assert "git" in present

    # A scan of a node that is genuinely absent must remove it.
    absent_id = next(
        e.id for e in CATALOG
        if e.transport == "local-process" and e.probe and e.id not in present
    )
    projection.apply(await scanner.scan([absent_id], True), targeted=True)
    assert absent_id not in {n.id for n in projection.present_nodes()}


async def test_present_nodes_are_returned_in_catalogue_order():
    scanner = EnvironmentScanner()
    projection = NodeProjection()
    projection.apply(await scanner.scan(None, True), targeted=False)
    order = [e.id for e in CATALOG]
    got = [n.id for n in projection.present_nodes()]
    assert got == sorted(got, key=order.index)


async def test_a_present_node_carries_its_probe_binary_for_routing():
    scanner = EnvironmentScanner()
    projection = NodeProjection()
    projection.apply(await scanner.scan(None, True), targeted=False)
    git_node = next(n for n in projection.present_nodes() if n.id == "git")
    assert git_node.binary == "git"
    assert "source-control" in git_node.capabilities


# --------------------------------------------------------------------------
# The registry stays honest about what it can do.
# --------------------------------------------------------------------------


def test_only_executors_with_real_implementations_are_registered():
    ids = {e.capability_id for e in machine_executors(EnvironmentScanner())}
    assert ids == {
        "filesystem.list", "filesystem.read", "filesystem.write",
        "terminal.execute", "agent.delegate", "system.install",
        "git.status", "git.diff", "git.branch", "git.commit", "git.push",
        "http.request",
    }
    # The AURA-internal ten need the workspace manager (Phase 3). Stubbing
    # them would make the manifest lie about what can run.
    assert not any(i.startswith(("project.", "mission.", "knowledge.", "memory.")) for i in ids)
