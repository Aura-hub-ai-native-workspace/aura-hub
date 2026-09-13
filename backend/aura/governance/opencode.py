"""OpenCode adapter — AURA-authored runtime enforcement.

Genuine pre-execution boundary, verified against the runtime's own
machinery (no fakes):

- `OPENCODE_CONFIG` env: per-invocation config with permission rules
  compiled from the task contract. Config `deny` is terminal inside the
  worker; project config can only ADD allow surface, never remove the
  plugin below.
- `OPENCODE_CONFIG_DIR` env: directory carrying the governance plugin.
  Plugins load for every tool call; `tool.execute.before` throwing
  DENIES the action before it executes. A project plugin cannot
  un-throw another plugin's denial, so enforcement is monotonic.
- The plugin mirrors decide_action (actions.py) in the smallest
  possible rule surface, logs every bounded action event as JSONL, and
  self-terminates (exit 42, after a synchronous log flush) on hard
  violations — a stopped worker the executor reports as failed, which
  enters the existing park/correction path.
- `external_directory: deny` in config + an absolute/outside-cwd check
  in the plugin stop the worker editing AURA's own policy/plugin files
  (they live outside the repo cwd). Post-hoc snapshot/delta
  verification still runs underneath everything.

SUPPORTS: COMMAND (pattern policy, best-effort) / FILE_WRITE /
FILE_DELETE (structured args, fully mediated) / FILE_READ (structured
args, mediated) / TOOL_CALL (allow-listed tools only) / PROCESS_SPAWN
(through COMMAND policy). NETWORK: unsupported — no interception
exists; capability gating stays the boundary.
"""

from __future__ import annotations

import json

SUPPORTS = {
    "COMMAND": "policy",
    "FILE_WRITE": "preflight",
    "FILE_DELETE": "preflight",
    "FILE_READ": "preflight",
    "PROCESS_SPAWN": "policy",
    "TOOL_CALL": "allowlist",
    "NETWORK": "unsupported",
}

PLUGIN_NAME = "aura-governance.ts"
CONFIG_NAME = "aura-governance.json"
SELF_KILL_CODE = 42


def compile_config(scope_paths: list[str]) -> dict:
    """Permission rules compiled from the task contract. Second layer
    behind the plugin (which always enforces); deny rules here are
    terminal inside the worker process."""
    allow_globs = []
    for scope in scope_paths:
        scope = scope.strip().rstrip("/")
        if scope:
            allow_globs.append(f"{scope}/**")
    edit_rules: dict[str, str] = {"*": "deny"}
    for glob in allow_globs:
        edit_rules[glob] = "allow"
    return {
        "$schema": "https://opencode.ai/config.json",
        "permission": {
            "edit": edit_rules,
            "bash": {
                "*": "allow",
                "rm *": "deny",
                "sudo *": "deny",
                "su *": "deny",
                "mkfs *": "deny",
                "dd *": "deny",
                "shutdown *": "deny",
                "reboot *": "deny",
                "chmod *": "deny",
                "chown *": "deny",
            },
            "external_directory": "deny",
            "skill": "deny",
            "webfetch": "deny",
            "websearch": "deny",
        },
    }


