"""Negative controls for the workspace and project registry.

This phase establishes one security boundary above all others: **an
execution's working directory comes from the registry, by project id, and
never from a request.** Most of what follows exists to prove a caller
cannot get execution pointed somewhere of its choosing.
"""

from __future__ import annotations

import json

import pytest

from aura_backend.fabric import (
    CapabilityFabric,
    InvocationActor,
    InvocationContext,
    NodeRef,
    ServiceFabricHost,
)
from aura_backend.tools.internal_executors import workspace_executors
from aura_backend.workspace import (
    ProjectConversations,
    ProjectMemory,
    ProjectRejected,
    WorkspaceManager,
    build_profile,
    get_or_build_profile,
    load_profile,
    slug,
)


def manager(tmp_path) -> WorkspaceManager:
    return WorkspaceManager(tmp_path / "home")


def a_project(tmp_path, name: str = "demo"):
    root = tmp_path / name
    (root / "src").mkdir(parents=True)
    (root / "README.md").write_text(f"# {name}\n\nA disposable project.\n", encoding="utf-8")
    (root / "src" / "index.ts").write_text("export const x = 1\n", encoding="utf-8")
    return root


# --------------------------------------------------------------------------
# cwd comes from the registry. Full stop.
# --------------------------------------------------------------------------


def test_an_unregistered_project_yields_no_working_directory(tmp_path):
    m = manager(tmp_path)
    assert m.cwd_for("never-registered") is None
    assert m.cwd_for(None) is None
    assert m.cwd_for("") is None


def test_a_registered_project_resolves_to_its_own_directory(tmp_path):
    m = manager(tmp_path)
    root = a_project(tmp_path)
    record = m.add_project(path=str(root)).project
    assert m.cwd_for(record.id) == str(root.resolve())


def test_a_registered_path_that_has_since_vanished_yields_nothing(tmp_path):
    """Better to refuse with "no project directory" than to spawn
    somewhere that no longer is one."""
    m = manager(tmp_path)
    root = a_project(tmp_path)
    record = m.add_project(path=str(root)).project
    for child in sorted(root.rglob("*"), reverse=True):
        child.unlink() if child.is_file() else child.rmdir()
    root.rmdir()
    assert m.cwd_for(record.id) is None


def test_a_registered_path_replaced_by_a_file_yields_nothing(tmp_path):
    m = manager(tmp_path)
    root = a_project(tmp_path)
    record = m.add_project(path=str(root)).project
    for child in sorted(root.rglob("*"), reverse=True):
        child.unlink() if child.is_file() else child.rmdir()
    root.rmdir()
    root.write_text("not a directory", encoding="utf-8")
    assert m.cwd_for(record.id) is None


def test_there_is_no_api_by_which_a_caller_supplies_a_directory():
    """`cwd_for` takes a project id and nothing else. If a `cwd` argument
    ever appears on it, this test is the thing that should have stopped
    it."""
    import inspect

    signature = inspect.signature(WorkspaceManager.cwd_for)
    assert list(signature.parameters) == ["self", "project_id"]


# --------------------------------------------------------------------------
# Registration refuses what is not a project.
# --------------------------------------------------------------------------


def test_a_path_that_is_not_a_directory_is_refused(tmp_path):
    m = manager(tmp_path)
    a_file = tmp_path / "a.txt"
    a_file.write_text("x", encoding="utf-8")
    for bad in (str(a_file), str(tmp_path / "does-not-exist")):
        with pytest.raises(ProjectRejected, match="not a directory"):
            m.add_project(path=bad)


def test_an_empty_path_resolves_to_the_working_directory(tmp_path, monkeypatch):
    """Documented finding, NOT a fix: an empty path resolves to the
    process's own working directory, which is a real directory, so
    registration succeeds. The reference behaves identically
    (`path.resolve('')` is cwd there too). Recorded in the migration map
    rather than changed, because changing it is a contract decision."""
    m = manager(tmp_path)
    workdir = tmp_path / "cwd"
    workdir.mkdir()
    monkeypatch.chdir(workdir)
    record = m.add_project(path="").project
    assert record.path == str(workdir.resolve())


def test_registering_the_same_folder_twice_is_refused(tmp_path):
    m = manager(tmp_path)
    root = a_project(tmp_path)
    m.add_project(path=str(root))
    with pytest.raises(ProjectRejected, match="already added"):
        m.add_project(path=str(root))
    # And by a different spelling of the same path.
    with pytest.raises(ProjectRejected, match="already added"):
        m.add_project(path=str(root) + "/./")


def test_registering_never_creates_the_folder(tmp_path):
    m = manager(tmp_path)
    missing = tmp_path / "not-there"
    with pytest.raises(ProjectRejected):
        m.add_project(path=str(missing))
    assert not missing.exists(), "registration created the folder it was meant to refuse"


