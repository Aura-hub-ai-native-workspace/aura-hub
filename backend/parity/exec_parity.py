"""Differential verification of the execution / process layer.

Runs identical scenarios through the TypeScript spawn primitive and the
Python port, and reports every difference.

Both sides run the SAME child programs, from fixture files written into a
shared temporary directory, so a difference in the result is a difference
in the primitive rather than in what was executed.

Usage (from backend/):
    uv run python -m parity.exec_parity --repo /mnt/storage/aura-hub
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import asdict, is_dataclass
from pathlib import Path

from aura_backend.execution import (
    AGENT_BINARIES,
    INSTALLER_BINARIES,
    SAFE_BINARIES,
    TIMEOUT_EXIT_CODE,
    ProcessNotInstalled,
    ProcessOutput,
    ProcessRefused,
    ResolveEnv,
    UnsafeArgumentError,
    git,
    is_cmd_shim,
    is_path_like,
    parse_command,
    quote_for_cmd,
    resolve_agent_binary,
    resolve_executable_with,
    resolve_installer_binary,
    run_agent,
    run_installer,
    safe_shell,
    safe_shell_with_code,
    spawn_target_for,
)
from aura_backend.execution.install import (
    InstallPlan,
    InstallSpec,
    detect_distro,
    plan_install,
    resolve_privilege,
    writable_with_ancestors,
)
from aura_backend.execution.process import SpawnOptions


def _spec(raw: dict | None) -> InstallSpec | None:
    if raw is None:
        return None
    return InstallSpec(
        method=raw["method"],
        package=raw["package"],
        privilege=raw["privilege"],
        distro=raw.get("distro", {}),
    )

FIXTURES = {
    "slow.js": "setTimeout(function(){}, 60000)\n",
    "exit3.js": "process.exit(3)\n",
    "exit0.js": "process.exit(0)\n",
    "sigterm.js": 'process.kill(process.pid, "SIGTERM")\n',
    "sigint.js": 'process.kill(process.pid, "SIGINT")\n',
    "partial.js": 'console.log("partial"); setTimeout(function(){}, 60000)\n',
    "both.js": 'process.stdout.write("OUT"); process.stderr.write("ERR"); process.exit(0)\n',
    "onlyerr.js": 'process.stderr.write("ERRONLY"); process.exit(0)\n',
    "erroutnonzero.js": (
        'process.stdout.write("SOME"); process.stderr.write("BAD"); process.exit(7)\n'
    ),
    "big.js": 'process.stdout.write("x".repeat(9*1024*1024))\n',
    "trailing.js": 'process.stdout.write("  padded  \\n\\n")\n',
}


def write_fixtures(directory: Path) -> None:
    for name, body in FIXTURES.items():
        (directory / name).write_text(body, encoding="utf-8")


def build_scenarios(cwd: str) -> list[dict]:
    s: list[dict] = [{"name": "allowlists", "kind": "allowlists"}]

    # ---- real spawns, identical child programs on both sides ----
    for name, command, timeout in [
        ("shell/exit0", "node exit0.js", None),
        ("shell/version", "node --version", None),
        ("shell/exit3", "node exit3.js", None),
        ("shell/timeout", "node slow.js", 700),
        ("shell/timeout-partial", "node partial.js", 700),
        ("shell/self-sigterm", "node sigterm.js", None),
        ("shell/self-sigint", "node sigint.js", None),
        ("shell/both-streams", "node both.js", None),
        ("shell/only-stderr", "node onlyerr.js", None),
        ("shell/stderr-and-nonzero", "node erroutnonzero.js", None),
        ("shell/trailing-whitespace", "node trailing.js", None),
        ("shell/maxbuffer", "node big.js", None),
    ]:
        s.append(
            {"name": name, "kind": "shell", "command": command, "cwd": cwd, "timeoutMs": timeout}
        )

    for name, command, timeout in [
        ("shellStrict/ok", "node both.js", None),
        ("shellStrict/killed-has-partial", "node partial.js", 700),
        ("shellStrict/refused", "rm -rf /", None),
        ("shellStrict/nonzero-with-output", "node erroutnonzero.js", None),
    ]:
        s.append(
            {
                "name": name,
                "kind": "shellStrict",
                "command": command,
                "cwd": cwd,
                "timeoutMs": timeout,
            }
        )

    s.append({"name": "git/status", "kind": "git", "args": ["status", "--porcelain"], "cwd": cwd,
              "timeoutMs": None})
    s.append({"name": "git/bad-subcommand", "kind": "git",
              "args": ["definitely-not-a-git-command"], "cwd": cwd, "timeoutMs": None})

    # Refusals that must never reach a spawn.
    s.append({"name": "agent/refused-path", "kind": "agent", "bin": "/bin/sh", "args": [],
              "cwd": cwd, "timeoutMs": 500})
    s.append({"name": "installer/refused-sudo", "kind": "installer", "bin": "sudo",
              "args": ["pacman", "-S", "x"], "cwd": cwd, "timeoutMs": 500})

    # ---- parseCommand: the allow-list and the verb guard ----
    parse_cases = [
        "", "   ",
        "git status", "git status --porcelain", "ls -la", "node --version",
        "npm test", "npm ci", "npm run build",
        "npm install", "npm install lodash", "npm install -g lodash",
        "npm install --global lodash", "npm i -g x", "npm add --global x",
        "npm -g install x", "npm install lodash -g",
        "cargo build", "cargo install ripgrep", "cargo --version install",
        "go build", "go install example.com/x@latest",
        "python3 script.py", "python3 -m pip install requests",
        "python3 -m pip download requests", "python3 -m pip", "python3 install pip",
        "rm -rf /", "sudo npm install", "sh -c 'x'", "opencode run",
        "git status; rm -rf /", "git status && rm -rf /", "git status | grep x",
        "git status > out.txt", "git status < in.txt", "echo `whoami`",
        "echo $HOME", "git log --format=%H", "find . -name *.ts",
        "npx cowsay hi", "grep -r foo .", "wc -l file", "du -sh .", "pwd",
        "GIT_DIR=/tmp git status", "git\tstatus", "  git   status  ",
        "C:\\Windows\\System32\\cmd.exe",
    ]
    for i, command in enumerate(parse_cases):
        s.append({"name": f"parse/{i:02d}/{command!r}", "kind": "parse", "command": command})

    # ---- binary resolvers ----
    resolver_cases = [
        "", "   ", "opencode", "OPENCODE", "claude", "codex", "gemini", "qwen",
        "cursor-agent", "sh", "bash", "git", "node", "npm",
        "/home/Groot/.opencode/bin/opencode", "../../bin/sh", "./opencode",
        "opencode; rm -rf /", "opencode && x", "opencode|x", "opencode>x",
        "opencode`x`", "opencode$x", "opencode\\x", "..", "../opencode",
        "opencode ", " opencode", "pipx", "cargo", "gh", "pacman", "apt",
        "sudo", "yay", "paru", "dnf",
    ]
    for i, name in enumerate(resolver_cases):
        s.append({"name": f"agentResolve/{i:02d}/{name!r}", "kind": "agentResolve", "name_": name})
        s.append(
            {"name": f"installerResolve/{i:02d}/{name!r}", "kind": "installerResolve",
             "name_": name}
        )

    # ---- which: platform resolution, provable on Linux ----
    win_files = [
        "C:\\tools\\git.exe",
        "C:\\tools\\npm.cmd",
        "C:\\tools\\both.exe",
        "C:\\tools\\both.cmd",
        "C:\\other\\node.exe",
    ]
    posix_files = ["/usr/bin/git", "/usr/local/bin/node", "/opt/x/tool"]
    which_cases = [
        ("win/git", "git", "win32", "C:\\tools;C:\\other", None, win_files),
        ("win/npm-cmd", "npm", "win32", "C:\\tools;C:\\other", None, win_files),
        ("win/pathext-order-exe-first", "both", "win32", "C:\\tools", ".COM;.EXE;.BAT;.CMD",
         win_files),
        ("win/pathext-order-cmd-first", "both", "win32", "C:\\tools", ".CMD;.EXE", win_files),
        ("win/already-has-ext", "git.exe", "win32", "C:\\tools", None, win_files),
        ("win/quoted-path-entry", "git", "win32", '"C:\\tools";C:\\other', None, win_files),
        ("win/second-dir", "node", "win32", "C:\\tools;C:\\other", None, win_files),
        ("win/missing", "nope", "win32", "C:\\tools", None, win_files),
        ("win/cwd-not-searched", "git", "win32", "", None, win_files),
        ("win/explicit-path", "C:\\tools\\git.exe", "win32", "C:\\ignored", None, win_files),
        ("win/empty-pathext", "both", "win32", "C:\\tools", "", win_files),
        ("posix/git", "git", "posix", "/usr/bin:/usr/local/bin", None, posix_files),
        ("posix/second", "node", "posix", "/usr/bin:/usr/local/bin", None, posix_files),
        ("posix/missing", "nope", "posix", "/usr/bin", None, posix_files),
        ("posix/explicit", "/opt/x/tool", "posix", "/usr/bin", None, posix_files),
        ("posix/empty-entry", "git", "posix", ":/usr/bin", None, posix_files),
        ("posix/trailing-sep", "git", "posix", "/usr/bin/", None, posix_files),
        ("posix/blank-name", "", "posix", "/usr/bin", None, posix_files),
    ]
    for label, name, platform, path_env, path_ext, files in which_cases:
        s.append(
            {
                "name": f"resolveExec/{label}",
                "kind": "resolveExec",
                "name_": name,
                "platform": platform,
                "pathEnv": path_env,
                "pathExt": path_ext,
                "files": files,
            }
        )

    for label, name, platform in [
        ("win/bare", "git", "win32"), ("win/slash", "a/b", "win32"),
        ("win/backslash", "a\\b", "win32"), ("win/drive", "C:x", "win32"),
        ("posix/bare", "git", "posix"), ("posix/slash", "a/b", "posix"),
        ("posix/backslash", "a\\b", "posix"), ("posix/drive", "C:x", "posix"),
    ]:
        s.append({"name": f"isPathLike/{label}", "kind": "isPathLike", "name_": name,
                  "platform": platform})

    for label, resolved, args, platform in [
        ("posix/plain", "/usr/bin/git", ["status"], "posix"),
        ("win/exe", "C:\\t\\git.exe", ["status"], "win32"),
        ("win/cmd", "C:\\t\\npm.cmd", ["run", "build"], "win32"),
        ("win/bat", "C:\\t\\x.bat", ["a b"], "win32"),
        ("win/cmd-empty-args", "C:\\t\\npm.cmd", [], "win32"),
        ("win/cmd-unsafe-percent", "C:\\t\\npm.cmd", ["%PATH%"], "win32"),
        ("win/cmd-unsafe-quote", "C:\\t\\npm.cmd", ['say "hi"'], "win32"),
        ("win/cmd-unsafe-newline", "C:\\t\\npm.cmd", ["a\nb"], "win32"),
        ("win/cmd-metachars-quoted", "C:\\t\\npm.cmd", ["a&b|c>d<e^f(g)"], "win32"),
    ]:
        s.append({"name": f"spawnTarget/{label}", "kind": "spawnTarget", "resolved": resolved,
                  "args": args, "platform": platform})

    for i, arg in enumerate(
        ["plain", "with space", "a&b", "a|b", "a>b", "a<b", "a^b", "a(b)", "%X%", 'q"q', "a\nb",
         "a\rb", "", "100%"]
    ):
        s.append({"name": f"quoteCmd/{i:02d}/{arg!r}", "kind": "quoteCmd", "arg": arg})

    for label, resolved, platform in [
        ("win/cmd", "x.CMD", "win32"), ("win/bat", "x.bat", "win32"),
        ("win/exe", "x.exe", "win32"), ("posix/cmd", "x.cmd", "posix"),
    ]:
        s.append({"name": f"isCmdShim/{label}", "kind": "isCmdShim", "resolved": resolved,
                  "platform": platform})

    # ---- install planning: the privilege floor ----
    s.append({"name": "detectDistro", "kind": "detectDistro"})

    for label, target in [
        ("existing", cwd),
        ("not-yet-created", os.path.join(cwd, "nope", "deeper")),
        ("root", "/"),
        ("system-bin", "/usr/lib"),
    ]:
        s.append({"name": f"writableAncestors/{label}", "kind": "writableAncestors",
                  "target": target})

    methods = ["npm-global", "pipx", "cargo", "gh-extension", "system-package"]
    for method in methods:
        for privilege in ("user", "root"):
            spec = {"method": method, "package": "somepkg", "privilege": privilege}
            s.append({"name": f"resolvePrivilege/{method}/{privilege}",
                      "kind": "resolvePrivilege", "spec": spec})
            s.append({
                "name": f"planInstall/{method}/{privilege}",
                "kind": "planInstall",
                "entryName": "Test Tool",
                "homepage": "https://example.invalid",
                "spec": spec,
            })

    s.append({"name": "planInstall/no-spec", "kind": "planInstall", "entryName": "Mystery",
              "homepage": "https://example.invalid", "spec": None})
    s.append({
        "name": "planInstall/distro-override",
        "kind": "planInstall",
        "entryName": "Docker",
        "homepage": "https://docker.com",
        "spec": {"method": "system-package", "package": "docker",
                 "privilege": "root", "distro": {"debian": "docker.io"}},
    })
    s.append({
        "name": "planInstall/real-opencode",
        "kind": "planInstall",
        "entryName": "OpenCode",
        "homepage": "https://opencode.ai",
        "spec": {"method": "npm-global", "package": "opencode-ai", "privilege": "user"},
    })

    return s


def _outcome(r: ProcessOutput) -> dict:
    return {
        "out": r.out,
        "code": r.code,
        "killed": bool(r.killed),
        "signal": r.signal,
        "timedOut": bool(r.timed_out),
    }


def run_python(scenarios: list[dict]) -> list[dict]:
    results = []
    for s in scenarios:
        kind = s["kind"]
        try:
            opts = SpawnOptions(
                cwd=s.get("cwd", "."),
                timeout_ms=s.get("timeoutMs"),
            )
            if kind == "shell":
                value = _outcome(safe_shell_with_code(s["command"], opts))
            elif kind == "shellStrict":
                value = {"resolved": safe_shell(s["command"], opts)}
            elif kind == "git":
                value = _outcome(git(s["args"], opts))
            elif kind == "agent":
                value = _outcome(run_agent(s["bin"], s["args"], opts))
            elif kind == "installer":
                value = _outcome(run_installer(s["bin"], s["args"], opts))
            elif kind == "parse":
                p = parse_command(s["command"])
                value = {"ok": p.ok, "bin": p.bin, "args": p.args, "reason": p.reason}
            elif kind == "agentResolve":
                r = resolve_agent_binary(s["name_"])
                value = {"ok": r.ok, "bin": r.bin, "reason": r.reason}
            elif kind == "installerResolve":
                r = resolve_installer_binary(s["name_"])
                value = {"ok": r.ok, "bin": r.bin, "reason": r.reason}
            elif kind == "allowlists":
                value = {
                    "safe": sorted(SAFE_BINARIES),
                    "agent": sorted(AGENT_BINARIES),
                    "installer": sorted(INSTALLER_BINARIES),
                    "timeoutExit": TIMEOUT_EXIT_CODE,
                }
            elif kind == "isPathLike":
                value = {"value": is_path_like(s["name_"], s["platform"])}
            elif kind == "resolveExec":
                files = set(s["files"])
                value = {
                    "value": resolve_executable_with(
                        s["name_"],
                        ResolveEnv(
                            platform=s["platform"],
                            path_env=s["pathEnv"],
                            path_ext=s["pathExt"],
                            is_executable_file=lambda c, known=files: c in known,
                        ),
                    )
                }
            elif kind == "spawnTarget":
                t = spawn_target_for(s["resolved"], s["args"], s["platform"])
                value = {"file": t.file, "args": t.args}
            elif kind == "quoteCmd":
                value = {"value": quote_for_cmd(s["arg"])}
            elif kind == "isCmdShim":
                value = {"value": is_cmd_shim(s["resolved"], s["platform"])}
            elif kind == "writableAncestors":
                value = {"value": writable_with_ancestors(s["target"])}
            elif kind == "detectDistro":
                d = detect_distro()
                value = {"id": d.id, "manager": d.manager, "installArgs": d.install_args}
            elif kind == "resolvePrivilege":
                privilege, why = resolve_privilege(_spec(s["spec"]))
                value = {"privilege": privilege, "why": why}
            elif kind == "planInstall":
                r = plan_install(
                    name=s["entryName"], homepage=s["homepage"], spec=_spec(s["spec"])
                )
                if isinstance(r, InstallPlan):
                    value = {
                        "executable": r.executable,
                        "privilege": r.privilege,
                        "bin": r.bin,
                        "args": r.args,
                        "command": r.command,
                        "why": r.why,
                    }
                else:
                    value = {"executable": False, "reason": r.reason}
            else:
                value = {"unsupported": kind}
        except (ProcessRefused, ProcessNotInstalled, UnsafeArgumentError) as exc:
            value = {"error": str(exc)}
        except Exception as exc:  # noqa: BLE001 - the oracle also reports any throw
            value = {"error": str(exc)}
        if is_dataclass(value):
            value = asdict(value)
        results.append({"name": s["name"], "value": value})
    return results


def run_typescript(scenarios: list[dict], repo: Path, workdir: Path) -> list[dict]:
    """Bundle the real primitive from source and run the scenarios on it."""
    entry = workdir / "entry.ts"
    entry.write_text(
        f"export * from {json.dumps(str(repo / 'packages/ai-service/src/exec/process.ts'))};\n"
        f"export * from {json.dumps(str(repo / 'packages/ai-service/src/exec/which.ts'))};\n"
        f"export * from {json.dumps(str(repo / 'packages/ai-service/src/exec/install.ts'))};\n",
        encoding="utf-8",
    )
    bundle = workdir / "bundle.mjs"
    build = subprocess.run(
        ["npx", "esbuild", str(entry), "--bundle", "--platform=node", "--format=esm",
         f"--outfile={bundle}"],
        cwd=repo, capture_output=True, text=True,
    )
    if build.returncode != 0:
        print(build.stderr, file=sys.stderr)
        raise SystemExit("could not bundle the TypeScript primitive; cannot claim parity")

    scenarios_path = workdir / "scenarios.json"
    # The oracle reads `name_` as `name` for the resolver/which scenarios;
    # rename here so the JSON the oracle sees uses its own field names.
    payload = []
    for s in scenarios:
        c = dict(s)
        if "name_" in c:
            c["name"] = c.pop("name_")
            c["scenario"] = s["name"]
        payload.append(c)
    scenarios_path.write_text(json.dumps(payload), encoding="utf-8")

    oracle = Path(__file__).parent / "exec_oracle.mjs"
    proc = subprocess.run(
        ["node", str(oracle), str(bundle), str(scenarios_path)],
        cwd=repo, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        raise SystemExit("the TypeScript oracle failed to run; cannot claim parity")
    out = json.loads(proc.stdout)
    # Restore our scenario labels.
    for row, original in zip(out, scenarios):
        row["name"] = original["name"]
    return out


def compare(ts: list[dict], py: list[dict]) -> list[str]:
    differences = []
    for t, p in zip(ts, py):
        if t["value"] != p["value"]:
            differences.append(
                f"{t['name']}\n"
                f"    TypeScript: {json.dumps(t['value'], sort_keys=True)}\n"
                f"    Python:     {json.dumps(p['value'], sort_keys=True)}"
            )
    return differences


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="/mnt/storage/aura-hub")
    args = ap.parse_args()
    repo = Path(args.repo)

    with tempfile.TemporaryDirectory(prefix="exec-parity-") as tmp:
        workdir = Path(tmp)
        fixtures = workdir / "cwd"
        fixtures.mkdir()
        write_fixtures(fixtures)
        subprocess.run(["git", "init", "-q"], cwd=fixtures, check=True)

        scenarios = build_scenarios(str(fixtures))
        ts = run_typescript(scenarios, repo, workdir)
        py = run_python(scenarios)

        differences = compare(ts, py)
        for d in differences:
            print(f"DIFF {d}")
        total = len(scenarios)
        print(f"\n{total - len(differences)}/{total} execution scenarios match the reference")
        return 1 if differences else 0


if __name__ == "__main__":
    raise SystemExit(main())
