# Invariants — behavior that must hold in ANY language

Every entry is extracted from TypeScript sources at revision `141d101` and carries its
citation. A Python implementation that violates any entry here is wrong even if every
test passes. These are the non-negotiables; everything else in this freeze is shape.

---

## 1. Policy engine (`packages/capability-fabric/src/policy.ts`)

### 1.1 Escalation ladder — `stricter()` (policy.ts:122)

Decisions are totally ordered, strictest last:

```
auto-execute < ask-user < require-approval < deny
```

Folding two decisions yields the stricter one. **No configurable layer can ever lower a
decision**; configuration can only escalate above floors.

### 1.2 The four hard floors (policy.ts:169–240)

Checked BEFORE any configuration, in precedence order; each is applied as a
`require-approval` **lower bound** via `floor()` → `stricter()`:

| Floor | Trigger |
| --- | --- |
| `irreversible-floor` | capability `irreversible: true` |
| `destructive-floor` | capability needs `resource.destroy` scope |
| `authorization-floor` | capability needs `account.authorize` scope |
| `system-floor` | capability needs `system.modify` scope |

A denial can still rise ABOVE a floor (e.g. node-override deny). Nothing can go beneath
one. A floor decision may be *escalated* by later layers, never weakened.

### 1.3 Shipped default policy (policy.ts:32–44) — verified byte-equal on disk

```json
{
  "byRisk": { "low": "auto-execute", "medium": "ask-user", "high": "require-approval" },
  "overrides": {
    "mission.approve": "ask-user",
    "provider.connect": "require-approval"
  },
  "nodeOverrides": {},
  "nodeAllowlists": {},
  "allowAutonomous": true
}
```

Precedence: hard floors → per-capability `overrides` → per-node `nodeOverrides` /
`nodeAllowlists` → `byRisk` default. All configurable layers fold with `stricter()`;
`nodeOverrides` is **deny-only in effect** — writing `auto-execute` there adds no
escalation but never skips an approval (types.ts:330–340).

### 1.4 The autonomous switch (policy.ts:~109, types.ts:350–353)

When `allowAutonomous === false`, every decision that would be `auto-execute` becomes
`ask-user`. Single switch, no other semantic.

### 1.5 Policy files are untrusted input

Everything read from `~/.aura/fabric-policy.json` goes through `sanitizePolicy()`
before the engine sees it: unknown decision strings fall back to the shipped default
per level; unknown keys are dropped (policy.ts:76–112, fabric/policyStore.ts:26–33).

## 2. Approvals (`capability-fabric/src/types.ts`, `ai-service/src/fabric/approvalStore.ts`)

- **Only `pending` requests are persisted or restored** (approvalStore.ts:24–32). An
  unspent grant must never survive a restart.
- **Single-use**: spending stamps `consumedAt`; a second spend attempt is refused
  (types.ts:418–424).
- **Exact-call binding**: at request time an item carries `fingerprint`; at spend time
  the Fabric recomputes it from the arguments actually presented and refuses on mismatch
  (fabric.ts:559–576). The checkpoint stores only `approvalId` — a pointer, never the
  authority.
- Human decisions themselves are audited: records with
  `approvalDecision: 'granted'|'denied'` + `decidedBy` (types.ts:556–565). A decline
  produces no execution but MUST produce an audit record.
- Per-invocation scoping: `approvedCapabilities` covers one call only;
  `approvalId` narrows to one exact invocation (types.ts:212–234).

## 3. Audit trail (`ai-service/src/fabric/auditStore.ts`)

- **Append-only JSONL**, one line per record, never rewritten (auditStore.ts:8–15).
- Bounds: keep 5000 (`MAX_RECORDS`), trim only past 6000 (`TRIM_TRIGGER`),
  drop OLDEST, checked once per 1000 appends of the live process.
- A truncated final line from an interrupted append is skipped, not fatal
  (auditStore.ts:66–73).
- Usability gate for a loaded record: non-empty string `invocationId`,
  `capabilityId`, `at` (auditStore.ts:36–43).
- Attribution honesty: `nodeId` = executor-attributed node; `requestedNodeId` vs
  `executedNodeId` both recorded when routing intent differs from resolution
  (types.ts:542–554). Absent means unattributable — never guessed.

## 4. Process execution (`packages/ai-service/src/exec/process.ts`)

### 4.1 Three disjoint allow-lists (process.ts:62–106)

| List | Members | Used by |
| --- | --- | --- |
| `SAFE_BINARIES` | `git ls pwd node npm npx wc du grep find cargo python3 go` | `terminal.execute` / generic spawn |
| `AGENT_BINARIES` | `opencode claude codex gemini qwen cursor-agent` | `agent.delegate` |
| `INSTALLER_BINARIES` | `npm pipx cargo gh` | `system.install` |

Disjointness is load-bearing: merging agent binaries into SAFE would let
`terminal.execute` launch agents; merging installers into either would let agents or
terminals install software. Never merged, in any language.

- Bare binary names resolved on PATH; **absolute/path-like names are rejected before
  the list is consulted** (process.ts:118–122, 180–183, 358–361).
- What must stay absent forever: `sudo pacman apt dnf yay paru` and any
  privilege-escalating wrapper (root-tier installs are never executed).
- Timeout exit code: **124** (`TIMEOUT_EXIT_CODE`, process.ts:256); killed-by-timeout
  reports exit 124 + `timedOut`. Python's `settle()` port must reproduce this exactly,
  including signal/exit-code reporting semantics.

