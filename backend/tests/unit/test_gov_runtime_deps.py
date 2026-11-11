"""The opencode-family runtime installs @opencode-ai/plugin (~63MB) into
every OPENCODE_CONFIG_DIR it is given. Those deps must not outlive the
run, while the policy, plugin and action log stay as evidence."""

from __future__ import annotations

import os
import time

from aura.governance import staging


def _stage(home, invocation_id="inv-1"):
    staged = staging.stage_opencode(
        str(home), invocation_id=invocation_id, task_id="t", node_id="n",
        attempt="1", cwd=str(home), scope_paths=["work"])
    config_dir = os.path.join(staged["govRoot"], "config-dir")
    # What the runtime itself drops into the config dir on startup.
    os.makedirs(os.path.join(config_dir, "node_modules", "effect"))
    for name in ("package.json", "package-lock.json", ".gitignore"):
        with open(os.path.join(config_dir, name), "w") as fh:
            fh.write("{}")
    return staged, config_dir


def test_release_drops_runtime_deps_and_keeps_evidence(tmp_path):
    staged, config_dir = _stage(tmp_path)
    staging.release_runtime_deps(staged["govRoot"])
    assert sorted(os.listdir(config_dir)) == ["plugin"]
    assert os.path.isfile(staged["pluginPath"])
    assert os.path.isfile(staged["configPath"])
    assert os.path.isfile(staged["logPath"])


def test_release_tolerates_missing_root(tmp_path):
    staging.release_runtime_deps(None)
    staging.release_runtime_deps(str(tmp_path / "gov" / "nope"))


def test_sweep_releases_only_stale_dirs(tmp_path):
    old, old_cfg = _stage(tmp_path, "inv-old")
    fresh, fresh_cfg = _stage(tmp_path, "inv-fresh")
    past = time.time() - staging.STALE_AFTER_S - 60
    os.utime(old["govRoot"], (past, past))
    assert staging.sweep_stale_runtime_deps(str(tmp_path)) == 1
    assert not os.path.exists(os.path.join(old_cfg, "node_modules"))
    assert os.path.isdir(os.path.join(fresh_cfg, "node_modules"))


def test_remove_gov_dir_only_under_gov(tmp_path):
    staged, _ = _stage(tmp_path, "rdy-abc")
    outside = tmp_path / "keep"
    outside.mkdir()
    staging.remove_gov_dir(str(outside))
    assert outside.is_dir()
    staging.remove_gov_dir(staged["govRoot"])
    assert not os.path.exists(staged["govRoot"])