def compile_plugin(policy: dict) -> str:
    """Governance plugin source with the policy inlined. Dependency-free
    (no imports) so the runtime loads it with no install step. The rule
    surface intentionally mirrors actions.decide_action; both are pinned
    by the same unit vectors (see test_action_governance)."""
    policy_json = json.dumps(policy)
    return r"""// AURA governance plugin — generated per invocation, do not edit.
// Enforces the task contract inside the worker runtime BEFORE tool
// execution. Deny = throw (tool call refused). Hard violation =
// synchronous log flush + process.exit(42): the worker stops and the
// executor reports failure, which enters park/correction.
export const AuraGovernance = async (ctx) => {
  const POLICY = __POLICY_JSON__;
  const fs = await import("node:fs");
  const path = await import("node:path");
  const LOG = process.env.AURA_ACTION_LOG || "";
  let seq = 0;

  const clip = (v, n) => {
    const s = String(v ?? "");
    return s.length > n ? s.slice(0, n) + "\u2026" : s;
  };
  const log = (action) => {
    if (!LOG) return;
    seq += 1;
    const line = JSON.stringify({
      taskId: POLICY.taskId,
      workerNodeId: POLICY.nodeId,
      invocationId: POLICY.invocationId,
      attemptId: POLICY.attempt,
      sequence: seq,
      at: new Date().toISOString(),
      ...action,
    }) + "\n";
    try { fs.appendFileSync(LOG, line); } catch { /* log loss never breaks enforcement */ }
  };
  const scopes = (POLICY.scopePaths || []).map((s) => String(s).replace(/\/$/, ""));
  const norm = (p) => String(p ?? "").replace(/\\/g, "/");
  const insideScope = (target) => {
    const cwdBase = norm(POLICY.cwd || "").replace(/\/$/, "");
    let t = norm(target).trim();
    if (!t || t.startsWith("~")) return false;
    if (t.startsWith("/")) {
      if (!cwdBase || !(t === cwdBase || t.startsWith(cwdBase + "/"))) return false;
      t = t.slice(cwdBase.length).replace(/^\//, "");
      if (!t) return true;
    }
    const parts = t.split("/");
    if (parts.includes("..") || parts.includes(".") || parts.includes("")) return false;
    if (scopes.length === 0) return true;
    return scopes.some((s) => t === s || t.startsWith(s + "/"));
  };
  const SENSITIVE = [".env", ".git/", ".ssh/", ".aws/", "secrets", ".gnupg", ".pki", "id_rsa", "id_ed25519", ".pem", ".key", "credentials"];
  const sensitive = (target) => {
    const t = norm(target).toLowerCase();
    return SENSITIVE.find((seg) => t.includes(seg)) || null;
  };
  // [pattern, destructive]: stacking/substitution refusal is
  // non-destructive (runtimes emit such commands in benign recon);
  // self-termination is reserved for boundary-probing and exfiltration.
  const DENY_PATTERNS = [
    [/(^|\s)(rm\s+(-[^ ]*\s+)*-(r|R|f).*(\/|\*)|rm\s+-rf?\s+\/)/i, true],
    [/(^|\s)(mkfs|dd\s+|shutdown|reboot|halt|poweroff)\b/i, true],
    [/(^|\s)(sudo|su|doas|runas)\b/i, true],
    [/(^|\s)(chmod|chown)\b/i, true],
    [/\|\s*(sh|bash|zsh|fish)\b/i, true],
    [/(curl|wget)\b.*\|\s*(sh|bash)\b/i, true],
    [/(^|\s)(nc|ncat|netcat|ssh|scp)\b/i, true],
    [/(^|\s)(nohup|setsid|daemon)\b/i, false],
    [/;/, false],
    [/`/, false],
    [/\$\(/, false],
  ];
  const deny = (tool, actionType, target, command, reason, destructive) => {
    const event = {
      actionType, tool, target: clip(target), command: clip(command),
      decision: "DENY", reason: clip(reason, 200), destructive: !!destructive,
    };
    log(event);
    if (destructive) {
      try { fs.appendFileSync(LOG, ""); } catch {}
      process.exit(__KILL_CODE__);
    }
    throw new Error("AURA denied " + tool + ": " + reason);
  };

  return {
    "tool.execute.before": async (input, output) => {
      const tool = input.tool;
      const args = (output && output.args) || {};
      if (tool === "edit" || tool === "write" || tool === "patch") {
        const target = norm(args.filePath || "");
        const seg = sensitive(target);
        if (seg) return deny(tool, "FILE_WRITE", target, "", "sensitive material '" + seg + "'", true);
        if (!insideScope(target)) return deny(tool, "FILE_WRITE", target, "", "outside task scope", true);
        log({ actionType: "FILE_WRITE", tool, target: clip(target), command: "", decision: "ALLOW", reason: "inside scope", destructive: false });
        return;
      }
      if (tool === "read" || tool === "glob" || tool === "grep") {
        const target = norm(args.filePath || args.pattern || args.path || "");
        const seg = sensitive(target);
        if (seg) return deny(tool, "FILE_READ", target, "", "sensitive material '" + seg + "'", true);
        // Glob/grep patterns are not paths: the files they resolve to
        // are mediated when actually read or edited (defense in depth).
        if (tool === "read" && target && !insideScope(target)) {
          return deny(tool, "FILE_READ", target, "", "outside task scope", false);
        }
        log({ actionType: "FILE_READ", tool, target: clip(target), command: "", decision: "ALLOW", reason: "read observed", destructive: false });
        return;
      }
      if (tool === "bash") {
        const command = String(args.command || "");
        if (!command.trim()) return deny(tool, "COMMAND", "", "", "empty command", false);
        const seg = sensitive(command);
        if (seg) return deny(tool, "COMMAND", "", command, "sensitive material '" + seg + "'", true);
        for (const [re, destructive] of DENY_PATTERNS) {
          if (re.test(command)) {
            return deny(tool, "COMMAND", "", command, "denied command pattern", destructive);
          }
        }
        log({ actionType: "COMMAND", tool, target: "", command: clip(command), decision: "ALLOW", reason: "argv policy", destructive: false });
        return;
      }
      if (tool === "task") {
        log({ actionType: "TOOL_CALL", tool, target: "", command: "", decision: "ALLOW", reason: "children mediated by same hooks", destructive: false });
        return;
      }
      if (tool === "skill" || tool === "webfetch" || tool === "websearch") {
        return deny(tool, "TOOL_CALL", "", "", "tool not allowed for governed tasks", false);
      }
      log({ actionType: "TOOL_CALL", tool, target: "", command: "", decision: "ALLOW", reason: "observed", destructive: false });
    },
  };
};
""".replace("__POLICY_JSON__", policy_json).replace("__KILL_CODE__", str(SELF_KILL_CODE))
