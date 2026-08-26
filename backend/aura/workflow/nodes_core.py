"""Node runtime core — port of nodes.ts essentials (interpolate, provenance,
pure-logic node runners) plus the governed BINDINGS subset executable today.

`{{secret:NAME}}` is deliberately NOT interpolated here (nodes.ts:60 note):
secrets resolve at the Fabric boundary only.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

MAX_LOOP_ITERATIONS = 20
MAX_NODE_EXECUTIONS = 400
DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000

# provenance ceiling per node type (provenance.ts:137-138 semantics)
_CEILING = {
    "current-project": "system", "selected-files": "system", "changed-files": "tool",
    "project-memory": "authored", "engineering-memory": "authored",
    "prompt": "tool", "groq": "tool", "generate-markdown": "tool",
    "generate-code": "tool", "generate-json": "tool", "agent": "tool",
    "intent-classifier": "system", "prompt-enhancer": "tool",
    "coding-engine": "tool", "fullstack-engine": "tool", "research-engine": "tool",
}
_ORDER = ["external", "tool", "system", "authored"]


def provenance_of(node_type: str, inbound: list[str], trigger: dict) -> str:
    ceiling = _CEILING.get(node_type)
    if ceiling is None:
        # action/io/logic types: authored when a human triggered the run
        return "authored" if trigger.get("kind") == "manual" else "external"
    vals = [*inbound, ceiling]
    return min(vals, key=_ORDER.index)


def interpolate(template: str, ctx: dict, input: dict) -> str:
    return re.sub(r"\{\{\s*([\w.-]+)\s*\}\}",
                  lambda m: (input.get("text") if m.group(1) == "input"
                             else ctx.get("projectName") if m.group(1) == "project"
                             else ctx.get("vars", {}).get(m.group(1), "")),
                  template or "")


def _n(v: Any, d: float = 0.0) -> float:
    try:
        f = float(v)
        return f
    except (TypeError, ValueError):
        return d


# ── pure-logic node runners (spec.run signature: (ctx,input,cfg)->result) ────


def run_condition(ctx, input, cfg):
    check = cfg.get("check") or "contains"
    value = interpolate(str(cfg.get("value") or ""), ctx, input)
    text = input.get("text") or ""
    if check == "contains":
        passed = value.lower() in text.lower()
    elif check == "not-contains":
        passed = value.lower() not in text.lower()
    elif check == "matches-regex":
        passed = bool(re.search(value, text, re.IGNORECASE))
    elif check == "longer-than":
        passed = len(text) > _n(cfg.get("value"), 0)
    elif check == "is-empty":
        passed = len(text.strip()) == 0
    else:
        raise RuntimeError(f"unknown check: {check}")
    return {**input, "port": "true" if passed else "false",
            "summary": f"{check} → {str(passed).lower()}"}


def run_variables(ctx, input, cfg):
    sets = cfg.get("set")
    vars_ = ctx.setdefault("vars", {})
    if isinstance(sets, list):
        for entry in sets:
            if isinstance(entry, dict) and entry.get("name"):
                vars_[entry["name"]] = interpolate(str(entry.get("value") or ""), ctx, input)
    elif isinstance(sets, dict):
        for k, v in sets.items():
            vars_[k] = interpolate(str(v), ctx, input)
    return {**input, "summary": f"{len(vars_)} variable(s)"}


def run_user_input(ctx, input, cfg):
    name = str(cfg.get("variable") or "")
    ctx.setdefault("vars", {})[name] = ctx.get("runInputs", {}).get(name, "")
    return {**input, "summary": f"input '{name}'"}


def run_output(ctx, input, cfg):
    # TS parity (nodes.ts output spec): passes input through; the title is
    # only the node-face summary. There is no template field.
    title = interpolate(str(cfg.get("title") or ""), ctx, input) or "Result"
    return {**input, "summary": title[:40]}


def run_delay(ctx, input, cfg):
    ms = max(0, int(_n(cfg.get("ms"), 1000)))
    sleep = ctx.get("sleep")
    if sleep:
        sleep(min(ms, 2000))
    return {**input, "summary": f"waited {ms}ms"}


def run_user_input_ts(ctx, input, cfg):
    """TS user-input: value from runInputs[NODE_ID] or default; empty throws."""
    marker = str(cfg.get("__nodeId") or "")
    value = str(ctx.get("runInputs", {}).get(marker) or cfg.get("default") or "")
    if not value.strip():
        raise RuntimeError(f'no value provided for "{cfg.get("prompt") or "user input"}"')
    return {"text": value, "summary": value[:40]}


def run_variables_ts(ctx, input, cfg):
    """TS variables: KEY=value lines in `pairs`."""
    vars_ = ctx.setdefault("vars", {})
    count = 0
    for line in str(cfg.get("pairs") or "").splitlines():
        line = line.strip()
        if not line:
            continue
        eq = line.find("=")
        if eq <= 0:
            continue
        vars_[line[:eq].strip()] = interpolate(line[eq + 1:].strip(), ctx, input)
        count += 1
    return {**input, "summary": f"{count} set"}


def run_prompt(ctx, input, cfg):
    """TS nodes.ts 'prompt' — pure interpolation, never a model call."""
    template = str(cfg.get("template") or "")
    if not template.strip():
        raise RuntimeError("empty prompt template")
    text = interpolate(template, ctx, input)
    return {"text": text, "summary": text[:46]}


PURE_RUNNERS: dict[str, Callable] = {
    "prompt": run_prompt,
    "condition": run_condition,
    "variables": run_variables_ts,
    "user-input": run_user_input_ts,
    "output": run_output,
    "delay": run_delay,
}

# Model/compute nodes - pure compute per the frozen design; they invoke
# nothing, so no approval gate applies.
#
# PARITY NOTE (explicit): the FROZEN TypeScript workflow ENGINE skips every
# one of these types (the oracle differential probes research-engine as the
# unknown-type case and expects a skip). Executing the model-backed types
# below is ADDITIVE Python behavior requested by the central-agent compiler;
# each runner body is a faithful port of its nodes.ts spec where one exists,
# but engine-level execution of them has NO TS-oracle counterpart.
# "research-engine" is deliberately EXCLUDED so the frozen skip parity holds;
# it stays honest-by-refusal exactly as before.
INTELLIGENCE_TYPES = {
    "groq", "generate-markdown", "generate-code", "generate-json",
    "intent-classifier", "prompt-enhancer", "coding-engine",
    "fullstack-engine", "agent",
}

GOVERNED_TYPES = {
    "shell-command", "export-file", "git-status", "changed-files", "git-diff",
    "git-commit", "git-branch", "http-request",
}

# BINDINGS subset (governed.ts:173+) — node type → planner(ctx,input,cfg,interpolate)
def _clip(s: str, n_: int) -> str:
    return s[:n_]


def bindings() -> dict[str, Callable]:
    def shell_command(_c, _i, cfg, interp):
        command = interp(str(cfg.get("command") or "")).strip()
        if not command:
            raise RuntimeError("no command configured")
        return {"capabilityId": "terminal.execute", "input": {"command": command},
                "describe": f'run "{_clip(command, 60)}"'}

    def export_file(_c, input, cfg, interp):
        rel = interp(str(cfg.get("path") or "")).strip()
        if not rel:
            raise RuntimeError("no export path configured")
        return {"capabilityId": "filesystem.write",
                "input": {"path": rel, "content": input.get("text") or ""},
                "describe": f"write {_clip(rel, 60)}"}

    def git_status(_c, _i, _cfg, _interp):
        return {"capabilityId": "git.status", "input": {}, "describe": "read git status"}

    def changed_files(_c, _i, _cfg, _interp):
        def shape(text):
            files = [l[3:].strip() for l in (text or "").split("\n") if l]
            return {"text": ("Changed files:\n" + "\n".join(f"- {f}" for f in files)) if files else "No uncommitted changes.",
                    "files": files, "data": files, "summary": f"{len(files)} changed"}
        return {"capabilityId": "git.status", "input": {}, "describe": "list changed files", "shape": shape}

    def git_diff(_c, _i, cfg, _interp):
        staged = cfg.get("staged") is True
        return {"capabilityId": "git.diff",
                "input": {"staged": staged}, "describe": "read git diff"}

    def git_commit(_c, _i, cfg, interp):
        message = interp(str(cfg.get("message") or "")).split("\n")[0].strip()
        if not message:
            raise RuntimeError("no commit message configured")
        return {"capabilityId": "git.commit", "input": {"message": message},
                "describe": f'commit "{_clip(message, 40)}"'}

    def git_branch(_c, _i, cfg, interp):
        name = interp(str(cfg.get("name") or "")).strip()
        if not name:
            raise RuntimeError("no branch name configured")
        return {"capabilityId": "git.branch", "input": {"name": name},
                "describe": f"branch {_clip(name, 40)}"}

    def git_push(_c, _i, cfg, _interp):
        remote = str(cfg.get("remote") or "origin")
        branch = str(cfg.get("branch") or "")
        inp: dict = {"remote": remote}
        if branch:
            inp["branch"] = branch
        return {"capabilityId": "git.push", "input": inp,
                "describe": f"push to {_clip(remote, 30)}"}

    def http_request(_c, input, cfg, interp):
        url = interp(str(cfg.get("url") or "")).strip()
        method = str(cfg.get("method") or "GET")
        body = interp(str(cfg.get("body"))) if cfg.get("body") is not None else None
        inp: dict = {"url": url, "method": method}
        if body is not None and body != "":
            inp["body"] = body
        return {"capabilityId": "http.request", "input": inp,
                "describe": f"{method} {_clip(url, 50)}"}

    return {
        "shell-command": shell_command,
        "export-file": export_file,
        "git-status": git_status,
        "changed-files": changed_files,
        "git-diff": git_diff,
        "git-commit": git_commit,
        "git-branch": git_branch,
        "git-push": git_push,
        "http-request": http_request,
    }
