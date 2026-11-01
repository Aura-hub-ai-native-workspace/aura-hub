"""The shared-context file the agents write is never counted as a project change."""
from aura.central_agent import change_observer
from aura.fabric.supervision import is_ignored_content_path


def test_the_shared_context_file_and_its_variants_are_ignored_paths():
    assert is_ignored_content_path("common-context.json")
    assert is_ignored_content_path("sub/common-context.json.lock")
    assert is_ignored_content_path("common-context.json.corrupt-123")
    assert not is_ignored_content_path("index.html")
    assert not is_ignored_content_path("my-common-context.json")


def test_writing_the_shared_context_file_is_not_a_change(tmp_path):
    (tmp_path / "index.html").write_text("a")
    before = change_observer.snapshot(tmp_path)
    (tmp_path / "common-context.json").write_text("{}")
    changes, complete = change_observer.diff(before, change_observer.snapshot(tmp_path))
    assert changes == [] and complete

    (tmp_path / "index.html").write_text("b")
    changes, _ = change_observer.diff(before, change_observer.snapshot(tmp_path))
    assert [c["path"] if isinstance(c, dict) else c for c in changes] and "index.html" in str(changes)