## 5. Agent runtime contract (`packages/ai-service/src/workflow/agent/`)

### 5.1 Bounds — clamp, never trust (agent/types.ts:44–78, bounds.ts:16–43)

```
AGENT_CEILINGS:  maxIterations=25   timeoutMs=600_000   maxTokens=200_000   maxConsecutiveFailures=5
AGENT_DEFAULTS:  maxIterations=10   timeoutMs=60_000    maxTokens=10_000    maxConsecutiveFailures=3
```

`clamp(value, fallback, ceiling)` (bounds.ts:16–20): non-finite or ≤0 → fallback;
otherwise `min(floor(n), ceiling)`. Silent clamping — never reject the workflow; record
effective bounds on the trace instead. A definition can NEVER raise a limit.

### 5.2 Tool narrowing — four rules, order matters (bounds.ts:105–191)

A requested capability survives only if ALL hold:
1. defined in the manifest (`unknown-capability`, permanent),
2. not irreversible (`agent-unsafe-irreversible`, permanent) — **checked before envelope**,
3. needs no human-only scope (`account.authorize`, `resource.destroy`, `system.modify`)
   → else `agent-unsafe-human-only`, permanent,
4. supported by a registered executor (`unsupported-capability`, NOT permanent),
5. contained in the workflow envelope (`outside-envelope`, NOT permanent — fixable).

Rules 2–3 are stricter than policy allows being — that is permitted here; nothing here
may loosen anything. Permanent exclusions are evaluated FIRST so authors get the honest
("never") answer rather than the misleading ("widen your workflow") one (bounds.ts:133–146).

Refusal answers carry `{ capabilityId, code, reason, permanent }`.

Tool descriptions shown to a model are built from the manifest ONLY, never from the
definition or prompt (tool-poisoning control, bounds.ts:193–228).

### 5.3 Stop reasons → ports (agent/types.ts:82–117)

```
completed            → done
awaiting-approval    → needs-human
denied               → needs-human      # a person changes something, not a retry
max-iterations       → failed
timeout              → failed
token-budget         → failed
consecutive-failures → failed
cancelled            → failed
failed               → failed
```

Never collapse `denied` into `failed`; never resume past a bound — `resume` exists ONLY
for `stopReason === 'awaiting-approval'` (types.ts:216–232).

### 5.4 The nine beats and their bounds (agent/types.ts:124–167, 235–240)

`intent plan proposal permission execution observation decision intervention result`
— actors `ai|fabric|human|system`; observation rows carry `untrusted: true`
(prompt-injection control, property of the RECORD not the UI).

Bounds: `MAX_BEATS=500`, `MAX_BEAT_TEXT=4000`, `MAX_TRANSCRIPT_ENTRIES=40`.
Token accounting states its source: `provider | estimated | mixed`.
Partial snapshots set `partial: true` and carry ONLY `beats`.

## 6. Workflow run records (`packages/ai-service/src/workflow/run/types.ts`)

- States never collapse: run `RunState` has 7 values; terminal =
  `succeeded failed cancelled timed-out` (run/types.ts:45–57). Node-level adds
  `denied skipped awaiting-approval` as distinct non-failures (:68–77).
- A run references `versionId`, never the live definition (:207–209).
- Evidence is a REFERENCE (`invocationId` join into audit), never a copied decision —
  one authority, two indexes (:93–109).
- Checkpoint payload is redacted+bounded output; `MAX_CHECKPOINT_TEXT = 64 KiB`,
  `MAX_TRANSITIONS = 60`, `MAX_RUN_LOG = 2000` (:188–192, 261).
- `resumable` is STATED, not derived (:241–243); superseded runs carry `supersededBy`
  forward-link and leave pending/resumable sets (:254–256).
- Store caps (`run/store.ts`): 200 runs per workflow, 5000 index entries
  (`workflow-runs/index.json`).

## 7. Provenance lattice (`packages/ai-service/src/workflow/provenance.ts:28–29`)

Ordered least→most trusted: `external < tool < system < authored`.
`weakest(levels)` returns the minimum. Derived values take the weakest input against
their own ceiling. No policy decision reads provenance (presentation + trace only).

## 8. Persistence mechanics (`packages/ai-service/src/persist.ts`, mirrored in automation/persist.ts)

- Config home: `$AURA_HOME` or `~/.aura`, created on demand (:22–25).
- Atomic write: temp file `` `${file}.${pid}.tmp` `` then `rename` (:40–46), content
  pretty-printed `JSON.stringify(value, null, 2)` + trailing newline absent (exact bytes
  matter for round-trip tests — match Node's JSON.stringify spacing).
- Reads return the fallback on missing OR corrupt files (:32–38) — corruption degrades,
  never crashes.
- Automation package keeps its own identical copy by design
  (automation/persist.ts header) — preserve that independence in Python too.

## 9. Wire gates (details in wire-contracts.md, repeated here because they are security)

- CORS reflects origin only when it matches
  `^(https?://(localhost|127\.0\.0\.1)(:\d+)?|tauri://localhost|https?://tauri\.localhost)$`
  (server.ts:46, 235).
- `/shutdown` requires header `x-aura-shutdown: 1`, else 403 — a cross-origin webpage
  must not be able to kill the service (server.ts:248–255).
- Service owns loopback port 4319; foreign-port refusal semantics preserved.