@pytest.mark.parametrize("name", ["../escape", "a/b", "a\\b", "..", "."])
def test_a_project_name_cannot_become_a_path(tmp_path, name):
    m = manager(tmp_path)
    with pytest.raises(ProjectRejected):
        m.create_project(name, parent_path=str(tmp_path / "parent"))


def test_creating_over_an_existing_folder_is_refused(tmp_path):
    m = manager(tmp_path)
    parent = tmp_path / "parent"
    (parent / "taken").mkdir(parents=True)
    with pytest.raises(ProjectRejected, match="already exists"):
        m.create_project("taken", parent_path=str(parent))


def test_removing_a_project_never_deletes_the_folder(tmp_path):
    """Forgetting a project and destroying the user's work are different
    operations, and this is the former."""
    m = manager(tmp_path)
    root = a_project(tmp_path)
    record = m.add_project(path=str(root)).project
    assert m.remove_project(record.id) is True
    assert root.is_dir()
    assert (root / "README.md").exists()


# --------------------------------------------------------------------------
# Ids are safe as path segments, because they become them.
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    ["../../etc", "a/b/c", "..", "  ", "!!!", "Hello World", "café", "a\\b"],
)
def test_a_slug_is_always_safe_as_a_path_segment(name):
    value = slug(name)
    assert value
    assert "/" not in value and "\\" not in value
    assert ".." not in value
    assert value.strip("-") == value


def test_ids_are_unique_even_for_identical_names(tmp_path):
    m = manager(tmp_path)
    first = m.add_project(path=str(a_project(tmp_path, "same")), name="Same").project
    second_root = tmp_path / "other"
    second_root.mkdir()
    second = m.add_project(path=str(second_root), name="Same").project
    assert first.id != second.id
    assert second.id == "same-2"


# --------------------------------------------------------------------------
# The profile reports what is there, and nothing else.
# --------------------------------------------------------------------------


