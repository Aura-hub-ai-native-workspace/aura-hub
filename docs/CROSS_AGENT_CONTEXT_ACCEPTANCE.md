# Cross-agent Common Context acceptance

This is a live acceptance test. It runs independent OpenCode and Kilo processes and requires their own MCP clients to produce completed structured tool-call events. Both clients point at the actual `common-context-mcp` executable and the same isolated `<temporary-project>/store.json`; after each write/read step, the runner independently inspects that store for the expected value and identity.

The test creates a disposable project and temporary HOME/XDG configuration. It copies only the agents' individual `auth.json` credential files when present. It does not copy or symlink agent data directories, session databases, logs, the real Common Context store, or Google Drive credentials. The child environment is allowlisted. Each OpenCode step runs against its own private `opencode serve` process, started under the temporary HOME on a free loopback port with a one-time password, so it does not intentionally join the user's background service (isolation by temporary HOME/config and a fresh password, not a cryptographic guarantee). The runner waits until that server's MCP client lists `common-context` as connected before sending the task with `opencode --server <private-url> run`; `--server` is a global flag and intentionally precedes the subcommand. Each step starts a new agent process; every agent process group is reaped before the next step. Temporary files are removed on normal completion and handled termination.

## Prerequisites

- Node.js 20 or newer.
- `opencode`, `kilo`, and `common-context-mcp` on `PATH`.
- Explicit models supported by the installed agent versions.
- Both agent credential files populated with provider access and sufficient balance.

## Run

From the repository root, provide the exact provider/model identifiers for both CLIs:

```sh
AURA_ACCEPTANCE_OPENCODE_MODEL='provider/model' \
AURA_ACCEPTANCE_KILO_MODEL='provider/model' \
node scripts/agents/cross-agent-context-acceptance.mjs
```

Run the no-model preflight before a quota-consuming acceptance. It requires a private OpenCode server to report the configured MCP server connected with a discovered tool count; it also checks Kilo's configured client connection. A configuration parse alone does not satisfy the check. It does not prove that either model will invoke a tool and is explicitly reported as `NOT_RUN` for the cross-agent exchange. If OpenCode's MCP client has not connected within 30 seconds, the preflight fails before any model call.

OpenCode 2.x connects a project's MCP servers a moment after the first request for that project. A one-shot MCP-list command can exit before that connection finishes, so the runner polls the private server's own MCP list endpoint and requires a connected status and a nonzero discovered tool count before starting an agent task.

```sh
AURA_ACCEPTANCE_PREFLIGHT_ONLY=1 \
node scripts/agents/cross-agent-context-acceptance.mjs
```

