# Common Context readiness gate — security boundary (review package)

Status: **implemented, not yet independently reviewed.** This document is the
package for that review. It makes no claim that the implementation is
approved.

Code: `backend/aura/workers/server_identity.py`,
`backend/aura/workers/opencode_mcp.py`,
`packages/ai-service/src/fabric/serverIdentity.ts`,
`packages/ai-service/src/fabric/opencodeMcp.ts`.
Tests: `backend/tests/unit/test_opencode_mcp_gate.py`,
`packages/ai-service/src/fabric/opencodeMcp.test.ts`, shared adversary
`backend/tests/fixtures/gate_adversary.py`.

## 1. What the gate does

When OpenCode or Kilo is configured with the `common-context` MCP server, AURA
starts a private runtime server (`opencode serve` / `kilo serve`, `--port 0`,
one-time password in the environment), waits until the runtime's own MCP
client reports Common Context connected, and only then sends the task to that
server (`opencode run --server <url>` / `kilo run --attach <url>`). For Kilo
the gate itself also sends `GET /mcp` and at most one
`POST /mcp/common-context/connect` with the password.

## 2. Threat model

### Assets

| Asset | Why it matters |
|---|---|
| A1. The one-time server password | Grants full control of the private runtime server (sessions, tools, file edits). |
| A2. The task text and its results | May contain user code, secrets, intent. |
| A3. The integrity of "connected" | A false `connected` sends a task to an agent without shared context. |
| A4. The user's machine state | Processes must not outlive the run. |

### Boundaries and trust

