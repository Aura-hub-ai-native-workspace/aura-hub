"""The data folder and the stores in it are private to their owner."""
import json
import os
import stat

import pytest

from aura.jsonutil import write_json_file
from aura.secrets import SecretStore

posix = pytest.mark.skipif(os.name == "nt", reason="POSIX permissions")


def _mode(p) -> int:
    return stat.S_IMODE(os.stat(p).st_mode)


@pytest.fixture()
def home(tmp_path, monkeypatch):
    h = tmp_path / ".aura"
    monkeypatch.setenv("AURA_HOME", str(h))
    return h


@posix
def test_a_store_in_the_data_folder_is_owner_only_and_closes_the_folder(home):
    home.mkdir(mode=0o755)
    os.chmod(home, 0o755)
    target = home / "secrets.json"
    target.write_text("{}")
    os.chmod(target, 0o644)
    write_json_file(target, {"secrets": {}})
    assert _mode(target) == 0o600
    assert _mode(home) == 0o700
    assert json.loads(target.read_text()) == {"secrets": {}}


@posix
def test_secret_store_files_are_owner_only(home):
    store = SecretStore()
    store.set("API_TOKEN", "value-1234567890")
    assert _mode(home / "secrets.json") == 0o600
    assert store._reveal("API_TOKEN") == "value-1234567890"


@posix
def test_files_outside_the_data_folder_keep_usual_permissions(home, tmp_path):
    outside = tmp_path / "project" / "settings.json"
    write_json_file(outside, {"a": 1})
    umask = os.umask(0)
    os.umask(umask)
    assert _mode(outside) == 0o666 & ~umask