The server exports standard snake-case names such as `load_context`, `save_context`, `search_context`, and `handoff`. OpenCode permission actions normalize unsupported name characters to `_`, yielding `common_context_load_context`, etc.; Kilo namespaces permissions as `{server}_{tool}`, yielding `common-context_load_context`, etc. See the [OpenCode permission naming rules](https://opencode.ai/docs/permissions/) and [Kilo MCP permission rules](https://kilo.ai/docs/automate/mcp/using-in-cli).

Optional timeout override:

```sh
AURA_ACCEPTANCE_OPENCODE_MODEL='provider/model' \
AURA_ACCEPTANCE_KILO_MODEL='provider/model' \
AURA_AGENT_ACCEPTANCE_TIMEOUT_MS=300000 \
node scripts/agents/cross-agent-context-acceptance.mjs
```

The random N1 value is given only to OpenCode in the save request; Kilo receives only the record key and must retrieve N1. Random N2 is given only to Kilo in the handoff request; a later independent OpenCode process must retrieve N2. Receiving prompts do not contain the expected values. Success requires completed tool-call events in each CLI's JSON output, correct isolated-store writer/reader records, exact challenge responses, and a persistence read from a fresh agent process and fresh MCP server.

Output includes agent versions and selected models, step names, exit status, and tool names. It does not print context values or raw agent output. Provider credential patterns and challenge values are redacted from failure diagnostics. Exit status is 0 for PASS, 2 for BLOCKED prerequisites/provider authentication or balance, and 1 for FAIL due to implementation, timeout, missing MCP evidence, incorrect result, or persistence failure. A missing prerequisite is not reported as a successful test.

## Status semantics

`aura-agents status --json` distinguishes installed/sign-in state, `mcpConfigured`, `contextServerHandshakeVerified`, `contextServerToolInvocationVerified`, and `contextServerVerified`. A server probe is opt-in (`--verify-context-server`) and its result is labeled **Context server verified**. It launches the configured server command with its arguments/environment but deliberately uses a temporary probe store. It does not verify an agent's own MCP client. `mcpHandshakeVerified` and `mcpToolInvocationVerified` remain false compatibility fields; only the live acceptance test establishes per-agent client calls. AURA's `executableByAura` value comes from the backend invocation registry and binary resolution.

## Production readiness gate (OpenCode and Kilo)

When AURA delegates a task to OpenCode or Kilo on this computer, the task is sent only after that runtime's own MCP client reports Common Context connected. One gate implements this for both runtimes, in `backend/aura/workers/opencode_mcp.py` and its TypeScript mirror `packages/ai-service/src/fabric/opencodeMcp.ts`; each runtime contributes a small profile, not a second implementation. The specialists keep their runtimes (Researcher, Planner and Frontend Builder on OpenCode; Backend Builder, Debugger and Reviewer/Fixer on Kilo). In the Python backend, a run inside a sandbox or container boundary is not gated, because the worker cannot reach MCP servers on this computer there; the TypeScript AI service has no such boundary and gates every OpenCode and Kilo task.

| | OpenCode | Kilo |
|---|---|---|
| Resolved configuration | `opencode --standalone debug config` | `kilo debug config` |
| Where servers are declared | `mcp.servers.<name>` | `mcp.<name>` |
| Private server | `opencode serve --hostname 127.0.0.1 --port 0` | `kilo serve --hostname 127.0.0.1 --port 0` |
| Server address | announced by that server on its stdout: `server listening on http://127.0.0.1:<port>` | announced by that server on its stdout: `kilo server listening on http://127.0.0.1:<port>` |
| One-time password (environment only) | `OPENCODE_PASSWORD` | `KILO_SERVER_PASSWORD` |
| Connectivity check | `opencode mcp list --server <url>` until `common-context connected` | `GET <url>/mcp` (HTTP basic auth, user `kilo`) returning `{"common-context":{"status":"connected"}}` |
| Task sent with | `opencode run --server <url> …` | `kilo run --attach <url> --dir <cwd> …` |

Both configuration formats of OpenCode are read: one configuration object (2.2.x) and the list of configuration layers it loaded (2.3.x, `[{"type":"document","path":…,"info":{…}}, …]`), whose `info` objects are merged in load order. An empty list, a list without a configuration document, or text that is not JSON is unreadable, and the task is not sent.

Behaviour, the same for both runtimes:

- **Not declared, or `enabled: false`:** the task runs exactly as before; no private server is started.
- **Declared:** a private server is started with the task's environment plus a one-time password, and the task is sent only once the runtime reports `common-context` connected. A failed connection (missing server binary, handshake timeout, connection closed, refused credentials), no answer within the deadline (30 s OpenCode, 40 s Kilo), a server that cannot be started, a server that exits, or a cancellation ends the attempt without sending the task. An initial failure is never retried.
- **Kilo only, connection lost after it was verified:** Kilo reports a dropped connection at once and does not restore it itself, so the connection is read once more just before the task goes. If it was lost, exactly one reconnect (`POST <url>/mcp/common-context/connect`) is requested and confirmed by a fresh read; otherwise the task is not sent (`lost`).
- The private server and every process it started are always stopped afterwards (its process group on Linux and macOS; `taskkill /F /T` on its whole tree on Windows).

**Where the outcome is recorded.** The refusal reason is one of `config-error`, `launch-failed`, `failed`, `timeout`, `cancelled`, `server-exited`, `lost`, `unverified-server` (a connection to the server's port was not held, according to the operating system, by the server process AURA started — or the server could not be identified unambiguously) or `identity-unavailable` (this system cannot be asked who holds the socket: Windows, missing `lsof`/`ps`, or permission denied).

- Python backend (`agent.delegate`): the executor result carries `output.contextMcp`: `connected`, `not-configured` or `not-ready:<reason>` for OpenCode and Kilo, and `not-checked` for other runtimes and for runs inside a sandbox boundary. A refused task also returns exit code 1 with the reason as its output text.
- TypeScript AI service (`agent.delegate`): a task that was sent carries `output.contextMcp` (`connected`, `not-configured`, or `not-checked` for other runtimes); a refused task returns `ok: false` with the reason as `detail` and `output.contextMcp: not-ready:<reason>`.

These are fields of the invocation result. Whether a caller persists them depends on that caller; the gate itself writes nothing to disk.

**Who receives the password and the task is decided by the operating system, not by stdout.** The private server picks its own port (`--port 0`) and announces it on stdout, but that pipe is shared with the server's children, so the announcement is not evidence of who listens. Instead every request to the private server — the gate's own `GET /mcp` and reconnect, `opencode mcp list --server`, and the task's `opencode run --server` / `kilo run --attach` — is pointed at an AURA-owned loopback relay. For each connection the relay opens its own connection to the server's port and forwards nothing until the OS shows the server side of *that exact connection* held by the server process AURA started (pinned by PID and process start time; Kilo's npm `node` launcher is followed to the one process it starts). A forged announcement is therefore ignored, and a listener that takes over the port later (port reuse, a child rebinding it, `SO_REUSEPORT`) receives no byte: the run is refused as `unverified-server`. The announcement is used only to choose between ports when the server itself holds more than one. The previous fixed "invalid credential" probe was removed: any impostor could imitate it.

**Platforms.** Linux reads `/proc`; macOS uses `lsof` and `ps` (both exercised by the test suites, the `lsof` path on Linux). Windows is not supported yet: a gated run there is refused with `identity-unavailable` before any server is started, never sent unverified.

**What this does not protect against.** This binds connections to a *process*, not to code. A malicious plugin running inside the server process, a compromised runtime binary, or another process of the same user that can ptrace the server or read `/proc/<pid>/environ` (and so the one-time password) is indistinguishable from the server to the OS. The server's children inherit the one-time password and can use it against the server directly; what they cannot do is receive AURA's credentials or task on a listener of their own. The full threat model, invariants and residual risks are in [`COMMON_CONTEXT_GATE_SECURITY.md`](COMMON_CONTEXT_GATE_SECURITY.md). (Measured: Kilo 7.5.14 prefers port 4096 and falls back to a random free port when 4096 is taken; OpenCode 2.3.2 takes a random free port.)

**Windows.** The private server is resolved exactly like every other agent launch: allow-listed name, `PATH` lookup, and npm `.cmd` shims run through `cmd.exe` as one pre-quoted command line. A server that cannot be started is a `launch-failed` refusal, never a stray exception.

**Kilo version.** The gate was verified with Kilo **7.5.14** (`debug config`, `serve` on a self-chosen port, `GET /mcp`, `run --attach`). A Kilo that does not recognise `debug config` is refused with `config-error` and a message naming the verified version; it is never run ungated. Reading the resolved configuration costs one `kilo debug config` call per task (about 3.6 s measured). It is deliberately not cached: the resolved configuration depends on the task environment (`KILO_CONFIG`), the project directory and every configuration file Kilo merges, so a cached answer could be stale and let a task skip the gate.

Kilo's `GET /mcp` answers only once each handshake has settled (Kilo's own limit is 30 s), so a single request may take that long; the gate bounds each request at 35 s and never waits past its deadline. Its `kilo mcp list` exits 0 even when a server failed, which is why the gate reads the private server's structured status instead.

The password is never a command-line argument, never logged and never part of an error or execution record: the server reads it from its environment, `kilo run --attach` reads `KILO_SERVER_PASSWORD` itself, and OpenCode reads `OPENCODE_PASSWORD`.

**Never pass `--pure` to Kilo in production.** `--pure` runs Kilo without external plugins, and AURA's governance for Kilo is a plugin (loaded through `KILO_CONFIG`). Because a Kilo task attached to the private server runs inside that server, the server is started with the task's exact environment so the same configuration and governance plugin load there. (The isolated, model-free investigation probes used `--pure` only because they ran against a throwaway configuration.)

**Connectivity is not enforcement.** A `connected` result proves that the runtime's MCP client reached Common Context before the task was sent. It does not prove that AURA's policy is enforced for the task. For Kilo run through `--attach`, enforcement depends on the governance plugin loading inside the private server; that is expected from the shared environment but has not yet been demonstrated by a run in which a forbidden action is denied. Until such a separately authorized test passes, do not describe the Kilo path as governance-verified.
