# Phase 1 — foundations

*Make every action recordable and stoppable.*

Branch `phase1/redaction-and-journal`, five commits on top of `origin/main`
@ `1212724`. Nothing pushed, nothing merged, no version bumped.

## What shipped

| # | Roadmap item | State | Suite |
|---|---|---|---|
| 1 | Redact the chat prompt path — one choke point across both composers | **RUNTIME VERIFIED** | `prompt-redaction-verify` |
| 2 | Append-only, hash-chained audit journal | **RUNTIME VERIFIED** | `audit-journal-verify` |
| 3 | Fix `mission.create` verify | **RUNTIME VERIFIED** | `capability-truth-verify` |
| 4 | Fix or downgrade `governance.audit` | **RUNTIME VERIFIED** (fixed, not downgraded) | `capability-truth-verify` |
| 5 | Process groups, orphan-free kill, real cancellation | **RUNTIME VERIFIED** on Linux/X11 · **NOT VERIFIED** on Windows and macOS | `process-containment-verify` |
| 6 | Consolidate the git wrappers and the bypassing spawn sites | **PARTIAL — see below** | `process-containment-verify` [E] |

Four new suites, 100 checks, 20 of them negative controls. All pass.
No pre-existing suite regressed.

## Exit criterion

> `kill -9` the service mid-mission: every decision and outcome is still on
> disk and readable, a tampered line is detectable, and no orphan process
> survives on any platform.

Met on Linux. `audit-journal-verify` SIGKILLs the real service and finds the
record; it breaks the chain four ways (edit, deletion, reorder, torn write)
and each is reported at the entry where it happened.
`process-containment-verify` spawns a fixture that forks a `detached`,
`unref`'d grandchild — the hardest shape on purpose — and finds it dead
after a timeout, a cancellation and a shutdown.

**"on any platform" is not met.** Every group assertion is POSIX; the
Windows path (`taskkill /T /F`) is written and typechecked but has never
run. Section [A]–[D] report `NOT VERIFIED` there rather than passing
vacuously. A Windows and a macOS runner are needed to close this.

## What each change actually was

**1 — the chat prompt leaked credentials.** `redact()` lived inside
`promptContract.ts`'s `block()`, which is the *agent* path. The chat
composer had no filter at all and is the path fed raw source excerpts and
raw recalled memory, so a key committed to a repository file went verbatim
to the provider. The patterns are now one module both import.

Extracting forced a decision the old rule had dodged: it redacted
everything after `password:`, which on free text is harmless and on source
code destroys `password: string` and `apiKey = process.env.OPENAI_KEY`.
The rule now reads the name by *words* (so `DATABASE_PASSWORD` matches and
`tokenizer` does not) and requires the value to look like a constant rather
than a lookup or a call.

The user's own message and conversation history are deliberately **not**
filtered. Someone pasting a key to ask why it is rejected must still get an
answer. AURA redacts what it went and fetched, not what it was told.

**2 — the governance record died with the process.** `auditLog` was an
array with no writer. It is now `~/.aura/fabric-audit.jsonl`: one line per
record, fsynced before the call returns, each line naming the hash of the
one before it. `GET /fabric/audit/verify` exposes the check. It is
tamper-**evident**, not tamper-proof, and the code says so.

Two things had to change because the record became durable: `inputSummary`
redacted by field *name* only, which misses a credential inside
`terminal.execute`'s command line; and the record gained `initiator`, the
one provenance field the Fabric can *state* rather than accept.

**3 —** `mission.create` looked itself up with `text.slice(0, 60)` where
`getMission` wants an id, so every successful creation reported
`unverified`. The id was in the executor's own result all along.

**4 —** `governance.audit` declared "Health scorecard, risk, release
readiness" and returned the stored profile. The engine it was describing
already exists in `@aura/governance`; it is wired now, and the manifest
describes what it really returns. `runNpmAudit` stays off — it spawns a
package manager, and `security_review.ts` hardcodes `npm.cmd`.

**5 —** `execFile`'s `timeout` and `signal` signal one pid, so a tool that
forks survived both. Children are now `detached`, killed as a group,
SIGTERM then SIGKILL. The group alone was not enough — the suite proved it:
a grandchild spawned `detached` leads a *new* group. Descendants are
therefore also collected from `/proc` (or one `ps`) **before** anything is
signalled, because once the parent exits its children are reparented and
the link is gone.

`detached` takes children out of the service's own group, so
`terminateAllChildren()` runs on `close()` before the socket goes.

## 6 — what is left, and why

Two byte-identical private `git()` wrappers were removed
(`mission/gitSignals.ts`, `diagnosis/gitSignals.ts`). Both reported a
timed-out git as exit 0, so "no commits touch this file" and "git ran out
of time" were the same answer.

The census check then found the same expression in
`@aura/automation`'s trigger detectors — a real defect nobody was looking
for. Fixed in place.

**Four direct spawns remain outside the primitive**, and three of them
cannot be consolidated without a structural change:

- `packages/governance/src/core/git.ts`
- `packages/governance/src/security/security_review.ts`
- `packages/governance/src/release/release_readiness.ts`
- `packages/automation/src/triggers.ts`

`@aura/governance` and `@aura/automation` sit **below** `@aura/ai-service`
in the dependency graph, so they cannot import `exec/process`. Genuine
consolidation means moving the primitive into a new low-level package
(`@aura/exec`, holding `process.ts` + `which.ts`, no dependencies) and
repointing all three. That is mechanical but it touches every package, and
it would collide head-on with the four phase branches currently in flight.
**It is the right next move once those land**, and it is deliberately not
being done under them.

Three more direct spawns are in the census as *not* duplicates:
`environment.ts` and `mission/execution/nodes.ts` probe binaries that are
deliberately **not** on any allow-list (that is what the environment
scanner is for), and `graphify.ts` streams a long-running CLI where the
primitive buffers to completion.

## Known defect found and not fixed here

`packages/governance/src/security/security_review.ts:314` hardcodes
`npm.cmd`, which `ENOENT`s on Linux and macOS. It is why `governance.audit`
runs with `runNpmAudit: false`. Out of Phase 1's scope; it belongs with the
`@aura/exec` move.

## How to run it

```
node scripts/prompt-redaction-verify.mjs
node scripts/audit-journal-verify.mjs
node scripts/capability-truth-verify.mjs
node scripts/process-containment-verify.mjs
```

None need a provider, a network or a browser. The last three build the
service bundle themselves, so they always test the working tree rather
than whatever was staged last.
