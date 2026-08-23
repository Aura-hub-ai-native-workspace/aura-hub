# Phase 6 — Execution / process management

**Status: COMPLETE.**
**TypeScript reference:** `packages/ai-service/src/exec/{process,which,install}.ts`
(995 lines) and `scripts/process-timeout-test.mjs`.
**Python destination:** `backend/src/aura_backend/execution/`.
**Difficulty: CRITICAL.**

---

## 1. Why this phase needed evidence rather than translation

Node's `execFile` and Python's `subprocess` do not report the same things,
and the differences land exactly on the field this layer exists to get
right — the exit status.

Rather than assume, the port began by **probing a running Node** to record
what `execFile` actually hands its callback:

| Case | `err.code` | `err.killed` | `err.signal` |
| --- | --- | --- | --- |
| timeout | `null` | **`true`** | `SIGTERM` |
| exited non-zero | `3` | `false` | `null` |
| self-inflicted SIGTERM | `null` | **`false`** | `SIGTERM` |
| `maxBuffer` exceeded | `'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` | absent | absent |
| binary missing | `'ENOENT'` | absent | absent |

Two of these corrected assumptions that would otherwise have shipped:

1. **Timeout and a self-inflicted SIGTERM are distinguished *only* by
   `killed`.** Python reports `returncode == -15` for both. If the port had
   inferred "timeout" from the return code, a process that terminated
   itself would have been reported as timed out — and, worse, a timeout
   would have been indistinguishable from ordinary termination. The Python
   layer therefore tracks whether *it* killed the child, explicitly.
2. **A `maxBuffer` overflow settles as exit code 1, not as a timeout.**
   The initial reading of `settle()` suggested overflow would hit the
   `killed` branch and be reported as 124. The probe showed `killed` is
   absent, so it falls through to the final branch. The port matches the
   measured behavior.

---

## 2. What was migrated

| TypeScript | Python | Responsibility |
| --- | --- | --- |
| `exec/which.ts` | `execution/which.py` | Executable resolution: PATH splitting per platform, PATHEXT ordering, `.cmd`/`.bat` routing through `cmd.exe`, argument quoting refusals. Pure functions over an injected platform, so the Windows branch is provable on Linux. |
| `exec/process.ts` (allow-lists) | `execution/allowlists.py` | The three disjoint binary allow-lists, the two "named, not located" resolvers, `parse_command`, and the verb-level install guard. |
| `exec/process.ts` (spawning) | `execution/process.py` | `settle()`, the bounded spawn, `git`, `safe_shell`, `safe_shell_with_code`, `run_agent`, `run_installer`. |
| `exec/install.ts` | `execution/install.py` | Install planning: the privilege floor, `writable_with_ancestors`, distro detection, the userspace argv catalogue. |

### Contracts preserved exactly

- **Three disjoint allow-lists**, contents byte-identical, never merged.
  `SAFE_BINARIES` (13), `AGENT_BINARIES` (6), `INSTALLER_BINARIES` (4).
  The only overlap is `npm` and `cargo` between SAFE and INSTALLER, which
  is what the verb guard exists to separate.
- **`settle()` rules**: 0 → 0; non-zero → that code; timeout → **124** with
  `timed_out`; signal → **128 + N**; anything else → **1, never 0**.
- **Timeouts**: git 20 s, shell 30 s, agent 10 min, install 5 min;
  `MAX_BUFFER` 4 MiB.
- **Refusal messages** are string-identical, including the interpolated
  allow-list order — verified by differential test, because these strings
  are what a user sees when AURA declines to do something.
- **The privilege floor may only rise.** An unresolvable npm prefix
  escalates to root. Root-tier installs are **never executed**; AURA hands
  over the command.