| Party | Trust |
|---|---|
| AURA backend / AI service process | Trusted (it is the enforcer). |
| The runtime binary AURA resolves (allow-listed name on `PATH`) | Trusted as code. `PATH` hijacking is a same-user compromise (class 4/5 below). |
| The private server **process** AURA started | Trusted to be the server. |
| Its children (MCP servers, plugins' subprocesses, shells) | **Untrusted.** They inherit the server's environment (A1) and its stdout. |
| Other local processes, same user | **Untrusted.** |
| Other local processes, other users | **Untrusted.** |
| The kernel | Trusted; it is the source of truth for socket ownership. |

### Attacker classes

| # | Attacker | Capabilities | Protected? |
|---|---|---|---|
| 1 | Accidental port reuse | A stale or unrelated listener ends up on the port. | **Yes.** It receives no byte (per-connection ownership). |
| 2 | Unrelated local malicious process | Can bind loopback ports, race for freed ports, use `SO_REUSEPORT` (same user), print nothing on our stdout. | **Yes for A1/A2 delivery.** It never receives AURA's credentials or task. A same-user process that can read `/proc/<pid>/environ` of the server, or ptrace it, can obtain A1 anyway — not distinguishable by the OS (see 4). |
| 3 | Malicious child of the server | Inherits A1, shares stdout (can forge exact announcements), can open its own listener, imitate the full protocol, rebind the server's port. | **Partly.** It cannot receive AURA's credentials or task on its own listener, and forged announcements are ignored. It **already holds A1** by inheritance and can use it against the server directly; that cannot be prevented without changing the runtimes. |
| 4 | Compromised plugin in the server process, or a same-user process with ptrace / `/proc/<pid>/environ` access | Runs as, or controls, the server process. | **No.** The OS cannot tell it from the server. Out of scope. |
| 5 | Compromised runtime binary | Is the server. | **No.** Out of scope. |

The design never claims protection against classes 4 and 5.

### Credential exposure paths (A1)

| Path | Before | Now |
|---|---|---|
| Server environment → its children | Inherited | **Unchanged** (runtime behaviour; residual risk R1). |
| Gate's own HTTP (Kilo) | Sent to whatever address stdout named | Sent only to AURA's relay, forwarded only over connections the OS attributes to the server. |
| `opencode mcp list --server`, `opencode run --server`, `kilo run --attach` | Sent by the CLI to whatever address stdout named | The CLI is given the relay URL; same guarantee. |
| Fixed decoy probe (`aura-invalid-credential-probe`) | Sent to every announced listener | **Removed.** Any impostor could imitate it; it protected nothing. |
| Command line / logs / error messages | Never | Never (unchanged). |

## 3. Architecture decision record

### Decision

Route every connection to the private server through an **AURA-owned loopback
relay** that, for each connection, opens its own upstream connection and
forwards **nothing** until the kernel shows the **server side of that exact
connection** (local = server port, remote = the relay's ephemeral port) held
by the **pinned server process** (PID + process start time). The task and all
probes use the relay URL, which is fixed for the run.

### Why this removes the time-of-check/time-of-use race

Ownership is checked on the connection that carries the data, after it exists
and before any byte is forwarded. The 4-tuple of an established TCP connection
cannot be taken over by another process; a listener that changes between
"identify" and "connect" (port reuse, a child rebinding the port, an
`SO_REUSEPORT` sibling) owns the accepted socket of the new connection, which
fails the check, so nothing is sent. There is no separate check to race.

The relay's own listener is held by AURA for the whole run (bound to
`127.0.0.1:0`, no `SO_REUSEPORT`), so the URL given to the CLIs cannot be
taken by another process while it is in use.

### Server identity

* The spawned process is the server unless its executable is a known launcher
  (`node`, `nodejs`, `node<N>`, `cmd.exe`). A launcher must have **exactly one**
  child, which is followed (up to 3 hops). Kilo 7.5.14's npm `bin/kilo` is a
  `node` script that spawns exactly one native binary (measured: `node` →
  `.kilo`, the only loopback listener). OpenCode 2.3.2 is a native binary that
  listens itself.
* A launcher with several children is **refused** (`unverified-server`),
  never guessed.
* The server's own children are never followed: the server is not a launcher.
* Identity is pinned as `(pid, start time)`; every check re-reads the start
  time, so an exited server whose PID is reused never matches.
* Process-group membership is never used as identity.

### Port selection

The port is one the kernel shows the server process **itself** listening on
(loopback or wildcard). The stdout announcement is not trusted; it is used only
to choose when the server holds more than one listener. Forged lines are
harmless noise. A server listening only on `::1` is never contacted (the relay
connects to `127.0.0.1`); IPv4-mapped sockets of a dual-stack server are
recognised.

### Alternatives investigated and rejected

| Alternative | Finding | Decision |
|---|---|---|
| Parent-owned listening socket (inherited fd, socket activation) | Neither runtime accepts an inherited socket. | Not possible without runtime changes. |
| Unix socket / named pipe | Neither `kilo serve` nor `opencode serve` offers one; clients take an `http://` URL. | Not possible. |
| OpenCode `serve --stdio` | Measured: prints `{"url":"http://127.0.0.1:4097"}` and still serves TCP. | Not an IPC channel. |
| Trust stdout, re-check at point of use (previous remediation) | Demonstrated bypass: forged line first, fast impostor wins. | Rejected. |
| Invalid-credential challenge (previous remediation) | Fixed public constant; any impostor answers 401 to it; a child inheriting the env can imitate the real server anyway. | Removed. |
| Check the listener's owner, then connect | Leaves a check-then-connect race. | Superseded by per-connection ownership. |
| A secret the children cannot read | The server needs the password in its environment and the runtimes pass their environment to children. | Not possible without runtime changes (R1). |
| HTTP-aware proxy that rewrites credentials (CLI never sees the server password) | Would keep A1 out of the CLI's environment, but the server's own children still inherit it; adds a full HTTP/1.1 + SSE proxy. | Not worth the complexity for no change in the class-3 outcome. Possible future step. |

## 4. Security invariants

1. **I1** No real credential, status request, reconnect or task leaves AURA
   except over a relay connection whose server side the kernel attributes to
   the pinned server process.
2. **I2** No byte from a client is read by the relay before that check passes
   (Python reads nothing; Node uses `pauseOnConnect`).
3. **I3** The URL given to the task and probes is the relay's own, fixed for
   the run; it is never re-read from stdout, so a missing or conflicting
   announcement cannot reach task execution (fixes M-2 structurally in both
   languages).
4. **I4** A refused connection (`unverified-server`) or an inspection failure
   (`identity-unavailable`) during readiness ends the run before the task; one
   during the task makes the run fail with the same reason ("result is not
   trusted").
5. **I5** Where the OS cannot be asked (unsupported platform, missing
   `lsof`/`ps`, `/proc` unreadable, permission denied), the run is refused
   before the server is started or before any request — never downgraded.
6. **I6** The relay and the server's whole process group (tree on Windows) are
   stopped on every path: success, refusal, timeout, cancellation, exception.
7. **I7** Python and TypeScript make the same decisions (same structure, same
   reasons, same adversary in tests).

## 5. Platform capability matrix

| Platform | Method | Server identity | Per-connection ownership | Status |
|---|---|---|---|---|
| Linux | `/proc/<pid>/stat`, `/proc/<pid>/exe`, `/proc/<pid>/fd`, `/proc/net/tcp{,6}` | PID + start time (field 22); launcher via `exe` | Exact: inode of the server-side socket of the 4-tuple ∈ server's fds; another holder ⇒ immediate refusal | Implemented, tested (real processes) |
| macOS | `lsof -nP -a -p <pid> -iTCP:<port> -sTCP:ESTABLISHED -Fn`, `ps -o lstart=,comm=`, `ps -A -o pid=,ppid=` | PID + `lstart`; launcher via `comm` | The 4-tuple must appear under the server PID; absence until the deadline (5 s) ⇒ refusal | Implemented; **exercised on Linux** with the real `lsof`/`ps`; **not run on macOS** |
| Windows | — | — | — | **Not implemented: gated runs are refused (`identity-unavailable`).** Candidate: `GetExtendedTcpTable` (owning PID per connection) + process creation time. |
| Any, inspection denied | — | — | — | Refused (`identity-unavailable`). |

## 6. Attack surface and adversarial tests

All scenarios run the production gate against
`backend/tests/fixtures/gate_adversary.py`: a real server, a real CLI and a
real impostor **child** that inherits the server's environment (knows the real
password), shares its stdout (prints exact announcements) and speaks the full
protocol (401 to a wrong password, `connected` to the right one). The impostor
logs every byte it receives. The same fixture is used by both languages.

| # | Scenario | Python test | TypeScript test | Expected |
|---|---|---|---|---|
| 1 | Forged announcement 1 s before the real one | `test_a_forged_announcement_before_the_real_one_never_reaches_the_impostor` (both runtimes × procfs/lsof) | `[runtime/backend] a forged announcement before the real one…` | connected to the real server; impostor 0 connections |
| 2 | Impostor answers 401/403 to wrong credentials | same impostor | same | irrelevant: never contacted |
| 3 | Impostor imitates the full connected response | same impostor | same | never contacted / refused |
| 4 | Malicious child inheriting the environment | same impostor (child of the server) | same | no credential or task to it |
| 5 | Conflicting announcements at different times | forged-first and `…after_the_real_one_is_ignored` | same | ignored |
| 6 | Port reuse between check and connection | `test_port_reuse_between_a_check_and_a_connection_delivers_nothing`; `test_a_so_reuseport_hijacker_on_the_same_port_gets_no_byte` | same | `unverified-server`; impostor received 0 bytes |
| 7 | PID exit and PID reuse | `test_connection_ownership_names_exactly_the_process_holding_the_server_side` | `[backend] names exactly the process…` | wrong start time / exited ⇒ never the server |
| 8 | Wrapper launching the server | `test_an_npm_node_launcher_is_followed…` (with and without forgery); `test_a_launcher_that_starts_more_than_one_process_is_refused` | same | followed / refused |
| 9 | IPv4 and IPv6 | `test_a_dual_stack_server_is_verified…`; `test_an_ipv6_only_listener_is_never_contacted`; `test_procfs_reads_ipv4_and_ipv4_mapped_rows` | same | v4 and v4-mapped verified; `::1` never contacted |
| 10 | Reconnect to a different listener | `test_a_kilo_reconnect_cannot_reach_a_different_listener` | same | `unverified-server`; the reconnect reached no one |
| 11 | Cancellation during identification | `test_cancellation_while_identifying_the_server…` | same | `cancelled`; nothing left running |
| 12 | Server dies during task delivery | `test_a_server_that_dies_while_receiving_the_task…` | same | failed run reported, cleanup |
| 13 | macOS / Windows behaviour | lsof parametrisation; `test_a_platform_without_verification_refuses_before_starting_anything` | same | lsof method verified; Windows refused before start |
| 14 | Missing permissions / tools | `test_unreadable_socket_ownership_refuses_the_run`; `test_missing_lsof_is_reported_unavailable_not_skipped` | same | `identity-unavailable` |
| 15 | No credential or task to an unverified listener | asserted in every scenario above (impostor byte log, task text, password) | same | holds |

The readiness-logic tests that use scripted servers (no process or socket)
substitute a clearly labelled test-only endpoint; they test waiting, failure,
reconnect and cancellation, not the boundary.

## 7. Residual risks

| ID | Risk | Why it remains | Mitigation / next step |
|---|---|---|---|
| R1 | The server's children inherit the one-time password and can use the server API directly. | Runtime behaviour; the server needs the password in its environment. | Runtime change (scrub children's env) or a per-run sandbox. |
| R2 | Same-user processes able to ptrace the server or read `/proc/<pid>/environ`. | Indistinguishable from the server to the OS. | OS hardening: `kernel.yama.ptrace_scope ≥ 1`, run agents under a separate user or container (AURA's Docker sandbox). |
| R3 | A plugin running inside the server process. | Same PID as the server. | Plugin allow-listing / governance; out of scope here. |
| R4 | Windows has no verification and refuses gated runs. | Not implemented. | Implement `GetExtendedTcpTable` + creation-time pinning; until then Windows users with Common Context configured cannot use the gated path. |
| R5 | macOS method not run on macOS. | No macOS machine in this environment. | Run the adversarial suite on macOS before relying on it there. |
| R6 | Launcher allow-list by executable name (`node`, `cmd.exe`). | A runtime installed behind a different launcher (e.g. `bun`) would resolve to the launcher, which owns no listener, and time out (fail closed). | Add launchers deliberately, with a test. |
| R7 | lsof method waits up to 5 s before refusing a connection held by another process. | lsof cannot cheaply name another holder. | Acceptable (fails closed); procfs refuses immediately. |
| R8 | `kilo run --attach` and `opencode run --server` through the relay were not exercised in an *intended* end-to-end run (no model calls permitted). | See the incident note below for one unintended run. | Run the cross-agent live acceptance with explicit authorization. |
| R9 | The live acceptance harness (`scripts/agents/cross-agent-context-acceptance.mjs`) still runs its own `opencode serve` on a pre-picked port. | Test tool, isolated HOME; not the production path; out of this change's scope. | Move it onto the gate or the relay. |

## 8. Deployment recommendations

1. Do not enable the gated path on Windows until R4 is implemented; the gate
   already refuses there.
2. Run the adversarial suite on macOS (R5) before shipping macOS support.
3. Keep `kernel.yama.ptrace_scope ≥ 1` on Linux hosts that run agents (R2).
4. Prefer AURA's Docker sandbox for untrusted projects; the gate does not
   isolate the runtime's children (R1).
5. Before production acceptance, have this package and the diff reviewed by
   an independent agent, and run the live acceptance (R8) with explicit
   authorization.

## 9. Incident during implementation (2026-11-22)

One TypeScript test was first written without installing the fake runtime, so
it ran the user's real `opencode` and `kilo` from `PATH` in a temporary
directory. OpenCode created no session (no model call). Kilo ran one session
(`ses_dfd6ce475ffeQ2yg0N8v9HM3ul`, "Secret task text investigation") with the
free model `nvidia/nemotron-3-ultra-550b-a55b:free` (2 steps, recorded cost 0)
plus one title request (`kilo-auto/small`); the agent only called Common
Context `load_context` against a fresh store and replied asking for a task. The
test was fixed, and both test suites now refuse to run a gate scenario unless
the first `PATH` entry holds the test adversary. Incidentally, that run showed
the real `kilo serve` + `kilo run --attach <relay>` working end to end through
the verified relay, including Kilo's MCP tool call.
