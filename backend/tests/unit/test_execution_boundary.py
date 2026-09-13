"""The execution boundary is architectural, not a matter of discipline.

Every guarantee the environment scan makes — no secrets in the child, stdin
closed, bounded output, whole-tree termination, identity pinning — lives in
exactly one function. That is only true for as long as nothing else reaches
for ``subprocess``.

These tests read the backend's own source. A new module that spawns a process
its own way fails here, with a message saying where the boundary is, rather
than quietly shipping a path around every control.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2]
PACKAGE = BACKEND / "aura"

#: The only modules allowed to create a process directly, each with the
#: reason it cannot go through `procexec.run_argv`. Adding an entry here is a
#: deliberate act that shows up in review; forgetting to is a test failure.
EXECUTION_EXEMPTIONS: dict[str, str] = {
    "aura/environment/procexec.py": (
        "is the boundary itself"
    ),
    "aura/environment/executor.py": (
        "installs packages: a long-running async job with its own timeout, "
        "process-group termination and DEVNULL stdin, asserted separately"
    ),
    "aura/central_agent/mcp_transport.py": (
        "speaks the MCP stdio protocol, which requires a live stdin pipe that "
        "the boundary deliberately refuses to provide; it still passes an "
        "explicit sanitized environment and its own session"
    ),
    "aura/exec_/__init__.py": (
        "runs the project commands a user asked for, where the project's own "
        "environment is the point; stdin is closed and the whole process "
        "group is signalled, asserted separately"
    ),
}

#: Ways of starting a process that the boundary would otherwise miss.
_SPAWNING_MODULES = {"subprocess", "pty", "multiprocessing"}
_SPAWNING_OS_CALLS = {
    "system",
    "popen",
    "execv",
    "execve",
    "execvp",
    "execvpe",
    "execl",
    "execle",
    "execlp",
    "spawnl",
    "spawnle",
    "spawnlp",
    "spawnv",
    "spawnve",
    "spawnvp",
    "posix_spawn",
    "posix_spawnp",
    "fork",
    "forkpty",
}
_SPAWNING_ASYNCIO_CALLS = {"create_subprocess_exec", "create_subprocess_shell"}


def _python_sources() -> list[Path]:
    return sorted(
        path
        for path in PACKAGE.rglob("*.py")
        if "__pycache__" not in path.parts
    )


def _relative(path: Path) -> str:
    return str(path.relative_to(BACKEND))


def _imports(tree: ast.AST) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".")[0])
    return names


def _attribute_calls(tree: ast.AST, module: str, attrs: set[str]) -> list[str]:
    """Calls of the form ``module.attr(...)``, including ``a.b.attr(...)``."""
    hits: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        if node.func.attr not in attrs:
            continue
        base = node.func.value
        while isinstance(base, ast.Attribute):
            base = base.value
        if isinstance(base, ast.Name) and base.id == module:
            hits.append(f"{module}.{node.func.attr}")
    return hits


class TestOneExecutionBoundary:
    def test_only_exempt_modules_import_a_process_spawner(self):
        offenders: list[str] = []
        for source in _python_sources():
            rel = _relative(source)
            if rel in EXECUTION_EXEMPTIONS:
                continue
            imported = _imports(ast.parse(source.read_text()))
            spawning = imported & _SPAWNING_MODULES
            if spawning:
                offenders.append(f"{rel} imports {', '.join(sorted(spawning))}")

        assert offenders == [], (
            "these modules spawn processes outside aura.environment.procexec, "
            "losing secret isolation, stdin isolation, output bounds, process-tree "
            "cleanup and identity pinning:\n  " + "\n  ".join(offenders)
        )

    def test_no_module_shells_out_through_os(self):
        offenders: list[str] = []
        for source in _python_sources():
            tree = ast.parse(source.read_text())
            hits = _attribute_calls(tree, "os", _SPAWNING_OS_CALLS)
            if hits:
                offenders.append(f"{_relative(source)}: {', '.join(sorted(set(hits)))}")
        assert offenders == [], "os-level process creation bypasses the boundary:\n  " + "\n  ".join(offenders)

    def test_only_exempt_modules_use_asyncio_subprocesses(self):
        offenders: list[str] = []
        for source in _python_sources():
            rel = _relative(source)
            if rel in EXECUTION_EXEMPTIONS:
                continue
            hits = _attribute_calls(ast.parse(source.read_text()), "asyncio", _SPAWNING_ASYNCIO_CALLS)
            if hits:
                offenders.append(f"{rel}: {', '.join(sorted(set(hits)))}")
        assert offenders == [], "\n  ".join(offenders)

    def test_nothing_anywhere_uses_a_shell(self):
        """No shell invocation, in code.

        Checked against the parsed source rather than the raw text: a
        comment explaining *why* `/bin/sh -c` is dangerous is documentation,
        not an invocation, and a check that cannot tell them apart pushes
        people to delete the explanation.
        """
        shell_invocations = ("/bin/sh -c", "/bin/bash -c", "bash -c", "sh -c", "cmd /c", "cmd.exe /c")
        offenders: list[str] = []
        for source in _python_sources():
            tree = ast.parse(source.read_text())
            for node in ast.walk(tree):
                if isinstance(node, ast.keyword) and node.arg == "shell":
                    value = node.value
                    if not (isinstance(value, ast.Constant) and value.value is False):
                        offenders.append(f"{_relative(source)} passes shell=")
                if isinstance(node, ast.Constant) and isinstance(node.value, str):
                    for needle in shell_invocations:
                        if needle in node.value:
                            offenders.append(f"{_relative(source)} builds {needle!r}")
        assert offenders == [], "\n  ".join(offenders)

    def test_every_exemption_still_exists_and_is_justified(self):
        """An exemption for a deleted or reformed module must not linger."""
        for rel, reason in EXECUTION_EXEMPTIONS.items():
            path = BACKEND / rel
            assert path.exists(), f"stale exemption for {rel}"
            assert len(reason) > 20, f"exemption for {rel} needs a real reason"
            imported = _imports(ast.parse(path.read_text()))
            uses_asyncio = _attribute_calls(
                ast.parse(path.read_text()), "asyncio", _SPAWNING_ASYNCIO_CALLS
            )
            assert (imported & _SPAWNING_MODULES) or uses_asyncio, (
                f"{rel} no longer spawns processes; remove its exemption"
            )

    def test_the_install_executor_keeps_its_own_guarantees(self):
        """It is exempt from the boundary, not from the requirements."""
        text = (PACKAGE / "environment" / "executor.py").read_text()
        assert "stdin=asyncio.subprocess.DEVNULL" in text
        assert "_terminate_tree" in text
        assert "start_new_session" in text

    def test_every_exempt_spawner_passes_an_explicit_environment(self):
        """Exempt from the boundary is not exempt from thinking about env.

        A spawn with no `env=` inherits every secret in this process. Where
        that is genuinely intended (`aura/exec_`, which runs the user's own
        build commands) it is stated in the exemption reason; everywhere else
        it must be explicit.
        """
        # `procexec` itself builds its keywords in a dict, so it is checked
        # behaviourally instead (see TestBoundaryGuaranteesAreCentral).
        must_be_explicit = {"aura/central_agent/mcp_transport.py"}
        for rel in must_be_explicit:
            tree = ast.parse((BACKEND / rel).read_text())
            spawns = [
                node
                for node in ast.walk(tree)
                if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in ("Popen", "run", "create_subprocess_exec")
                and any(
                    isinstance(kw.arg, str) and kw.arg in ("stdout", "stdin")
                    for kw in node.keywords
                )
            ]
            assert spawns, f"expected {rel} to spawn something"
            for call in spawns:
                keywords = {kw.arg for kw in call.keywords}
                assert "env" in keywords, (
                    f"{rel} spawns a process with an inherited environment"
                )

    def test_the_project_command_runner_cleans_up_its_process_group(self):
        text = (PACKAGE / "exec_" / "__init__.py").read_text()
        assert "start_new_session" in text
        assert "killpg" in text
        assert "stdin=asyncio.subprocess.DEVNULL" in text


class TestBoundaryGuaranteesAreCentral:
    """The guarantees live in the boundary, not re-implemented per caller.

    Asserted behaviourally rather than by reading source: each one runs a
    real child process and inspects what that child experienced.
    """

    @pytest.mark.skipif(
        __import__("sys").platform == "win32", reason="POSIX fixture scripts"
    )
    def test_every_guarantee_holds_for_an_arbitrary_caller(self, tmp_path):
        import os

        from aura.environment.procexec import MAX_OUTPUT_BYTES, ExecStatus, run_argv

        os.environ["BOUNDARY_TEST_SECRET"] = "must-not-leak"
        try:
            seen = tmp_path / "seen.txt"
            script = tmp_path / "probe"
            script.write_text(
                "#!/bin/sh\n"
                f'env > "{seen}"\n'
                f'if [ -t 0 ]; then echo tty >> "{seen}"; else echo notty >> "{seen}"; fi\n'
                "echo 1.0.0\n"
            )
            script.chmod(0o755)

            outcome = run_argv([str(script)], timeout_ms=5000)

            assert outcome.status is ExecStatus.OK
            body = seen.read_text()
            assert "must-not-leak" not in body, "the boundary leaked a secret"
            assert "notty" in body, "the boundary left stdin attached"
            assert len(outcome.stdout.encode()) <= MAX_OUTPUT_BYTES
        finally:
            os.environ.pop("BOUNDARY_TEST_SECRET", None)

    def test_a_fabric_capability_goes_through_the_boundary(self, tmp_path, monkeypatch):
        """git.status is a Fabric capability; it must inherit the guarantees."""
        from aura.fabric import executors

        captured: dict[str, object] = {}
        real = executors.__dict__.get("_run_argv")
        assert real is not None

        from aura.environment import procexec

        def recording(argv, **kwargs):
            captured["argv"] = argv
            captured["kwargs"] = kwargs
            return procexec.ExecOutcome(
                status=procexec.ExecStatus.OK, exit_code=0, stdout="## main"
            )

        monkeypatch.setattr(procexec, "run_argv", recording)
        code, text = real(["git", "status", "--porcelain=v1"], tmp_path)

        assert code == 0
        assert captured["argv"][0] == "git"
        assert "timeout_ms" in captured["kwargs"]
        assert "max_output" in captured["kwargs"]