- **Named, not located.** Both resolvers reject path-like input *before*
  consulting their list. The asymmetry in the reference is preserved:
  the agent resolver rejects `/`, `\` and shell metacharacters; the
  installer resolver rejects `/`, `\` and `..`.

### Python-specific hardening (no behavioral change)

`subprocess` makes the unsafe form easier to write than the safe one.
There is **no code path in this module that accepts a command string for a
shell**: every spawn passes an argv list with `shell=False`. A negative
control proves it — an argument containing `; touch <file>` is passed
through as text and creates nothing.

---

## 3. Verification

### Differential — 225/225

`backend/parity/exec_parity.py` bundles the **real** TypeScript modules
from source with esbuild (the same technique `process-timeout-test.mjs`
uses, so the oracle cannot drift from the implementation) and runs
identical scenarios through both sides. Both run the *same* child programs
from fixtures in a shared temporary directory, so a difference in the
result is a difference in the primitive.

Coverage: 12 real spawns (clean exit, non-zero, timeout, timeout with
partial output, self-SIGTERM, self-SIGINT, both streams, stderr-only,
stderr plus non-zero, trailing whitespace, maxBuffer), 4 strict-shell
cases, 2 git cases, 2 pre-spawn refusals, 47 `parse_command` cases, 74
resolver cases, 18 executable-resolution cases across both platforms, 8
`is_path_like`, 9 `spawn_target_for`, 14 `quote_for_cmd`, 4 `is_cmd_shim`,
and 24 install-planning cases.

**Mutation-tested.** Reintroducing the historical false-success bug
(timeout settling as exit 0) was caught immediately, on exactly the two
scenarios that should catch it. A harness that passes vacuously is worse
than none, so this was checked rather than assumed.

### Reference suite, ported — 16/16

`backend/verify/process_timeout_test.py` is a check-for-check port of
`scripts/process-timeout-test.mjs`, numbering preserved so the two read
side by side. Both suites pass:

| | TypeScript | Python |
| --- | --- | --- |
| 1. exit 0 reports 0 | PASS | PASS |
| 2. non-zero reports the real code | PASS | PASS |
| 3/3b/3c. timeout is a failure, 124, explained | PASS | PASS |
| 4. signal termination preserved (143) | PASS | PASS |
| 5/5b. git works; timed-out git is not exit 0 | PASS | PASS |
| 6. `safe_shell` refuses partial output | PASS | PASS |
| 7/7b/7c. agent allow-list separate and enforced | PASS | PASS |
| 8. a timed-out **real agent** reports 124 | PASS | PASS |

Check 8 spawns a real OpenCode binary and times it out. This is runtime
verification, not simulation.

### Negative controls — 99/99

`tests/test_execution_negative_controls.py` (77),
`tests/test_install_privilege.py` (22). They assert things that must stay
false forever:

- No agent is reachable through the safe shell, for any agent name.
- No privilege-escalating binary is on any list (`sudo`, `pacman`, `yay`,
  `paru`, `apt`, `dnf`, `sh`, `bash`).
- Ten shell-operator injection forms are refused before anything spawns.
- An argument containing shell syntax creates no file.
- Eleven path-like or metacharacter agent names are refused; nine
  installer names likewise; a refusal leaves the working directory empty.
- Nine install-through-the-safe-shell forms are refused and name
  `system.install`; eight ordinary project commands still work.
- A runaway child cannot exhaust memory.
- Every `settle()` branch reports failure rather than success.
- No grant combination emits a human-only scope from install planning; no
  planned command names a privileged binary; a root tier is never
  executable.
- An existing-but-unwritable directory is a real refusal, while a
  not-yet-created one under a writable parent is not.

### Process cleanup — 4/4

`tests/test_process_cleanup.py`: no zombie children after a timeout, no
file-descriptor leak across repeated timeouts, no wedge when a grandchild
holds the pipe, and a SIGTERM-ignoring child does not survive.

---

## 4. Behavioral differences from the reference

Three, all deliberate, all discovered by testing rather than assumed.

### 4.1 A child that ignores SIGTERM is escalated to SIGKILL

**Reference:** Node's `execFile` sends its kill signal once and then waits
for the child to exit. A child that installs a SIGTERM handler and ignores
it hangs Node indefinitely.

**Python:** `terminate()`, then `kill()` after a 5 s grace period.

**Why:** a wedged backend is a worse failure than a divergence, and
"process cleanup" is in this phase's scope. Covered by
`test_a_child_ignoring_sigterm_is_escalated_and_does_not_survive`.

### 4.2 A detached grandchild holding the pipe no longer wedges the caller

**Reference:** Node waits for both process exit *and* stdio close. A child
that spawns a detached grandchild inheriting stdout, then exits, leaves
Node waiting for the grandchild's entire lifetime.

**Python:** once the process has exited, the pipes are drained for a
bounded 2 s and then abandoned; the status reported is the one the process
actually exited with.

**Why:** this was found by a test that initially **failed** — the first
implementation used reader threads, and the caller wedged for 30.1 s.
The cause is Python-specific and worth recording: closing a buffered
stream while another thread is blocked in `read()` acquires the same
buffer lock, so the *close* blocks too. The read loop was rebuilt on
`selectors` over the raw descriptors, which keeps every wait bounded.

**Note:** the reference has the same wedge. This is a fix, not a
regression, but it is a difference and is recorded as one.

### 4.3 maxBuffer truncation boundary

Node accumulates with a `StringDecoder` and enforces `maxBuffer` against
byte length as chunks arrive. Python caps on bytes and decodes once at the
end with `errors="replace"`. For a stream that overflows mid-multi-byte
character the final character may differ. Both report exit code 1 and
truncate to 4 MiB; the differential test covers the overflow case and
passes.

---

## 5. Security findings

Carried forward, not silently fixed:

1. **Process-group orphans.** Neither implementation kills a process
   *tree* — only the direct child. A grandchild spawned by an allow-listed
   command survives a timeout. Preserved deliberately: changing it alters
   what happens to a process tree, which is a product decision rather than
   a migration one. `test_a_grandchild_holding_the_pipe_does_not_wedge_the_caller`
   documents the current behavior.
2. **`npx` is on `SAFE_BINARIES`** and executes arbitrary packages. Known
   sharp edge in the reference, carried over unchanged.
3. **`parse_command` splits on whitespace with no quote handling.** An
   argument containing a space becomes two arguments. Faithful to the
   reference; worth revisiting as a product change, not here.

---

## 6. Known limitations

- **Windows is verified only by pure-function differential tests.** The
  PATHEXT ordering, `.cmd` routing and `cmd.exe` quoting logic are proved
  on Linux via injected platform (18 + 9 + 14 scenarios, all matching),
  exactly as the reference proves them. **No Python spawn has been run on
  a real Windows machine.** BUILT ≠ RUNTIME VERIFIED, and for Windows this
  is BUILT.
- **`_drain` uses `selectors`,** which supports pipes on POSIX. On Windows
  `DefaultSelector` does not select on pipe handles; that path needs a
  thread-based fallback before a Windows cutover. Recorded as a blocker
  for Phase 16, not for this phase.
- **The layer is not wired into any HTTP route yet.** That happens in
  Phase 7 (Fabric executors). Nothing in this phase changes the running
  service's behavior.

---

## 7. Files created

```
backend/src/aura_backend/execution/__init__.py
backend/src/aura_backend/execution/which.py
backend/src/aura_backend/execution/allowlists.py
backend/src/aura_backend/execution/process.py
backend/src/aura_backend/execution/install.py
backend/parity/exec_oracle.mjs
backend/parity/exec_parity.py
backend/verify/__init__.py
backend/verify/process_timeout_test.py
backend/tests/test_execution_negative_controls.py
backend/tests/test_install_privilege.py
backend/tests/test_process_cleanup.py
backend/tests/test_execution_parity.py
docs/PHASE_06_EXECUTION.md
```
