# Phase 4 — questions only the user can answer

Everything else in the phase brief is built. These four are stopped, not
guessed at. Each says exactly what was done instead, so nothing is
half-finished and nothing is invented.

---

## 1. Deleting the desktop `localStorage` memory store needs a data decision

**Brief:** `apps/desktop/src/ops/memoryStore.ts` — *"DELETE (Phase 2 may
already do this — coordinate via HANDOFF.md)"*.

**What is actually there.** 478 lines with **seven importers**:
`MemoryCenter.tsx`, `MemoryGraph.tsx`, `EngineeringLearning.tsx`,
`learningEngine.ts`, `agentEngine.ts`, `memoryRecorder.ts` and
`data/useWorkspace.ts`. It is a browser `localStorage` store with its own
schema, its own category metadata (`MEMORY_CATEGORY_META`) and its own
graph builder. Nothing in it reaches a prompt, which is why the phase
brief marks it for deletion.

**Why it stopped here.** Deleting it is not a deletion — it is porting
seven UI surfaces onto the server-backed `@aura/engineering-memory`
store, which needs HTTP endpoints that do not exist yet, and it needs an
answer to a question about the user's own data:

> **Some users already have memories in `localStorage` from using the
> app. On deletion, should AURA (a) migrate them into
> `~/.aura/engineering-memory/`, (b) export them to a file and then
> remove the store, or (c) discard them?**

There is no defensible default. (a) silently promotes browser-scoped
notes into the durable engineering record; (c) destroys user data.

**What was done instead.** The store is untouched and still works. The
*reason* it was marked for deletion — that the real semantic store never
reached a prompt — is fixed independently: `@aura/engineering-memory` is
now the semantic tier of `unifiedMemory.ts` and reaches every prompt on
both paths. The `localStorage` store is now redundant rather than
load-bearing, so removing it later is a UI port and a data decision, not
an architectural one.

---

## 2. MCP over stdio launches a user-registered command — is the registry file enough?

**What was built.** MCP servers are declared by the user in
`~/.aura/mcp/servers.json`. AURA connects to what is listed and enabled,
and to nothing else: no discovery, no auto-install, no default server
list. `ProcessSession` requires every long-lived process to name the
authority that permitted it to exist, and an MCP server's authority is
literally *"the user registered this server in
`~/.aura/mcp/servers.json`"*.

**Why it stopped here.** An MCP server command is arbitrary — `npx`,
`node`, `python`, a binary. AURA has three deliberately disjoint binary
allow-lists (`SAFE_BINARIES`, `AGENT_BINARIES`, `INSTALLER_BINARIES`) and
invariant 8 says they are never merged. Adding a fourth general-purpose
list would be that merge under a new name, so the registry file is the
allow-list instead.

> **Is "the user wrote it in the registry file" sufficient authorisation
> to launch an MCP server, or should the first launch of each server also
> require an explicit in-app approval — a Fabric approval record naming
> the command, shown once per server?**

**What was done instead.** The registry-file model is implemented and
verified. Adding a first-launch approval on top is a small change
(`McpConnectionPool.connect` gains an approval gate) and is not blocked
by anything — it needs a product decision about friction, not code.

---

## 3. The browser tier can log in — who performs the login?

**What was built.** AURA drives a browser profile it owns at
`~/.aura/browser/profile`, never the user's daily profile. Session grants
are per-origin, time-bounded (24h ceiling) and revocable, stored in
`~/.aura/browser/grants.json`.

**Why it stopped here.** A grant records that AURA *may* act on an origin.
It does not put a session in the profile. Getting one there requires the
user to sign in, and where that happens is a product decision:

> **When a user grants AURA a session for a site, how do they sign in?
> (a) AURA opens its own browser window, headful, on that site and the
> user signs in there; (b) the user imports specific cookies for that
> origin from their own browser; (c) something else.**

(a) is the honest one — the credentials never pass through AURA — but it
requires a visible browser window, which the current headless launch does
not provide. (b) means AURA handles the user's session cookies directly,
which is exactly what "a profile AURA owns" was meant to avoid.

**What was done instead.** `BrowserSession` takes a `headless` flag
(defaulting to headless) so (a) is one argument away. Grants work,
expire and revoke today; a page fetched without a grant is fetched signed
out, and `browser.navigate` says so in its result rather than pretending.

---

## 4. The redirect re-check is built but not exercised end to end

**What was built.** `net/ssrfGuard.ts` follows redirects manually and
re-checks every hop, because a single check before an auto-following
`fetch` proves nothing about where the request lands.

**Why it stopped here.** Exercising it end to end needs a **public**
redirector that answers 302 with a private-address `Location` — the first
hop must resolve public, or the guard refuses at hop 0 and the redirect
loop never runs. That needs either an outbound-network dependency in the
suite or a host AURA controls.

> **May the verification suite make outbound network requests to a
> nominated test endpoint, or should this stay a structural check?**

**What was done instead.** `browser-tier-verify` §6 verifies the deny list
against eleven address families with a negative control proving it does
not block the public internet, verifies literal and name-resolved
refusals, verifies `guardedFetch` refusing a real loopback URL end to
end, and asserts the manual-redirect structure in source. The redirect
re-check is reported in `HANDOFF.md` as **BUILT, structurally verified,
NOT runtime verified** rather than claimed.