def test_a_profile_of_an_empty_folder_invents_nothing(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    profile = build_profile("empty", str(empty))
    assert profile.type == "Empty or non-code folder"
    assert profile.primary_language == "unknown"
    assert profile.languages == []
    assert profile.frameworks == []
    assert profile.dependencies == []
    assert profile.package_manager is None
    assert profile.file_count == 0


def test_a_profile_reports_real_languages_and_frameworks(tmp_path):
    root = a_project(tmp_path)
    # Several TypeScript files, so the primary language is unambiguous. A
    # tie is broken by walk order in both implementations, which makes it
    # a poor thing to assert on.
    for i in range(4):
        (root / "src" / f"m{i}.ts").write_text("export const y = 1\n", encoding="utf-8")
    (root / "package.json").write_text(
        json.dumps({"dependencies": {"react": "^18"}, "description": "A thing"}),
        encoding="utf-8",
    )
    profile = build_profile("demo", str(root))
    assert profile.primary_language == "TypeScript"
    assert "React" in profile.frameworks
    assert profile.package_manager == "npm"
    assert any(d["name"] == "react" for d in profile.dependencies)


def test_a_profile_ignores_vendored_directories(tmp_path):
    root = a_project(tmp_path)
    noisy = root / "node_modules" / "pkg"
    noisy.mkdir(parents=True)
    for i in range(50):
        (noisy / f"f{i}.ts").write_text("x", encoding="utf-8")
    profile = build_profile("demo", str(root))
    assert profile.file_count < 10, "node_modules was walked"


def test_a_corrupt_package_json_does_not_break_profiling(tmp_path):
    root = a_project(tmp_path)
    (root / "package.json").write_text("{not json", encoding="utf-8")
    profile = build_profile("demo", str(root))
    assert profile.dependencies == []
    assert profile.package_manager == "npm"


def test_a_profile_is_cached_and_reused_until_the_fingerprint_changes(tmp_path):
    home = tmp_path / "home"
    root = a_project(tmp_path)
    (root / "package.json").write_text("{}", encoding="utf-8")
    first = get_or_build_profile(home, "demo", str(root))
    second = get_or_build_profile(home, "demo", str(root))
    assert first.generated_at == second.generated_at, "the cache was not used"
    assert load_profile(home, "demo") is not None


def test_load_profile_returns_nothing_for_an_unprofiled_project(tmp_path):
    assert load_profile(tmp_path / "home", "never-profiled") is None


# --------------------------------------------------------------------------
# Per-project stores never mix.
# --------------------------------------------------------------------------


def test_memory_is_scoped_to_one_project(tmp_path):
    home = tmp_path / "home"
    ProjectMemory(home, "a").add("decision", "A decision", "for project a")
    assert len(ProjectMemory(home, "a").list()) == 1
    assert ProjectMemory(home, "b").list() == []


def test_conversations_are_scoped_to_one_project(tmp_path):
    home = tmp_path / "home"
    ProjectConversations(home, "a").create("thread")
    assert len(ProjectConversations(home, "a").list()) == 1
    assert ProjectConversations(home, "b").list() == []


def test_recall_of_an_empty_store_returns_nothing_rather_than_something(tmp_path):
    assert ProjectMemory(tmp_path / "home", "a").recall("anything") == []


def test_recall_never_returns_an_unrelated_item(tmp_path):
    store = ProjectMemory(tmp_path / "home", "a")
    store.add("decision", "Database choice", "We chose postgres for the ledger")
    store.add("decision", "Colour scheme", "The header is blue")
    hits = store.recall("postgres ledger")
    assert [h.title for h in hits] == ["Database choice"]


def test_removing_the_last_assistant_turn_can_never_remove_a_user_turn(tmp_path):
    store = ProjectConversations(tmp_path / "home", "a")
    conversation = store.create()
    store.append(conversation.id, "user", "a question")
    assert store.remove_last_assistant(conversation.id) is False
    assert len(store.get(conversation.id).messages) == 1
    store.append(conversation.id, "assistant", "an answer")
    assert store.remove_last_assistant(conversation.id) is True
    assert [m.role for m in store.get(conversation.id).messages] == ["user"]


def test_body_and_title_are_bounded(tmp_path):
    item = ProjectMemory(tmp_path / "home", "a").add("code", "t" * 500, "b" * 9000)
    assert len(item.title) == 160
    assert len(item.body) == 4000


# --------------------------------------------------------------------------
# The fabric now resolves cwd — and only from the registry.
# --------------------------------------------------------------------------


async def test_an_executor_refuses_when_the_project_is_unknown(tmp_path):
    m = manager(tmp_path)
    fabric = CapabilityFabric(ServiceFabricHost())
    for executor in workspace_executors(m):
        fabric.register(executor)
    from aura_backend.environment import EnvironmentScanner
    from aura_backend.tools.executors import machine_executors

    for executor in machine_executors(EnvironmentScanner()):
        fabric.register(executor)

    context = InvocationContext(
        actor=InvocationActor(kind="agent", id="t"),
        project_id="ghost",
        cwd=m.cwd_for("ghost"),
        approved_capabilities=("filesystem.read",),
    )
    result = await fabric.invoke("filesystem.read", {"path": "a.txt"}, context)
    assert result.outcome == "failed"
    assert "No project directory" in result.detail


async def test_a_registered_project_lets_execution_reach_its_own_files(tmp_path):
    m = manager(tmp_path)
    root = a_project(tmp_path)
    record = m.add_project(path=str(root)).project

    fabric = CapabilityFabric(ServiceFabricHost())
    from aura_backend.environment import EnvironmentScanner
    from aura_backend.tools.executors import machine_executors

    for executor in machine_executors(EnvironmentScanner()):
        fabric.register(executor)

    context = InvocationContext(
        actor=InvocationActor(kind="agent", id="t"),
        project_id=record.id,
        cwd=m.cwd_for(record.id),
    )
    result = await fabric.invoke("filesystem.read", {"path": "README.md"}, context)
    assert result.outcome == "succeeded"
    assert "disposable project" in result.output


async def test_execution_still_cannot_escape_the_resolved_project(tmp_path):
    """Resolving a real cwd must not weaken confinement inside it."""
    m = manager(tmp_path)
    root = a_project(tmp_path)
    secret = tmp_path / "secret.txt"
    secret.write_text("SECRET", encoding="utf-8")
    record = m.add_project(path=str(root)).project

    fabric = CapabilityFabric(ServiceFabricHost())
    from aura_backend.environment import EnvironmentScanner
    from aura_backend.tools.executors import machine_executors

    for executor in machine_executors(EnvironmentScanner()):
        fabric.register(executor)

    context = InvocationContext(
        actor=InvocationActor(kind="agent", id="t"),
        project_id=record.id,
        cwd=m.cwd_for(record.id),
    )
    result = await fabric.invoke("filesystem.read", {"path": "../secret.txt"}, context)
    assert result.outcome == "failed"
    assert "SECRET" not in json.dumps(result.to_json())


# --------------------------------------------------------------------------
# The four still-deferred executors stay honest.
# --------------------------------------------------------------------------


def test_the_deferred_capabilities_are_not_stubbed(tmp_path):
    ids = {e.capability_id for e in workspace_executors(manager(tmp_path))}
    assert ids == {
        "project.list", "project.create", "project.open", "project.inspect",
        "memory.search", "governance.audit",
    }
    for deferred in ("mission.inspect", "mission.approve", "knowledge.graph", "workflow.run"):
        assert deferred not in ids, f"{deferred} was stubbed rather than left unsupported"


async def test_a_deferred_capability_reports_unsupported_rather_than_an_empty_answer(tmp_path):
    fabric = CapabilityFabric(
        ServiceFabricHost(present_nodes=lambda: [NodeRef(id="x", name="X")])
    )
    for executor in workspace_executors(manager(tmp_path)):
        fabric.register(executor)
    context = InvocationContext(
        actor=InvocationActor(kind="agent", id="t"), project_id="p"
    )
    result = await fabric.invoke("knowledge.graph", {"projectId": "p"}, context)
    assert result.outcome == "unsupported"
    assert result.output is None
